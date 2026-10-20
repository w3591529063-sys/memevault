import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { HttpError, badRequest, notFound, tooLarge, tooMany } from './errors.js';
import { safeEqual } from './images.js';
import { MemeStore } from './store.js';
import { cleanText, normalizeTags, normalizeVisitor } from './text.js';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "media-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join('; ')
};

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function sendJson(req, res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
}

function sendBuffer(req, res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', body.length);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
}

async function readJson(req, limit) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', '请求必须使用 application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw tooLarge(`请求内容超过 ${Math.round(limit / 1024 / 1024)} MB 限制`);
    }
    chunks.push(chunk);
  }
  if (!size) throw badRequest('empty_body', '请求内容是空的');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw badRequest('invalid_json', '请求内容不是合法的 JSON 对象');
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function createLimiter({ windowMs, max }) {
  const buckets = new Map();
  let lastSweep = Date.now();
  return function take(key) {
    const now = Date.now();
    if (now - lastSweep > windowMs * 2) {
      for (const [bucketKey, bucket] of buckets) {
        if (now - bucket.start > windowMs) buckets.delete(bucketKey);
      }
      lastSweep = now;
    }
    const current = buckets.get(key);
    if (!current || now - current.start > windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return true;
    }
    if (current.count >= max) return false;
    current.count += 1;
    return true;
  };
}

function parseMemeRoute(pathname) {
  const detail = /^\/api\/memes\/([0-9a-fA-F-]{36})$/.exec(pathname);
  if (detail) return { id: detail[1].toLowerCase(), action: 'detail' };
  const sub = /^\/api\/memes\/([0-9a-fA-F-]{36})\/(comments|rating)$/.exec(pathname);
  if (sub) return { id: sub[1].toLowerCase(), action: sub[2] };
  return null;
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    type: 'application/zip',
    disposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  };
}

export function createApp(options = {}) {
  const config = loadConfig(options);
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const db = openDatabase({ dbPath: config.dbPath });
  const store = new MemeStore({
    db,
    uploadsDir: config.uploadsDir,
    adminToken: config.adminToken,
    maxUploadBytes: config.maxUploadBytes,
    maxExportBytes: config.maxExportBytes
  });

  const limiters = {
    upload: createLimiter({ windowMs: 60_000, max: 30 }),
    import: createLimiter({ windowMs: 60_000, max: 60 }),
    comment: createLimiter({ windowMs: 60_000, max: 20 }),
    rating: createLimiter({ windowMs: 60_000, max: 60 }),
    export: createLimiter({ windowMs: 60_000, max: 10 })
  };

  function enforceLimit(req, name) {
    if (!config.rateLimit) return;
    if (!limiters[name](clientIp(req, config.trustProxy))) {
      throw tooMany();
    }
  }

  async function handleApi(req, res, pathname, url) {
    if (pathname === '/api/config' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(req, res, 200, {
        maxUploadBytes: config.maxUploadBytes,
        maxBodyBytes: config.maxBodyBytes,
        maxExportBytes: config.maxExportBytes,
        maxImportItems: 300,
        maxFiles: 30,
        version: config.version
      });
    }

    if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(req, res, 200, {
        ok: true,
        version: config.version,
        time: new Date().toISOString()
      });
    }

    if (pathname === '/api/stats' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(req, res, 200, store.stats());
    }

    if (pathname === '/api/admin/check' && req.method === 'GET') {
      const token = req.headers['x-admin-token'];
      const admin = Boolean(config.adminToken) && safeEqual(token, config.adminToken);
      return sendJson(req, res, 200, { admin, configured: Boolean(config.adminToken) });
    }

    if (pathname === '/api/memes') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const result = store.list({
          q: url.searchParams.get('q') ?? '',
          tag: url.searchParams.get('tag') ?? '',
          sort: url.searchParams.get('sort') ?? 'new',
          page: url.searchParams.get('page') ?? 1,
          limit: url.searchParams.get('limit') ?? 24
        });
        return sendJson(req, res, 200, result);
      }
      if (req.method === 'POST') {
        enforceLimit(req, 'upload');
        const body = await readJson(req, config.maxBodyBytes);
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) throw badRequest('no_files', '请选择要上传的图片');
        if (files.length > 30) throw badRequest('too_many_files', '一次最多上传 30 张图片');
        const commonTags = normalizeTags(body.tags);
        const commonUploader = cleanText(body.uploader, 24);
        const items = [];
        const skipped = [];
        const errors = [];
        for (const file of files) {
          if (!file || typeof file !== 'object') {
            errors.push({ title: '未知文件', message: '文件数据不正确' });
            continue;
          }
          try {
            const result = store.createMeme({
              dataUrl: file.dataUrl,
              filename: file.filename,
              title:
                cleanText(file.title, 80) ||
                (files.length === 1 ? cleanText(body.title, 80) : '') ||
                '',
              tags: file.tags ?? commonTags,
              uploader: cleanText(file.uploader, 24) || commonUploader
            });
            if (result.duplicate) {
              skipped.push({
                title: cleanText(file.title, 80) || '重复图片',
                existingId: result.existing.id,
                reason: 'duplicate'
              });
            } else {
              items.push({ ...result.meme, deleteToken: result.deleteToken });
            }
          } catch (error) {
            if (error instanceof HttpError) {
              errors.push({
                title: cleanText(file.title || file.filename, 80) || '上传失败',
                message: error.message
              });
            } else {
              console.error('[memevault] upload failed:', error);
              errors.push({
                title: cleanText(file.title || file.filename, 80) || '上传失败',
                message: '服务器保存失败'
              });
            }
          }
        }
        if (!items.length && !skipped.length) {
          return sendJson(req, res, 400, {
            error: {
              code: errors[0] ? 'upload_failed' : 'no_files',
              message: errors[0]?.message ?? '没有可上传的图片'
            },
            errors
          });
        }
        return sendJson(req, res, items.length ? 201 : 200, {
          items,
          skipped,
          errors,
          stats: store.stats()
        });
      }
      return sendJson(req, res, 405, { error: { code: 'method_not_allowed', message: '不支持的请求方法' } });
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      enforceLimit(req, 'import');
      const body = await readJson(req, config.maxBodyBytes);
      const result = store.importMemes(body.memes);
      return sendJson(req, res, 200, { ...result, stats: store.stats() });
    }

    if (pathname === '/api/export' && (req.method === 'GET' || req.method === 'HEAD')) {
      enforceLimit(req, 'export');
      const rawIds = url.searchParams.get('ids');
      let ids = null;
      if (rawIds && rawIds !== 'all') {
        ids = rawIds
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
      }
      const result = store.buildExport(ids);
      const { type, disposition } = contentDisposition(result.filename);
      return sendBuffer(req, res, 200, result.buffer, {
        'Content-Type': type,
        'Content-Disposition': disposition,
        'Content-Length': String(result.buffer.length),
        'Cache-Control': 'no-store',
        'X-Export-Count': String(result.count)
      });
    }

    const memeRoute = parseMemeRoute(pathname);
    if (memeRoute && memeRoute.action === 'detail') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.method === 'DELETE') {
          enforceLimit(req, 'upload');
          const result = store.deleteMeme(memeRoute.id, {
            deleteToken: String(req.headers['x-delete-token'] ?? ''),
            adminToken: String(req.headers['x-admin-token'] ?? '')
          });
          return sendJson(req, res, 200, { ok: true, ...result, stats: store.stats() });
        }
        return sendJson(req, res, 405, { error: { code: 'method_not_allowed', message: '不支持的请求方法' } });
      }
      const visitor = normalizeVisitor(url.searchParams.get('visitor') ?? '');
      const meme = store.getMeme(memeRoute.id, visitor);
      if (!meme) throw notFound('meme_not_found', '这个表情不存在或已被删除');
      return sendJson(req, res, 200, meme);
    }

    if (memeRoute && memeRoute.action === 'rating' && req.method === 'POST') {
      enforceLimit(req, 'rating');
      const body = await readJson(req, 32 * 1024);
      const visitor = normalizeVisitor(body.visitor);
      if (!visitor) throw badRequest('invalid_visitor', '访客标识不正确');
      const summary = store.addRating(memeRoute.id, visitor, body.value);
      return sendJson(req, res, 200, summary);
    }

    if (memeRoute && memeRoute.action === 'comments') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!store.getRawMeme(memeRoute.id)) {
          throw notFound('meme_not_found', '这个表情不存在或已被删除');
        }
        return sendJson(req, res, 200, { comments: store.listComments(memeRoute.id) });
      }
      if (req.method === 'POST') {
        enforceLimit(req, 'comment');
        const body = await readJson(req, 32 * 1024);
        const result = store.addComment(memeRoute.id, {
          author: body.author,
          body: body.body
        });
        return sendJson(req, res, 201, result);
      }
      return sendJson(req, res, 405, { error: { code: 'method_not_allowed', message: '不支持的请求方法' } });
    }

    const commentRoute = /^\/api\/comments\/([0-9a-fA-F-]{36})$/.exec(pathname);
    if (commentRoute && req.method === 'DELETE') {
      const result = store.deleteComment(commentRoute[1].toLowerCase(), req.headers['x-admin-token']);
      return sendJson(req, res, 200, { ok: true, ...result });
    }

    throw notFound('api_not_found', '接口不存在');
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: { code: 'method_not_allowed', message: '不支持的请求方法' } });
    }
    let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (!relative || relative.includes('\0')) throw badRequest('bad_path', '路径不正确');
    let filePath = path.resolve(config.publicDir, relative);
    const root = path.resolve(config.publicDir);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      throw notFound('not_found', '页面不存在');
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw notFound('not_found', '页面不存在');
    }
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      try {
        stat = fs.statSync(filePath);
      } catch {
        throw notFound('not_found', '页面不存在');
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate';
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', cacheControl);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function serveMedia(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: { code: 'method_not_allowed', message: '不支持的请求方法' } });
    }
    const match = /^\/media\/([0-9a-f-]{36}\.(?:png|jpg|gif|webp))$/.exec(pathname);
    if (!match) throw notFound('media_not_found', '图片不存在');
    const filePath = path.join(config.uploadsDir, match[1]);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw notFound('media_not_found', '图片不存在');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    applySecurityHeaders(res);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw badRequest('bad_path', '路径编码不正确');
      }
      if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');

      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname, url);
      } else if (pathname.startsWith('/media/')) {
        await serveMedia(req, res, pathname);
      } else {
        await serveStatic(req, res, pathname);
      }
      if (config.logRequests) {
        console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(req, res, error.status, {
          error: { code: error.code, message: error.message, details: error.details }
        });
      } else {
        console.error('[memevault] unhandled error:', error);
        sendJson(req, res, 500, {
          error: { code: 'internal_error', message: '服务器开小差了，请稍后再试' }
        });
      }
    }
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  return {
    server,
    config,
    db,
    store,
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const address = server.address();
      return {
        port: typeof address === 'object' && address ? address.port : port,
        host
      };
    },
    async close() {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      try {
        db.close();
      } catch {
        // The database may already be closed during shutdown.
      }
    }
  };
}
