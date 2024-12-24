"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

const utils = require("@iobroker/adapter-core");
const { OaseClient, TransportType, OaseProtocol } = require("./lib/oase");
const { OaseServer } = require("./lib/oase/protocol"); 

class Oasecontrol extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options = {}) {
        super({...options, name: 'oasecontrol'});
        // Add retry configuration
        this.INITIAL_RETRY_DELAY = 60 * 1000;  // 1 minute
        this.MAX_RETRY_DELAY = 2 * 60 * 60 * 1000;  // 2 hours
        this.retryAttempts = 0;
        this.discoveryTimer = null;

        this.on("ready", this.onReady.bind(this));
        // @ts-ignore
        this.on("stateChange", this.onStateChange.bind(this));
        // this.on("objectChange", this.onObjectChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));

        this.oaseClient = null;
        this.oaseServer = null;
        this.pollingGetScene = null;
        this.pollingKeepAlive = null;
        this.enableKeepAlive = false;
        this.intervalKeepAlive = 30;
        this.tlsPort = 5999;
        this.udpPort = 5959;
        this.isTxLock = false;
        this.txRetries = 3;
        this.cmdReq = {
            itemId : 0x00,
            value : 0x00
        };
    }

    getOaseClient() {
        if (!this.oaseClient) {
            throw new Error("OaseClient not initialized");
        }
        return this.oaseClient;
    }

    async isDeviceConnect() {
        const sCon = await this.getStateAsync("info.connection");
        if (sCon != null ){ return sCon.val; } else { return false; }
    }

    calculateNextRetryDelay() {
        // Exponential backoff: 1min, 5min, 20min, 1hr, 2hr
        const delay = this.INITIAL_RETRY_DELAY * Math.pow(4, this.retryAttempts);
        return Math.min(delay, this.MAX_RETRY_DELAY);
    }

    async tryDiscovery() {
        try {
            await this.getOaseClient().connectUdp();
            const discovery = await this.getOaseClient().discoveryReq(TransportType.UDP);
            
            if (discovery.lname.startsWith("FM-Master EGC")) {
                this.log.info("Detected device:" + discovery.lname);
                this.retryAttempts = 0;
                await this.initFmMasterEgcStates();
                await this.updateDiscoveryStates(discovery);
                return true;
            }
            return false;
        } catch (err) {
            return false;
        }
    }

    async scheduleNextDiscovery() {
        const delay = this.calculateNextRetryDelay();
        this.log.warn(`Device not available, next retry in ${Math.floor(delay/1000)} seconds`);
        this.retryAttempts++;

        if (this.discoveryTimer) {
            clearTimeout(this.discoveryTimer);
        }

        return new Promise(resolve => {
            this.discoveryTimer = setTimeout(async () => {
                const success = await this.tryDiscovery();
                resolve(success);
            }, delay);
        });
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        try {
            this.checkCfg();
            
            // Set initial states
            this.createObj("info.connection", "info.connection", "state", "indicator", "boolean", false, true);
            this.setState("info.connection", { val: false, ack: true });

            // Initialize components
            this.log.debug("initializing TLS server...");
            this.protocol = new OaseProtocol();
            this.oaseServer = new OaseServer({
                host: this.config.optIpTcpServer,
                port: this.tlsPort,
                protocol: this.protocol,
                log: this.log
            });

            // Start TLS server
            this.log.debug("starting TCP server with TLS...");
            this.oaseServer.start();

            this.log.debug("initializing client...");
            this.oaseClient = new OaseClient({
                host: this.config.optIpDevice,
                protocol: this.protocol,
                server: this.oaseServer,
                udpPort: this.udpPort,
                log: this.log
            });

            this.oaseServer.setClient(this.getOaseClient());

            // discovery with retries
            while (true) {
                const discovered = await this.tryDiscovery();
                if (discovered) {
                    const conReq = await this.getOaseClient().tcpConReq(this.tlsPort);
                    if (conReq.error) {
                        throw new Error("TCP connection req failed: " + conReq.error);
                    }
                    
                    this.log.debug("waiting for TLS handshake from device...");
                    await this.oaseServer.waitForHandshake();
                    await this.handleTlsConnection();
                    break;
                } else {
                    await this.scheduleNextDiscovery();
                }
            }

        } catch (err) {
            this.log.error(`Failed to initialize adapter: ${err}`);
            this.restart();
        }
    }

    async sleep(ms){
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    async handleTlsConnection() {
        try {
            await this.sleep(1000);

            // Authenticate using TLS
            this.log.debug("authenticating TLS connection...");

            const pwCheck = await this.getOaseClient().checkDevicePwReq(
                this.config.optDevicePassword,
                false,
                TransportType.TLS
            );

            if (!pwCheck) {
                throw new Error("Authentication failed");
            }

            this.log.info("authenticated to device");
            this.setState("info.connection", { val: true, ack: true });

            //start scene poll once
            await this.sleep(1000);
            await this.getFmMasterScene()


            // start keep alive handling
            if (this.enableKeepAlive) {
                this.log.debug("starting keep alive polling...");
                this.startKeepAlive();
            }

            // Start scene polling
            this.startScenePolling();

        } catch (err) {
            this.log.error(`TLS client error: ${err}`);
            this.restart();
        }
    }

    async getFmMasterScene() {
        const sceneData = this.getOaseClient().createFmMasterSocketSceneGet();
        const gls = await this.getOaseClient().getLiveSceneReq(sceneData, TransportType.TLS);
        if (gls.error != "") {
            throw new Error(`Invalid poll scene states answer: ${gls.error}`);
        }
        const ssg = this.getProtocol().parseSocketSceneGetReply(gls.data);
        if (ssg.error != "") {
            throw new Error(`Invalid poll scene socke answer: ${ssg.error}`);
        }
        this.updateFmMasterStates(ssg);
    }

    startScenePolling() {
        this.pollingGetScene = setInterval(async () => {
            if (!this.isTxLocked()) {
                try {
                    await this.getFmMasterScene()
                } catch (err) {
                    this.txRetries--;
                    this.log.warn(`Polling failed. Retries left: ${this.txRetries}`);
                    console.log("scene polling error: " + err );
                    if (this.txRetries <= 0) {
                        this.log.error(`Max retries reached. Restarting adapter`);
                        clearInterval(this.pollingGetScene);
                        this.restart();
                    }
                }
            }
        }, this.config.optPollTime * 1000);
    }

    startKeepAlive() {
        this.pollingKeepAlive = setInterval(async () => {
            if (!this.isTxLocked()) {
                try {
                    const alive = await this.getOaseClient().aliveReq( TransportType.TLS );
                    if (alive.error != "") {
                        throw new Error(`Invalid keep alive answer: ${alive.error}`);
                    } else {
                        this.log.debug("keep-alive successful (sn: " + alive.sn +" )" );
                    }
                } catch (err) {
                    console.log("scene polling error: " + err.message );                
                }
            }
        }, this.intervalKeepAlive * 1000);
    }

    async updateFmMasterStates(states) {
        this.setState("outlet1", { val: states.s1, ack: true });
        this.setState("outlet2", { val: states.s2, ack: true });
        this.setState("outlet3", { val: states.s3, ack: true });
        this.setState("outlet4", { val: states.s4, ack: true });
        this.setState("outlet4_dimmer", { val: states.s4_dim, ack: true });

        this.log.debug("outlet states polled (" + states.s1 + ", " + states.s2 + ", " + states.s3 + ", " + states.s4 + ", " + states.s4_dim + ")");
    }

    bufferToHexString(buffer) {
        return Buffer.from(buffer).toString('hex').toUpperCase();
    }

    getProtocol(){
        if (!this.protocol) {
            throw new Error("Protocol not initialized");
        } else {
            return this.protocol;
        }
    }

    checkCfg(){
        if (this.config.optIpTcpServer == "" || this.config.optIpDevice == "" || this.config.optDevicePassword == "")
        {
            this.log.error(`IP address, device IP address or device password not set.`);
            this.disable();
        }
        //output config options
        this.log.debug(`Adapter IP: ${this.config.optIpTcpServer}`);
        this.log.debug(`Device IP: ${this.config.optIpDevice}`);
        this.log.debug(`Device password: ${this.config.optDevicePassword}`);
        this.log.debug(`Polling time: ${this.config.optPollTime} seconds`);
        if (this.config.optPollTime < 5 )
        {
            this.log.error(`Polling time below 5 seconds.`);
            this.disable();
        }
        else if (this.config.optPollTime > 55 )
        {
            this.log.warn(`Polling time above 55 seconds requires sending a keep alive message to the device.`);

            //check that keep alive is not send on same time as polling states
            if (this.config.optPollTime % this.intervalKeepAlive === 0) {
                this.intervalKeepAlive += 7
            }

            this.enableKeepAlive = true;
        }
    }

    async updateDiscoveryStates( discovery ){
        this.setState("name", discovery.name, true);
        this.setState("serial-number", discovery.sn, true);
        this.setState("device", discovery.lname, true);
    }

    async initFmMasterEgcStates(){
        this.log.debug("initializing FM Master EGC states...");
        if ( await this.getStateAsync("name") == null ) { await this.createObj("name", "name", "state", "text", "string", false, true); }
        if ( await this.getStateAsync("sn") == null ) {   await this.createObj("serial-number", "sn", "state", "text", "string", false, true); }
        if ( await this.getStateAsync("device") == null ) {   await this.createObj("device", "device", "state", "text", "string", false, true); }

        //this.log.debug("initializing FM Master outlet objects...");
        if ( await this.getStateAsync("outlet1") == null ) { await this.createObj("outlet1", "outlet1", "state", "switch", "boolean", true, true); }
        if ( await this.getStateAsync("outlet2") == null ) { await this.createObj("outlet2", "outlet2", "state", "switch", "boolean", true, true); }
        if ( await this.getStateAsync("outlet3") == null ) { await this.createObj("outlet3", "outlet3", "state", "switch", "boolean", true, true); }         
        if ( await this.getStateAsync("outlet4") == null ) { await this.createObj("outlet4", "outlet4", "state", "switch", "boolean", true, true);  }
        if ( await this.getStateAsync("outlet4dim") == null ) {  await this.createObj("outlet4_dimmer", "outlet4dim", "state", "value", "number", true, true);  }

        this.subscribeStatesAsync("outlet1");
        this.subscribeStatesAsync("outlet2");
        this.subscribeStatesAsync("outlet3");
        this.subscribeStatesAsync("outlet4");
        this.subscribeStatesAsync("outlet4_dimmer");

        //this.log.debug("creating FM Master read-only switches...");
        if ( await this.getStateAsync("outlet1_readOnly") == null ) { await this.createObj("outlet1_readOnly", "outlet1_readOnly", "state", "switch", "boolean", true, true); }
        if ( await this.getStateAsync("outlet2_readOnly") == null ) { await this.createObj("outlet2_readOnly", "outlet2_readOnly", "state", "switch", "boolean", true, true); }
        if ( await this.getStateAsync("outlet3_readOnly") == null ) { await this.createObj("outlet3_readOnly", "outlet3_readOnly", "state", "switch", "boolean", true, true); }
        if ( await this.getStateAsync("outlet4_readOnly") == null ) { await this.createObj("outlet4_readOnly", "outlet4_readOnly", "state", "switch", "boolean", true, true); }

        //this.log.debug("initialize read-only switches...");
        const roValOutlet1 =  await this.getStateAsync(this.name+"."+this.instance+".outlet1_readOnly");
        const roValOutlet2 =  await this.getStateAsync(this.name+"."+this.instance+".outlet2_readOnly");
        const roValOutlet3 =  await this.getStateAsync(this.name+"."+this.instance+".outlet3_readOnly");
        const roValOutlet4 =  await this.getStateAsync(this.name+"."+this.instance+".outlet4_readOnly");
        if ( roValOutlet1 == null ) {  this.setState(this.name+"."+this.instance+".outlet1_readOnly", false ); }
        if ( roValOutlet2 == null ) {  this.setState(this.name+"."+this.instance+".outlet2_readOnly", false ); }
        if ( roValOutlet3 == null ) {  this.setState(this.name+"."+this.instance+".outlet3_readOnly", false ); }
        if ( roValOutlet4 == null ) {  this.setState(this.name+"."+this.instance+".outlet4_readOnly", false ); }

        //this.log.debug("creating FM master switch names...");
        if ( await this.getStateAsync("outlet1_name") == null ) { await this.createObj("outlet1_name", "outlet1_name", "state", "text", "string", true, true); }
        if ( await this.getStateAsync("outlet2_name") == null ) { await this.createObj("outlet2_name", "outlet2_name", "state", "text", "string", true, true); }
        if ( await this.getStateAsync("outlet3_name") == null ) { await this.createObj("outlet3_name", "outlet3_name", "state", "text", "string", true, true); }
        if ( await this.getStateAsync("outlet4_name") == null ) { await this.createObj("outlet4_name", "outlet4_name", "state", "text", "string", true, true); }

        //this.log.debug("initialize switch default names...");
        if ( await this.getStateAsync(this.name+"."+this.instance+".outlet1_name") == null ) {  this.setState(this.name+"."+this.instance+".outlet1_name", "outlet1" ); }
        if ( await this.getStateAsync(this.name+"."+this.instance+".outlet2_name") == null ) {  this.setState(this.name+"."+this.instance+".outlet2_name", "outlet2" ); }
        if ( await this.getStateAsync(this.name+"."+this.instance+".outlet3_name") == null ) {  this.setState(this.name+"."+this.instance+".outlet3_name", "outlet3" ); }
        if ( await this.getStateAsync(this.name+"."+this.instance+".outlet4_name") == null ) {  this.setState(this.name+"."+this.instance+".outlet4_name", "outlet4" ); }

        //this.log.debug("adapter objects created.");
    }


    async createObj( pathName, commonName, objType, commonRole, commonDataType, commonWrite, commonRead){
        await this.setObjectNotExistsAsync( pathName, {
            type: objType,
            common: {
                name: commonName,
                type: commonDataType,
                role: commonRole,
                read: commonRead,
                write: commonWrite,
            },
            native: {},
        });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);
            if (this.pollingGetScene){ clearInterval(this.pollingGetScene); }
            if (this.pollingKeepAlive){ clearInterval(this.pollingKeepAlive); }
            if (this.oaseServer) { this.oaseServer.stop(); }
            if (this.oaseClient) { this.oaseClient.close(); }

            callback();
        } catch (e) {
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // onObjectChange(id, obj) {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state && state.ack == false) {
            // The state was changed
            this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

            //find out which outlet
            const idSplitted = id.split(".");
            const idName = idSplitted[ idSplitted.length - 1 ];

            //error checks:
            if ( !idName.startsWith("outlet") )
            {
                //discard change on not relevant states
                this.log.debug("discard state change because not relevant");
                return 0;
            }
            //find if outlet is set to read only
            let idReadOnly = "";
            if (idName != "outlet4_dimmer")
            {
                idReadOnly = idName + "_readOnly";
            } else {
                //map dimmer to outlet 4 switch
                idReadOnly = "outlet4_readOnly";
            }
            const valReadOnly = await this.getStateAsync(idReadOnly);
            if ( valReadOnly && valReadOnly.val == true )
            {
                //state change not allowed; read only protection
                this.log.info("ignoring state change because state " + idName +  " is set to read only");
                return 0;
            }
            if ( valReadOnly == null )
            {
                this.log.error(`read only states not available`);
                return 0;
            }

            if ( ! await this.isDeviceConnect() ){
                //device is not connected; discard state change
                this.log.warn("ignoring state change because device is disconnected.")
                return 0;
            }

            //preperations
            this.setTxLock( true );

            //process outlet state change:
            switch ( idName ){
                case "outlet1" : this.cmdReq.itemId = 0x00; break;
                case "outlet2" : this.cmdReq.itemId = 0x01; break;
                case "outlet3" : this.cmdReq.itemId = 0x02; break;
                case "outlet4" : this.cmdReq.itemId = 0x03; break;
                case "outlet4_dimmer" : this.cmdReq.itemId = 0x04; break;
                default : this.cmdReq.itemId = 0xff;
            }
            switch ( state.val ){
                case false : this.cmdReq.value = 0x00; break;
                case true : this.cmdReq.value = 0xff; break;
                default : this.cmdReq.value = Number(state.val);
            }
            if ( ( this.cmdReq.itemId != 0xff ) && ( this.cmdReq.value <= 0xff ) && ( this.cmdReq.value >= 0x00) ){
                //process cmd
                const sceneData = this.getOaseClient().createFmMasterSocketSceneSet( this.cmdReq.itemId, this.cmdReq.value );
                const res = await this.getOaseClient().setLiveSceneReq( sceneData, TransportType.TLS );
                this.log.info("outlet "+ this.cmdReq.itemId + " -> " + this.cmdReq.value + " : " + res );
                this.setTxLock( false );
            } else {
                this.log.warn("given object value is not compatible. Command discarded.");
            }

            //cleanup
            this.setTxLock( false );
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === "object" && obj.message) {
    //         if (obj.command === "send") {
    //             // e.g. send email or pushover or whatever
    //             this.log.info("send command");

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
    //         }
    //     }
    // }

    setTxLock( lock ){
        this.isTxLock = lock;
    }

    isTxLocked(){
        return this.isTxLock;
    }

}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Oasecontrol(options);
} else {
    // otherwise start the instance directly
    new Oasecontrol();
}
