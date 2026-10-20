import path from 'node:path';
import process from 'node:process';

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve runtime configuration. Explicit overrides win over environment
 * variables, which win over defaults. Tests use overrides to point at a
 * temporary data directory and disable rate limits.
 */
export function loadConfig(overrides = {}) {
  const root = path.resolve(overrides.root ?? process.cwd());
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? path.join(root, 'data'));
  const maxUploadMb = overrides.maxUploadMb ?? positiveInt(process.env.MAX_UPLOAD_MB, 10);
  const maxBodyMb = overrides.maxBodyMb ?? positiveInt(process.env.MAX_BODY_MB, 64);

  return {
    root,
    dataDir,
    uploadsDir: path.join(dataDir, 'uploads'),
    dbPath: path.join(dataDir, 'memes.db'),
    publicDir: path.resolve(overrides.publicDir ?? path.join(root, 'public')),
    host: overrides.host ?? process.env.HOST ?? '0.0.0.0',
    port: overrides.port ?? positiveInt(process.env.PORT, 3000),
    adminToken: overrides.adminToken ?? process.env.ADMIN_TOKEN ?? '',
    trustProxy: overrides.trustProxy ?? process.env.TRUST_PROXY === '1',
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    maxBodyBytes: maxBodyMb * 1024 * 1024,
    maxExportBytes: (overrides.maxExportMb ?? positiveInt(process.env.MAX_EXPORT_MB, 300)) * 1024 * 1024,
    rateLimit: overrides.rateLimit ?? process.env.RATE_LIMIT !== '0',
    logRequests: overrides.logRequests ?? process.env.LOG_REQUESTS === '1',
    version: '1.0.0'
  };
}
