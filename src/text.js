const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_CHARS, '').trim();
  return maxLength ? Array.from(text).slice(0, maxLength).join('') : text;
}

export function titleFromFilename(filename = '') {
  const base = String(filename).split(/[\\/]/).pop() ?? '';
  const withoutExt = base.replace(/\.[a-z0-9]{1,8}$/i, '');
  return cleanText(withoutExt.replace(/[_]+/g, ' '), 80) || '未命名表情';
}

export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,，]/);
  const seen = new Set();
  const tags = [];
  for (const item of raw) {
    const tag = cleanText(String(item), 20).replace(/^#+/, '');
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

export function normalizeVisitor(value) {
  if (typeof value !== 'string') return '';
  const visitor = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(visitor) ? visitor : '';
}

export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}
