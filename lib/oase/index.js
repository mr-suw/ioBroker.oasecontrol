const { OaseProtocol, OasePacketTypes } = require("./protocol");
const dgram = require("dgram");

const TransportType = {
    UDP: "udp",
    TLS: "tls"
};

class OaseClient {
    constructor(options = {}) {
        this.host = options.host;
        this.protocol = options.protocol || new OaseProtocol();
        this.server = options.server;
        this.udpPort = options.udpPort || 5959;
        this.log = options.log || console;
        this.udpClient = null;
        this.requestTimeout = 5000;
    }

    async connectUdp() {
        this.udpClient = new OaseUdpClient({
            host: this.host,
            port: this.udpPort,
            protocol: this.protocol,
            log: this.log
        });
        await this.udpClient.connect();
        return this.udpClient;
    }

    async discoveryReq(transport = TransportType.TLS) {
        const response = await this.server.sendRequest(
            OasePacketTypes.DISCOVERY,
            Buffer.alloc(0),
            transport
        );

        if (!response || !response.payload) {
            throw new Error("Invalid response received");
        }

        const result = this.protocol.parseDiscoveryReply(response.payload);
        if (result.error) {
            throw new Error(result.error);
        }
        return result;
    }

    async aliveReq(transport = TransportType.TLS) {
        const response = await this.server.sendRequest(
            OasePacketTypes.ALIVE,
            Buffer.alloc(0),
            transport
        );
        const result = this.protocol.parseAliveReply(response.payload);
        if (result.error) {
            throw new Error(result.error);
        }
        return result;
    }

    async tcpConReq(port, transport = TransportType.UDP) {
        const timestampBuffer = this.getUnixTimestamp();
        const buffer = Buffer.alloc(7);
        buffer.writeUInt8(0, 0);
        buffer.writeUInt16LE(port, 1);

        const timestampArray = new Uint8Array(timestampBuffer.buffer, timestampBuffer.byteOffset, timestampBuffer.byteLength);
        buffer.set(timestampArray, 3); // Copy 4-byte timestamp

        const response = await this.server.sendRequest(
            OasePacketTypes.TCP_REQ,
            buffer,
            transport
        );
        return this.protocol.parseTcpConReply(response.payload);
    }

    bufferToHexString(buffer) {
        return Buffer.from(buffer).toString("hex").toUpperCase();
    }

    async checkDevicePwReq(pw, isPwUnicodeEncoded, transport = TransportType.TLS) {
        const pwBuffer = this.get64BytesFromString(pw, isPwUnicodeEncoded);
        //this.log.debug("pw string: '" + pw +"'");
        //this.log.debug("pw buffer:'" + this.bufferToHexString(pwBuffer) +"'");
        const response = await this.server.sendRequest(
            OasePacketTypes.PASSWORD_CHECK,
            pwBuffer,
            transport
        );
        //this.log.debug("pw req res: " + this.bufferToHexString(response.payload));
        const result = this.protocol.parseCheckPwReply(response.payload);
        if (result.error) {
            throw new Error(result.error);
        }
        return result.success;
    }

    async getLiveSceneReq(sceneData, transport = TransportType.TLS) {
        const response = await this.server.sendRequest(
            OasePacketTypes.GET_LIVE_SCENE,
            Buffer.from(sceneData),
            transport
        );
        const result = this.protocol.parseLiveSceneReply(response.payload);
        if (result.error) {
            throw new Error(result.error);
        }
        return result;
    }

    async setLiveSceneReq(sceneData, transport = TransportType.TLS) {
        const response = await this.server.sendRequest(
            OasePacketTypes.SET_LIVE_SCENE,
            Buffer.from(sceneData),
            transport
        );
        const result = this.protocol.parseSetLiveSceneReply(response.payload);
        if (result.error) {
            throw new Error(result.error);
        }
        return result.success;
    }



    get64BytesFromString(input, isUnicodeEncoded = true) {
        // Create fixed-size Uint8Array filled with zeros
        const resultBuffer = new Uint8Array(64).fill(0);

        if (!isUnicodeEncoded) {
            //decode unicode
            input = input.replace(/\\u([0-9A-Fa-f]{4})/g, (_, code) => {
                return String.fromCharCode(parseInt(code, 16));
            });
            //this.log.debug("pw unicode decode: " + input);
        }

        // Convert input string to Uint8Array
        const encoder = new TextEncoder();
        const inputArray = encoder.encode(input);

        // Copy only up to 64 bytes from input
        resultBuffer.set(inputArray.slice(0, 64));

        return resultBuffer;
    }

    getUnixTimestamp() {
        // Get current Unix timestamp in seconds
        const timestamp = Math.floor(Date.now() / 1000);

        // Create 4-byte buffer
        const buffer = Buffer.alloc(4);

        // Write timestamp as 32-bit little-endian
        buffer.writeUInt32LE(timestamp & 0xFFFFFFFF, 0);

        return buffer;
    }

    createFmMasterSocketSceneGet(){
        const buffer = Buffer.alloc(5, 0);
        buffer.writeUInt8(4, 0); //SceneId
        buffer.writeUint32LE(0, 1);

        return buffer;
    }

    createFmMasterSocketSceneSet(socketIdx, socketVal){
        const buffer = Buffer.alloc(13, 0);
        buffer.writeUInt8(4, 0); //SceneId
        buffer.writeUint32LE(0, 1);
        buffer.writeUint32LE(0, 5);
        buffer.writeUint8(100, 9); //SceneType
        buffer.writeUint8(2, 10); //SceneLength
        buffer.writeUint8(socketIdx, 11); //SceneData
        buffer.writeUint8(socketVal, 12); //SceneData

        return buffer;
    }

    close() {
        if (this.udpClient) {
            this.udpClient.close();
        }
    }

    getUdpClient() {
        return this.udpClient;
    }
}


class OaseUdpClient {
    constructor(options = {}) {
        this.host = options.host;
        this.port = options.port || 5959;
        this.protocol = options.protocol;
        this.log = options.log || console;
        this.udpClient = null;
    }

    /**
     * Connects the UDP client.
     * @returns {Promise<void>}
     */
    async connect() {
        return new Promise((resolve, reject) => {
            this.udpClient = dgram.createSocket({ type: "udp4", reuseAddr: true });

            this.udpClient.on("error", (err) => {
                if (this.udpClient) {
                    this.udpClient.close();
                }
                reject(err);
            });

            this.udpClient.on("listening", () => {
                resolve();
            });

            this.udpClient.connect(this.port, this.host);
            this.log.debug(`Udp client connect to ${this.host}:${this.port}`);
        });
    }

    async sendUdpMsg(packet) {
        if (!this.udpClient) {
            throw new Error("No UDP client connection");
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.udpClient) {
                    this.udpClient.removeListener("message", handleMessage);
                }
                reject(new Error("UDP response timeout"));
            }, 5000);

            const handleMessage = (msg) => {
                clearTimeout(timeout);
                resolve(msg);
            };

            if (this.udpClient) {
                this.udpClient.send(packet, (err) => {
                    if (err) {
                        clearTimeout(timeout);
                        reject(err);
                        return;
                    }
                    if (this.udpClient) {
                        this.udpClient.once("message", handleMessage);
                    } else {
                        reject(new Error("No UDP client connection"));
                    }
                });
            } else {
                reject(new Error("No UDP client connection"));
            }
        });
    }

    close() {
        if (this.udpClient) {
            this.udpClient.close();
            this.udpClient = null;
        }
    }

    onMessage(callback) {
        if (this.udpClient) {
            this.udpClient.on("message", callback);
        }
    }
}

module.exports = { OaseClient, TransportType, OaseProtocol };