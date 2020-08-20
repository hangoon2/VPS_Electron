const EventEmitter = require('events').EventEmitter;
const net = require('net');

const sharp = require('sharp');
const moment = require('moment');

const utils = require('./Utils.js');
const logger = require('./Logger.js').logger;

const config = require('./json/config.json');
const command = require('./json/command.json');

class Device extends EventEmitter {
    constructor(param) {
        super();

        this.mirroring_socket = new net.Socket();
        this.control_socket = new net.Socket();

        this.dNum = param.dNum;
        this.width = param.width;
        this.height = param.height;
        this.onControl = false;
        this.is_wide = param.width > param.height ? true : false;
        this.is_vertical = true;
        this.keyframe_width;
        this.keyframe_height;
        this.mirroring_quality = utils.VPS_DEFAULT_QUALITY;
        this.record_framerate = utils.VPS_DEFAULT_FRAMERATE;
        this.device_orientation = utils.VPS_DEVICE_ORIENTATION.PORTRAIT;
        this.is_service = false;
        this.onCapture = false;
        this.onAnimate = false;
        this.onAnimateCapture = false;

        this.recv_frames = 0;
        this.prev_recv_frames = 0;
        this.receive_buffer = [];
        this.send_queue = [];
        // this.animate_event_queue = [];
    }

    init() {
        if(!this.connect_control_socket()) {
            logger.error(`컨트롤 소켓 연결 안됨(${this.dNum})`);
        }
        if(!this.connect_mirroring_socket()) {
            logger.error(`미러링 소켓 연결 안됨(${this.dNum})`);
        }
    }

    start() {
        this.is_service = true;

        this.init();

        this.mirroring_socket.on('data', this.onMirroringSocketData.bind(this));
        this.mirroring_socket.on('error', this.onMirroringSocketError.bind(this));
        this.mirroring_socket.on('close', this.onMirroringSocketClose.bind(this));

        this.control_socket.on('data', this.onControlSocketData.bind(this));
        this.control_socket.on('error', this.onControlSocketError.bind(this));
        this.control_socket.on('close', this.onControlSocketClose.bind(this));
    }

    stop() {
        this.is_service = false;
        this.set_on(false);

        logger.info(`단말 연결 종료(${this.dNum})`);

        if(this.mirroring_socket !== undefined) {
            this.mirroring_socket.destroy();
            this.mirroring_socket = undefined;
        }

        if(this.control_socket !== undefined) {
            this.control_socket.destroy();
            this.control_socket = undefined;
        }
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

            if(dNum < 0 || dNum > config.VPS_MAXIMUM_DEVICES) {
                return;
            }

            let checksum = data.readUInt16BE(dLen + 8);

            let packet = utils.VpsImagePacket.create(dLen, uCmd, dNum, checksum);
            packet.info.timestamp = 0;  //Number(data.readBigUInt64BE(8));
            packet.info.left = data.readUInt16BE(16);
            packet.info.top = data.readUInt16BE(18);
            packet.info.right = data.readUInt16BE(20);
            packet.info.bottom = data.readUInt16BE(22);
            packet.info.keyframe = Boolean(data.readUInt8(24));
            packet.payload = data.slice(25, dLen + 8);
            data = null;

            if(this.keyframe_width == undefined && packet.info.keyframe) {
                this.keyframe_width = packet.info.right;
                this.keyframe_height = packet.info.bottom;
            }

            this.parse(packet);
        } while(this.receive_buffer.length > 0)
    }

    parse(packet) {
        if(this.is_wide) {
            if(packet.header.uCmd == command.DEVICE_PORTRAIT_IMAGE_PORTRAIT) {
                packet.header.uCmd = command.DEVICE_LANDSCAPE_IMAGE_LANDSCAPE;
            } else if(packet.header.uCmd == command) {
                packet.header.uCmd = command.DEVICE_PORTRAIT_IMAGE_PORTRAIT;
            }
        }

        if(!this.is_vertical && packet.header.uCmd == command.DEVICE_PORTRAIT_IMAGE_PORTRAIT) {
            packet.header.uCmd = command.DEVICE_LANDSCAPE_IMAGE_PORTRAIT;
        } else if(this.is_vertical && packet.header.uCmd == command.DEVICE_LANDSCAPE_IMAGE_LANDSCAPE) {
            packet.header.uCmd = command.DEVICE_PORTRAIT_IMAGE_LANDSCAPE;
        }

        switch(packet.header.uCmd) {
        case command.WIDE_DEVICE_IMAGE_LANDSCAPE:
            break;
        case command.WIDE_DEVICE_IMAGE_PORTRAIT:
            break;
        case command.DEVICE_PORTRAIT_IMAGE_PORTRAIT: // 20004
        case command.DEVICE_LANDSCAPE_IMAGE_LANDSCAPE: // 20005
        case command.DEVICE_PORTRAIT_IMAGE_LANDSCAPE: // 20006
        case command.DEVICE_LANDSCAPE_IMAGE_PORTRAIT: // 20007
            this.recv_frames += 1;
            this.process(packet);
            break;

        case command.NXPTC_CAPTURE_FAILED:
            process.send({ type: 'mirroring:uncaught', data: { packet: packet }});
            break;
        }
    }

    async process(packet) {
        var image;
        if(packet.header.uCmd == 20005 || packet.header.uCmd == 20007 && !this.is_wide) {
            try {
                image = await sharp(packet.payload).rotate(-90).jpeg().toBuffer();
                
                let left = packet.info.left;
                let top = packet.info.top;
                let right = packet.info.right;
                let bottom = packet.info.bottom;

                packet.info.left = packet.info.top;
                packet.info.top = (this.keyframe_width > this.keyframe_height ? this.keyframe_height : this.keyframe_width) - packet.info.right;
                packet.info.right = packet.info.bottom;
                packet.info.bottom = (this.keyframe_width > this.keyframe_height ? this.keyframe_height : this.keyframe_width) - left;
                packet.payload = image;
                packet.header.dLen = image.length + 17;
            } catch(e) {
                logger.error(`가로 방향 이미지 변환 실패(${packet.header.dNum}) : ${e}`);
            }
        } else if(packet.header.uCmd == 20004 && this.is_wide) {
            try {
                image = await sharp(packet.payload).rotate(-90).jpeg().toBuffer();

                let left = packet.info.left;
                let top = packet.info.top;
                let right = packet.info.right;
                let bottom = packet.info.bottom;

                packet.info.left = packet.info.top;
                packet.info.top = (this.keyframe_width > this.keyframe_height ? this.keyframe_width : this.keyframe_height) - right;
                packet.info.right = packet.info.bottom;
                packet.info.bottom = (this.keyframe_width > this.keyframe_height ? this.keyframe_width : this.keyframe_height) - left;
                packet.payload = image;
                packet.header.dLen = image.length + 17;
            } catch(e) {
                logger.error(`와이드 단말 이미지 변환 실패(${packet.header.dNum}:20004) : ${e}`);
            }
        } else if(packet.header.uCmd == 20006 && this.is_wide) {
            try {
                image = await sharp(packet.payload).rotate(90).jpeg().toBuffer();

                let left = packet.info.left;
                let top = packet.info.top;
                let right = packet.info.right;
                let bottom = packet.info.bottom;

                packet.info.left = (this.keyframe_width > this.keyframe_height ? this.keyframe_height : this.keyframe_width) - packet.info.bottom;
                packet.info.top = left;
                packet.info.right = (this.keyframe_width > this.keyframe_height ? this.keyframe_height : this.keyframe_width) - top;
                packet.info.bottom = right;
                packet.payload = image;
                packet.header.dLen = image.length + 17;
            } catch(e) {
                logger.error(`와이드 단말 이미지 변환 실패(${packet.header.dNum}:20006) : ${e}`);
            }
        }

        // if(packet.info.keyframe) {
        //     console.log('keyframe(', this.dNum, ')')
        // }

        if(this.onCapture && packet.info.keyframe) {
            let filename = packet.header.dNum.toString().padStart(2, '0') + '_' + moment().format('YYYYMMDD_hhmmss') + '.jpg';
            let filepath = config.VPS_SHARED_DIRECTORY + packet.header.dNum.toString() + '/';
            this.onCapture = false;
            let fullpath = filepath + filename;

            sharp(packet.payload).jpeg().toFile(fullpath, (err, info) => {
                if(err) {
                    logger.error(`이미지 캡쳐 실패(${this.dNum}) : ${err}`);
                } else {
                    process.send({ type: 'file:response', data: { dNum: packet.header.dNum, type: 'jpg', filename: filename }});
                }
            })
        }

        if(this.onAnimateCapture && packet.info.keyframe) {
            this.onAnimateCapture = false;
            this.animate_capture(packet);
        }
        process.send({ type: 'mirroring:data', data: { packet: packet }});
    }

    capture() {
        this.onCapture = true;
    }

    animate() {
        logger.info(`animate : ${this.onAnimate} -> ${!this.onAnimate}`)
        return this.onAnimate = !this.onAnimate;
    }

    animate_event() {
        if(!this.onAnimate) return;

        logger.info('animate event(device)')
        this.onAnimateCapture = true;

        // this.animate_event_queue.push({ type: type, data: data });
    }

    animate_capture(packet) {
        this.emit('animate:capture', packet);
    }

    send(packet) {
        if(!this.onControl) {
            if(packet.header.uCmd == command.TURN_ON) {
                let ret = false;
                this.onControl = true;
                ret = this.control_socket.write(this.serialize(packet));

                try {
                    while(this.send_queue.length > 0) {
                        let reminded_packet = this.send_queue.shift();
                        logger.debug(`잔여 패킷 전송 : ${packet.header.uCmd}`);
                        this.control_socket.write(this.serialize(reminded_packet));
                    }

                    ret = true;
                } catch(e) {
                    ret = false;
                }

                return ret;
            } else {
                this.send_queue.push(packet);
            }
        } else {
            return this.control_socket.write(this.serialize(packet));
        }
    }

    // send(packet) {
    //     console.log(this.control_socket)
    //     return this.control_socket.write(this.serialize(packet)); 
    //     // let ret = false;

    //     // if(typeof(packet) === 'object') {
    //     //     ret =    
    //     // } else {
    //     //     ret = this.control_socket.write(packet);
    //     // }

    //     // return ret;
    // }

    serialize(packet) {
        let send_buffer;
        try {
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
        } catch(e) {
            console.log('device serialize failure : ', e)
        }

        return send_buffer;
    }

    connect_mirroring_socket() {
        let ret = true;

        try {
            this.mirroring_socket.connect(config.VPS_MIRRORING_BASE_PORT + this.dNum, () => {
                logger.info(`미러링 소켓 연결(${this.dNum}) : ${config.VPS_MIRRORING_BASE_PORT + this.dNum}`);
                this.mirroring_socket.write('sendme');
            })
        } catch(e) {
            ret = false;
            logger.error(`미러링 소켓 연결(${this.dNum}) 실패 : ${e}`);
        }

        return ret;
    }

    connect_control_socket() {
        let ret = true;

        try {
            this.control_socket.connect(config.VPS_CONTROL_BASE_PORT + this.dNum, () => {
                logger.info(`컨트롤 소켓(${this.dNum}) 연결 : ${config.VPS_CONTROL_BASE_PORT + this.dNum}`);
                this.set_on(true);
            })
        } catch(e) {
            ret = false;
            logger.error(`컨트롤 소켓(${this.dNum}) 연결 실패 : ${e}`);
        }

        return ret;
    }

    set_orientation(orientation) {
        if(this.is_vertical !== Boolean(orientation)) {
            logger.info(`단말(${this.dNum}) 방향 변경 : ${this.is_vertical ? '세로' : '가로'} -> ${!this.is_vertical ? '세로' : '가로'}`);
            this.is_vertical = !this.is_vertical;
        }
    }

    onControlSocketClose() {
        logger.info(`컨트롤 소켓(${this.dNum}) 종료`);
    }

    onControlSocketError(e) {
        logger.info(`컨트롤 소켓(${this.dNum}) 오류 : ${e}`);
    }

    onControlSocketData(data) {
        logger.info(`컨트롤 소켓(${this.dNum}) 데이터 수신 : ${JSON.stringify(data)}`);
    }

    onMirroringSocketClose() {
        logger.info(`미러링 소켓(${this.dNum}) 종료`);
        if(this.is_service) {
            let packet = utils.VpsPacket.create(2, command.NXPTC_CAPTURE_FAILED, this.dNum, 1);
            packet.payload = Buffer.alloc(2);
            packet.payload.writeUInt16BE(101);

            process.send({ type: 'mirroring:broken', data: { packet: packet }});
        }
    }

    onMirroringSocketError(e) {
        logger.info(`미러링 소켓(${this.dNum}) 오류 : ${e}`);
    }

    onMirroringSocketData(data) {
        this.read(data);
    }

    set_on(flag) {
        let dLen = 1;
        let uCmd = command.TURN_ON;
        let buf = Buffer.alloc(dLen);
        buf.writeUInt8(Number(flag), 0);

        this.make_and_send_packet(dLen, uCmd, buf, (packet) => {
            logger.info(`단말(${this.dNum}) ON/OFF 패킷 전송`);
            this.send(packet);
        });
    }

    set_resolution(dir, width, height) {
        let dLen = 5;
        let uCmd = command.CHANGE_RESOLUTION;
        let buf = Buffer.alloc(dLen);
        buf.writeUInt8(dir, 0);
        buf.writeUInt16BE(width, 1);
        buf.writeUInt16BE(height, 3);

        this.make_and_send_packet(dLen, uCmd, buf, (packet) => {
            logger.info(`단말(${this.dNum}) 해상도 변경 패킷 전송 : ${width} x ${height}`);
            this.send(packet);
        });
    }

    set_ratio(ratio) {
        let dLen = 1;
        let uCmd = command.CHANGE_RATIO;
        let buf = Buffer.alloc(dLen);
        buf.writeUInt16BE(ratio, 0);

        this.make_and_send_packet(dLen, uCmd, buf, (packet) => {
            logger.info(`단말(${this.dNum}) 종횡비 패킷 전송 : ${ratio}`);
            this.send(packet);
        });
    }

    request_keyframe() {
        let dLen = 0;
        let uCmd = command.SEND_KEYFRAME;

        this.make_and_send_packet(dLen, uCmd, null, (packet) => {
            this.send(packet);
        });
    }

    make_and_send_packet(dLen, uCmd, buf, cb) {
        let packet = utils.VpsPacket.create(dLen, uCmd, this.dNum, 1);
        if(buf !== null) {
            packet.payload = buf;
        } else {
            packet.payload = null;
        }

        cb(packet);
    }

    get_receive_frames() {
        let ret = 0;
        ret = this.recv_frames - this.prev_recv_frames;
        this.prev_recv_frames = this.recv_frames;

        return ret;
    }
}

module.exports = Device;