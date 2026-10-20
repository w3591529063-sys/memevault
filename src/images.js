import crypto from 'node:crypto';
import { badRequest } from './errors.js';

export const MAX_DIMENSION = 20000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 4 >= buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 >= buffer.length) break;
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  if (chunk === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return null;
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1
    };
  }
  return null;
}

/**
 * Detect a supported image purely from its bytes. The declared MIME type or
 * file extension is never trusted. SVG is deliberately unsupported because it
 * can execute script when served inline.
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) return null;
    return { mime: 'image/png', ext: 'png', width, height };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const size = jpegDimensions(buffer);
    if (!size || !size.width || !size.height) return null;
    return { mime: 'image/jpeg', ext: 'jpg', width: size.width, height: size.height };
  }

  const header = buffer.toString('ascii', 0, 6);
  if (header === 'GIF87a' || header === 'GIF89a') {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    if (!width || !height) return null;
    return { mime: 'image/gif', ext: 'gif', width, height };
  }

  if (
    buffer.length >= 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const size = webpDimensions(buffer);
    if (!size || !size.width || !size.height) return null;
    return { mime: 'image/webp', ext: 'webp', width: size.width, height: size.height };
  }

  return null;
}

export function assertSaneDimensions(size) {
  if (!size || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
    throw badRequest('image_dimensions', '图片尺寸不正确或超过 20000 像素');
  }
}

const DATA_URL_PATTERN = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i;

export function decodeDataUrl(value, maxBytes) {
  if (typeof value !== 'string' || value.length > maxBytes * 1.5 + 4096) {
    throw badRequest('invalid_file', '图片数据过大或格式不正确');
  }
  const match = DATA_URL_PATTERN.exec(value.trim());
  if (!match) {
    throw badRequest('invalid_file', '只支持 base64 图片数据');
  }
  const base64 = match[2].replace(/\s+/g, '');
  if (!base64) throw badRequest('invalid_file', '图片内容为空');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw badRequest('invalid_file', '图片内容为空');
  if (buffer.length > maxBytes) {
    throw badRequest('file_too_large', `单张图片不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
  return { buffer, declaredMime: match[1].toLowerCase() };
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}
