/**
 * src/config/logger.js
 * =============================================================================
 * Logger terpusat pakai Winston + daily rotate file.
 * - Console: berwarna & ringkas (dev).
 * - File: logs/app-YYYY-MM-DD.log (semua level) & logs/error-YYYY-MM-DD.log (error saja),
 *   format JSON, auto-rotate harian, simpan 14 hari.
 *
 * Pemakaian:
 *   const logger = require('./config/logger');
 *   logger.info('pesan', { meta });
 *   logger.error('gagal', { err });
 *
 * Level diatur lewat env LOG_LEVEL (default: 'info', atau 'debug' saat development).
 * =============================================================================
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

// Pastikan folder logs ada
fs.mkdirSync(LOG_DIR, { recursive: true });

// Waktu Asia/Jakarta untuk timestamp log
const timeFormat = winston.format.timestamp({
  format: () =>
    new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(' ', 'T'),
});

// Format untuk file (JSON, lengkap dengan stack error)
const fileFormat = winston.format.combine(
  timeFormat,
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Format untuk console (ringkas & berwarna)
const consoleFormat = winston.format.combine(
  timeFormat,
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${stack || message}${metaStr}`;
  })
);

const transports = [
  new winston.transports.Console({ format: consoleFormat }),

  // Semua log harian
  new winston.transports.DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: process.env.LOG_MAX_DAYS || '14d',
    format: fileFormat,
  }),

  // Khusus error
  new winston.transports.DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxFiles: process.env.LOG_MAX_DAYS || '14d',
    format: fileFormat,
  }),
];

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  defaultMeta: { service: 'zlaundry' },
  transports,
  exitOnError: false,
});

// Stream untuk morgan (request logger) -> diteruskan ke winston level http/info
logger.stream = {
  write: (message) => logger.info(message.trim()),
};

module.exports = logger;
