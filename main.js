"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
//const { error } = require("console");

// Load your modules here, e.g.:
// const fs = require("fs");
const dgram = require("dgram");

class Oasecontrol extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "oasecontrol",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        // this.on("objectChange", this.onObjectChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.portOase = 5959;
        this.seq = 0x00;
        this.magicBytes = Buffer.from([0x5c, 0x23, 0x4f, 0x41]);
        this.txRetries = 3;
        this.client = undefined;
        this.polling = null;
        this.isConnected = false;
        this.isSubscDone = false;
        this.isTxLock = false;
        this.cmdReq = {
            itemId : 0x00,
            value : 0x00
        };
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.checkCfg();

        this.setState("connected", { val: false, ack: true } );

        //create initial states
        this.createInitialStates();

        //connection logic
        this.createSocket()
            .then( () => {
                //req device info
                this.reqDevInfo().then( () =>  {
                    //start polling after 2s
                    this.setTimeout( () => {
                        if ( this.isConnected == true ){
                            this.log.info("polling device states every " + this.config.optPollTime + " seconds");
                            this.pollStates();
                        } else {
                            this.log.error("Connection to OASE device (" + this.config.optIp + ":" + this.portOase + ") was not possible. Please check that IP configuration is correct and device is online");
                            this.disable();
                        }
                    }, 2000);
                }).catch( () => {
                    this.log.error("requesting device info failed. Restarting adapter.");
                    this.setState("connected", { val: false, ack: true } );
                    this.restart();
                });
            })
            .catch( () => {
                this.log.error("socket connection failed. Restarting adapter.");
                this.setState("connected", { val: false, ack: true } );
                this.restart();
            });
    }

    checkCfg(){
        if (this.config.optIp == "" || (this.config.optPollTime < 10))
        {
            this.log.error("IP address not set or polling time below 10 seconds.");
            this.disable();
        }
    }

    createSocket(){
        return new Promise((resolve, reject) => {
            // create socket and connect to client
            this.client = dgram.createSocket({ type: "udp4", reuseAddr: true} );

            //register connection handlers
            this.client.on("error", (err) => {
                this.log.error("socket error: " + err);
                if (this.client) { this.client.close(); }
                reject(err);
            });

            this.client.on("listening", () => {
                this.log.info("UDP connection ready.");
                resolve(0);
            });

            this.client.on("message", this.onUdpMsg.bind(this) );

            this.client.connect(this.portOase, this.config.optIp, () => {
                this.log.info("created UDP socket for OASE device (" + this.config.optIp + ":" + this.portOase + ")");
            });
        });
    }

    sendUdpMsg(){
        return new Promise( (resolve, reject) => {
            if (this.client && this.tx ){
                this.client.send( this.tx, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(0);
                    }
                });
            } else {
                const err = "objects client and tx buffer undefined";
                this.log.error( err );
                reject( err );
            }
        });
    }

    async onUdpMsg(msg, rinfo){
        this.log.debug("new rx message from "+ rinfo.address + ":"+ rinfo.port +":\nASCII: "+ msg.toString("ascii") + "\n  HEX: " + msg.toString("hex"));

        //parse messages
        try {
            const m = msg.slice(0, 4);
            this.log.debug( "m: " + m.toString("hex"));

            if ( 0 == this.magicBytes.compare( m ) ) {
                //valid OASE message
                const l = msg.readUInt16LE(4);
                const s = msg.readUInt8(9);
                const d = msg.readUInt8(10);

                this.log.debug( "l: " + l +", s: "+ s + ", d: "+ d.toString(16));
                if ( Number(d) === 0xff ) {
                    //from OASE device
                    const c = msg.readUInt8(11);
                    const p = msg.slice( 16, Number(l) + 17 );
                    this.log.debug("c: "+ c.toString(16) + ", p: " + p.toString("hex"));
                    switch ( Number(c) ) {
                        case 0x10 : this.parseDevInfo( p ); break;
                        case 0xc4 : this.parseOutletCmd( p ); break;
                        case 0xc5 : this.parseOutletStates( p ); break;
                        default : this.log.debug("discard command ("+ c.toString("hex") + ") response: " + msg.toString("hex") );
                    }
                } else {
                    this.log.debug("discard message because not from OASE device.");
                }
            } else {
                this.log.debug("discarded unknown message.");
            }
        } catch (error) {
            this.log.error("parser failed: "+ error);
        }
    }

    async parseDevInfo( payload ){
        this.log.debug("device info is: \nASCII: "+ payload.toString("ascii") + "\n  HEX: " + payload.toString("hex") );
        const name = payload.slice(2, 34).toString("ascii").trim();
        const sn = payload.slice(34, 66).toString("ascii").trim();
        const devType = payload.slice(66, 134).toString("ascii").trim();

        this.log.info("detected device: name: "+ name + ", serial number: " + sn + ", device type: " + devType);

        //supported devices
        if ( devType.startsWith("FM-Master EGC") ){
            await this.createObj("name", "name", "state", "text", "string", false, true);
            await this.createObj("serial-number", "sn", "state", "text", "string", false, true);
            await this.createObj("device", "device", "state", "text", "string", false, true);

            this.setState("name", name, true);
            this.setState("serial-number", sn, true);
            this.setState("device", devType, true);

            //device is connected
            this.setStateAsync("connected", { val: true, ack: true } );
            this.isConnected = true;
        } else {
            this.log.error("sorry, your device type ("+ devType+ ") is not supported.");
            this.disable();
        }
    }

    async parseOutletCmd( payload ){
        this.log.debug("outlet cmd response: \nASCII: "+ payload.toString("ascii") + "\n  HEX: " + payload.toString("hex") );
    }

    async parseOutletStates( payload ){
        this.log.debug("outlet states response: \nASCII: "+ payload.toString("ascii") + "\n  HEX: " + payload.toString("hex") );
        const s1 = payload.readUInt8(11);
        const s2 = payload.readUInt8(12);
        const s3 = payload.readUInt8(13);
        const s4 = payload.readUInt8(14);
        const s4intensity = payload.readUInt8(15);

        if ( this.isSubscDone == false ){
            this.log.debug("creating adapter objects...");
            await this.createObj("outlet1", "outlet1", "state", "switch", "boolean", true, true);
            await this.createObj("outlet2", "outlet2", "state", "switch", "boolean", true, true);
            await this.createObj("outlet3", "outlet3", "state", "switch", "boolean", true, true);
            await this.createObj("outlet4", "outlet4", "state", "switch", "boolean", true, true);
            await this.createObj("outlet4_dimmer", "outlet4dim", "state", "value", "number", true, true);

            this.subscribeStatesAsync("outlet1");
            this.subscribeStatesAsync("outlet2");
            this.subscribeStatesAsync("outlet3");
            this.subscribeStatesAsync("outlet4");
            this.subscribeStatesAsync("outlet4_dimmer");

            await this.createObj("outlet1_readOnly", "outlet1_readOnly", "state", "switch", "boolean", true, true);
            await this.createObj("outlet2_readOnly", "outlet2_readOnly", "state", "switch", "boolean", true, true);
            await this.createObj("outlet3_readOnly", "outlet3_readOnly", "state", "switch", "boolean", true, true);
            await this.createObj("outlet4_readOnly", "outlet4_readOnly", "state", "switch", "boolean", true, true);

            const roValOutlet1 =  await this.getStateAsync("oasecontrol.0.outlet1_readOnly");
            const roValOutlet2 =  await this.getStateAsync("oasecontrol.0.outlet2_readOnly");
            const roValOutlet3 =  await this.getStateAsync("oasecontrol.0.outlet3_readOnly");
            const roValOutlet4 =  await this.getStateAsync("oasecontrol.0.outlet4_readOnly");
            if ( roValOutlet1 == null ) {  this.setStateAsync("oasecontrol.0.outlet1_readOnly", false ); }
            if ( roValOutlet2 == null ) {  this.setStateAsync("oasecontrol.0.outlet2_readOnly", false ); }
            if ( roValOutlet3 == null ) {  this.setStateAsync("oasecontrol.0.outlet3_readOnly", false ); }
            if ( roValOutlet4 == null ) {  this.setStateAsync("oasecontrol.0.outlet4_readOnly", false ); }

            this.isSubscDone = true;
            this.log.debug("adapter objects created.");
        }

        this.setState( "outlet1", (s1 === 255 ) ? true : false, true);
        this.setState( "outlet2", (s2 === 255 ) ? true : false, true);
        this.setState( "outlet3", (s3 === 255 ) ? true : false, true);
        this.setState( "outlet4", (s4 === 255 ) ? true : false, true);
        this.setState("outlet4_dimmer", s4intensity, true);

        this.log.debug("outlet states: (outlet 1, outlet 2, outlet 3, outlet 4, outlet 4 dimmer) = (" + s1 + ", " + s2 + ", " + s3 + ", " +s4+ ", " +s4intensity + ")");
    }

    setNextSeq(){
        if (this.seq == 0xff ){ this.seq = 0x00; }
        this.seq = this.seq + 0x01;
    }

    reqDevInfo(){
        return new Promise( (resolve, reject) => {
            const lenMsb = 0x00;
            const lenLsb = 0x00;
            const cmd = 0x10;
            this.bufReqDev = Buffer.from([lenMsb, lenLsb, 0x00, 0x00, 0x02, this.seq, 0x00, cmd, 0x00, 0x00, 0x00, 0x00] );
            this.setNextSeq();
            this.tx = Buffer.concat( [this.magicBytes, this.bufReqDev ]);
            try {
                this.sendUdpMsg().then( () => {
                    if (this.tx){
                        this.log.debug("req device info: "+ this.tx.toString("hex"));
                        resolve(0);
                    } else {
                        reject(1);
                    }
                }).catch( () => {
                    this.log.error("send UDP message failed.");
                    reject(0);
                });
            } catch(err) {
                this.log.error("req device info failed: " + this.tx.toString("hex"));
                reject(err);
            }
        });
    }

    reqOutletStates(){
        //request new states
        return new Promise( (resolve, reject) => {
            const lenMsb = 0x05;
            const lenLsb = 0x00;
            const cmd = 0xc5;
            this.bufReqDev = Buffer.from([lenMsb, lenLsb, 0x00, 0x00, 0x02, this.seq, 0x00, cmd, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00] );
            this.setNextSeq();
            this.tx = Buffer.concat( [this.magicBytes, this.bufReqDev ]);
            try {
                this.sendUdpMsg().then( () => {
                    if (this.tx){
                        this.log.debug("req outlet states: "+ this.tx.toString("hex"));
                        resolve(0);
                    } else {
                        reject(1);
                    }
                }).catch( () => {
                    this.log.error("send UDP message failed.");
                    reject(0);
                });
            } catch(err) {
                this.log.error("req outlet states failed: " + this.tx.toString("hex"));
                reject(err);
            }
        });
    }

    /*
     * @param {Number} outletIdx: 0x00 ('outlet switch 1'), 0x01 ('outlet switch 2'), 0x02 ('outlet switch 3'), 0x03 ('outlet switch 4'), 0x04 ('dimmer intensity for outlet switch 4')
     * @param {Number} outletIntensity: 0xff ('on'), 0x00 ('off') or dimmer intensity value
    */
    reqOutletSwitch( outletIdx, outletIntensity  ){
        return new Promise( (resolve, reject) => {
            const lenMsb = 0x0d;
            const lenLsb = 0x00;
            const cmd = 0xc4;
            this.bufReqDev = Buffer.from([lenMsb, lenLsb, 0x00, 0x00, 0x02, this.seq, 0x00, cmd, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x02, outletIdx, outletIntensity] );
            this.setNextSeq();
            this.tx = Buffer.concat( [this.magicBytes, this.bufReqDev ]);
            try {
                this.sendUdpMsg().then( () => {
                    if (this.tx){
                        this.log.debug("req outlet switch: "+ this.tx.toString("hex"));
                        resolve(0);
                    } else {
                        reject(1);
                    }
                }).catch( () => {
                    this.log.error("send UDP message failed.");
                    reject(0);
                });
            } catch(err) {
                this.log.error("req outlet switch failed: " + this.tx.toString("hex"));
                reject(err);
            }
        });
    }

    async pollStates() {
        //clear cylce time
        if (this.polling)
        {
            this.clearTimeout(this.polling);
            this.polling = null;
            this.log.debug("polling cycle time cleared.");
        }

        this.log.debug("polling of states started.");

        if ( this.isTxLocked() == false ){
            // request new outlet states
            this.reqOutletStates().then( () => {
                this.log.debug("polling of states done. Next poll cycle in " + this.config.optPollTime + " seconds.");

                // setup cycle time for requesting new outlet states
                this.polling = this.setTimeout( () => {
                    this.pollStates();
                }, this.config.optPollTime * 1000 );
            }).catch( (err) => {
                this.txRetries = this.txRetries - 1;
                this.log.warn("polling of outlet states failed: "+ err + ". Left retries: " + this.txRetries);
                if ( this.txRetries <= 0){
                    this.log.error("polling of outlet states failed: "+ err + ". Left retries: " + this.txRetries + ". Restarting adapter");
                    this.restart();
                }
            });
        }
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

    async createInitialStates(){
        this.createObj("connected", "connected", "state", "indicator", "boolean", false, true );
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
            if (this.polling){ this.clearTimeout(this.polling); }
            if (this.client) { this.client.close(); }

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

            //preperations
            this.setTxLock( true );

            //find out which outlet
            const idSplitted = id.split(".");
            const idName = idSplitted[ idSplitted.length - 1 ];

            //find if outlet is set to read only
            const idReadOnly = idName + "_readOnly";
            const valReadOnly = await this.getStateAsync(idReadOnly);
            if ( valReadOnly && valReadOnly.val == true )
            {
                //state change not allowed; read only protection
                this.log.info("ignore state change because state " + idName +  " is set to read only");
            } else if (valReadOnly && valReadOnly.val == false ){
                //state change allowed

                //setup cmd
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
                    this.reqOutletSwitch( this.cmdReq.itemId, this.cmdReq.value )
                        .then( () => {
                            this.log.debug("command for outlet (" + this.cmdReq.itemId + ") has been requested to switch to value " + this.cmdReq.value + ".");
                            this.setTxLock( false );

                            //start polling after 1s
                            this.setTimeout( () => {
                                if ( this.isConnected == true ){
                                    this.log.debug("polling updated outlet states");
                                    this.pollStates();
                                } else {
                                    this.log.error("not connected to device.");
                                    // retry connecting possible
                                }
                            }, 1000);
                        })
                        .catch( () => {
                            this.log.error("command failed becasue socket connection issue. Restarting adapter.");
                            this.setState("connected", { val: false, ack: true } );
                            this.restart();
                        });
                } else {
                    this.log.warn("given object value is not compatible. Command discarded.");
                }
            }
            else {
                this.log.error("warning: read only switch does not exist");
            }

            //cleanup
            this.setTxLock( false );
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
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