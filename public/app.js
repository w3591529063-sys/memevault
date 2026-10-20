import { isZipFile, readZip } from './zip.js';

/* =========================================================
   Utilities
   ========================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const BASE_TITLE = '表情包仓库 · MemeVault';
const MAX_UPLOAD_FILES = 30;
const DEFAULT_CONFIG = {
  maxUploadBytes: 10 * 1024 * 1024,
  maxImportItems: 300,
  maxExportBytes: 300 * 1024 * 1024,
  version: '1.0.0'
};

const IMAGE_EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
};

const ALLOWED_MIME = new Set(Object.values(IMAGE_EXT_MIME));
const OWNED_KEY = 'memevault:owned';
const NAME_KEY = 'memevault:name';
const VISITOR_KEY = 'memevault:visitor';
const THEME_KEY = 'memevault:theme';
const ADMIN_KEY = 'memevault:admin';

const numberFormat = new Intl.NumberFormat('zh-CN');
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return dateFormat.format(date);
}

function timeAgo(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
  return formatDate(value);
}

function parseTags(value) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(value ?? '').split(/[,，]/)) {
    const tag = raw.trim().replace(/^#+/, '').slice(0, 20);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

function titleFromFilename(filename) {
  const base = String(filename || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/_+/g, ' ').trim().slice(0, 80) || '未命名表情';
}

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
}

function mimeForName(name) {
  return IMAGE_EXT_MIME[extensionOf(name)] || '';
}

function isSupportedImageName(name) {
  return Boolean(mimeForName(name));
}

function mimeLabel(mime) {
  if (mime === 'image/jpeg') return 'JPG';
  if (mime === 'image/png') return 'PNG';
  if (mime === 'image/gif') return 'GIF';
  if (mime === 'image/webp') return 'WEBP';
  return '图片';
}

function safeFilename(title, fallback = 'meme') {
  return (
    String(title || '')
      .replace(/[\\/:*?"<>|\r\n]/g, '_')
      .trim()
      .slice(0, 60) || fallback
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`读取「${file.name}」失败`));
    reader.readAsDataURL(file);
  });
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function dataUrlFromBytes(bytes, mime) {
  return `data:${mime || 'image/png'};base64,${bytesToBase64(bytes)}`;
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function storeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage may be unavailable in private modes; the app still works.
  }
}

function storeRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // Ignore.
  }
}

function getVisitorId() {
  let visitor = storeGet(localStorage, VISITOR_KEY) || '';
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(visitor)) {
    visitor = `mv_${randomHex(16)}`;
    storeSet(localStorage, VISITOR_KEY, visitor);
  }
  return visitor;
}

function loadOwned() {
  try {
    const parsed = JSON.parse(storeGet(localStorage, OWNED_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveOwned(map) {
  const entries = Object.entries(map).slice(-500);
  storeSet(localStorage, OWNED_KEY, JSON.stringify(Object.fromEntries(entries)));
}

function ownedToken(id) {
  return state.owned[id] || '';
}

function rememberOwned(items) {
  for (const item of items || []) {
    if (item && item.id && item.deleteToken) state.owned[item.id] = item.deleteToken;
  }
  saveOwned(state.owned);
}

function forgetOwned(id) {
  if (state.owned[id]) {
    delete state.owned[id];
    saveOwned(state.owned);
  }
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.tag) params.set('tag', state.tag);
  if (state.sort && state.sort !== 'new') params.set('sort', state.sort);
  const search = params.toString();
  const url = `${location.pathname}${search ? `?${search}` : ''}${location.hash}`;
  try {
    history.replaceState(history.state, '', url);
  } catch {
    // Ignore history failures in unusual embedding contexts.
  }
}

/* =========================================================
   State & DOM
   ========================================================= */

const state = {
  config: { ...DEFAULT_CONFIG },
  version: '1.0.0',
  items: [],
  total: 0,
  page: 1,
  hasMore: false,
  loading: false,
  loadError: false,
  seq: 0,
  q: '',
  tag: '',
  sort: 'new',
  stats: null,
  selectionMode: false,
  selected: new Map(),
  owned: loadOwned(),
  detail: null,
  detailId: null,
  detailSeq: 0,
  ratingBusy: false,
  adminToken: storeGet(sessionStorage, ADMIN_KEY) || '',
  isAdmin: false,
  adminConfigured: null,
  uploadFiles: [],
  uploadBusy: false,
  importPending: null,
  importBusy: false,
  importSeq: 0,
  demoBusy: false,
  exportBusy: false
};

const dom = {
  heroStats: $('#heroStats'),
  searchForm: $('#searchForm'),
  searchInput: $('#searchInput'),
  themeToggle: $('#themeToggle'),
  importBtn: $('#importBtn'),
  uploadBtn: $('#uploadBtn'),
  settingsBtn: $('#settingsBtn'),
  libraryTitle: $('#libraryTitle'),
  resultCount: $('#resultCount'),
  sortSelect: $('#sortSelect'),
  selectModeBtn: $('#selectModeBtn'),
  tagBar: $('#tagBar'),
  galleryGrid: $('#galleryGrid'),
  emptyState: $('#emptyState'),
  emptyTitle: $('#emptyTitle'),
  emptyText: $('#emptyText'),
  demoBtn: $('#demoBtn'),
  loadMoreWrap: $('#loadMoreWrap'),
  loadMoreBtn: $('#loadMoreBtn'),
  selectionBar: $('#selectionBar'),
  selectedCount: $('#selectedCount'),
  clearSelectionBtn: $('#clearSelectionBtn'),
  exportSelectedBtn: $('#exportSelectedBtn'),
  toastStack: $('#toastStack'),
  cardTpl: $('#memeCardTpl'),
  footerVersion: $('#footerVersion'),

  uploadDialog: $('#uploadDialog'),
  uploadDrop: $('#uploadDrop'),
  uploadInput: $('#uploadInput'),
  uploadPreview: $('#uploadPreview'),
  uploadTitleInput: $('#uploadTitleInput'),
  uploadTagsInput: $('#uploadTagsInput'),
  uploaderInput: $('#uploaderInput'),
  uploadProgress: $('#uploadProgress'),
  uploadProgressBar: $('#uploadProgressBar'),
  uploadStatus: $('#uploadStatus'),
  uploadSubmit: $('#uploadSubmit'),

  importDialog: $('#importDialog'),
  importDrop: $('#importDrop'),
  importInput: $('#importInput'),
  importPreview: $('#importPreview'),
  importSummaryTitle: $('#importSummaryTitle'),
  importSummaryText: $('#importSummaryText'),
  importList: $('#importList'),
  importTagsInput: $('#importTagsInput'),
  importUploaderInput: $('#importUploaderInput'),
  importProgress: $('#importProgress'),
  importProgressBar: $('#importProgressBar'),
  importStatus: $('#importStatus'),
  importSubmit: $('#importSubmit'),

  detailDialog: $('#detailDialog'),
  detailImg: $('#detailImg'),
  detailLoading: $('#detailLoading'),
  detailDownload: $('#detailDownload'),
  detailCopy: $('#detailCopy'),
  detailDelete: $('#detailDelete'),
  detailTitle: $('#detailTitle'),
  detailKicker: $('#detailKicker'),
  detailMeta: $('#detailMeta'),
  detailTags: $('#detailTags'),
  detailAvg: $('#detailAvg'),
  detailRatingText: $('#detailRatingText'),
  starRow: $('#starRow'),
  commentHeading: $('#commentHeading'),
  detailCommentCount: $('#detailCommentCount'),
  commentList: $('#commentList'),
  commentForm: $('#commentForm'),
  commentAuthor: $('#commentAuthor'),
  commentBody: $('#commentBody'),
  commentCount: $('#commentCount'),
  commentSubmit: $('#commentSubmit'),

  settingsDialog: $('#settingsDialog'),
  adminTokenInput: $('#adminTokenInput'),
  adminSaveBtn: $('#adminSaveBtn'),
  adminClearBtn: $('#adminClearBtn'),
  adminStatus: $('#adminStatus'),
  adminHint: $('#adminHint'),
  exportAllBtn: $('#exportAllBtn'),
  settingsImportBtn: $('#settingsImportBtn'),
  storageMemes: $('#storageMemes'),
  storageBytes: $('#storageBytes'),
  storageComments: $('#storageComments'),
  aboutVersion: $('#aboutVersion'),

  confirmDialog: $('#confirmDialog'),
  confirmTitle: $('#confirmTitle'),
  confirmMessage: $('#confirmMessage'),
  confirmCancel: $('#confirmCancel'),
  confirmOk: $('#confirmOk')
};

/* =========================================================
   Toasts, dialogs, API
   ========================================================= */

function toast(message, type = 'info', timeout = 3800) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const mark = document.createElement('span');
  mark.className = 'toast-icon';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';

  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = String(message ?? '');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', () => node.remove());

  node.append(mark, text, close);
  dom.toastStack.append(node);
  while (dom.toastStack.children.length > 4) dom.toastStack.firstElementChild.remove();
  setTimeout(() => node.remove(), timeout);
}

function syncLock() {
  document.body.classList.toggle('is-locked', Boolean(document.querySelector('dialog[open]')));
}

function showDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  syncLock();
}

function closeDialogSafely(dialog) {
  if (!dialog.open) return;
  if (dialog === dom.uploadDialog && state.uploadBusy) {
    toast('正在上传，请稍等片刻…');
    return;
  }
  if (dialog === dom.importDialog && state.importBusy) {
    toast('正在导入，请稍等片刻…');
    return;
  }
  dialog.close();
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
  } catch {
    throw new Error('网络连接失败，请检查服务器是否在线');
  }

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const data = await response.json();
      message = data?.error?.message || message;
      const error = new Error(message);
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    } catch (error) {
      if (error instanceof Error && error.message !== 'Unexpected end of JSON input') throw error;
      throw new Error(message);
    }
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new Error('服务器返回了无法解析的内容');
  }
}

function setProgress(kind, percent, message) {
  const isUpload = kind === 'upload';
  const wrap = isUpload ? dom.uploadProgress : dom.importProgress;
  const bar = isUpload ? dom.uploadProgressBar : dom.importProgressBar;
  const status = isUpload ? dom.uploadStatus : dom.importStatus;
  wrap.hidden = false;
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  bar.style.width = `${safe}%`;
  status.textContent = message;
}

function hideProgress(kind) {
  const isUpload = kind === 'upload';
  (isUpload ? dom.uploadProgress : dom.importProgress).hidden = true;
  (isUpload ? dom.uploadProgressBar : dom.importProgressBar).style.width = '0%';
  (isUpload ? dom.uploadStatus : dom.importStatus).textContent = '';
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/* =========================================================
   Stats & tags
   ========================================================= */

function updateStatsDisplay(stats) {
  if (!stats) return;
  for (const key of ['memes', 'ratings', 'comments']) {
    const node = $(`[data-stat="${key}"]`, dom.heroStats);
    if (node) node.textContent = numberFormat.format(stats[key] || 0);
  }
  if (dom.storageMemes) dom.storageMemes.textContent = numberFormat.format(stats.memes || 0);
  if (dom.storageBytes) dom.storageBytes.textContent = formatBytes(stats.bytes || 0);
  if (dom.storageComments) dom.storageComments.textContent = numberFormat.format(stats.comments || 0);
}

function renderTagBar() {
  const tags = Array.isArray(state.stats?.tags) ? state.stats.tags : [];
  const visible = tags.slice(0, 18);
  if (state.tag && !visible.some((entry) => entry.tag === state.tag)) {
    visible.unshift({ tag: state.tag, count: null });
  }

  const chips = [];
  const all = document.createElement('button');
  all.type = 'button';
  all.className = `chip${!state.tag ? ' is-active' : ''}`;
  all.setAttribute('aria-pressed', String(!state.tag));
  all.append(document.createTextNode('全部'));
  if (state.stats) {
    const count = document.createElement('span');
    count.className = 'chip-count';
    count.textContent = numberFormat.format(state.stats.memes || 0);
    all.append(count);
  }
  all.addEventListener('click', () => {
    state.tag = '';
    applyFilters();
  });
  chips.push(all);

  for (const entry of visible) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${state.tag === entry.tag ? ' is-active' : ''}`;
    chip.setAttribute('aria-pressed', String(state.tag === entry.tag));
    chip.append(document.createTextNode(`#${entry.tag}`));
    if (entry.count != null) {
      const count = document.createElement('span');
      count.className = 'chip-count';
      count.textContent = numberFormat.format(entry.count);
      chip.append(count);
    }
    chip.addEventListener('click', () => {
      state.tag = state.tag === entry.tag ? '' : entry.tag;
      applyFilters();
    });
    chips.push(chip);
  }

  dom.tagBar.replaceChildren(...chips);
  dom.tagBar.hidden = chips.length <= 1 && !state.tag;
}

async function loadStats() {
  try {
    const stats = await api('/api/stats');
    state.stats = stats;
    updateStatsDisplay(stats);
    renderTagBar();
  } catch {
    // Stats are decorative; the gallery remains usable if they fail.
  }
}

function renderResultCount() {
  if (state.loadError) {
    dom.resultCount.textContent = '加载失败，请刷新重试';
    return;
  }
  const total = numberFormat.format(state.total || 0);
  if (state.q && state.tag) {
    dom.resultCount.textContent = `“${state.q}” · #${state.tag} · ${total} 张`;
  } else if (state.q) {
    dom.resultCount.textContent = `“${state.q}” · ${total} 张`;
  } else if (state.tag) {
    dom.resultCount.textContent = `#${state.tag} · ${total} 张`;
  } else if (state.total > 0) {
    dom.resultCount.textContent = `共 ${total} 张 · 慢慢翻`;
  } else {
    dom.resultCount.textContent = '仓库里还没有表情';
  }
}

/* =========================================================
   Gallery
   ========================================================= */

function buildCard(meme) {
  const node = dom.cardTpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = meme.id;

  const media = $('.meme-media', node);
  const image = $('img', node);
  image.src = meme.url;
  image.alt = meme.title || '表情包';
  media.setAttribute('aria-label', `查看「${meme.title || '未命名表情'}」`);

  const badge = $('.media-badge', node);
  if (meme.mime === 'image/gif') {
    badge.hidden = false;
    badge.textContent = 'GIF';
  }

  const check = $('.card-check', node);
  check.setAttribute('aria-pressed', String(state.selected.has(meme.id)));
  if (state.selected.has(meme.id)) node.classList.add('is-selected');

  const open = () => {
    if (state.selectionMode) toggleSelection(meme);
    else openDetail(meme.id);
  };
  media.addEventListener('click', open);

  const titleButton = $('.meme-title-btn', node);
  titleButton.textContent = meme.title || '未命名表情';
  titleButton.title = meme.title || '';
  titleButton.addEventListener('click', open);

  check.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSelection(meme);
  });

  const tagsNode = $('.meme-tags', node);
  const tags = Array.isArray(meme.tags) ? meme.tags : [];
  for (const tag of tags.slice(0, 2)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mini-tag';
    chip.textContent = `#${tag}`;
    chip.title = `筛选 #${tag}`;
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      state.tag = tag;
      applyFilters();
    });
    tagsNode.append(chip);
  }
  if (tags.length > 2) {
    const more = document.createElement('span');
    more.className = 'mini-tag more';
    more.textContent = `+${tags.length - 2}`;
    tagsNode.append(more);
  }

  $('.meme-rating strong', node).textContent =
    meme.avgRating == null ? '—' : Number(meme.avgRating).toFixed(1);
  $('.meme-rating-count', node).textContent = meme.ratingCount
    ? `(${numberFormat.format(meme.ratingCount)})`
    : '';
  $('.meme-comments span', node).textContent = numberFormat.format(meme.commentCount || 0);

  return node;
}

function renderSkeletons(count = 8) {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index += 1) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    card.setAttribute('aria-hidden', 'true');
    const media = document.createElement('div');
    media.className = 'skeleton-media';
    const body = document.createElement('div');
    body.className = 'skeleton-body';
    for (const className of ['skeleton-line', 'skeleton-line short']) {
      const line = document.createElement('div');
      line.className = className;
      body.append(line);
    }
    card.append(media, body);
    fragment.append(card);
  }
  dom.galleryGrid.replaceChildren(fragment);
  dom.galleryGrid.hidden = false;
}

function setEmptyState() {
  const isEmpty = !state.loading && !state.loadError && state.total === 0;
  dom.emptyState.hidden = !isEmpty;
  dom.galleryGrid.hidden = isEmpty;
  dom.loadMoreWrap.hidden = isEmpty || !state.hasMore;
  if (isEmpty) {
    const filtered = Boolean(state.q || state.tag);
    dom.emptyTitle.textContent = filtered ? '没找到这样的表情' : '仓库还是空的';
    dom.emptyText.textContent = filtered
      ? '换个关键词或标签试试，或者清空筛选看看全部表情。'
      : '上传第一张表情包，或者把一个 ZIP 表情包拖进来。快乐从这一张开始。';
    dom.demoBtn.hidden = filtered;
  }
  renderResultCount();
}

async function loadMemes({ reset = false } = {}) {
  if (!reset && (state.loading || !state.hasMore)) return;
  const seq = ++state.seq;
  state.loading = true;
  state.loadError = false;

  if (reset) {
    state.page = 1;
    state.items = [];
    state.total = 0;
    state.hasMore = false;
    renderSkeletons();
    dom.emptyState.hidden = true;
    dom.loadMoreWrap.hidden = true;
  }

  const params = new URLSearchParams({
    q: state.q,
    tag: state.tag,
    sort: state.sort,
    page: String(state.page),
    limit: '24'
  });

  try {
    const data = await api(`/api/memes?${params.toString()}`);
    if (seq !== state.seq) return;
    state.total = data.total;
    state.page = data.page;
    state.hasMore = data.hasMore;
    if (reset) {
      state.items = data.items;
      dom.galleryGrid.replaceChildren();
    } else {
      state.items.push(...data.items);
    }
    const fragment = document.createDocumentFragment();
    for (const meme of data.items) fragment.append(buildCard(meme));
    dom.galleryGrid.append(fragment);
  } catch (error) {
    if (seq !== state.seq) return;
    state.loadError = true;
    state.total = 0;
    state.hasMore = false;
    dom.galleryGrid.replaceChildren();
    toast(error.message || '表情列表加载失败', 'error');
  } finally {
    if (seq === state.seq) {
      state.loading = false;
      setEmptyState();
      dom.loadMoreBtn.disabled = false;
    }
  }
}

function applyFilters() {
  state.q = dom.searchInput.value.trim();
  state.sort = dom.sortSelect.value;
  state.page = 1;
  clearSelection();
  dom.libraryTitle.textContent = state.q ? '搜索结果' : state.tag ? `#${state.tag}` : '全部表情';
  syncUrl();
  loadMemes({ reset: true });
}

function toggleSelection(meme) {
  if (state.selected.has(meme.id)) state.selected.delete(meme.id);
  else state.selected.set(meme.id, meme);
  updateSelectionUI();
}

function updateSelectionUI() {
  for (const card of $$('.meme-card', dom.galleryGrid)) {
    const selected = state.selected.has(card.dataset.id);
    card.classList.toggle('is-selected', selected);
    const check = $('.card-check', card);
    if (check) check.setAttribute('aria-pressed', String(selected));
  }
  dom.selectionBar.hidden = state.selected.size === 0;
  dom.selectedCount.textContent = String(state.selected.size);
  dom.exportSelectedBtn.disabled = state.selected.size === 0;
}

function clearSelection() {
  state.selected.clear();
  updateSelectionUI();
}

function setSelectionMode(enabled) {
  state.selectionMode = enabled;
  document.body.classList.toggle('is-selecting', enabled);
  dom.selectModeBtn.classList.toggle('btn-primary', enabled);
  dom.selectModeBtn.querySelector('span').textContent = enabled ? '完成' : '选择';
  dom.selectModeBtn.setAttribute('aria-pressed', String(enabled));
  if (!enabled) clearSelection();
  else updateSelectionUI();
}

async function refreshAll() {
  await Promise.allSettled([loadStats(), loadMemes({ reset: true })]);
}

/* =========================================================
   Export
   ========================================================= */

function filenameFromDisposition(header) {
  if (!header) return '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return encoded[1].trim();
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain ? plain[1] : '';
}

async function downloadExport(ids = null) {
  const query = Array.isArray(ids) && ids.length ? `?ids=${encodeURIComponent(ids.join(','))}` : '?ids=all';
  let response;
  try {
    response = await fetch(`/api/export${query}`, { credentials: 'same-origin' });
  } catch {
    throw new Error('网络连接失败，导出没有开始');
  }
  if (!response.ok) {
    let message = `导出失败（${response.status}）`;
    try {
      const data = await response.json();
      message = data?.error?.message || message;
    } catch {
      // Keep the status message.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get('content-disposition')) || 'memepack.zip';
  const count = Number(response.headers.get('x-export-count') || 0);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  return { count, filename, size: blob.size };
}

async function exportSelection() {
  const ids = [...state.selected.keys()];
  if (!ids.length) return;
  if (state.exportBusy) return;
  state.exportBusy = true;
  setBusy(dom.exportSelectedBtn, true);
  try {
    const result = await downloadExport(ids);
    toast(`已导出 ${result.count || ids.length} 张表情`, 'success');
    setSelectionMode(false);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.exportBusy = false;
    setBusy(dom.exportSelectedBtn, false);
  }
}

/* =========================================================
   Upload
   ========================================================= */

function storedName() {
  return storeGet(localStorage, NAME_KEY) || '';
}

function rememberName(name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (clean) storeSet(localStorage, NAME_KEY, clean);
}

function resetUpload() {
  for (const entry of state.uploadFiles) URL.revokeObjectURL(entry.url);
  state.uploadFiles = [];
  state.uploadBusy = false;
  dom.uploadPreview.replaceChildren();
  dom.uploadTitleInput.value = '';
  dom.uploadTitleInput.disabled = false;
  dom.uploadTagsInput.value = '';
  dom.uploaderInput.value = storedName();
  dom.uploadInput.value = '';
  dom.uploadInput.disabled = false;
  dom.uploadDrop.classList.remove('is-dragging');
  dom.uploadDrop.querySelector('strong').textContent = '把图片拖到这里';
  hideProgress('upload');
  syncUploadSubmit();
}

function syncUploadSubmit() {
  dom.uploadSubmit.disabled = state.uploadBusy || state.uploadFiles.length === 0;
}

function openUpload() {
  resetUpload();
  showDialog(dom.uploadDialog);
  setTimeout(() => dom.uploadDrop.focus(), 40);
}

function addUploadFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const rejected = [];
  let added = 0;

  for (const file of files) {
    if (state.uploadFiles.length >= MAX_UPLOAD_FILES) {
      rejected.push(`一次最多 ${MAX_UPLOAD_FILES} 张`);
      break;
    }
    const mime = (file.type && ALLOWED_MIME.has(file.type) ? file.type : '') || mimeForName(file.name);
    if (!mime) {
      rejected.push(`「${file.name}」不是支持的图片`);
      continue;
    }
    if (file.size > state.config.maxUploadBytes) {
      rejected.push(
        `「${file.name}」超过 ${Math.round(state.config.maxUploadBytes / 1024 / 1024)} MB`
      );
      continue;
    }
    const duplicate = state.uploadFiles.some(
      (entry) =>
        entry.file.name === file.name &&
        entry.file.size === file.size &&
        entry.file.lastModified === file.lastModified
    );
    if (duplicate) continue;
    state.uploadFiles.push({ file, url: URL.createObjectURL(file), mime });
    added += 1;
  }

  if (added) {
    dom.uploadDrop.querySelector('strong').textContent = `已选 ${state.uploadFiles.length} 张，还可以继续加`;
    if (state.uploadFiles.length === 1) {
      dom.uploadTitleInput.disabled = false;
      const title = titleFromFilename(state.uploadFiles[0].file.name);
      if (!dom.uploadTitleInput.value) dom.uploadTitleInput.value = title;
    } else {
      dom.uploadTitleInput.disabled = true;
    }
    renderUploadPreview();
    syncUploadSubmit();
  }
  if (rejected.length) toast(rejected[0], 'error', 4600);
}

function renderUploadPreview() {
  const fragment = document.createDocumentFragment();
  state.uploadFiles.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    const image = document.createElement('img');
    image.src = entry.url;
    image.alt = entry.file.name;
    image.loading = 'lazy';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preview-remove';
    remove.setAttribute('aria-label', `移除 ${entry.file.name}`);
    remove.append(icon('x'));
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      URL.revokeObjectURL(entry.url);
      state.uploadFiles.splice(index, 1);
      renderUploadPreview();
      syncUploadSubmit();
      if (!state.uploadFiles.length) {
        dom.uploadDrop.querySelector('strong').textContent = '把图片拖到这里';
        dom.uploadTitleInput.disabled = false;
        dom.uploadTitleInput.value = '';
      } else if (state.uploadFiles.length === 1) {
        dom.uploadTitleInput.disabled = false;
      }
    });
    const name = document.createElement('span');
    name.className = 'preview-name';
    name.textContent = entry.file.name;
    item.append(image, remove, name);
    fragment.append(item);
  });
  dom.uploadPreview.replaceChildren(fragment);
}

function groupBySize(items, maxCount, maxBytes, sizeOf) {
  const groups = [];
  let current = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length && (current.length >= maxCount || bytes + size > maxBytes)) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function submitUpload() {
  if (state.uploadBusy || !state.uploadFiles.length) return;
  const files = state.uploadFiles.map((entry) => entry.file);
  const single = files.length === 1;
  const title = single ? dom.uploadTitleInput.value.trim() : '';
  const tags = parseTags(dom.uploadTagsInput.value);
  const uploader = dom.uploaderInput.value.trim();
  rememberName(uploader);

  state.uploadBusy = true;
  syncUploadSubmit();
  dom.uploadInput.disabled = true;

  let succeeded = 0;
  let skipped = 0;
  const errors = [];
  const groups = groupBySize(files, 3, 40 * 1024 * 1024, (file) => file.size);
  let processed = 0;

  try {
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      setProgress(
        'upload',
        5 + (processed / files.length) * 90,
        `正在读取第 ${index + 1} / ${groups.length} 组…`
      );
      const payload = [];
      for (const file of group) {
        if (file.size > state.config.maxUploadBytes) {
          errors.push(`「${file.name}」超过大小限制`);
          continue;
        }
        try {
          const dataUrl = await readFileAsDataUrl(file);
          payload.push({ filename: file.name, title, dataUrl });
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (payload.length) {
        setProgress(
          'upload',
          5 + (processed / files.length) * 90,
          `正在上传 ${processed + 1}–${processed + payload.length} 张…`
        );
        try {
          const result = await api('/api/memes', {
            method: 'POST',
            body: { files: payload, tags, uploader, title }
          });
          succeeded += result.items?.length || 0;
          skipped += result.skipped?.length || 0;
          for (const failure of result.errors || []) {
            errors.push(failure.title ? `${failure.title}：${failure.message}` : failure.message);
          }
          rememberOwned(result.items);
        } catch (error) {
          errors.push(error.message);
        }
      }
      processed += group.length;
      setProgress('upload', 5 + (processed / files.length) * 90, `已处理 ${processed} / ${files.length} 张`);
    }

    if (!succeeded && !skipped) {
      setProgress('upload', 100, `上传失败：${errors[0] || '请稍后再试'}`);
      toast(errors[0] || '上传失败，请稍后再试', 'error', 5200);
      return;
    }

    setProgress('upload', 100, `完成：成功 ${succeeded} 张${skipped ? `，跳过 ${skipped} 张` : ''}`);
    const parts = [`成功上传 ${succeeded} 张`];
    if (skipped) parts.push(`跳过 ${skipped} 张重复图片`);
    if (errors.length) parts.push(`${errors.length} 张失败`);
    toast(parts.join('，'), errors.length ? 'info' : 'success');
    dom.uploadDialog.close();
    resetUpload();
    await refreshAll();
  } finally {
    state.uploadBusy = false;
    syncUploadSubmit();
    dom.uploadInput.disabled = false;
  }
}

/* =========================================================
   Import
   ========================================================= */

function resetImport() {
  state.importSeq += 1;
  state.importPending = null;
  state.importBusy = false;
  dom.importInput.value = '';
  dom.importInput.disabled = false;
  dom.importPreview.hidden = true;
  dom.importSummaryTitle.textContent = '';
  dom.importSummaryText.textContent = '';
  dom.importList.replaceChildren();
  dom.importTagsInput.value = '';
  dom.importUploaderInput.value = storedName();
  dom.importDrop.classList.remove('is-dragging');
  hideProgress('import');
  syncImportSubmit();
}

function syncImportSubmit() {
  dom.importSubmit.disabled =
    state.importBusy || !state.importPending || state.importPending.items.length === 0;
}

function openImport() {
  resetImport();
  showDialog(dom.importDialog);
  setTimeout(() => dom.importDrop.focus(), 40);
}

function normalizeArchivePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function basename(value) {
  return normalizeArchivePath(value).split('/').pop() || '';
}

async function collectFromZip(file, items, skipped, limit) {
  let zip;
  try {
    zip = await readZip(await file.arrayBuffer());
  } catch (error) {
    skipped.push(`${file.name}：${error.message}`);
    return false;
  }

  const entries = zip.entries;
  const byName = new Map();
  const byBase = new Map();
  for (const entry of entries) {
    byName.set(normalizeArchivePath(entry.name), entry);
    const base = basename(entry.name);
    if (base && !byBase.has(base)) byBase.set(base, entry);
  }

  const manifestEntry =
    entries.find((entry) => basename(entry.name).toLowerCase() === 'manifest.json') || null;
  let manifest = null;
  if (manifestEntry) {
    try {
      const parsed = JSON.parse(manifestEntry.text());
      if (parsed && parsed.format === 'memepack/v1' && Array.isArray(parsed.memes)) manifest = parsed;
    } catch {
      // A malformed manifest falls back to scanning the archive for images.
    }
  }

  if (manifest) {
    for (const meta of manifest.memes) {
      if (items.length >= limit) {
        skipped.push(`已达到 ${limit} 张上限，其余未读取`);
        break;
      }
      const target = normalizeArchivePath(meta?.file || '');
      const entry = byName.get(target) || byBase.get(basename(target));
      if (!entry) {
        skipped.push(`「${meta?.title || basename(target) || '未知文件'}」缺少图片文件`);
        continue;
      }
      const mime = mimeForName(entry.name) || (String(meta?.mime).startsWith('image/') ? meta.mime : '');
      if (!mime || !entry.data?.byteLength) {
        skipped.push(`「${entry.name}」不是支持的图片`);
        continue;
      }
      items.push({
        source: 'pack',
        filename: basename(entry.name),
        title: String(meta?.title || titleFromFilename(entry.name)).slice(0, 80),
        tags: Array.isArray(meta?.tags) ? meta.tags : [],
        uploader: String(meta?.uploader || '').slice(0, 24),
        createdAt: meta?.createdAt,
        comments: Array.isArray(meta?.comments) ? meta.comments.slice(0, 200) : [],
        mime,
        data: entry.data
      });
    }
    return { pack: true, exportedAt: manifest.exportedAt || '', count: items.length };
  }

  let found = 0;
  for (const entry of entries) {
    if (items.length >= limit) {
      skipped.push(`已达到 ${limit} 张上限，其余未读取`);
      break;
    }
    const base = basename(entry.name);
    if (!base || base.startsWith('.') || entry.name.includes('__MACOSX/')) continue;
    if (!isSupportedImageName(base) || !entry.data?.byteLength) continue;
    if (entry.size > state.config.maxUploadBytes) {
      skipped.push(`「${base}」超过大小限制`);
      continue;
    }
    items.push({
      source: 'pack',
      filename: base,
      title: titleFromFilename(base),
      tags: [],
      uploader: '',
      createdAt: '',
      comments: [],
      mime: mimeForName(base),
      data: entry.data
    });
    found += 1;
  }
  return { pack: false, count: found, exportedAt: '' };
}

async function handleImportFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const seq = ++state.importSeq;
  const limit = state.config.maxImportItems || 300;
  const items = [];
  const skipped = [];
  let packInfo = null;
  let totalImages = 0;

  state.importPending = null;
  syncImportSubmit();
  dom.importPreview.hidden = false;
  dom.importSummaryTitle.textContent = '正在读取文件…';
  dom.importSummaryText.textContent = '较大的 ZIP 需要一点时间，请不要关闭页面。';
  dom.importList.replaceChildren();

  for (let index = 0; index < files.length; index += 1) {
    if (seq !== state.importSeq) return;
    const file = files[index];
    setProgress('import', 5 + (index / files.length) * 75, `正在读取 ${index + 1} / ${files.length}：${file.name}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (seq !== state.importSeq) return;

    if (isZipFile(file)) {
      const info = await collectFromZip(file, items, skipped, limit);
      if (seq !== state.importSeq) return;
      if (info && info.pack && !packInfo) packInfo = info;
      if (info && info.count) totalImages += info.count;
    } else {
      const mime = (file.type && ALLOWED_MIME.has(file.type) ? file.type : '') || mimeForName(file.name);
      if (!mime) {
        skipped.push(`${file.name}：不是支持的图片`);
        continue;
      }
      if (file.size > state.config.maxUploadBytes) {
        skipped.push(
          `${file.name}：超过 ${Math.round(state.config.maxUploadBytes / 1024 / 1024)} MB`
        );
        continue;
      }
      if (items.length >= limit) {
        skipped.push(`已达到 ${limit} 张上限，其余未读取`);
        break;
      }
      items.push({
        source: 'file',
        file,
        filename: file.name,
        title: titleFromFilename(file.name),
        tags: [],
        uploader: '',
        createdAt: '',
        comments: [],
        mime
      });
    }
  }

  if (seq !== state.importSeq) return;
  hideProgress('import');

  if (!items.length) {
    dom.importSummaryTitle.textContent = '没有可导入的图片';
    dom.importSummaryText.textContent = skipped[0] || '换一个 ZIP 或图片试试。';
    toast(skipped[0] || '没有找到可导入的图片', 'error', 5200);
    syncImportSubmit();
    return;
  }

  state.importPending = { items, skipped, packInfo, totalImages };
  renderImportPreview();
  syncImportSubmit();
}

function renderImportPreview() {
  const pending = state.importPending;
  if (!pending) return;
  const totalBytes = pending.items.reduce(
    (sum, item) => sum + (item.source === 'file' ? item.file.size : item.data.byteLength),
    0
  );
  const comments = pending.items.reduce((sum, item) => sum + (item.comments?.length || 0), 0);

  dom.importPreview.hidden = false;
  dom.importSummaryTitle.textContent = pending.packInfo?.pack
    ? `本站导出包 · ${pending.items.length} 张`
    : `待导入 · ${pending.items.length} 张`;
  const bits = [`约 ${formatBytes(totalBytes)}`];
  if (comments) bits.push(`${comments} 条评论`);
  if (pending.skipped.length) bits.push(`跳过 ${pending.skipped.length} 个文件`);
  if (pending.packInfo?.exportedAt) bits.push(`导出于 ${formatDate(pending.packInfo.exportedAt)}`);
  dom.importSummaryText.textContent = bits.join(' · ');

  const list = document.createDocumentFragment();
  for (const item of pending.items.slice(0, 8)) {
    const li = document.createElement('li');
    li.textContent = item.title || item.filename;
    list.append(li);
  }
  if (pending.items.length > 8) {
    const li = document.createElement('li');
    li.textContent = `…还有 ${pending.items.length - 8} 张`;
    list.append(li);
  }
  for (const reason of pending.skipped.slice(0, 3)) {
    const li = document.createElement('li');
    li.textContent = `跳过：${reason}`;
    list.append(li);
  }
  dom.importList.replaceChildren(list);
}

async function submitImport() {
  if (state.importBusy || !state.importPending?.items.length) return;
  const pending = state.importPending;
  const defaults = {
    tags: parseTags(dom.importTagsInput.value),
    uploader: dom.importUploaderInput.value.trim()
  };
  rememberName(defaults.uploader);

  state.importBusy = true;
  syncImportSubmit();
  dom.importInput.disabled = true;

  let imported = 0;
  let skipped = pending.skipped.length;
  const errors = [];
  const groups = groupBySize(
    pending.items,
    15,
    40 * 1024 * 1024,
    (item) => (item.source === 'file' ? item.file.size : item.data.byteLength)
  );
  let processed = 0;

  try {
    for (let index = 0; index < groups.length; index += 1) {
      if (state.importBusy === false) break;
      const group = groups[index];
      const memes = [];
      for (const item of group) {
        try {
          let dataUrl;
          if (item.source === 'pack') dataUrl = dataUrlFromBytes(item.data, item.mime);
          else dataUrl = await readFileAsDataUrl(item.file);
          const payload = {
            filename: item.filename,
            title: item.source === 'pack' ? item.title || '' : titleFromFilename(item.filename),
            dataUrl
          };
          if (item.source === 'pack') {
            payload.tags = item.tags;
            payload.uploader = item.uploader || defaults.uploader;
            if (item.createdAt) payload.createdAt = item.createdAt;
            if (item.comments?.length) payload.comments = item.comments;
          } else {
            payload.tags = defaults.tags;
            payload.uploader = defaults.uploader;
          }
          memes.push(payload);
        } catch (error) {
          errors.push(error.message);
        }
      }

      if (memes.length) {
        setProgress(
          'import',
          (processed / pending.items.length) * 95,
          `正在导入第 ${index + 1} / ${groups.length} 组…`
        );
        try {
          const result = await api('/api/import', { method: 'POST', body: { memes } });
          imported += result.imported?.length || 0;
          skipped += result.skipped?.length || 0;
          for (const failure of result.errors || []) {
            errors.push(failure.title ? `${failure.title}：${failure.message}` : failure.message);
          }
          rememberOwned(result.imported);
        } catch (error) {
          errors.push(error.message);
          break;
        }
      }
      processed += group.length;
      setProgress('import', (processed / pending.items.length) * 95, `已处理 ${processed} / ${pending.items.length} 张`);
    }

    if (!imported && !skipped) {
      setProgress('import', 100, `导入失败：${errors[0] || '请稍后再试'}`);
      toast(errors[0] || '导入失败，请稍后再试', 'error', 5400);
      return;
    }

    setProgress('import', 100, `完成：导入 ${imported} 张${skipped ? `，跳过 ${skipped} 张` : ''}`);
    const parts = [`导入 ${imported} 张`];
    if (skipped) parts.push(`跳过 ${skipped} 张`);
    if (errors.length) parts.push(`${errors.length} 张失败`);
    toast(parts.join('，'), errors.length ? 'info' : 'success');
    dom.importDialog.close();
    resetImport();
    await refreshAll();
  } finally {
    state.importBusy = false;
    syncImportSubmit();
    dom.importInput.disabled = false;
  }
}

/* =========================================================
   Detail, ratings, comments
   ========================================================= */

function resetDetailUI() {
  dom.detailImg.removeAttribute('src');
  dom.detailImg.alt = '';
  dom.detailLoading.hidden = false;
  dom.detailLoading.textContent = '正在打开表情…';
  dom.detailTitle.textContent = '正在加载…';
  dom.detailKicker.textContent = '表情详情';
  dom.detailMeta.replaceChildren();
  dom.detailTags.replaceChildren();
  dom.detailAvg.textContent = '—';
  dom.detailRatingText.textContent = '还没有人打分，来做第一个';
  dom.commentList.replaceChildren();
  dom.detailCommentCount.textContent = '0';
  dom.commentBody.value = '';
  dom.commentCount.textContent = '0 / 500';
  dom.detailDelete.hidden = true;
  dom.detailDownload.href = '#';
  dom.starRow.querySelectorAll('.star-btn').forEach((button) => {
    button.classList.remove('is-on');
    button.setAttribute('aria-checked', 'false');
  });
}

async function openDetail(id, { push = true } = {}) {
  if (!id) return;
  if (state.detailId === id && dom.detailDialog.open) return;
  state.detailId = id;
  state.detail = null;
  const seq = ++state.detailSeq;
  resetDetailUI();
  showDialog(dom.detailDialog);

  const hash = `#m/${id}`;
  if (push && location.hash !== hash) {
    try {
      history.pushState({ meme: id }, '', `${location.pathname}${location.search}${hash}`);
    } catch {
      // Ignore.
    }
  }

  try {
    const meme = await api(`/api/memes/${id}?visitor=${encodeURIComponent(getVisitorId())}`);
    if (seq !== state.detailSeq) return;
    state.detail = meme;
    fillDetail(meme);
  } catch (error) {
    if (seq !== state.detailSeq) return;
    toast(error.message, 'error');
    dom.detailDialog.close();
  }
}

function fillDetail(meme) {
  dom.detailImg.src = meme.url;
  dom.detailImg.alt = meme.title || '表情包';
  dom.detailTitle.textContent = meme.title || '未命名表情';
  dom.detailKicker.textContent = `表情详情 · ${mimeLabel(meme.mime)}`;

  const meta = [
    meme.uploader || '匿名',
    formatDate(meme.createdAt),
    formatBytes(meme.size),
    meme.width && meme.height ? `${meme.width}×${meme.height}` : ''
  ].filter(Boolean);
  const metaNodes = meta.map((text, index) => {
    const span = document.createElement('span');
    if (index > 0) span.className = 'dot';
    span.textContent = text;
    return span;
  });
  dom.detailMeta.replaceChildren(...metaNodes);

  const tagNodes = (meme.tags || []).map((tag) => {
    const span = document.createElement('span');
    span.className = 'mini-tag';
    span.textContent = `#${tag}`;
    return span;
  });
  dom.detailTags.replaceChildren(...tagNodes);

  updateRatingDisplay(meme);
  dom.detailRatingText.textContent = ratingText(meme);
  paintCurrentStars();

  renderComments(meme);
  const canDelete = state.isAdmin || Boolean(ownedToken(meme.id));
  dom.detailDelete.hidden = !canDelete;

  const ext = extensionOf(meme.url) || 'png';
  dom.detailDownload.href = meme.url;
  dom.detailDownload.download = `${safeFilename(meme.title)}.${ext}`;
  document.title = `${meme.title || '表情'} · 表情包仓库`;
}

function updateRatingDisplay(meme) {
  dom.detailAvg.textContent = meme.avgRating == null ? '—' : Number(meme.avgRating).toFixed(1);
  dom.detailRatingText.textContent = ratingText(meme);
}

function ratingText(meme) {
  const count = Number(meme.ratingCount || 0);
  if (meme.myRating) return `你打了 ${meme.myRating} 星 · ${count} 人参与`;
  if (count) return `已有 ${count} 人打分`;
  return '还没有人打分，来做第一个';
}

function paintStars(value, preview = false, selected = value) {
  const score = Number(value) || 0;
  dom.starRow.querySelectorAll('.star-btn').forEach((button) => {
    const on = Number(button.dataset.score) <= score;
    button.classList.toggle('is-on', on);
    if (!preview) {
      button.setAttribute('aria-checked', String(button.dataset.score === String(selected)));
    }
  });
}

function paintCurrentStars() {
  const average = Math.round(Number(state.detail?.avgRating) || 0);
  paintStars(state.detail?.myRating || average, false, state.detail?.myRating || 0);
}

function renderComments(meme) {
  const comments = Array.isArray(meme.comments) ? meme.comments : [];
  const count = Number(meme.commentCount ?? comments.length) || 0;
  dom.detailCommentCount.textContent = numberFormat.format(count);

  if (!comments.length) {
    const empty = document.createElement('li');
    empty.className = 'comment-empty';
    empty.textContent = '还没有评论，来抢个沙发。';
    dom.commentList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const comment of comments) {
    const item = document.createElement('li');
    item.className = 'comment-item';

    const avatar = document.createElement('span');
    avatar.className = 'comment-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = Array.from(comment.author || '匿')[0] || '匿';

    const main = document.createElement('div');
    main.className = 'comment-main';

    const top = document.createElement('div');
    top.className = 'comment-top';
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = comment.author || '匿名';
    const time = document.createElement('time');
    time.className = 'comment-time';
    time.dateTime = comment.createdAt;
    time.title = formatDate(comment.createdAt);
    time.textContent = timeAgo(comment.createdAt);
    top.append(author, time);

    const body = document.createElement('p');
    body.className = 'comment-body';
    body.textContent = comment.body;

    main.append(top, body);

    if (state.isAdmin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'comment-delete';
      remove.textContent = '删除评论';
      remove.addEventListener('click', () => deleteComment(comment.id));
      main.append(remove);
    }

    item.append(avatar, main);
    fragment.append(item);
  }
  dom.commentList.replaceChildren(fragment);
}

async function rateMeme(value) {
  if (!state.detail || state.ratingBusy) return;
  state.ratingBusy = true;
  dom.starRow.querySelectorAll('.star-btn').forEach((button) => {
    button.disabled = true;
  });
  try {
    const result = await api(`/api/memes/${state.detail.id}/rating`, {
      method: 'POST',
      body: { visitor: getVisitorId(), value }
    });
    state.detail.avgRating = result.avgRating;
    state.detail.ratingCount = result.ratingCount;
    state.detail.myRating = result.myRating;
    updateRatingDisplay(state.detail);
    paintStars(result.myRating || 0);
    patchCardRating(state.detail);
    loadStats();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.ratingBusy = false;
    dom.starRow.querySelectorAll('.star-btn').forEach((button) => {
      button.disabled = false;
    });
  }
}

function patchCardRating(meme) {
  const item = state.items.find((entry) => entry.id === meme.id);
  if (item) {
    item.avgRating = meme.avgRating;
    item.ratingCount = meme.ratingCount;
  }
  const card = dom.galleryGrid.querySelector(`.meme-card[data-id="${meme.id}"]`);
  if (!card) return;
  $('.meme-rating strong', card).textContent =
    meme.avgRating == null ? '—' : Number(meme.avgRating).toFixed(1);
  $('.meme-rating-count', card).textContent = meme.ratingCount
    ? `(${numberFormat.format(meme.ratingCount)})`
    : '';
}

function patchCardComments(meme, count) {
  const item = state.items.find((entry) => entry.id === meme.id);
  if (item) item.commentCount = count;
  const card = dom.galleryGrid.querySelector(`.meme-card[data-id="${meme.id}"]`);
  if (card) $('.meme-comments span', card).textContent = numberFormat.format(count || 0);
}

function updateCharCount() {
  dom.commentCount.textContent = `${Array.from(dom.commentBody.value).length} / 500`;
}

async function submitComment(event) {
  event.preventDefault();
  if (!state.detail) return;
  const body = dom.commentBody.value.trim();
  if (!body) {
    toast('写点什么再发吧', 'info');
    dom.commentBody.focus();
    return;
  }
  const author = dom.commentAuthor.value.trim();
  rememberName(author);

  setBusy(dom.commentSubmit, true);
  try {
    const result = await api(`/api/memes/${state.detail.id}/comments`, {
      method: 'POST',
      body: { author, body }
    });
    state.detail.comments = [result.comment, ...(state.detail.comments || [])];
    state.detail.commentCount = result.commentCount;
    renderComments(state.detail);
    patchCardComments(state.detail, result.commentCount);
    dom.commentBody.value = '';
    updateCharCount();
    toast('评论已发布', 'success', 2400);
    loadStats();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(dom.commentSubmit, false);
  }
}

async function deleteComment(commentId) {
  if (!state.isAdmin || !state.detail) return;
  const confirmed = await askConfirm({
    title: '删除这条评论？',
    message: '删除后无法恢复。',
    okText: '删除评论'
  });
  if (!confirmed) return;
  try {
    await api(`/api/comments/${commentId}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': state.adminToken }
    });
    state.detail.comments = (state.detail.comments || []).filter((comment) => comment.id !== commentId);
    state.detail.commentCount = Math.max(0, (state.detail.commentCount || 1) - 1);
    renderComments(state.detail);
    patchCardComments(state.detail, state.detail.commentCount);
    toast('评论已删除', 'success', 2200);
    loadStats();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteMeme(meme) {
  if (!meme) return;
  const token = ownedToken(meme.id);
  if (!token && !state.isAdmin) {
    toast('只有上传者或管理员可以删除这张表情', 'error');
    return;
  }
  const confirmed = await askConfirm({
    title: '删除这张表情？',
    message: `「${meme.title || '未命名表情'}」和它的评论都会消失，无法恢复。`,
    okText: '删除表情'
  });
  if (!confirmed) return;

  const headers = {};
  if (token) headers['x-delete-token'] = token;
  if (state.isAdmin) headers['x-admin-token'] = state.adminToken;

  try {
    await api(`/api/memes/${meme.id}`, { method: 'DELETE', headers });
    forgetOwned(meme.id);
    dom.detailDialog.close();
    toast('表情已删除', 'success');
    await refreshAll();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* =========================================================
   Admin & settings
   ========================================================= */

function updateAdminUI() {
  if (state.isAdmin) {
    dom.adminStatus.textContent = '管理员模式已开启 · 可以删除任意内容';
    dom.adminStatus.classList.add('is-admin');
  } else if (state.adminConfigured === false) {
    dom.adminStatus.textContent = '服务器没有设置 ADMIN_TOKEN，管理员功能不可用';
    dom.adminStatus.classList.remove('is-admin');
  } else {
    dom.adminStatus.textContent = '当前是访客模式';
    dom.adminStatus.classList.remove('is-admin');
  }
  dom.adminClearBtn.disabled = !state.adminToken;

  if (state.detail) {
    renderComments(state.detail);
    dom.detailDelete.hidden = !(state.isAdmin || ownedToken(state.detail.id));
  }
}

async function initAdmin() {
  const token = state.adminToken;
  try {
    const result = await api('/api/admin/check', {
      headers: token ? { 'x-admin-token': token } : {}
    });
    state.adminConfigured = Boolean(result.configured);
    if (result.admin && token) {
      state.isAdmin = true;
      state.adminToken = token;
    } else {
      state.isAdmin = false;
      if (token) {
        state.adminToken = '';
        storeRemove(sessionStorage, ADMIN_KEY);
      }
    }
  } catch {
    state.isAdmin = false;
  }
  updateAdminUI();
}

async function saveAdminToken() {
  const token = dom.adminTokenInput.value.trim();
  if (!token) {
    toast('先粘贴管理员密钥', 'info');
    dom.adminTokenInput.focus();
    return;
  }
  setBusy(dom.adminSaveBtn, true);
  try {
    const result = await api('/api/admin/check', { headers: { 'x-admin-token': token } });
    state.adminConfigured = Boolean(result.configured);
    if (result.admin) {
      state.adminToken = token;
      state.isAdmin = true;
      storeSet(sessionStorage, ADMIN_KEY, token);
      dom.adminTokenInput.value = '';
      updateAdminUI();
      toast('管理员模式已开启', 'success');
    } else if (result.configured === false) {
      toast('服务器没有设置 ADMIN_TOKEN，请先在环境变量里配置', 'error', 5200);
    } else {
      toast('密钥不正确', 'error');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(dom.adminSaveBtn, false);
  }
}

function clearAdminToken() {
  state.adminToken = '';
  state.isAdmin = false;
  storeRemove(sessionStorage, ADMIN_KEY);
  updateAdminUI();
  toast('已退出管理员模式', 'info', 2600);
}

function openSettings() {
  dom.adminTokenInput.value = '';
  updateAdminUI();
  if (state.stats) updateStatsDisplay(state.stats);
  showDialog(dom.settingsDialog);
}

/* =========================================================
   Confirm dialog
   ========================================================= */

let confirmState = null;

function askConfirm({ title, message, okText = '确认删除' }) {
  if (confirmState) {
    confirmState.resolve(false);
    confirmState = null;
  }
  return new Promise((resolve) => {
    confirmState = { resolve };
    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    dom.confirmOk.textContent = okText;
    showDialog(dom.confirmDialog);
    setTimeout(() => dom.confirmOk.focus(), 40);
  });
}

/* =========================================================
   Demo pack
   ========================================================= */

function makeDemoImage({ emoji, caption, background }) {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建画布');

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 480, 480);

  ctx.strokeStyle = '#1f1b16';
  ctx.lineWidth = 10;
  ctx.strokeRect(16, 16, 448, 448);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '150px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  ctx.fillText(emoji, 240, 205);

  ctx.font = '900 42px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
  const textWidth = Math.min(340, ctx.measureText(caption).width + 56);
  const x = (480 - textWidth) / 2;
  ctx.fillStyle = '#fffdf7';
  ctx.strokeStyle = '#1f1b16';
  ctx.lineWidth = 5;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, 336, textWidth, 70, 35);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(x, 336, textWidth, 70);
    ctx.strokeRect(x, 336, textWidth, 70);
  }
  ctx.fillStyle = '#1f1b16';
  ctx.fillText(caption, 240, 373);

  return canvas.toDataURL('image/png');
}

async function addDemoMemes() {
  if (state.demoBusy) return;
  state.demoBusy = true;
  dom.demoBtn.disabled = true;
  const demos = [
    { emoji: '🤣', caption: '笑死', background: '#ffd25e', tags: ['示例', '爆笑'] },
    { emoji: '😎', caption: '好耶', background: '#c9b8ff', tags: ['示例', '开心'] },
    { emoji: '🫠', caption: '无语', background: '#9fe3d8', tags: ['示例', '无语'] },
    { emoji: '🥹', caption: '破防', background: '#ffb3a7', tags: ['示例', '破防'] },
    { emoji: '🤝', caption: '收到', background: '#bfe3a0', tags: ['示例', '收到'] },
    { emoji: '🐟', caption: '摸鱼', background: '#a8d0ff', tags: ['示例', '摸鱼'] }
  ];
  try {
    const files = demos.map((demo, index) => ({
      filename: `demo-${index + 1}.png`,
      title: demo.caption,
      tags: demo.tags,
      dataUrl: makeDemoImage(demo)
    }));
    const result = await api('/api/memes', {
      method: 'POST',
      body: { files, tags: ['示例'], uploader: '' }
    });
    rememberOwned(result.items);
    toast(`放好了 ${result.items?.length || 0} 张示例，开始玩吧`, 'success');
    await refreshAll();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.demoBusy = false;
    dom.demoBtn.disabled = false;
  }
}

/* =========================================================
   Theme
   ========================================================= */

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  dom.themeToggle.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
  dom.themeToggle.title = dark ? '切换到浅色模式' : '切换到深色模式';
}

function setTheme(theme, persist = true) {
  const value = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  if (persist) storeSet(localStorage, THEME_KEY, value);
  updateThemeButton();
  const color = value === 'dark' ? '#17130f' : '#f7f2e8';
  $$('meta[name="theme-color"]').forEach((meta) => meta.setAttribute('content', color));
}

function initTheme() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  updateThemeButton();
  const saved = storeGet(localStorage, THEME_KEY);
  if (!saved && window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', (event) => {
      if (!storeGet(localStorage, THEME_KEY)) setTheme(event.matches ? 'dark' : 'light', false);
    });
  }
  setTheme(current, false);
}

/* =========================================================
   Boot & events
   ========================================================= */

async function initMeta() {
  const [configResult, healthResult] = await Promise.allSettled([
    api('/api/config'),
    api('/api/health')
  ]);
  if (configResult.status === 'fulfilled' && configResult.value) {
    state.config = { ...DEFAULT_CONFIG, ...configResult.value };
  }
  if (healthResult.status === 'fulfilled' && healthResult.value?.version) {
    state.version = healthResult.value.version;
  }
  const version = `v${state.version}`;
  dom.footerVersion.textContent = version;
  dom.aboutVersion.textContent = version;
  const uploadMb = Math.max(1, Math.round(state.config.maxUploadBytes / 1024 / 1024));
  $$('[data-max-upload]').forEach((node) => {
    node.textContent = String(uploadMb);
  });
  $$('[data-max-import]').forEach((node) => {
    node.textContent = String(state.config.maxImportItems || 300);
  });
}

function routeMemeId() {
  const match = /^#m\/([0-9a-fA-F-]{36})$/.exec(location.hash);
  return match ? match[1].toLowerCase() : '';
}

function handleRoute() {
  const id = routeMemeId();
  if (id) {
    if (!dom.detailDialog.open || state.detailId !== id) openDetail(id, { push: false });
  } else if (dom.detailDialog.open) {
    dom.detailDialog.close();
  }
}

function bindEvents() {
  dom.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    applyFilters();
  });

  let searchTimer = 0;
  dom.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 280);
  });

  dom.sortSelect.addEventListener('change', applyFilters);

  dom.selectModeBtn.addEventListener('click', () => setSelectionMode(!state.selectionMode));
  dom.clearSelectionBtn.addEventListener('click', () => setSelectionMode(false));
  dom.exportSelectedBtn.addEventListener('click', exportSelection);

  dom.loadMoreBtn.addEventListener('click', async () => {
    dom.loadMoreBtn.disabled = true;
    await loadMemes();
    dom.loadMoreBtn.disabled = false;
  });

  $$('[data-open-upload]').forEach((button) => button.addEventListener('click', openUpload));
  $$('[data-open-import]').forEach((button) => button.addEventListener('click', openImport));
  dom.uploadBtn.addEventListener('click', openUpload);
  dom.importBtn.addEventListener('click', openImport);
  dom.settingsBtn.addEventListener('click', openSettings);
  dom.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(next, true);
  });
  dom.demoBtn.addEventListener('click', addDemoMemes);

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      if (dialog) closeDialogSafely(dialog);
    });
  });

  document.addEventListener('click', (event) => {
    const dialog = event.target;
    if (dialog instanceof HTMLDialogElement && dialog.classList.contains('modal')) {
      closeDialogSafely(dialog);
    }
  });

  for (const dialog of [dom.uploadDialog, dom.importDialog, dom.detailDialog, dom.settingsDialog, dom.confirmDialog]) {
    dialog.addEventListener('close', syncLock);
  }
  dom.uploadDialog.addEventListener('cancel', (event) => {
    if (state.uploadBusy) {
      event.preventDefault();
      toast('正在上传，请稍等片刻…');
    }
  });
  dom.importDialog.addEventListener('cancel', (event) => {
    if (state.importBusy) {
      event.preventDefault();
      toast('正在导入，请稍等片刻…');
    }
  });

  dom.uploadDrop.addEventListener('click', () => dom.uploadInput.click());
  dom.uploadDrop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dom.uploadInput.click();
    }
  });
  dom.uploadInput.addEventListener('change', () => {
    addUploadFiles(dom.uploadInput.files);
    dom.uploadInput.value = '';
  });
  let uploadDragDepth = 0;
  dom.uploadDrop.addEventListener('dragenter', (event) => {
    event.preventDefault();
    uploadDragDepth += 1;
    dom.uploadDrop.classList.add('is-dragging');
  });
  dom.uploadDrop.addEventListener('dragover', (event) => event.preventDefault());
  dom.uploadDrop.addEventListener('dragleave', () => {
    uploadDragDepth = Math.max(0, uploadDragDepth - 1);
    if (!uploadDragDepth) dom.uploadDrop.classList.remove('is-dragging');
  });
  dom.uploadDrop.addEventListener('drop', (event) => {
    event.preventDefault();
    uploadDragDepth = 0;
    dom.uploadDrop.classList.remove('is-dragging');
    addUploadFiles(event.dataTransfer?.files);
  });
  dom.uploadSubmit.addEventListener('click', submitUpload);

  document.addEventListener('paste', (event) => {
    if (!dom.uploadDialog.open) return;
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    addUploadFiles(files);
  });

  dom.importDrop.addEventListener('click', () => dom.importInput.click());
  dom.importDrop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dom.importInput.click();
    }
  });
  dom.importInput.addEventListener('change', () => {
    const files = [...dom.importInput.files];
    dom.importInput.value = '';
    handleImportFiles(files);
  });
  let importDragDepth = 0;
  dom.importDrop.addEventListener('dragenter', (event) => {
    event.preventDefault();
    importDragDepth += 1;
    dom.importDrop.classList.add('is-dragging');
  });
  dom.importDrop.addEventListener('dragover', (event) => event.preventDefault());
  dom.importDrop.addEventListener('dragleave', () => {
    importDragDepth = Math.max(0, importDragDepth - 1);
    if (!importDragDepth) dom.importDrop.classList.remove('is-dragging');
  });
  dom.importDrop.addEventListener('drop', (event) => {
    event.preventDefault();
    importDragDepth = 0;
    dom.importDrop.classList.remove('is-dragging');
    handleImportFiles(event.dataTransfer?.files);
  });
  dom.importSubmit.addEventListener('click', submitImport);

  dom.detailDialog.addEventListener('close', () => {
    state.detailSeq += 1;
    state.detail = null;
    state.detailId = null;
    document.title = BASE_TITLE;
    if (location.hash.startsWith('#m/')) {
      try {
        history.replaceState(history.state, '', `${location.pathname}${location.search}`);
      } catch {
        // Ignore.
      }
    }
  });
  dom.detailImg.addEventListener('load', () => {
    dom.detailLoading.hidden = true;
  });
  dom.detailImg.addEventListener('error', () => {
    dom.detailLoading.hidden = false;
    dom.detailLoading.textContent = '图片加载失败';
  });

  dom.starRow.addEventListener('click', (event) => {
    const button = event.target.closest('.star-btn');
    if (button) rateMeme(Number(button.dataset.score));
  });
  dom.starRow.addEventListener('pointerover', (event) => {
    const button = event.target.closest('.star-btn');
    if (button) paintStars(Number(button.dataset.score), true);
  });
  dom.starRow.addEventListener('pointerleave', () => {
    paintCurrentStars();
  });

  dom.commentForm.addEventListener('submit', submitComment);
  dom.commentBody.addEventListener('input', updateCharCount);
  dom.commentBody.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      dom.commentForm.requestSubmit();
    }
  });

  dom.detailDelete.addEventListener('click', () => deleteMeme(state.detail));
  dom.detailCopy.addEventListener('click', async () => {
    if (!state.detail) return;
    const url = `${location.origin}${location.pathname}${location.search}#m/${state.detail.id}`;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.append(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      toast('链接已复制，分享给朋友吧', 'success', 2400);
    } catch {
      toast('复制失败，请手动复制地址栏链接', 'error');
    }
  });

  dom.adminSaveBtn.addEventListener('click', saveAdminToken);
  dom.adminClearBtn.addEventListener('click', clearAdminToken);
  dom.adminTokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveAdminToken();
    }
  });

  dom.exportAllBtn.addEventListener('click', async () => {
    if (state.exportBusy) return;
    if (!state.stats?.memes) {
      toast('仓库还是空的，先上传几张吧', 'info');
      return;
    }
    state.exportBusy = true;
    setBusy(dom.exportAllBtn, true);
    try {
      const result = await downloadExport(null);
      toast(`已导出 ${result.count} 张表情`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.exportBusy = false;
      setBusy(dom.exportAllBtn, false);
    }
  });
  dom.settingsImportBtn.addEventListener('click', () => {
    dom.settingsDialog.close();
    openImport();
  });

  dom.confirmOk.addEventListener('click', () => {
    const current = confirmState;
    confirmState = null;
    dom.confirmDialog.close();
    current?.resolve(true);
  });
  dom.confirmCancel.addEventListener('click', () => dom.confirmDialog.close());
  dom.confirmDialog.addEventListener('close', () => {
    if (confirmState) {
      confirmState.resolve(false);
      confirmState = null;
    }
  });

  window.addEventListener('popstate', handleRoute);
  window.addEventListener('hashchange', handleRoute);

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    dom.searchInput.focus();
    dom.searchInput.select();
  });
}

async function init() {
  bindEvents();
  initTheme();

  const params = new URLSearchParams(location.search);
  state.q = (params.get('q') || '').slice(0, 80);
  state.tag = (params.get('tag') || '').slice(0, 40);
  const sort = params.get('sort');
  state.sort = sort === 'hot' || sort === 'rating' ? sort : 'new';
  dom.searchInput.value = state.q;
  dom.sortSelect.value = state.sort;
  dom.libraryTitle.textContent = state.q ? '搜索结果' : state.tag ? `#${state.tag}` : '全部表情';
  dom.uploaderInput.value = storedName();
  dom.importUploaderInput.value = storedName();
  dom.commentAuthor.value = storedName();
  updateCharCount();
  updateSelectionUI();

  await initMeta();
  await Promise.allSettled([loadStats(), loadMemes({ reset: true })]);
  await initAdmin();

  const id = routeMemeId();
  if (id) openDetail(id, { push: false });
}

init();
