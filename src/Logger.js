const winston = require('winston');
const winstonDaily = require('winston-daily-rotate-file');
const { combine, timestamp, printf, colorize } = winston.format;

const customFormat = printf(info => {
    return `${info.timestamp} [${info.level}]: ${info.message}`;
});

const logger = winston.createLogger({
    level: 'debug',
    format: combine(
        timestamp({
            format: 'YYYY-MM-DD HH:mm:ss',
        }),
        colorize(),
        customFormat,
    ),
    transports: [
        new winston.transports.Console(),

        new winstonDaily({
            level: 'debug',
            datePattern: 'YYYYMMDD',
            dirname: `${__dirname}/../logs`,
            filename: `vps-%DATE%.log`,
            maxSize: null,
            maxFiles: 14,
            colorize: true
        }),
    ],
});

const stream = {
    write: message => {
      logger.debug(message)
    }
}

module.exports = {
    logger
}