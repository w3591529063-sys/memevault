/**
 * Tiny, dependency-free ZIP reader for the browser.
 *
 * Supports the two compression methods that virtually every meme pack uses:
 * stored (0) and deflate (8). ZIP64 and encrypted archives are rejected with a
 * clear message instead of producing corrupt images.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const MAX_ENTRIES = 1200;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const MAX_ENTRY_BYTES = 60 * 1024 * 1024;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function findEndOfCentralDirectory(view) {
  const minimum = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  // Some writers append junk after the comment. Accept the last signature.
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) {
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      // Fall through to the legacy encodings below.
    }
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    // Legacy ZIPs often carry GBK names without the UTF-8 flag.
  }
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持解压 deflate，请换用新版 Chrome、Edge、Safari 或 Firefox');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel();
      throw new Error('压缩包里有解压后过大的文件，已停止读取');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function toDate(dosDate, dosTime) {
  try {
    const year = 1980 + ((dosDate >> 9) & 0x7f);
    const month = ((dosDate >> 5) & 0x0f) - 1;
    const day = dosDate & 0x1f;
    const hours = (dosTime >> 11) & 0x1f;
    const minutes = (dosTime >> 5) & 0x3f;
    const seconds = (dosTime & 0x1f) * 2;
    return new Date(year, month, day, hours, minutes, seconds).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Read a ZIP archive from an ArrayBuffer / Uint8Array.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{entries: Array<{name: string, data: Uint8Array, size: number,
 *   method: number, lastModified: string, text: () => string}>}>}
 */
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 22) throw new Error('这不是一个有效的 ZIP 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('没有找到 ZIP 目录，文件可能已损坏');

  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  let entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new Error('暂不支持分卷 ZIP 文件');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式，请用普通 ZIP 重新打包');
  }
  if (entryCount === 0) throw new Error('压缩包是空的');
  if (entryCount > MAX_ENTRIES) {
    throw new Error(`压缩包里的文件太多了（${entryCount} 个，最多 ${MAX_ENTRIES} 个）`);
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    throw new Error('ZIP 目录超出了文件范围，文件可能已损坏');
  }

  const entries = [];
  let totalBytes = 0;
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP 目录损坏，无法继续读取');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const dosTime = view.getUint16(offset + 12, true);
    const dosDate = view.getUint16(offset + 14, true);

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error('ZIP 文件名越界，文件可能已损坏');
    const rawName = bytes.subarray(nameStart, nameEnd);
    const name = decodeName(rawName, Boolean(flags & 0x0800)).replace(/\\/g, '/');
    offset = nameEnd + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (!name || name.includes('\0')) continue;
    if (flags & 1) throw new Error(`压缩包里的「${name}」有密码保护，暂不支持`);
    if (method !== 0 && method !== 8) {
      throw new Error(`「${name}」使用了不支持的压缩方式，请用普通 ZIP 重新打包`);
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`「${name}」解压后超过 60 MB，已停止读取`);
    }

    if (
      localOffset + 30 > bytes.byteLength ||
      view.getUint32(localOffset, true) !== LOCAL_SIGNATURE
    ) {
      throw new Error(`「${name}」的本地文件头损坏`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw new Error(`「${name}」的数据越界，文件可能已损坏`);

    const compressed = bytes.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = new Uint8Array(compressed);
    } else {
      data = await inflateRaw(compressed);
    }

    totalBytes += data.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('压缩包解压后超过 300 MB，请分批导入');
    }
    if (uncompressedSize && data.byteLength !== uncompressedSize) {
      throw new Error(`「${name}」解压后大小不一致，文件可能已损坏`);
    }

    entries.push({
      name: name.replace(/^\.\//, ''),
      data,
      size: data.byteLength,
      method,
      lastModified: toDate(dosDate, dosTime),
      text: () => new TextDecoder('utf-8').decode(data)
    });
  }

  return { entries };
}

export function isZipFile(file) {
  if (!file) return false;
  const name = String(file.name || '').toLowerCase();
  return name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}
