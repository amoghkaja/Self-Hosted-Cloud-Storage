import { ErrorCode, type ProblemDetails } from '@familycloud/shared/all';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
  507: 'Insufficient Storage',
};

export function sendProblem(
  reply: FastifyReply,
  status: number,
  code: ProblemDetails['code'],
  detail: string,
  extra: Partial<ProblemDetails> = {},
) {
  const body: ProblemDetails = {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    code,
    detail,
    ...extra,
  };
  return reply
    .status(status)
    .type('application/problem+json')
    .serializer(JSON.stringify)
    .send(body);
}

/** Every error leaves as RFC 9457 problem+json. Internal details never reach the client. */
export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      if (err.status >= 500) req.log.error({ err }, err.message);
      return sendProblem(reply, err.status, err.code, err.message);
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({
        path: String(v.instancePath ?? '')
          .replace(/^\//, '')
          .replace(/\//g, '.'),
        message: v.message ?? 'Invalid value',
      }));
      return sendProblem(
        reply,
        400,
        ErrorCode.VALIDATION,
        issues[0]?.message ?? 'Invalid request',
        {
          issues,
        },
      );
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause?.issues }, 'response failed schema validation');
      return sendProblem(reply, 500, ErrorCode.INTERNAL, 'Something went wrong');
    }
    // Text Postgres can't store (a NUL, in text or JSON) can only have come from the request.
    // Drizzle wraps the driver's error; a query run on postgres-js directly throws it as is.
    const pgCode = (err as { cause?: { code?: unknown } }).cause?.code ?? err.code;
    if (pgCode === '22021' || pgCode === '22P05') {
      return sendProblem(reply, 400, ErrorCode.VALIDATION, 'Text cannot contain a NUL character');
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return sendProblem(reply, 429, ErrorCode.RATE_LIMITED, err.message || 'Too many requests');
    }
    if (status < 500) {
      return sendProblem(reply, status, ErrorCode.VALIDATION, err.message || 'Invalid request');
    }
    req.log.error({ err }, 'unhandled error');
    return sendProblem(reply, 500, ErrorCode.INTERNAL, 'Something went wrong');
  });
}
