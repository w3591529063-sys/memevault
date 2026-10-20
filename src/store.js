import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { transaction } from './db.js';
import { badRequest, forbidden, notFound, tooLarge } from './errors.js';
import {
  assertSaneDimensions,
  decodeDataUrl,
  hashToken,
  randomToken,
  safeEqual,
  sha256,
  sniffImage
} from './images.js';
import { cleanText, escapeLike, normalizeTags, titleFromFilename } from './text.js';
import { createZip as createZipBuffer } from './zip.js';

const BASE_SELECT = `
  SELECT m.*,
    (SELECT AVG(r.value) FROM ratings r WHERE r.meme_id = m.id) AS avg_rating,
    (SELECT COUNT(*) FROM ratings r WHERE r.meme_id = m.id) AS rating_count,
    (SELECT COUNT(*) FROM comments c WHERE c.meme_id = m.id) AS comment_count
  FROM memes m
`;

function roundRating(value) {
  return value == null ? null : Math.round(Number(value) * 10) / 10;
}

function mapMeme(row) {
  if (!row) return null;
  let tags = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((tag) => typeof tag === 'string');
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    title: row.title,
    tags,
    uploader: row.uploader || '',
    mime: row.mime,
    width: row.width ?? null,
    height: row.height ?? null,
    size: Number(row.size) || 0,
    createdAt: row.created_at,
    avgRating: roundRating(row.avg_rating),
    ratingCount: Number(row.rating_count) || 0,
    commentCount: Number(row.comment_count) || 0,
    url: `/media/${row.id}.${row.ext}`
  };
}

function mapComment(row) {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at
  };
}

function normalizeDate(value) {
  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      const date = new Date(timestamp);
      const year = date.getUTCFullYear();
      if (year >= 2000 && date.getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
        return date.toISOString();
      }
    }
  }
  return new Date().toISOString();
}

function exportFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `memepack-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}.zip`;
}

export class MemeStore {
  constructor({ db, uploadsDir, adminToken = '', maxUploadBytes, maxExportBytes }) {
    this.db = db;
    this.uploadsDir = uploadsDir;
    this.adminToken = adminToken;
    this.maxUploadBytes = maxUploadBytes;
    this.maxExportBytes = maxExportBytes;
    fs.mkdirSync(this.uploadsDir, { recursive: true });
  }

  isAdmin(token) {
    return Boolean(this.adminToken) && safeEqual(token, this.adminToken);
  }

  list({ q = '', tag = '', sort = 'new', page = 1, limit = 24 } = {}) {
    const clauses = [];
    const params = [];
    const query = cleanText(String(q), 80);
    const tagFilter = cleanText(String(tag), 40);

    if (query) {
      const like = `%${escapeLike(query)}%`;
      clauses.push(
        `(m.title LIKE ? ESCAPE '\\' OR m.uploader LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\')`
      );
      params.push(like, like, like);
    }
    if (tagFilter) {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value = ?)`);
      params.push(tagFilter);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const safePage = Math.max(1, Math.min(10000, Number.parseInt(page, 10) || 1));
    const safeLimit = Math.max(1, Math.min(60, Number.parseInt(limit, 10) || 24));
    let orderBy = 'm.created_at DESC, m.rowid DESC';
    if (sort === 'rating') {
      orderBy = `(rating_count = 0) ASC, avg_rating DESC, rating_count DESC, m.created_at DESC`;
    } else if (sort === 'hot') {
      orderBy = `(rating_count * 2 + comment_count * 3) DESC, m.created_at DESC`;
    }

    const rows = this.db
      .prepare(`${BASE_SELECT} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, (safePage - 1) * safeLimit);
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS count FROM memes m ${where}`).get(...params).count
    );

    return {
      items: rows.map(mapMeme),
      total,
      page: safePage,
      limit: safeLimit,
      hasMore: safePage * safeLimit < total
    };
  }

  listComments(memeId) {
    return this.db
      .prepare('SELECT * FROM comments WHERE meme_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200')
      .all(memeId)
      .map(mapComment);
  }

  getMeme(id, visitor = '') {
    const row = this.db.prepare(`${BASE_SELECT} WHERE m.id = ?`).get(id);
    if (!row) return null;
    const meme = mapMeme(row);
    let myRating = null;
    if (visitor) {
      const rating = this.db
        .prepare('SELECT value FROM ratings WHERE meme_id = ? AND visitor = ?')
        .get(id, visitor);
      myRating = rating ? Number(rating.value) : null;
    }
    return { ...meme, myRating, comments: this.listComments(id) };
  }

  getRawMeme(id) {
    return this.db.prepare('SELECT * FROM memes WHERE id = ?').get(id);
  }

  createMeme(input, options = {}) {
    if (!input || typeof input !== 'object') {
      throw badRequest('invalid_meme', '表情数据不正确');
    }
    const title =
      cleanText(input.title, 80) || titleFromFilename(cleanText(input.filename, 200) || '');
    const tags = normalizeTags(input.tags);
    const uploader = cleanText(input.uploader, 24);
    const createdAt = normalizeDate(options.createdAt);
    const { buffer } = decodeDataUrl(input.dataUrl, this.maxUploadBytes);
    const detected = sniffImage(buffer);
    if (!detected) {
      throw badRequest('unsupported_image', '只支持 PNG、JPEG、GIF、WebP 图片');
    }
    assertSaneDimensions(detected);

    const checksum = sha256(buffer);
    const duplicate = this.db
      .prepare('SELECT id, title FROM memes WHERE sha256 = ?')
      .get(checksum);
    if (duplicate) {
      return {
        duplicate: true,
        existing: { id: duplicate.id, title: duplicate.title }
      };
    }

    const id = crypto.randomUUID();
    const filename = `${id}.${detected.ext}`;
    const filePath = path.join(this.uploadsDir, filename);
    const deleteToken = randomToken();
    const comments = Array.isArray(options.comments) ? options.comments.slice(0, 200) : [];

    try {
      fs.writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o644 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw badRequest('id_collision', '生成文件名冲突，请重试');
      }
      throw error;
    }

    try {
      transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO memes
              (id, title, tags, uploader, ext, mime, width, height, size, sha256, delete_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            title,
            JSON.stringify(tags),
            uploader,
            detected.ext,
            detected.mime,
            detected.width,
            detected.height,
            buffer.length,
            checksum,
            hashToken(deleteToken),
            createdAt
          );

        const insertComment = this.db.prepare(
          'INSERT INTO comments (id, meme_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)'
        );
        for (const comment of comments) {
          const body = cleanText(comment?.body, 500);
          if (!body) continue;
          insertComment.run(
            crypto.randomUUID(),
            id,
            cleanText(comment?.author, 24) || '匿名',
            body,
            normalizeDate(comment?.createdAt)
          );
        }
      });
    } catch (error) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // The image file is best-effort cleanup at this point.
      }
      if (String(error.message).includes('UNIQUE constraint failed')) {
        const existing = this.db
          .prepare('SELECT id, title FROM memes WHERE sha256 = ?')
          .get(checksum);
        if (existing) {
          return {
            duplicate: true,
            existing: { id: existing.id, title: existing.title }
          };
        }
      }
      throw error;
    }

    const meme = this.getMeme(id);
    return { meme, deleteToken };
  }

  importMemes(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest('empty_import', '导入包里没有可用的表情');
    }
    if (items.length > 300) {
      throw badRequest('too_many_items', '一次最多导入 300 张表情，请分批导入');
    }

    const imported = [];
    const skipped = [];
    const errors = [];
    for (const item of items) {
      try {
        const result = this.createMeme(item, {
          createdAt: item?.createdAt,
          comments: item?.comments
        });
        if (result.duplicate) {
          skipped.push({
            title: cleanText(item?.title, 80) || '未命名表情',
            existingId: result.existing.id,
            reason: 'duplicate'
          });
        } else {
          imported.push({
            ...result.meme,
            deleteToken: result.deleteToken
          });
        }
      } catch (error) {
        errors.push({
          title: cleanText(item?.title, 80) || '未命名表情',
          message: error.message || '导入失败'
        });
      }
    }
    return { imported, skipped, errors };
  }

  addRating(memeId, visitor, value) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 5) {
      throw badRequest('invalid_rating', '评分必须是 1 到 5 的整数');
    }
    if (!this.db.prepare('SELECT 1 FROM memes WHERE id = ?').get(memeId)) {
      throw notFound('meme_not_found', '这个表情不存在或已被删除');
    }
    this.db
      .prepare(
        `INSERT INTO ratings (meme_id, visitor, value, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(meme_id, visitor) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`
      )
      .run(memeId, visitor, numeric, new Date().toISOString());
    return this.ratingSummary(memeId, visitor);
  }

  ratingSummary(memeId, visitor = '') {
    const row = this.db
      .prepare('SELECT AVG(value) AS avg, COUNT(*) AS count FROM ratings WHERE meme_id = ?')
      .get(memeId);
    let myRating = null;
    if (visitor) {
      const rating = this.db
        .prepare('SELECT value FROM ratings WHERE meme_id = ? AND visitor = ?')
        .get(memeId, visitor);
      myRating = rating ? Number(rating.value) : null;
    }
    return {
      avgRating: roundRating(row.avg),
      ratingCount: Number(row.count) || 0,
      myRating
    };
  }

  addComment(memeId, { author, body } = {}) {
    if (!this.db.prepare('SELECT 1 FROM memes WHERE id = ?').get(memeId)) {
      throw notFound('meme_not_found', '这个表情不存在或已被删除');
    }
    const text = cleanText(body, 500);
    if (!text) throw badRequest('empty_comment', '评论不能为空');
    const name = cleanText(author, 24) || '匿名';
    const comment = {
      id: crypto.randomUUID(),
      author: name,
      body: text,
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare('INSERT INTO comments (id, meme_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(comment.id, memeId, comment.author, comment.body, comment.createdAt);
    const count = Number(
      this.db.prepare('SELECT COUNT(*) AS count FROM comments WHERE meme_id = ?').get(memeId).count
    );
    return { comment, commentCount: count };
  }

  deleteComment(commentId, adminToken) {
    if (!this.isAdmin(adminToken)) {
      throw forbidden('admin_required', '需要管理员密钥才能删除评论');
    }
    const row = this.db.prepare('SELECT id, meme_id FROM comments WHERE id = ?').get(commentId);
    if (!row) throw notFound('comment_not_found', '评论不存在');
    this.db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
    return { id: row.id, memeId: row.meme_id };
  }

  deleteMeme(memeId, { deleteToken = '', adminToken = '' } = {}) {
    const row = this.getRawMeme(memeId);
    if (!row) throw notFound('meme_not_found', '这个表情不存在或已被删除');
    const ownerAllowed = Boolean(deleteToken) && safeEqual(hashToken(deleteToken), row.delete_hash);
    if (!ownerAllowed && !this.isAdmin(adminToken)) {
      throw forbidden('delete_not_allowed', '只有上传者或管理员可以删除这张表情');
    }
    this.db.prepare('DELETE FROM memes WHERE id = ?').run(memeId);
    try {
      fs.unlinkSync(path.join(this.uploadsDir, `${row.id}.${row.ext}`));
    } catch {
      // A missing file should not block deleting the database record.
    }
    return { id: memeId };
  }

  stats() {
    const totals = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM memes) AS memes,
           (SELECT COUNT(*) FROM comments) AS comments,
           (SELECT COUNT(*) FROM ratings) AS ratings,
           (SELECT AVG(value) FROM ratings) AS avg_rating,
           (SELECT COALESCE(SUM(size), 0) FROM memes) AS bytes`
      )
      .get();
    const tags = this.db
      .prepare(
        `SELECT value AS tag, COUNT(*) AS count
         FROM memes, json_each(memes.tags)
         GROUP BY value
         ORDER BY count DESC, tag COLLATE NOCASE ASC
         LIMIT 50`
      )
      .all()
      .map((row) => ({ tag: row.tag, count: Number(row.count) }));
    return {
      memes: Number(totals.memes) || 0,
      comments: Number(totals.comments) || 0,
      ratings: Number(totals.ratings) || 0,
      avgRating: roundRating(totals.avg_rating),
      bytes: Number(totals.bytes) || 0,
      tags
    };
  }

  buildExport(ids = null) {
    let rows;
    if (Array.isArray(ids) && ids.length > 0) {
      const unique = [...new Set(ids.filter((id) => typeof id === 'string'))].slice(0, 1000);
      if (!unique.length) throw badRequest('empty_export', '还没有选择要导出的表情');
      const placeholders = unique.map(() => '?').join(',');
      rows = this.db
        .prepare(`${BASE_SELECT} WHERE m.id IN (${placeholders}) ORDER BY m.created_at ASC`)
        .all(...unique);
    } else {
      rows = this.db.prepare(`${BASE_SELECT} ORDER BY m.created_at ASC, m.rowid ASC`).all();
    }
    if (!rows.length) throw badRequest('empty_export', '还没有可导出的表情');

    const manifestMemes = [];
    const fileEntries = [];
    let totalBytes = 0;
    const exportedAt = new Date().toISOString();

    for (const row of rows) {
      const filePath = path.join(this.uploadsDir, `${row.id}.${row.ext}`);
      let data;
      try {
        data = fs.readFileSync(filePath);
      } catch {
        continue;
      }
      totalBytes += data.length;
      if (totalBytes > this.maxExportBytes) {
        throw tooLarge('导出内容超过大小限制，请少选一些表情后分批导出');
      }
      const comments = this.listComments(row.id).map((comment) => ({
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt
      }));
      manifestMemes.push({
        ...mapMeme(row),
        sha256: row.sha256,
        file: `memes/${row.id}.${row.ext}`,
        comments
      });
      fileEntries.push({ name: `memes/${row.id}.${row.ext}`, data });
    }

    if (!manifestMemes.length) {
      throw badRequest('empty_export', '这些表情的图片文件已丢失，无法导出');
    }

    const manifest = {
      format: 'memepack/v1',
      app: '表情包仓库',
      version: 1,
      exportedAt,
      count: manifestMemes.length,
      memes: manifestMemes
    };
    const readme = [
      '表情包仓库 · 导出包',
      '==================',
      '',
      `导出时间：${exportedAt}`,
      `包含：${manifestMemes.length} 张表情，${manifestMemes.reduce(
        (sum, meme) => sum + meme.comments.length,
        0
      )} 条评论`,
      '',
      '怎么导入？',
      '1. 打开表情包仓库网站，点击顶部「导入」；',
      '2. 选择这个 ZIP 文件（不需要解压）；',
      '3. 表情、标签、上传时间和评论会被保留，评分会从 0 开始',
      '   （评分与每位访客绑定，无法随文件迁移）。',
      '',
      'manifest.json 包含完整元数据；memes/ 目录是原图。',
      '你也可以直接把 memes/ 里的图片拖进网站，一样可以导入。',
      ''
    ].join('\n');

    const zip = createExportZip(manifest, readme, fileEntries);
    return {
      buffer: zip,
      filename: exportFilename(),
      count: manifestMemes.length,
      totalBytes
    };
  }
}

function createExportZip(manifest, readme, fileEntries) {
  return createZipBuffer([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    ...fileEntries
  ]);
}
