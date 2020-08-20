const net = require('net');
const fs = require('fs');

const Session = require('./Session.js');
const utils = require('./Utils.js');
const logger = require('./Logger.js').logger;

const config = require('./json/config.json');
const command = require('./json/command.json');

var server;

var vps_sessions = Array(10).fill().map(() => new Set());
var vps_controller = undefined;

process.on('message', message => {
    switch(message.type) {
    case 'vps:start':
        start_session_worker();
        break;
    case 'vps:stop':
        stop_session_worker();
        break;
    case 'vps:reset':
        reset_session_worker();
        break;

    case 'mirroring:data':
        if(vps_sessions[message.data.packet.header.dNum - 1].size > 0) {
            mirroring(message.data);
        }
        break;
    case 'mirroring:uncaught':
        mirroring(message.data);
        break;
    case 'mirroring:broken':
        notify_broken_mirroring_socket(message.data);
        break;
    // case 'mirroring:count':
    //     break;

    case 'file:response':
        make_and_send_file_response(message.data);
        break;
    }
})

function onTimer() {
    // setInterval(() => {
    //     fs.readdir(config.VPS_SHARED_DIRECTORY, dirs => {
    //         dirs.forEach(dir => {
    //             if(dir !== '.DS_Store') {
    //                 let target = config.VPS_SHARED_DIRECTORY + dir + '/';
    //                 fs.readdir(target, files => {
    //                     files.forEach(file => {
    //                         if(file !== '.DS_Store') {
    //                             let dd = file.split('_')[1] + file.split('_')[2].split('.')[0]
    //                             let old = moment(dd, 'YYMMDD_HHmmss');
    //                             let now = moment();

    //                             if(moment.duration(now.diff(old)).asHours() > 24) {
    //                                 fs.unlink
    //                             }
    //                         }
    //                     })
    //                 })
    //             }
    //         })
    //     })
    // }, 3600000);
}

function start_session_worker() {
    onTimer();

    server = net.createServer( socket => {
        socket.setNoDelay(true);
        
        let session = new Session(socket);
        session.start();
        onEventListener(session);
    }).listen(10001, () => {
        logger.info(`VPS 서버 구동(${config.VPS_MAIN_PORT})`);
    })
}

function onEventListener(session) {
    session.on('connect', (dNum) => {
        if(session.type & 0b1000) { // mobile controller
            if(vps_controller == undefined) {
                vps_controller = session;
                
                
            } else {
                logger.info(`디바이스 컨트롤러 접속중`);
            }
        } else {
            // check duplicated connection
            check_duplicated_connection(dNum, session, (ss) => {
                ss.emit('disconnect', { dNum: dNum });
                ss.stop();
                vps_sessions[dNum - 1].delete(ss);
            });

            if(session.type & 0b0010) { // guest
                if(check_exist_host_connection(dNum)) {
                    logger.info(`세션(${session.id}) 접속 : 게스트(${session.socket.remoteAddress}:${session.socket.remotePort})`);
                    vps_sessions[dNum - 1].add(session);
                } else {
                    guest_disconnection(dNum, session.id, send_to_controller);
                }
            } else { // host, monitor
                logger.info(`세션(${session.id}) 접속 : 호스트(${session.socket.remoteAddress}:${session.socket.remotePort})`);
                vps_sessions[dNum - 1].add(session);
            }
        }

        ////////////////////////////////// 클라이언트 연결 처리 //////////////////////////////////////
        process.send({ type: 'client:connect', data: {dNum: session.dNum, type: session.type} });
        /////////////////////////////////////////////////////////////////////////////////////////
    })
    session.on('update:time', param => {
        update_guest_time(param);
    })
    session.on('disconnect', param => {
        if(session.type & 0b0010) {
            update_guest_status(param.dNum, 0b0001, send_to_session);
        } 

        session.stop();
        vps_sessions[param.dNum - 1].delete(session);
    })
    session.on('disconnect:guest', param => {
        for(let ss of vps_sessions[param.dNum - 1]) {
            if(ss.type & 0b0010 && ss.id == param.disconn_id) {
                if(ss.send(param.packet)) {
                    ss.stop();
                    vps_sessions[param.dNum - 1].delete(ss);

                    update_guest_status(param.dNum, 0b0001, send_to_session);
                } else {
                    logger.info(`게스트 접속 해제 실패(${ss.id})`);
                    ss.stop();
                    vps_sessions[param.dNum - 1].delete(ss);

                    update_guest_status(param.dNum, 0b0001, send_to_session);
                }
                break;
            }
        }
    })
    session.on('send:controller', packet => {
        if(vps_controller.send(packet)) {
            if(packet.header.uCmd !== 32100)
                logger.info(`디바이스 컨트롤러 패킷 전송(${session.id}) : ${packet.header.uCmd} [${packet.header.dNum}]`);
        } else {
            if(packet.header.uCmd !== 32100)
                logger.error(`디바이스 컨트롤러 패킷 전송(${session.id}) 실패 : ${packet.header.uCmd} [${packet.header.dNum}]`);
        }
        vps_controller.send(packet);
    })
    session.on('send:session', packet => {
        for(let ss of vps_sessions[packet.header.dNum - 1]) {
            if(ss.send(packet)) {
                logger.info(`세션(${ss.id}) 패킷 전송 : ${packet.header.uCmd} [${packet.header.dNum}]`);
            } else {
                logger.info(`세션(${ss.id}) 패킷 전송 실패 : ${packet.header.uCmd} [${packet.header.dNum}]`);
            }
        }
    })

    session.on('client:disconnect', param => {
        ////////////////////////////////////// 클라이언트 연결 해제 처리 /////////////////////////////////////
        process.send({ type: 'client:disconnect', data: {dNum: session.dNum, type: session.type} });
        ///////////////////////////////////////////////////////////////////////////////////////////////
    })
}

function stop_session_worker() {
    if(server !== undefined) {
        server.close();
        logger.info(`VPS 서버 중지`)
    }
}

function send_to_controller(packet) {
    vps_controller.send(packet);
}

function send_to_session(dNum, target_type, packet) {
    vps_sessions[dNum - 1].forEach(ss => {
        if(target_type & ss.type) {
            ss.send(packet);
        }
    })
}

function check_duplicated_connection(dNum, session, cb) {
    for(let ss of vps_sessions[dNum - 1]) {
        if(session.id == ss.id && session.type == ss.type/* && session.socket.remoteAddress == ss.socket.remoteAddress && session.socket.remotePort == ss.remotePort*/) {
            logger.info(`중복 접속(${session.id}:${dNum})`);
            cb(ss);
        }
    }
}

function check_exist_host_connection(dNum) {
    for(let ss of vps_sessions[dNum - 1]) {
        if(ss.type & 0b0001) {
            logger.info(`호스트 접속 확인(${ss.id}:${dNum})`);
            return true;
        }
    }

    logger.info(`호스트 없음(${dNum})`);
    return false;
}

function update_guest_status(dNum, target_type, cb) {
    logger.info(`게스트 상태 갱신(${dNum}) : ${target_type}`);

    let dLen = 0;
    let uCmd = command.UPDATE_GUEST_STATUS;

    let packet = utils.VpsPacket.create(dLen, uCmd, dNum, 1);

    cb(dNum, target_type, packet);
}

function update_guest_time(param, target_type, cb) {
    logger.info(`게스트 시간 갱신(${param.dNum}) : ${target_type}`);

    cb(param.dNum, target_type, param.packet);
}

function guest_disconnection(dNum, id, cb) {
    logger.info(`게스트 접속 종료(${id}:${dNum})`);

    let dLen = 0;
    let uCmd = command.CONNECTION_DISCONNECT_GUEST;

    let packet = utils.VpsPacket.create(dLen, uCmd, dNum, 1);

    cb(packet);
}

function mirroring(data) {
    vps_sessions[data.packet.header.dNum - 1].forEach(ss => {
        ss.send_mirroring(data.packet);
    })
}

function mirroring_exception() {

}

function notify_broken_mirroring_socket(param) {
    logger.info(`미러링 소켓 깨짐 통보(${param.packet.header.dNum})`);

    vps_controller.send(param.packet);
}

function make_and_send_file_response(param) {
    let packet = utils.VpsPacket.create(param.filename.length, command.FILE, param.dNum, 1);
    packet.payload = Buffer.from(param.filename);

    logger.info(`파일 결과(${param.dNum}) : ${param.filename}`);

    vps_controller.send(packet);
}