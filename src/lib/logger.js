import { randomUUID } from 'crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export const httpLogger = pinoHttp({
  logger,
  genReqId(req) {
    return req.headers['x-request-id'] ?? randomUUID();
  },
  autoLogging: {
    ignore(req) {
      return req.url === '/health';
    },
  },
  redact: {
    paths: ['req.headers.authorization'],
    censor: '[REDACTED]',
  },
});
