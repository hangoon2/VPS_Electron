const fs = require('fs');

const sharp = require('sharp');
const GifEncoder = require('gifencoder');
const PngFileStream = require('png-file-stream');
const moment = require('moment');

const Device = require('./Device.js');
const utils = require('./Utils.js');
const logger = require('./Logger.js').logger;

const config = require('./json/config.json');
const { resolve } = require('path');

var vps_device = undefined;

var animate_event_queue = [];

process.on('message', message => {
    switch(message.type) {
    case 'vps:start':
        start_device_worker();
        break;
    case 'vps:stop':
        stop_device_worker();
        break;
    case 'vps:reset':
        reset_device_worker();
        break;

    case 'device:start':
        start_device(message.data, request_keyframe);
        break;
    case 'device:stop':
        stop_device(message.data);
        break;
    case 'device:orientation':
        set_device_orientation(message.data, request_keyframe);
        break;
    case 'device:quality':
        set_device_quality(message.data, request_keyframe);
        break;
    case 'device:framerate':
        set_device_framerate(message.data, request_keyframe);
        break;
    case 'device:keyframe':
        break;

    case 'screen:capture':
        screen_capture(request_keyframe);
        break;
    case 'screen:animate':
        screen_animate();
        break;
    case 'screen:event':
        animate_event(message.data, request_keyframe);
        break;
    case 'screen:record':
        break;
    case 'screen:touch':
        break;
    }
})

// var frame_counter = setInterval(() => {
//     let has_changed_status = false;
//     let currunt_receive;
    
//     if(vps_device !== undefined) {
//         currunt_receive = vps_device.get_receive_frames() > 1 ? 1 : 2;
//     }

//     if(receive_status !== currunt_receive) {
//         let packet = utils.VpsPacket.create()
//     }
// }, 20000);

function start_device_worker() {

}

function stop_device_worker() {

}

function reset_device_worker() {

}

function onEventListener() {
    vps_device.on('animate:capture', packet => {
        console.log('animate capture')
        let animate_event_info = animate_event_queue.shift();

        make_event_screen(packet, animate_event_info);
    })
}

function start_device(param, cb) {
    try {
        vps_device = new Device({ dNum: param.dNum, width: param.width, height: param.height});
        onEventListener();
        vps_device.start();
        logger.info(`단말 연결(${param.dNum}) : ${param.width} x ${param.height}`);

        cb();
    } catch(e) {
        console.error(`단말 연결 오류(${param.dNum}) : ${e}`);
    }
}

function stop_device(param) {
    logger.info(`단말 연결 종료(${param.dNum})`);

    if(vps_device !== undefined) {
        vps_device.stop();
        vps_device = undefined;
    }
}

function set_device_orientation(param, cb) {
    logger.info(`단말 방향 설정(${param.dNum}) : ${param.orientation}`);
    
    if(vps_device !== undefined) {
        vps_device.set_orientation(param.orientation);

        cb();
    } else {
        logger.error(`단말 방향 설정(${param.dNum}) : 단말 연결되지 않음`);
    }
}

function set_device_quality(param, cb) {
    logger.info(`단말 품질 설정(${param.dNum}) : ${JSON.stringify(param.packet)}`);

    if(vps_device !== undefined) {
        vps_device.send(param.packet);

        cb();
    } else {
        logger.error(`단말 품질 설정(${param.dNum}) : 단말 연결되지 않음`);
    }
}

function set_device_framerate(param, cb) {
    logger.info(`단말 프레임레이트 설정(${param.dNum}) : ${JSON.stringify(param.packet)}`);

    if(vps_device !== undefined){
        vps_device.send(param.packet);

        cb();
    }
    else {
        logger.error(`단말 프레임레이트 설정(${param.dNum}) : 단말 연결되지 않음`);
    }
}

function request_keyframe() {
    vps_device.request_keyframe();
}

function screen_capture(cb) {
    vps_device.capture();

    cb();
}

function screen_animate() {
    if(!vps_device.animate()) {
        gif_encode();

        process.send({ type: 'screen:animate_stop', data: { dNum: vps_device.dNum }});
    } else {
        process.send({ type: 'screen:animate_start', data: { dNum: vps_device.dNum }});
    }
}

function animate_event(param, cb) {
    vps_device.animate_event();

    animate_event_queue.push({ type: param.type, data: param.data });

    cb();
}

function make_event_screen(packet, animate_event_info) {
    console.log('make event screen')
    switch(animate_event_info.type) {
    case 1:        // click
        let left = Math.floor(animate_event_info.data.now_x * vps_device.keyframe_width / vps_device.width) - 36 > 0 ? Math.floor(animate_event_info.data.now_x * vps_device.keyframe_width / vps_device.width) - 36 : 0;
        let top = Math.floor(animate_event_info.data.now_y * vps_device.keyframe_height / vps_device.height) - 36 > 0 ? Math.floor(animate_event_info.data.now_y * vps_device.keyframe_height / vps_device.height) - 36 : 0;
        let longer = vps_device.keyframe_width > vps_device.keyframe_height ? vps_device.keyframe_width : vps_device.keyframe_height;
        let filepath = `${__dirname}/../images/` + packet.header.dNum.toString() + '/';
        let filename = packet.header.dNum.toString().padStart(2, '0') + '_' + moment().format('YYMMDD-HHmmss') + '.png';

        let opt = {
            left: left,
            top: top,
            input: `${__dirname}/../resources/Click.png`,
            blend: 'over'
        }

        let image;
        if(packet.payload.data) {
            image = Buffer.from(packet.payload.data);
        } else {
            image = packet.payload;
        }

        sharp(image).composite([opt]).png().toBuffer((e, buf, info) => {
            if(e) {
                logger.error(`애니메이트 캡쳐 실패(${packet.header.dNum}:CLICK) : ${e}`);
            } else {
                let opt = {
                    left: Math.floor(info.width > info.height ? 0 : (longer - info.width) / 2),
                    top: Math.floor(info.width < info.height ? 0 : (longer - info.height) / 2),
                    input: buf
                }

                sharp({ create: { width: longer, height: longer, channels: 3, background: { r: 0, g: 0, b: 0 }}}).composite([opt]).png().toFile(filepath + filename, (e, info) => {
                    if(e) {
                        logger.error(`애니메이트 캡쳐 실패(${packet.header.dNum}:CLICK_COMPOSITE_BACKGROUND) : ${e}`);
                        logger.error(`경로 : ${filepath}, 이름 : ${filename}`);
                    } else {
                        logger.debug(`애니메이트 캡쳐(${packet.header.dNum}:CLICK)`);
                    }
                })
            }
        })
        break;
    case 2:        // move
        let atx = animate_event_info.data.now_x - animate_event_info.data.prev_x
        let aty = animate_event_info.data.now_y - animate_event_info.data.prev_y
        let at2 = Math.atan2(aty, atx) * 180 / Math.PI

        logger.debug(`make image : ${atx}, ${aty} - ${at2}`)
        let angle = Math.round(Math.atan2(aty, atx) * 180 / Math.PI);
        sharp(`${__dirname}/../resources/Cursor.png`).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 }}).png().toBuffer((e, buf, info) => {
            if(e) {
                logger.error(`애니메이트 캡쳐 실패(${packet.header.dNum}:CURSOR_ROTATE) : ${e}`);
            } else {
                let left = Math.floor(animate_event_info.data.prev_x * vps_device.keyframe_width / vps_device.width) - Math.floor(info.width / 2) > 0 ? Math.floor(animate_event_info.data.prev_x * vps_device.keyframe_width / vps_device.width) - Math.floor(info.width / 2) : 0;
                let top = Math.floor(animate_event_info.data.prev_y * vps_device.keyframe_height / vps_device.height) - Math.floor(info.height / 2) > 0 ? Math.floor(animate_event_info.data.prev_y * vps_device.keyframe_height / vps_device.height) - Math.floor(info.height / 2) : 0;
                let longer = vps_device.keyframe_width > vps_device.keyframe_height ? vps_device.keyframe_width : vps_device.keyframe_height;
                let filepath = `${__dirname}/../images/` + packet.header.dNum.toString() + '/';
                let filename = packet.header.dNum.toString().padStart(2, '0') + '_' + moment().format('YYMMDD-HHmmss') + '.png';

                let opt = {
                    left: left,
                    top: top,
                    input: buf,
                    blend: 'over'
                }

                let image;
                if(packet.payload.data) {
                    image = Buffer.from(packet.payload.data);
                } else {
                    image = packet.payload;
                }

                sharp(image).composite([opt]).png().toBuffer((e, buf, info) => {
                    if(e) {
                        logger.error(`애니메이트 캡쳐 실패(${packet.header.dNum}:CURSOR) : ${e}`);
                    } else {
                        let opt = {
                            left: Math.floor(info.width > info.height ? 0 : (longer - info.width) / 2),
                            top: Math.floor(info.width < info.height ? 0 : (longer - info.height) / 2),
                            input: buf
                        }

                        sharp({ create: { width: longer, height: longer, channels: 3, background: { r: 0, g: 0, b: 0 }}}).composite([opt]).png().toFile(filepath + filename, (e, info) => {
                            if(e) {
                                logger.error(`애니메이트 캡쳐 실패(${packet.header.dNum}:CURSOR_COMPOSITE_BACKGROUND) : ${e}`);
                                logger.error(`경로 : ${filepath}, 이름 : ${filename}`);
                            } else {
                                logger.debug(`애니메이트 캡쳐(${packet.header.dNum}:CURSOR)`);
                            }
                        })
                    }
                })
            }
        })
        break;
    }
}

function gif_encode() {
    let dNum = vps_device.dNum;
    let longer = vps_device.keyframe_width > vps_device.keyframe_height ? vps_device.keyframe_width : vps_device.keyframe_height;
    const encoder = new GifEncoder(longer, longer);
    let filepath = config.VPS_SHARED_DIRECTORY + dNum.toString() + '/';
    let filename = dNum.toString().padStart(2, '0') + moment().format('YYYYMMDD_HHmmssSSS') + '.gif';
    let src_path = `${__dirname}/../images/` + dNum.toString() + '/';
    let target = dNum.toString().padStart(2, '0') + '_******-******.png'
    let t = src_path + target;
    const stream = PngFileStream(t)
                    .pipe(encoder.createWriteStream({ repeat: -1, delay: 1000, quality: 10 }))
                    .pipe(fs.createWriteStream(filepath + filename));

    stream.on('finish', () => {
        logger.debug(`GIF 파일 저장(${vps_device.dNum}) : ${filepath} - ${filename}`);

        process.send({ type: 'file:response', data: { dNum: vps_device.dNum, type: 'gif', filename: filename }});

        setTimeout(() => {
            if(vps_device != undefined)
                remove_image_data(vps_device.dNum);
        }, 10000);
    });
}

function remove_image_data(dNum) {
    let files = fs.readdirSync(`${__dirname}/../images/` + dNum.toString())
    files.forEach(file => {
        fs.unlink(`${__dirname}/../images/` + dNum.toString() + '/' + file, (err) => {
            logger.debug(`애니메이트 캡쳐 이미지 삭제(${dNum}) : ./images/${dNum.toString()}/${file}`);
        })
    })
}