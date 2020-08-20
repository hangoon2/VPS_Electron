const EventEmitter = require('events').EventEmitter;

const utils = require('./Utils.js');
const logger = require('./Logger.js').logger;

const config = require('./json/config.json');
const command = require('./json/command.json');

class Session extends EventEmitter {
    constructor(socket) {
        super();

        this.socket = socket;
        this.id;
        this.type = 0;
        this.dNum = 0;

        this.prev_event_coord = {};

        this.sent_frames = 0;
        
        this.receive_buffer = [];
    }

    start() {
        this.socket.on('data', this.onSocketData.bind(this));
        this.socket.on('error', this.onSocketError.bind(this));
        this.socket.on('close', this.onSocketClose.bind(this));
    }

    stop() {
        logger.info(`세션(${this.id}) 종료`)
        if(this.socket !== undefined)
            this.socket.destroy();
        this.socket = undefined;
    }

    read(data) {
        do {
            if(this.receive_buffer.length > 0) {
                if(data !== null) {
                    this.receive_buffer.push(data);
                }
                data = Buffer.concat(this.receive_buffer);
                this.receive_buffer = [];
            }

            if(data.length < 8) {
                this.receive_buffer.push(data);
                return;
            }

            let dLen = data.readUInt32BE(1);
            let uCmd = data.readUInt16BE(5);
            let dNum = data.readUInt8(7);

            if(data.length < dLen + 11) {
                this.receive_buffer.push(data);
                return;
            }

            if(uCmd < 0 || uCmd > 0xFFFF) {
                return;
            }

            if(dNum < 0 || dNum > 10) {
                return;
            }

            let sFlag = data.readUInt8(0);
            let eFlag = data.readUInt8(dLen + 10);

            if(sFlag !== 0x7F || eFlag !== 0xEF) {
                return;
            }

            if(data.length > dLen + 11) {
                let buffer = data.slice(dLen + 11, data.length);
                data = data.slice(0, dLen + 11);
                this.receive_buffer.push(buffer);
            }

            let checksum = data.readUInt16BE(dLen + 8);

            let packet = utils.VpsPacket.create(dLen, uCmd, dNum, checksum);
            if(dLen > 0) {
                packet.payload = data.slice(8, dLen + 8);
            }
            data = null;

            this.parse(packet);
        } while(this.receive_buffer.length > 0)
    }

    parse(packet) {
        if(packet.header.uCmd !== command.HEARTBEAT_HOST) {
            // console.log(`command : ${packet.header.uCmd} - ${packet.header.dNum}(${this.id})`);
            logger.debug(`패킷 파싱(${this.id}:${this.dNum}) : ${packet.header.uCmd}(${packet.header.dNum})`);
        }

        switch(packet.header.uCmd) {
        case command.CONNECTION_HOST:
        case command.CONNECTION_GUEST:
        case command.CONNECTION_MONITOR:
            this.id = packet.payload.toString();
            this.dNum = packet.header.dNum;

            if(packet.header.uCmd == command.CONNECTION_HOST) {
                if(this.id === 'MOBILECONTROL') {
                    this.type = utils.VPS_CONNECTION_TYPE.CONTROL;
                } else {
                    this.type = utils.VPS_CONNECTION_TYPE.HOST;
                }
            } else if(packet.header.uCmd == command.CONNECTION_GUEST) {
                this.type = utils.VPS_CONNECTION_TYPE.GUEST;
            } else if(packet.header.uCmd == command.CONNECTION_MONITOR) {
                this.type = utils.VPS_CONNECTION_TYPE.MONITOR;
            }

            this.emit('connect', this.dNum);
            break;

        case command.CONNECTION_DISCONNECT:
            this.emit('disconnect', { dNum: packet.header.dNum });
            break;
        case command.CONNECTION_DISCONNECT_GUEST:
            let disconn_id = packet.payload.toString();

            this.emit('disconnect:guest', { dNum: packet.header.dNum, disconn_id: disconn_id, packet: packet });
            break;
        case command.CONNECTION_UPDATE_GUEST_TIME:
            this.emit('update:time', { dNum: packet.header.dNum, packet: packet });
            break;
        // UPDATE_GUEST_STATUS는 게스트의 상태가 변했을 때 호스트에게 변경된 상태를 통지
        // 직접적으로 호스트나 게스트로부터 패킷을 전달받진 않음
        // case command.CONNECTION_UPDATE_GUEST_STATUS:
        //     break;

        case command.DEVICE_START:
            let width = packet.payload.readUInt16BE(0);
            let height = packet.payload.readUInt16BE(2);

            process.send({ type: 'device:start', data: { dNum: packet.header.dNum, width: width, height: height }});
            break;
        case command.DEVICE_STOP:
            process.send({ type: 'device:stop', data: { dNum: packet.header.dNum }});
            break;
        case command.DEVICE_DISCONNECTED:
            this.emit('send:session', packet);
            break;
        case command.IMAGE_QUALITY:
            process.send({ type: 'device:quality', data: { dNum: packet.header.dNum, packet: packet }});
            break;
        case command.VIDEO_FRAMERATE:
            process.send({ type: 'device:framerate', data: { dNum: packet.header.dNum, packet: packet }});
            break;
        case command.ORIENTATION_PORTRAIT:
        case command.ORIENTATION_LANDSCAPE:
            let orientation = packet.header.uCmd == command.ORIENTATION_PORTRAIT ? true : false;

            process.send({ type: 'device:orientation', data: { dNum: packet.header.dNum, orientation: orientation }});
            break;

        case command.SCREEN_CAPTURE:
            process.send({ type: 'screen:capture', data: { dNum: packet.header.dNum }});
            break;
        case command.SCREEN_ANIMATE:
            process.send({ type: 'screen:animate', data: { dNum: packet.header.dNum }});
            break;
        case command.SCREEN_RECORD:
            break;

        case command.LOGCAT_START:
        case command.LOGCAT_STOP:
        case command.RESOURCE_START:
        case command.RESOURCE_STOP:
            this.emit('send:controller', packet);
            break;

        case command.USAGE_NETWORK:
        case command.USAGE_CPU:
        case command.USAGE_MEMORY:
        case command.LOGCAT_DATA:
        case command.ACK:
            this.emit('send:session', packet);
            break;

        case command.SCRIPT_RESULT:
        case command.START_EVENT_INDEX:
        case command.START_EVENT_PATH:
        case command.START_SCRIPT_RESULT:
            this.emit('send:session', packet);
            break;

        case command.CLICK_HARDKEY:
        case command.CLICK_TAP:
        case command.CLICK_TOUCH_DOWN:
        case command.CLICK_TOUCH_UP:
        case command.CLICK_TOUCH_MOVE:
        case command.CLICK_SWIPE:
        case command.CLICK_MULTI_TOUCH_DOWN:
        case command.CLICK_MULTI_TOUCH_UP:
        case command.CLICK_MULTI_TOUCH_MOVE:
            let touchType;
            let x, y;

            if(packet.header.uCmd == command.CLICK_TAP) {
                x = packet.payload.readUInt16BE(0);
                y = packet.payload.readUInt16BE(2);

                touchType = utils.VPS_TOUCH_TYPE.CLICK;

                process.send({ type: 'screen:event', data: { dNum: packet.header.dNum, type: touchType, data: { now_x: x, now_y: y, prev_x: null, prev_y: null }}});
            } else if(packet.header.uCmd == command.CLICK_TOUCH_DOWN) {
                x = packet.payload.readUInt16BE(0);
                y = packet.payload.readUInt16BE(2);

                this.prev_event_coord.x = x;
                this.prev_event_coord.y = y;
            } else if(packet.header.uCmd == command.CLICK_TOUCH_UP) {
                x = packet.payload.readUInt16BE(0);
                y = packet.payload.readUInt16BE(2);

                if(this.prev_event_coord.x == x && this.prev_event_coord.y == y) {
                    touchType = utils.VPS_TOUCH_TYPE.CLICK;

                    process.send({ type: 'screen:event', data: { dNum: packet.header.dNum, type: touchType, data: { now_x: x, now_y: y, prev_x: null, prev_y: null }}});
                } else {
                    touchType = utils.VPS_TOUCH_TYPE.MOVE;

                    process.send({ type: 'screen:event', data: { dNum: packet.header.dNum, type: touchType, data: { now_x: x, now_y: y, prev_x: this.prev_event_coord.x, prev_y: this.prev_event_coord.y }}});
                }
            }
            this.emit('send:controller', packet);
            break;

        case command.CLICK_TOUCH_EVENT:
            let event = packet.payload.readUInt16BE(0);

            if(event == 71) {
                let touchType = utils.VPS_TOUCH_TYPE.CLICK;
                let x = packet.payload.readUInt32BE(2);
                let y = packet.payload.readUInt32BE(6);

                process.send({ type: 'screen:event', data: { dNum: packet.header.dNum, type: touchType, data: { now_x: x, now_y: y, prev_x: null, prev_y: null }}});
            } else if(event == 72) {
                let touchType = utils.VPS_TOUCH_TYPE.MOVE;
                let x = packet.payload.readUInt32BE(2);
                let y = packet.payload.readUInt32BE(6);
                let orgX = packet.payload.readUInt32BE(10);
                let orgY = packet.payload.readUInt32BE(14);

                process.send({ type: 'screen:event', data: { dNum: packet.header.dNum, type: touchType, data: { now_x: x, now_y: y, prev_x: orgX, prev_y: orgY }}});
            }
            break;

        default:
            this.emit('send:controller', packet);
            break;
        }
    }

    send(packet) {
        let ret = false;

        if(this.socket !== undefined) {
            if(typeof(packet) === 'object') {
                ret = this.socket.write(this.serialize(packet));
            } else {
                ret = this.socket.write(packet);
            }
        }

        return ret;
    }

    serialize(packet) {
        let send_buffer = Buffer.alloc(packet.header.dLen + 11);
        send_buffer.writeUInt8(0x7F, 0);
        send_buffer.writeUInt32BE(packet.header.dLen, 1);
        send_buffer.writeUInt16BE(packet.header.uCmd, 5);
        send_buffer.writeUInt8(packet.header.dNum, 7);
        if(packet.payload) {
            if(packet.payload.data) {
                packet.payload = Buffer.from(packet.payload.data);
            }
            packet.payload.copy(send_buffer, 8);
        }
        send_buffer.writeUInt16BE(packet.header.checksum, packet.header.dLen + 8);
        send_buffer.writeUInt8(0xEF, packet.header.dLen + 10);

        return send_buffer;
    }

    send_mirroring(packet) {
        let ret = false;
        this.sent_frames += 1;

        if(this.socket !== undefined) {
            if(typeof(packet) === 'object') {
                ret = this.socket.write(this.serialize_mirroring(packet));
            } else {
                ret = this.socket.write(packet);
            }
        }
        
        return ret;
    }

    serialize_mirroring(packet) { 
        let send_buffer;
        if(packet.header.uCmd !== command.NXPTC_CAPTURE_FAILED) {
            send_buffer = Buffer.alloc(packet.header.dLen + 25);
            send_buffer.writeUInt8(0x7F, 0);
            send_buffer.writeUInt32BE(packet.header.dLen, 1);
            send_buffer.writeUInt16BE(packet.header.uCmd, 5);
            send_buffer.writeUInt8(packet.header.dNum, 7);
//            send_buffer.writeBigUInt64BE(BigInt(packet.info.timestamp), 8);
            send_buffer.writeUInt16BE(packet.info.left, 16);
            send_buffer.writeUInt16BE(packet.info.top, 18);
            send_buffer.writeUInt16BE(packet.info.right, 20);
            send_buffer.writeUInt16BE(packet.info.bottom, 22);
            send_buffer.writeUInt8(Boolean(packet.info.keyframe), 24);
            if(packet.payload) {
                if(packet.payload.data) {
                    packet.payload = Buffer.from(packet.payload.data);
                }
                packet.payload.copy(send_buffer, 25);
            }
            send_buffer.writeUInt16BE(1, packet.header.dLen + 8);
            send_buffer.writeUInt8(0xEF, packet.header.dLen + 10);
        } else {
            send_buffer = Buffer.alloc(packet.header.dLen + 11);
            send_buffer.writeUInt8(0x7F, 0);
            send_buffer.writeUInt32BE(packet.header.dLen, 1);
            send_buffer.writeUInt16BE(packet.header.uCmd, 5);
            send_buffer.writeUInt8(packet.header.dNum, 7);
            if(packet.payload) {
                if(packet.payload.data) {
                    packet.payload = Buffer.from(packet.payload.data);
                }
                packet.payload.copy(send_buffer, 8);
            }
            send_buffer.writeUInt16BE(packet.header.checksum, packet.header.dLen + 8);
            send_buffer.writeUInt8(0xEF, packet.header.dLen + 10);
        }

        return send_buffer;
    }

    onSocketClose() {
        console.log('session close : ', this.id);
        this.stop();

        /////////////////////// 클라이언트 소켓 연결 끊김 처리 ////////////////////////
//        this.connect_time = undefined;

        this.emit('client:disconnect', { dNum: this.dNum, type: this.type });
        ///////////////////////////////////////////////////////////////////////
    }

    onSocketError(e) {
        console.log('session error : ', e);
    }

    onSocketData(data) {
        this.read(data);
    }
}

module.exports = Session;