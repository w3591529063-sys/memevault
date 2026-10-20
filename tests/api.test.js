import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { dataUrl, makePng, readZip } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');
let app;
let base;
let tempDir;
let firstUpload;

async function api(pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathname}`, { ...options, headers });
  let body = null;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) body = await response.json();
  return { response, body };
}

async function upload(files, extra = {}) {
  return api('/api/memes', {
    method: 'POST',
    body: JSON.stringify({ files, ...extra })
  });
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memevault-test-'));
  app = createApp({
    root,
    dataDir: path.join(tempDir, 'data'),
    publicDir: path.join(root, 'public'),
    adminToken: 'test-admin-secret',
    rateLimit: false,
    maxUploadMb: 2,
    maxBodyMb: 16
  });
  const address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('表情包 API', () => {
  test('health / empty stats', async () => {
    const health = await api('/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);

    const stats = await api('/api/stats');
    assert.equal(stats.response.status, 200);
    assert.equal(stats.body.memes, 0);
    assert.equal(stats.body.comments, 0);
    assert.deepEqual(stats.body.tags, []);
  });

  test('uploads images, derives metadata and rejects non-images', async () => {
    const pngOne = makePng(1, 6, 4);
    const pngTwo = makePng(2, 5, 7);
    const result = await upload(
      [
        {
          filename: '笑死.png',
          title: '笑死我了',
          dataUrl: dataUrl(pngOne),
          tags: ['日常', '爆笑']
        },
        {
          filename: '无语.png',
          dataUrl: dataUrl(pngTwo),
          tags: ['无语']
        }
      ],
      { uploader: '测试员' }
    );
    assert.equal(result.response.status, 201);
    assert.equal(result.body.items.length, 2);
    assert.equal(result.body.errors.length, 0);
    firstUpload = result.body.items[0];
    assert.equal(firstUpload.title, '笑死我了');
    assert.deepEqual(firstUpload.tags, ['日常', '爆笑']);
    assert.equal(firstUpload.mime, 'image/png');
    assert.equal(firstUpload.width, 6);
    assert.equal(firstUpload.height, 4);
    assert.equal(firstUpload.uploader, '测试员');
    assert.match(firstUpload.url, /^\/media\/[0-9a-f-]{36}\.png$/);
    assert.match(firstUpload.deleteToken, /^[0-9a-f]{48}$/);

    const image = await fetch(`${base}${firstUpload.url}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal((await image.arrayBuffer()).byteLength, pngOne.length);

    const bad = await upload([
      {
        filename: 'x.svg',
        title: '坏图片',
        dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`
      }
    ]);
    assert.equal(bad.response.status, 400);
    assert.equal(bad.body.error.code, 'upload_failed');

    const badBase64 = await upload([{ filename: 'x.png', dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' }]);
    assert.equal(badBase64.response.status, 400);
  });

  test('duplicate images are skipped, not stored twice', async () => {
    const duplicate = await upload([
      { filename: 'again.png', dataUrl: dataUrl(makePng(1, 6, 4)) }
    ]);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.items.length, 0);
    assert.equal(duplicate.body.skipped.length, 1);
    assert.equal(duplicate.body.skipped[0].existingId, firstUpload.id);
  });

  test('lists, searches, tags and sorts', async () => {
    const list = await api('/api/memes?limit=10');
    assert.equal(list.body.total, 2);
    assert.equal(list.body.items.length, 2);

    const search = await api('/api/memes?q=' + encodeURIComponent('无语'));
    assert.equal(search.body.total, 1);
    assert.equal(search.body.items[0].title, '无语');

    const byTag = await api('/api/memes?tag=' + encodeURIComponent('爆笑'));
    assert.equal(byTag.body.total, 1);

    const noMatch = await api('/api/memes?q=zzzzzz');
    assert.equal(noMatch.body.total, 0);

    const stats = await api('/api/stats');
    assert.equal(stats.body.memes, 2);
    assert.ok(stats.body.tags.some((entry) => entry.tag === '爆笑' && entry.count === 1));
  });

  test('ratings are per-visitor and can be changed', async () => {
    const visitorA = 'visitor-aaaaaaaa';
    const visitorB = 'visitor-bbbbbbbb';
    const first = await api(`/api/memes/${firstUpload.id}/rating`, {
      method: 'POST',
      body: JSON.stringify({ visitor: visitorA, value: 5 })
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.avgRating, 5);
    assert.equal(first.body.ratingCount, 1);
    assert.equal(first.body.myRating, 5);

    const changed = await api(`/api/memes/${firstUpload.id}/rating`, {
      method: 'POST',
      body: JSON.stringify({ visitor: visitorA, value: 4 })
    });
    assert.equal(changed.body.ratingCount, 1);
    assert.equal(changed.body.avgRating, 4);

    const second = await api(`/api/memes/${firstUpload.id}/rating`, {
      method: 'POST',
      body: JSON.stringify({ visitor: visitorB, value: 2 })
    });
    assert.equal(second.body.ratingCount, 2);
    assert.equal(second.body.avgRating, 3);

    const invalid = await api(`/api/memes/${firstUpload.id}/rating`, {
      method: 'POST',
      body: JSON.stringify({ visitor: visitorA, value: 9 })
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_rating');

    const detail = await api(`/api/memes/${firstUpload.id}?visitor=${visitorA}`);
    assert.equal(detail.body.myRating, 4);
    assert.equal(detail.body.avgRating, 3);
    assert.equal(detail.body.ratingCount, 2);
  });

  test('comments can be posted, listed and administrated', async () => {
    const created = await api(`/api/memes/${firstUpload.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ author: '路人甲', body: '太好笑了哈哈哈' })
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.comment.author, '路人甲');
    assert.equal(created.body.commentCount, 1);

    const detail = await api(`/api/memes/${firstUpload.id}`);
    assert.equal(detail.body.comments.length, 1);
    assert.equal(detail.body.commentCount, 1);

    const empty = await api(`/api/memes/${firstUpload.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: '   ' })
    });
    assert.equal(empty.response.status, 400);

    const denied = await api(`/api/comments/${created.body.comment.id}`, { method: 'DELETE' });
    assert.equal(denied.response.status, 403);

    const deleted = await api(`/api/comments/${created.body.comment.id}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': 'test-admin-secret' }
    });
    assert.equal(deleted.response.status, 200);
    const after = await api(`/api/memes/${firstUpload.id}`);
    assert.equal(after.body.comments.length, 0);
  });

  test('export produces a ZIP with manifest, readme and images', async () => {
    const response = await fetch(`${base}/api/export`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.match(response.headers.get('content-disposition'), /attachment; filename="memepack-/);
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);

    const files = readZip(zip);
    assert.ok(files.has('manifest.json'));
    assert.ok(files.has('README.txt'));
    const manifest = JSON.parse(files.get('manifest.json').data.toString('utf8'));
    assert.equal(manifest.format, 'memepack/v1');
    assert.equal(manifest.memes.length, 2);
    const exported = manifest.memes.find((meme) => meme.id === firstUpload.id);
    assert.equal(exported.title, '笑死我了');
    assert.equal(exported.avgRating, 3);
    assert.equal(exported.ratingCount, 2);
    assert.ok(files.has(exported.file));
    assert.ok(files.get('README.txt').data.toString('utf8').includes('怎么导入'));

    const selected = await fetch(`${base}/api/export?ids=${firstUpload.id}`);
    const selectedManifest = JSON.parse(
      readZip(Buffer.from(await selected.arrayBuffer())).get('manifest.json').data.toString('utf8')
    );
    assert.equal(selectedManifest.memes.length, 1);
  });

  test('import restores metadata and comments but de-duplicates', async () => {
    const payload = {
      memes: [
        {
          title: '导入的表情',
          tags: ['导入', '测试'],
          uploader: '搬运工',
          createdAt: '2024-03-04T05:06:07.000Z',
          dataUrl: dataUrl(makePng(3, 8, 8)),
          comments: [{ author: '旧朋友', body: '这条评论也要回来', createdAt: '2024-03-05T00:00:00.000Z' }]
        }
      ]
    };
    const imported = await api('/api/import', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(imported.response.status, 200);
    assert.equal(imported.body.imported.length, 1);
    assert.equal(imported.body.imported[0].title, '导入的表情');
    assert.equal(imported.body.imported[0].createdAt, '2024-03-04T05:06:07.000Z');
    assert.match(imported.body.imported[0].deleteToken, /^[0-9a-f]{48}$/);

    const detail = await api(`/api/memes/${imported.body.imported[0].id}`);
    assert.equal(detail.body.comments.length, 1);
    assert.equal(detail.body.comments[0].body, '这条评论也要回来');
    assert.equal(detail.body.comments[0].createdAt, '2024-03-05T00:00:00.000Z');

    const again = await api('/api/import', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(again.body.imported.length, 0);
    assert.equal(again.body.skipped.length, 1);
  });

  test('only the owner or admin can delete a meme', async () => {
    const denied = await api(`/api/memes/${firstUpload.id}`, { method: 'DELETE' });
    assert.equal(denied.response.status, 403);

    const wrong = await api(`/api/memes/${firstUpload.id}`, {
      method: 'DELETE',
      headers: { 'x-delete-token': 'f'.repeat(48) }
    });
    assert.equal(wrong.response.status, 403);

    const deleted = await api(`/api/memes/${firstUpload.id}`, {
      method: 'DELETE',
      headers: { 'x-delete-token': firstUpload.deleteToken }
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.ok, true);

    const missing = await fetch(`${base}${firstUpload.url}`);
    assert.equal(missing.status, 404);

    const detail = await api(`/api/memes/${firstUpload.id}`);
    assert.equal(detail.response.status, 404);
  });

  test('requires JSON and validates visitors', async () => {
    const wrongType = await fetch(`${base}/api/memes`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello'
    });
    assert.equal(wrongType.status, 415);

    const badVisitor = await api(`/api/memes/${firstUpload.id}/rating`, {
      method: 'POST',
      body: JSON.stringify({ visitor: 'x', value: 3 })
    });
    assert.equal(badVisitor.response.status, 400);
    assert.equal(badVisitor.body.error.code, 'invalid_visitor');

    const missingMeme = await api('/api/memes/00000000-0000-4000-8000-000000000000/rating', {
      method: 'POST',
      body: JSON.stringify({ visitor: 'test_visitor_12345', value: 3 })
    });
    assert.equal(missingMeme.response.status, 404);
  });

  test('serves the app shell when present', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /表情包仓库/);
  });
});
