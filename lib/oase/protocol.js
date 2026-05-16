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
    TCP_REQ: 5120,
};

const TransportType = {
    UDP: 'udp',
    TLS: 'tls',
};

/**
 * OaseProtocol class
 */
class OaseProtocol {
    /**
     * Initializes the OaseProtocol with a transaction number starting at 0 and a predefined start delimiter for packet construction and parsing. The protocol provides methods for creating packets, parsing received packets, and handling specific reply types for TCP connection, password check, alive status, discovery, live scene retrieval, and socket scene management.
     */
    constructor() {
        this.transactionNumber = 0;
        this.startDelimiter = Buffer.from([0x5c, 0x23, 0x4f, 0x41]);
    }

    /**
     * Gets the next transaction number, cycling from 0 to 255.
     */
    getNextTransactionNumber() {
        const current = this.transactionNumber;
        this.transactionNumber = this.transactionNumber + 1 <= 255 ? this.transactionNumber + 1 : 0;
        return current;
    }

    /**
     * Creates a packet with the specified type and payload, including the header with start delimiter, length, version, transaction number, and packet type.
     *
     * @param packetType
     * @param payload
     */
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

    /**
     * Parses a received packet, validating the start delimiter and extracting the length, version, transaction number, packet type, and payload.
     *
     * @param data
     */
    parsePacket(data) {
        if (data.length < 16) {
            throw new Error('Invalid packet size');
        }

        const startDelim = data.slice(0, 4);
        if (!startDelim.equals(this.startDelimiter)) {
            throw new Error('Invalid start delimiter');
        }

        return {
            length: data.readUInt32LE(4),
            version: data.readUInt8(8),
            transactionNumber: data.readUInt8(9),
            packetType: data.readUInt16LE(10),
            payload: data.slice(16),
        };
    }

    /**
     * Parses a TCP connection reply, extracting the success status and connection count.
     *
     * @param data
     */
    parseTcpConReply(data) {
        if (data.length < 2) {
            return { error: 'invalid length' };
        }
        return {
            success: data[0] === 1,
            conCnt: data[1],
            error: '',
        };
    }

    /**
     * Parses a password check reply, extracting the success status.
     *
     * @param data
     */
    parseCheckPwReply(data) {
        if (data.length !== 1) {
            return { error: 'invalid length' };
        }
        return {
            success: data[0] === 1,
            error: '',
        };
    }

    /**
     * Parses an alive reply, extracting the serial number.
     *
     * @param data
     */
    parseAliveReply(data) {
        if (data.length < 33) {
            return { error: 'invalid length' };
        }
        return {
            sn: data.slice(0, 12).toString('ascii'),
            error: '',
        };
    }

    /**
     * Parses a discovery reply, extracting various device information fields such as hardware type, device index, name, serial number, long name, order, firmware version, memory versions, Wi-Fi channel, network type, and status.
     *
     * @param data
     */
    parseDiscoveryReply(data) {
        if (data.length < 324) {
            return { error: 'invalid length' };
        }

        return {
            hwType: data[0],
            devIdx: data[1],
            name: data.slice(2, 34).toString('ascii').replace(/\0+$/, ''),
            sn: data.slice(34, 46).toString('ascii'),
            lname: data.slice(66, 130).toString('ascii').replace(/\0+$/, ''),
            order: data.readUInt32LE(130),
            fw: data[187],
            rMemVer: data[192],
            cMemVer: data[193],
            fwL: data[194],
            fwH: data[195],
            wifiCh: data[196],
            net: data[197],
            status: data.slice(199, 323).toString('ascii').replace(/\0+$/, ''),
            error: '',
        };
    }

    /**
     * Parses a live scene reply, extracting the type, ID, count, scene type, scene length, and scene data.
     *
     * @param data
     */
    parseLiveSceneReply(data) {
        if (data.length < 11) {
            return { error: 'invalid length' };
        }

        return {
            type: data[0],
            id: data.readUInt32LE(1),
            cnt: data.readUInt32LE(5),
            sceneType: data[9],
            sceneLen: data[10],
            data: data.slice(11, 11 + data[10]),
            error: '',
        };
    }

    /**
     * Parses a socket scene get reply, extracting the status of four sockets and the dimension of the fourth socket.
     *
     * @param data
     */
    parseSocketSceneGetReply(data) {
        if (data.length !== 5) {
            return { error: 'invalid length' };
        }

        return {
            s1: data[0] === 0xff,
            s2: data[1] === 0xff,
            s3: data[2] === 0xff,
            s4: data[3] === 0xff,
            s4_dim: data[4],
            error: '',
        };
    }

    /**
     * Parses a socket scene set reply, extracting the success status.
     *
     * @param data
     */
    parseSetLiveSceneReply(data) {
        if (data.length < 1) {
            return { error: 'invalid length' };
        }
        return {
            success: data[0] === 1,
            error: '',
        };
    }
}

/**
 * OaseServer class that manages a TLS server for handling Oase protocol communication, including certificate generation, connection management, data handling, and request-response logic.
 */
class OaseServer extends EventEmitter {
    /**
     * Initializes the OaseServer with optional host, port, protocol handler, logging, and sets up internal state for managing TLS connections and pending requests.
     *
     * @param options
     */
    constructor(options = {}) {
        super();
        this.host = options.host || '0.0.0.0';
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

    /**
     * Sets the Oase client instance for the server, allowing it to access UDP client functionality if needed.
     *
     * @param oaseClient
     */
    setClient(oaseClient) {
        this.oaseClient = oaseClient;
    }

    /**
     * Generates a self-signed certificate using node-forge, creating a new RSA key pair, setting the certificate attributes, and signing it with the private key. The generated certificate is valid for 14 days (7 days before and after the current date) and is returned in PEM format.
     */
    generateCert() {
        // Keep existing certificate generation using node-forge
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';

        const now = new Date();
        cert.validity.notBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        cert.validity.notAfter = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const attrs = [
            {
                name: 'commonName',
                value: 'com.oase.easycontrol',
            },
        ];
        cert.setSubject(attrs);
        cert.setIssuer(attrs);
        cert.sign(keys.privateKey, forge.md.sha256.create());

        return {
            key: forge.pki.privateKeyToPem(keys.privateKey),
            cert: forge.pki.certificateToPem(cert),
        };
    }

    /**
     * Starts the TLS server, setting up the necessary options for secure communication, handling incoming connections, managing socket events for data, errors, timeouts, and connection closures, and emitting events for new connections and received data. The server listens on the specified host and port, and resolves a handshake promise once the TLS handshake is completed successfully.
     */
    start() {
        this.handshakePromise = new Promise(resolve => {
            this.handshakeResolve = resolve;
        });

        this.log.debug('Generating certificates...');
        const certs = this.generateCert();

        const tlsOptions = {
            key: certs.key,
            cert: certs.cert,
            requestCert: false, // Don't request client certificate
            rejectUnauthorized: false,
            minVersion: tls.DEFAULT_MIN_VERSION,
            maxVersion: tls.DEFAULT_MAX_VERSION,
            ciphers: 'AES128-SHA:DES-CBC3-SHA:RC4-SHA:RC4-MD5:AES256-SHA:AES128-SHA256:AES256-SHA256',
            secureOptions: require('node:constants').SSL_OP_NO_TLSv1_3,
            handshakeTimeout: 10000,
            sessionTimeout: 7200, // 2 hours
            keepAlive: true,
            enableTrace: false,
            debug: false,
        };

        this.server = tls.createServer(tlsOptions, socket => {
            this.log.info('Starting TCP server with TLS...');
            this.activeSocket = socket;

            // Maximum keepalive settings
            socket.setKeepAlive(true, 7200000); // 2 hours in milliseconds
            socket.setTimeout(7200000); // 2 hours timeout

            socket.on('data', data => {
                //this.log.debug(`TLS Data received: ${data.length} bytes`);
                this.handleTlsData(socket, data);
            });

            socket.on('timeout', () => {
                this.log.debug('Socket timeout detected');
            });

            socket.on('error', err => {
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

            socket.on('close', hadError => {
                this.log.debug(`TLS Connection closed, had error: ${hadError}`);
            });

            this.emit('connection', socket);
        });

        this.server.on('secureConnection', socket => {
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

        this.server.on('error', err => {
            if (err.code == 'EADDRINUSE') {
                this.log.error('address and port already in use');
            }
            this.log.debug('TLS Server error:', err.message);
            console.log('TLS Server error:', err);
        });

        this.server.listen(this.port, this.host, () => {
            this.log.debug(`TLS Server listening on ${this.host}:${this.port}`);
        });
    }

    /**
     * Waits for the TLS handshake to complete.
     */
    async waitForHandshake() {
        return this.handshakePromise;
    }

    /**
     * Handles incoming TLS data, resolving any pending requests waiting for a response and emitting a 'data' event with the received data.
     *
     * @param socket
     * @param data
     */
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

    /**
     * Sends data over the active TLS connection, returning a promise that resolves with the response or rejects on timeout or if no active connection exists. The method manages pending requests and their timeouts to ensure proper request-response handling.
     *
     * @param data
     */
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
                timeout,
            });

            this.activeSocket.write(data);
        });
    }

    /**
     * Utility method to convert a buffer to a hexadecimal string representation, used for logging raw packet data in a readable format.
     *
     * @param buffer
     */
    bufferToHexString(buffer) {
        return Buffer.from(buffer).toString('hex').toUpperCase();
    }

    /**
     * Sends a request packet using the specified transport type (UDP or TLS), creating the packet with the protocol handler, logging the sent packet, and handling the response accordingly. The method validates the transport type, checks for active connections, and returns the parsed response or throws errors if issues occur during sending or receiving.
     *
     * @param packetType
     * @param data
     * @param transport
     */
    async sendRequest(packetType, data, transport = TransportType.TLS) {
        if (!Object.values(TransportType).includes(transport)) {
            throw new Error('Invalid transport type');
        }

        const packet = this.protocol.createPacket(packetType, data);
        this.log.debug(`Sending packet -> packet type: ${packetType} packet data: ${this.bufferToHexString(data)}`);
        this.log.debug(`Raw packet: ${this.bufferToHexString(packet)}`);
        let response;

        if (transport === TransportType.UDP) {
            if (!this.oaseClient.getUdpClient()) {
                throw new Error('No UDP client connected');
            }
            response = await this.oaseClient.getUdpClient().sendUdpMsg(packet);
        } else {
            if (!this.server) {
                throw new Error('No TLS server available');
            }

            try {
                response = await this.sendTlsData(packet);
            } catch (error) {
                throw new Error(`TLS request failed: ${error.message}`);
            }
        }

        if (!response) {
            throw new Error('No response received');
        }

        return this.protocol.parsePacket(response);
    }

    /**
     * Stops the TLS server, closing any active connections and clearing pending requests to ensure a clean shutdown of the server and its resources.
     */
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

    /**
     * Gets the currently active TLS socket, allowing other parts of the application to access the socket for direct communication if needed. This method returns the active socket instance or null if no active connection exists.
     */
    getActiveSocket() {
        return this.activeSocket;
    }
}

module.exports = { OaseProtocol, OasePacketTypes, OaseServer };
