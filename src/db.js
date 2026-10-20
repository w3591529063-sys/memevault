import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS memes (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    uploader    TEXT NOT NULL DEFAULT '',
    ext         TEXT NOT NULL,
    mime        TEXT NOT NULL,
    width       INTEGER,
    height      INTEGER,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL UNIQUE,
    delete_hash TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memes_created ON memes (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memes_sha ON memes (sha256);

  CREATE TABLE IF NOT EXISTS ratings (
    meme_id    TEXT NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
    visitor    TEXT NOT NULL,
    value      INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
    created_at TEXT NOT NULL,
    PRIMARY KEY (meme_id, visitor)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         TEXT PRIMARY KEY,
    meme_id    TEXT NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_comments_meme ON comments (meme_id, created_at DESC);
`;

export function openDatabase({ dbPath }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    throw error;
  }
}
