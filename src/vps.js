const cluster = require('cluster');
const fs = require('fs');

const moment = require('moment');

const logger = require(`./Logger.js`).logger;

const config = require(`./json/config.json`);

var vps_session_worker;
var vps_device_worker = Array(10);


function run(win) {
    check_and_make_directorys();

    if(cluster.isMaster) {
        cluster.setupMaster({ exec: `${__dirname}/vps_session_worker.js`});
        vps_session_worker = cluster.fork({ WorkerId: 10});
        vps_session_worker.send({ type: 'vps:start' });
        vps_session_worker.on('message', message => {
            switch(message.type) {
            case 'vps:reset':
                break;
            
            case 'device:start':
            case 'device:stop':
            case 'device:orientation':
            case 'device:quality':
            case 'device:framerate':
            case 'device:keyframe':

            case 'screen:capture':
            case 'screen:animate':
            case 'screen:record':
            case 'screen:touch':
            case 'screen:event':
                try{
                    vps_device_worker[message.data.dNum - 1].send(message);
                } catch(e) {
                    logger.info(`디바이스 워커 전송 실패(${JSON.stringify(message)}) : ${e}`);
                    logger.info(`>> 디바이스 워커 정보 : ${JSON.stringify(vps_device_worker[message.data.dNum - 1])}`);
                }
                // check the device number and send to device worker[i]

                ////////// 디바이스 시작 & 정지 처리 & 화면 캡쳐 ///////////
                parse_message(win, message);
                ////////////////////////////////////////////////////
                break;

            ///////////// 클라이언트 연결 & 해제 처리, 캡쳐 응답, 캡쳐 응답 실패, Send Frame Count ////////////
            case 'client:connect':
            case 'client:disconnect':
            case 'capture:response':
            case 'client:connection_info':
                parse_message(win, message);
                break;
            ////////////////////////////////////////////////
            }
        })

        cluster.setupMaster({ exec: `${__dirname}/vps_device_worker.js`});
        for(let i=0; i<10; i++) {
            let worker = cluster.fork({ WorkerId: i });
            worker.on('message', message => {
                // console.log('device workers : ', vps_device_worker);
                switch(message.type) {
                case 'mirroring:data':
                    try{
                        vps_session_worker.send(message);
                    } catch(e) {
                        logger.error(`세션 워커 전송 오류(미러링 데이터) : ${e}`);
                    }

                    ///////////////////// 미러링 처리 //////////////////////
                    parse_message(win, message);
                    /////////////////////////////////////////////////////
                    break;
                case 'mirroring:uncaught':
                    try {
                        vps_session_worker.send(message);
                    } catch(e) {
                        logger.error(`세션 워커 전송 오류(미러링 데이터) : ${e}`);
                    }
                    break;
                case 'mirroring:broken':
                    try {
                        vps_session_worker.send(message);
                    } catch(e) {
                        logger.error(`세션 워커 전송 오류(미러링 소켓 오류) : ${e}`);
                    }
                    break;
                case 'mirroring:count':
                    try {
                        vps_session_worker.send(message);
                    } catch(e) {
                        logger.error(`세션 워커 전송 오류(미러링 카운터) : ${e}`);
                    }
                    break;

                case 'file:response':
                    try {
                        vps_session_worker.send(message);
                    } catch(e) {
                        logger.error(`세션 워커 전송 오류(파일 결과) : ${e}`);
                    }

                    ///////////// 캡쳐 응답 ////////////
                    parse_message(win, message);
                    ////////////////////////////////////////////////
                    break;

                //////////////// animate 시작 & 정지 ////////////////
                case 'screen:animate_start':
                case 'screen:animate_stop':
                    parse_message(win, message);
                    break;
                ///////////////////////////////////////////////////
                }
            })
            vps_device_worker[i] = worker;
            vps_device_worker[i].send({ type: 'vps:start', data: i });
        }
    }
}

function check_and_make_directorys() {
    let path = `${__dirname}/../images/` + config.VPS_MAX_DEVICES.toString();
    // console.log('path : ', path)
    // console.log('exist : ', fs.existsSync(path))
    if(fs.existsSync(path)) {

    } else {
        fs.mkdirSync(`${__dirname}/../images/`);
        for(let i = 0; i < config.VPS_MAX_DEVICES; i++) {
            fs.mkdirSync(`${__dirname}/../images/` + (i + 1).toString());
        }
    }
}

process.on('SIGINT', () => {
    try {
        vps_session_worker.send({ type: 'vps:stop' });
        for(let i=0; i<10; i++) {
            vps_device_worker[i].send({ type: 'vps:stop' });
        }
    } catch(e) {
        
    }
})

function parse_message(win, message) {
    switch(message.type) {
        case 'vps:start':
            start_vps(win, message.data);
            break;
        case 'mirroring:data':
            mirroring(win, message.data);
            break;
        case 'device:start':
            device_start(win, message.data);
            break;
        case 'device:stop':
            device_stop(win, message.data);
            break;
        case 'device:orientation': 
            device_rotation(win, message.data);
            break;
        case 'client:connect':
            client_connect(win, message.data);
            break;
        case 'client:disconnect':
            client_disconnect(win, message.data);
            break;
        case 'screen:capture':
            device_capture_request(win, message.data);
            break;
        case 'screen:animate_start':
            device_animate_request(win, message.data);
            break;
        case 'screen:animate_stop':
            device_animate_stop(win, message.data);
            break;
        case 'file:response':
            device_capture(win, message.data);
            break;
        case 'client:connection_info':
            client_update_connection_info(win, message.data);
            break;
    }
}

function formatDate(date) {
    return moment(date).format('YYYY/MM/DD, HH:mm:ss:SSS');
}

function start_vps(win, param) {
    let text = formatDate( new Date() ) + ` : [0:VPS] UI 초기화 완료`;
    win.webContents.send('logData', text);
}

function device_start(win, param) {
    win.webContents.send('device_connect', { dNum: param.dNum, width: param.width, height: param.height });
    
    let text = formatDate( new Date() ) + ` : [${param.dNum}:VPS] Start Command 명령 받음 : LCD Width=${param.width}, Height=${param.height}`;
    win.webContents.send('logData', text);
}

function device_stop(win, param) {
    win.webContents.send('device_disconnect', param.dNum);

    let text = formatDate( new Date() ) + ` : [${param.dNum}:VPS] Stop Command 명령 받음 : 채널 서비스 종료 처리 수행`;
    win.webContents.send('logData', text);
}

function device_rotation(win, param) {
    let text = formatDate( new Date() ) + ' : ';
    if(param.orientation == 1) {
        text += `[${param.dNum}:VPS] 영상 세로 모드 출력`;
    } else {
        text += `[${param.dNum}:VPS] 영상 가로 모드 출력`;
    }
    win.webContents.send('logData', text);
}

function device_capture_request(win, param) {
    let text = formatDate( new Date() ) + ` : [${param.dNum}:VPS] 단말기 화면 캡쳐 명령 받음`;
    win.webContents.send('logData', text);
}

function device_animate_request(win, param) {
    let text = formatDate( new Date() ) + ` : [${param.dNum}:VPS] 단말기 화면 녹화 시작 명령 받음`;
    win.webContents.send('logData', text);
}

function device_animate_stop(win, param) {
    let text = formatDate( new Date() ) + ` : [${param.dNum}:VPS] 단말기 화면 녹화 정지 명령 받음`;
    win.webContents.send('logData', text);
}

function device_capture(win, param) {
    let text;

    if(param.type == 'jpg') {
        text = formatDate( new Date() ) + ` : [${param.dNum}:VPS] 단말기 화면 캡쳐 응답 보냄 : 성공(${param.filename})`;
    } else {
        text = formatDate( new Date() ) + ` : [${param.dNum}:VPS] 단말기 화면 녹화 응답 보냄 : 성공(${param.filename})`;
    }
    
    win.webContents.send('logData', text);
}

function client_connect(win, param) {
    let text = formatDate( new Date() ) + ' : ';

    if(param.type == 0b1000) {
        console.log(`Device Controller is connected.`);

        text += `[0:VPS] Device Controller is connected`;
    } else if(param.type == 0b0100) {
        console.log(`Monitor is connected.`);
        
        text += `[${param.dNum}:VPS] Monitor is connected`;
    } else if(param.type == 0b0010) {
        console.log(`Guest is connected.`);
        
        text += `[${param.dNum}:VPS] Guest is connected`;
    } else {
        console.log(`Host is connected.`);
        
        text += `[${param.dNum}:VPS] Host is connected`;       
    }

    win.webContents.send('logData', text);
}

function client_disconnect(win, param) {
    let text = formatDate( new Date() ) + ' : ';

    if(param.type == 0b1000) {
        console.log(`Device Controller is disconnected.`);

        text += `[${param.dNum}:VPS] Device Controller is disconnected`;
    } else if(param.type == 0b0100) {
        console.log(`Monitor is disconnected.`);

        text += `[${param.dNum}:VPS] Monitor is disconnected`;
    } else if(param.type == 0b0010) {
        console.log(`Guest is disconnected.`);

        text += `[${param.dNum}:VPS] Guest is disconnected`;
    } else {
        console.log(`Host is disconnected.`);

        text += `[${param.dNum}:VPS] Host is disconnected`;
    }

    win.webContents.send('logData', text);
}

function client_update_connection_info(win, param) {
    win.webContents.send('updateConnectInfo', { dNum: param.dNum, connect_time: param.connect_time, frames: param.frames });
}

function mirroring(win, packet) {
    packet = packet.packet;
    var keyframe = packet.info.keyframe;
    
    if(keyframe) {
        var dNum = packet.header.dNum;
        var width = packet.info.right - packet.info.left;
        var height = packet.info.bottom - packet.info.top;
        var data = packet.payload;

        win.webContents.send('mirrorData', { dNum: dNum, width: width, height: height, data: data });
    }
}

module.exports = {
    run
}