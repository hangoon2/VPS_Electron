const VPS_CONNECTION_TYPE = {
    UNKNOWN: 0,
    HOST: 1,
    GUEST: 2,
    MONITOR: 4,
    CONTROL: 8
}

const VPS_DEVICE_ORIENTATION = {
    LANDSCAPE: 0,
    PORTRAIT: 1
}

const VPS_TOUCH_TYPE = {
    CLICK: 1,
    MOVE: 2
}

const VPS_DEFAULT_QUALITY = 70;

const VPS_DEFAULT_FRAMERATE = 20;

const VpsPacket = {
    create: (dLen, uCmd, dNum, chkSum) => {
        return {
            header: {
                dLen: dLen,
                uCmd: uCmd,
                dNum: dNum,
                chkSum: chkSum
            },
            payload: null
        }
    }
}

const VpsImagePacket = {
    create: (dLen, uCmd, dNum, chkSum) => {
        return {
            header: {
                dLen:   dLen,
                uCmd:   uCmd,
                dNum:   dNum,
                chkSum: chkSum
            },
            info: {
                timestamp:  undefined,
                left:       undefined,
                top:        undefined,
                right:      undefined,
                bottom:     undefined,
                keyframe:   undefined
            },
            payload: null
        }
    }
}

module.exports = {
    VPS_CONNECTION_TYPE,
    VPS_DEVICE_ORIENTATION,
    VPS_TOUCH_TYPE,
    VPS_DEFAULT_QUALITY,
    VPS_DEFAULT_FRAMERATE,
    VpsPacket,
    VpsImagePacket
}
