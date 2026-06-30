import pino from 'pino';
import { config } from './config.js';

const isDev = config.env !== 'production';

export const logger = pino({
  level: config.logLevel,
  // Pretty, human-friendly logs in dev; structured JSON in production.
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});
