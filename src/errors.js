export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code, message, details) {
  return new HttpError(400, code, message, details);
}

export function notFound(code = 'not_found', message = '没有找到这个资源') {
  return new HttpError(404, code, message);
}

export function forbidden(code = 'forbidden', message = '没有权限执行这个操作') {
  return new HttpError(403, code, message);
}

export function tooLarge(message = '内容太大了') {
  return new HttpError(413, 'payload_too_large', message);
}

export function tooMany(message = '操作太频繁了，歇一会儿再试') {
  return new HttpError(429, 'rate_limited', message);
}
