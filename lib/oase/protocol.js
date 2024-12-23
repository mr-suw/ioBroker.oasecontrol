const tls = require('node:tls');
const EventEmitter = require('events');
const forge = require('node-forge');

const OasePacketTypes = {
    PASSWORD_CHECK: 40704,
    DEVICE_INFO: 4096,
    ALIVE: 4352,
    DISCOVERY: 4096,
    GET_LIVE_SCENE: 50432,
    SET_LIVE_SCENE: 50176,
    TCP_REQ: 5120
};

const TransportType = {
    UDP: "udp",
    TLS: "tls"
};

class OaseProtocol {
    constructor() {
        this.transactionNumber = 0;
        this.startDelimiter = Buffer.from([0x5c, 0x23, 0x4f, 0x41]);
    }

    getNextTransactionNumber() {
        const current = this.transactionNumber;
        this.transactionNumber = (this.transactionNumber + 1 <= 255) ? this.transactionNumber + 1 : 0;
        return current;
    }

    createPacket(packetType, payload) {
        const length = payload.length;
        const version = 2;
        const txn = this.getNextTransactionNumber();

        this.header = Buffer.alloc(16);
        this.header.writeUInt32LE(this.startDelimiter.readUInt32LE(0), 0);
        this.header.writeUInt32LE(length, 4);
        this.header.writeUInt8(version, 8);
        this.header.writeUInt8(txn, 9);
        this.header.writeUInt16LE(packetType, 10);

        return Buffer.concat([this.header, payload]);
    }

    parsePacket(data) {
        if (data.length < 16) throw new Error("Invalid packet size");

        const startDelim = data.slice(0, 4);
        if (!startDelim.equals(this.startDelimiter)) {
            throw new Error("Invalid start delimiter");
        }

        return {
            length: data.readUInt32LE(4),
            version: data.readUInt8(8),
            transactionNumber: data.readUInt8(9),
            packetType: data.readUInt16LE(10),
            payload: data.slice(16)
        };
    }

    parseTcpConReply(data) {
        if (data.length < 2) {
            return { error: "invalid length" };
        }
        return {
            success: data[0] === 1,
            conCnt: data[1],
            error: ""
        };
    }

    parseCheckPwReply(data) {
        if (data.length !== 1) {
            return { error: "invalid length" };
        }
        return {
            success: data[0] === 1,
            error: ""
        };
    }

    parseAliveReply(data) {
        if (data.length < 33) {
            return { error: "invalid length" };
        }
        return {
            sn: data.slice(0, 12).toString("ascii"),
            error: ""
        };
    }

    parseDiscoveryReply(data) {
        if (data.length < 324) {
            return { error: "invalid length" };
        }

        return {
            hwType: data[0],
            devIdx: data[1],
            name: data.slice(2, 34).toString("ascii").replace(/\0+$/, ""),
            sn: data.slice(34, 46).toString("ascii"),
            lname: data.slice(66, 130).toString("ascii").replace(/\0+$/, ""),
            order: data.readUInt32LE(130),
            fw: data[187],
            rMemVer: data[192],
            cMemVer: data[193],
            fwL: data[194],
            fwH: data[195],
            wifiCh: data[196],
            net: data[197],
            status: data.slice(199, 323).toString("ascii").replace(/\0+$/, ""),
            error: ""
        };
    }

    parseLiveSceneReply(data) {
        if (data.length < 11) {
            return { error: "invalid length" };
        }

        return {
            type: data[0],
            id: data.readUInt32LE(1),
            cnt: data.readUInt32LE(5),
            sceneType: data[9],
            sceneLen: data[10],
            data: data.slice(11, 11 + data[10]),
            error: ""
        };
    }

    parseSocketSceneGetReply(data) {
        if (data.length !== 5) {
            return { error: "invalid length" };
        }

        return {
            s1: data[0] === 0xFF,
            s2: data[1] === 0xFF,
            s3: data[2] === 0xFF,
            s4: data[3] === 0xFF,
            s4_dim: data[4],
            error: ""
        };
    }

    parseSetLiveSceneReply(data) {
        if (data.length < 1) {
            return { error: "invalid length" };
        }
        return {
            success: data[0] === 1,
            error: ""
        };
    }
}

class OaseServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.host = options.host || "0.0.0.0";
        this.port = options.port || 5999;
        this.protocol = options.protocol;
        this.activeSocket = null;
        this.server = null;
        this.pendingRequests = new Map();
        this.requestTimeout = 5000;
        this.log = options.log || console;
        this.tlsHandshakeComplete = false;
        this.handshakePromise = null;
        this.handshakeResolve = null;
    }

    setClient(oaseClient) {
        this.oaseClient = oaseClient;
    }

    generateCert() {
        // Keep existing certificate generation using node-forge
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        
        const now = new Date();
        cert.validity.notBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        cert.validity.notAfter = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        
        const attrs = [{
            name: 'commonName',
            value: 'com.oase.easycontrol'
        }];
        cert.setSubject(attrs);
        cert.setIssuer(attrs);
        cert.sign(keys.privateKey, forge.md.sha256.create());

        return {
            key: forge.pki.privateKeyToPem(keys.privateKey),
            cert: forge.pki.certificateToPem(cert)
        };
    }

    start() {
        this.handshakePromise = new Promise((resolve) => {
            this.handshakeResolve = resolve;
        });

        this.log.debug("Generating certificates...");
        const certs = this.generateCert();

        const tlsOptions = {
            key: certs.key,
            cert: certs.cert,
            requestCert: false, // Don't request client certificate
            rejectUnauthorized: false,
            minVersion: tls.DEFAULT_MIN_VERSION,
            maxVersion: tls.DEFAULT_MAX_VERSION,
            ciphers: 'AES128-SHA:DES-CBC3-SHA:RC4-SHA:RC4-MD5:AES256-SHA:AES128-SHA256:AES256-SHA256',
            secureOptions: require('constants').SSL_OP_NO_TLSv1_3,
            handshakeTimeout: 10000,
            sessionTimeout: 7200,  // 2 hours
            keepAlive: true,
            enableTrace: false,
            debug: false
        };

        this.server = tls.createServer(tlsOptions, (socket) => {
            this.log.info('Starting TCP server with TLS...');
            this.activeSocket = socket;

            // Maximum keepalive settings
            socket.setKeepAlive(true, 7200000); // 2 hours in milliseconds
            socket.setTimeout(7200000); // 2 hours timeout

            socket.on('data', (data) => {
                //this.log.debug(`TLS Data received: ${data.length} bytes`);
                this.handleTlsData(socket, data);
            });

            socket.on('timeout', () => {
                this.log.debug('Socket timeout detected');
            });

            socket.on('error', (err) => {
                this.log.debug('TLS Socket error:', err.message);
                console.log(`Error details: ${err.library}, ${err.reason}, ${err.code}`);
                if (err.code === 'ECONNRESET') {
                    this.log.debug('Connection reset by peer');
                }
                this.activeSocket = null;
            });

            socket.on('end', () => {
                this.log.info('TLS Connection ended');
                this.activeSocket = null;
            });

            socket.on('close', (hadError) => {
                this.log.debug(`TLS Connection closed, had error: ${hadError}`);
            });

            this.emit('connection', socket);
        });

        this.server.on('secureConnection', (socket) => {
            this.log.debug('TLS Handshake completed');
            this.log.debug(`Protocol: ${socket.getProtocol()}`);
            this.log.debug(`Cipher: ${socket.getCipher().name}`);

            this.tlsHandshakeComplete = true;
            if (this.handshakeResolve) {
                this.handshakeResolve(true);
            }
        });

        this.server.on('tlsClientError', (err, socket) => {
            this.log.debug(`TLS Client Error. IP: ${socket.remoteAddress}:${socket.remotePort}`);
            console.log('TLS Client Error:', err);
        });

        this.server.on('error', (err) => {
            if (err.code == "EADDRINUSE"){
                this.log.error("address and port already in use")
            }
            this.log.debug("TLS Server error:", err.message);
            console.log('TLS Server error:', err);
        });

        this.server.listen(this.port, this.host, () => {
            this.log.debug(`TLS Server listening on ${this.host}:${this.port}`);
        });
    }

    async waitForHandshake() {
        return this.handshakePromise;
    }

    handleTlsData(socket, data) {
        //this.log.debug(`Processing TLS data, socket valid: ${!!socket && socket.writable}`);
        const pendingRequest = Array.from(this.pendingRequests.values())[0];
        if (pendingRequest) {
            clearTimeout(pendingRequest.timeout);
            pendingRequest.resolve(data);
            this.pendingRequests.clear();
        }
        this.emit('data', data);
    }

    async sendTlsData(data) {
        return new Promise((resolve, reject) => {
            if (!this.activeSocket) {
                reject(new Error('No active TLS connection'));
                return;
            }

            const timeout = setTimeout(() => {
                this.pendingRequests.clear();
                reject(new Error('TLS response timeout'));
            }, this.requestTimeout);

            this.pendingRequests.set('current', {
                resolve,
                reject,
                timeout
            });

            this.activeSocket.write(data);
        });
    }

    bufferToHexString(buffer) {
        return Buffer.from(buffer).toString('hex').toUpperCase();
    }

    async sendRequest(packetType, data, transport = TransportType.TLS) {
        if (!Object.values(TransportType).includes(transport)) {
            throw new Error("Invalid transport type");
        }

        const packet = this.protocol.createPacket(packetType, data);
        this.log.debug(`Sending packet -> packet type: ${packetType} packet data: ${this.bufferToHexString(data)}`);
        this.log.debug(`Raw packet: ${this.bufferToHexString(packet)}`);
        let response;

        if (transport === TransportType.UDP) {
            if (!this.oaseClient.getUdpClient()) {
                throw new Error("No UDP client connected");
            }
            response = await this.oaseClient.getUdpClient().sendUdpMsg(packet);
        } else {
            if (!this.server) {
                throw new Error("No TLS server available");
            }

            try {
                response = await this.sendTlsData(packet);
            } catch (error) {
                throw new Error(`TLS request failed: ${error.message}`);
            }
        }

        if (!response) {
            throw new Error("No response received");
        }

        return this.protocol.parsePacket(response);
    }

    stop() {
        if (this.activeSocket) {
            this.activeSocket.end();
            this.activeSocket = null;
        }
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        if (this.pendingRequests.size > 0) {
            this.pendingRequests.forEach(request => {
                clearTimeout(request.timeout);
            });
        }
        this.pendingRequests.clear();
    }

    getActiveSocket() {
        return this.activeSocket;
    }
}

module.exports = { OaseProtocol, OasePacketTypes, OaseServer };