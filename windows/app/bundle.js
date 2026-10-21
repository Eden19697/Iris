// 把 Markdown + 图片文件夹合成 .mdz(zip)。纯 Node,无第三方依赖。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const EXT = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

// 资源上限:防止误选巨大目录把内存吃光
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_MD_BYTES = 20 * 1024 * 1024;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// entries: [{ name: 'a/b.png', data: Buffer }]
function makeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw);
    const deflated = comp.length < raw.length;
    const data = deflated ? comp : raw;
    const method = deflated ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// 不跟随符号链接,也不会因为目录过深/过多而无限遍历
function walk(dir, out = [], depth = 0) {
  if (depth > 12 || out.length > MAX_FILES * 4) return out;
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    const p = path.join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) walk(p, out, depth + 1);
    else if (d.isFile() && IMG.test(d.name)) out.push(p);
  }
  return out;
}
const inside = (base, p) => { const r = path.relative(base, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const posix = p => p.split(path.sep).join('/');
const real = p => { try { return fs.realpathSync.native(p); } catch { return null; } };

// mdPath: .md 文件;imgDir: 图片文件夹(可为空)。
// 返回 { zip, count, missing, skipped, conflicts }
//   missing   引用了但没找到
//   skipped   找到了但出于安全没有收入(不是图片 / 不在允许范围内 / 超限)
//   conflicts 不同位置的同名资源,仅保留第一个
function buildBundle(mdPath, imgDir) {
  const mdDir = path.dirname(mdPath);
  const mdStat = fs.statSync(mdPath);
  if (mdStat.size > MAX_MD_BYTES) throw new Error('Markdown 文件过大(超过 20MB)');
  const text = fs.readFileSync(mdPath);
  const src = text.toString('utf8');

  // 允许收集的范围:所选图片文件夹 + md 所在文件夹(realpath 后比较,符号链接指向范围外会被拒绝)
  const roots = [mdDir, imgDir].filter(Boolean).map(real).filter(Boolean);
  const inRoots = abs => roots.some(r => abs === r || inside(r, abs));

  const files = new Map();   // zip 内路径 -> 磁盘真实路径
  const skipped = [], conflicts = [];
  let total = 0;

  const add = (abs, label) => {
    const rp = real(abs);
    if (!rp || !inRoots(rp) || !IMG.test(rp) || !IMG.test(abs)) { skipped.push(label || abs); return; }
    let st;
    try { st = fs.statSync(rp); } catch { return; }
    if (!st.isFile()) { skipped.push(label || abs); return; }
    const rootMd = real(mdDir), rootImg = imgDir ? real(imgDir) : null;
    const name = inside(rootMd, rp)
      ? posix(path.relative(rootMd, rp))
      : 'assets/' + posix(rootImg && inside(rootImg, rp) ? path.relative(rootImg, rp) : path.basename(rp));
    if (files.has(name)) { if (files.get(name) !== rp) conflicts.push(name); return; }
    if (st.size > MAX_FILE_BYTES || files.size >= MAX_FILES || total + st.size > MAX_TOTAL_BYTES) { skipped.push((label || abs) + '(超出大小/数量上限)'); return; }
    total += st.size;
    files.set(name, rp);
  };

  if (imgDir) for (const f of walk(imgDir)) add(f);

  // md 里引用到的本地图片:只接受范围内的图片文件
  const refs = [...src.matchAll(/!\[[^\]]*\]\(\s*<?([^)>\s]+)/g)].map(m => m[1])
    .concat([...src.matchAll(/<img[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]));
  const missing = [];
  for (const ref of new Set(refs)) {
    if (EXT.test(ref)) continue;
    let rel = ref.split('#')[0].split('?')[0];
    try { rel = decodeURIComponent(rel); } catch {}
    const abs = path.resolve(mdDir, rel);
    if (fs.existsSync(abs)) { add(abs, ref); continue; }
    const leaf = path.basename(rel).toLowerCase();
    if (![...files.keys()].some(k => path.posix.basename(k).toLowerCase() === leaf)) missing.push(ref);
  }

  const mdName = path.basename(mdPath);
  const entries = [{ name: mdName, data: text }];
  for (const [name, rp] of files) {
    if (name === mdName) continue;
    entries.push({ name, data: fs.readFileSync(rp) });
  }
  return { zip: makeZip(entries), count: entries.length - 1, missing, skipped: [...new Set(skipped)], conflicts: [...new Set(conflicts)] };
}

module.exports = { makeZip, buildBundle, crc32 };
