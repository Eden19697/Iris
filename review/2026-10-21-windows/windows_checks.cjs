// Defensive regression probes (after hardening). Synthetic fixtures + isolated profile only.
// 运行(在 windows/ 目录,先 npm install && npm run reader):
//   .\node_modules\electron\dist\electron.exe ..\review\2026-10-21-windows\windows_checks.cjs
// 需要未设置 ELECTRON_RUN_AS_NODE。结果写入同目录的 windows-results.json(已被 .gitignore 忽略)。
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '../../windows');
const { buildBundle, makeZip } = require(path.join(root, 'app/bundle'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-audit2-'));
app.setPath('userData', path.join(tmp, 'profile'));
fs.mkdirSync(app.getPath('userData'));
fs.writeFileSync(path.join(app.getPath('userData'), 'recent.json'), '[null,{},"relative.md",42]');   // 故意损坏
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// ---- fixtures ----
fs.mkdirSync(path.join(tmp, 'docs/images'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'outside'));
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SYNTHETIC_PRIVATE_CONTENT');
fs.writeFileSync(path.join(tmp, 'outside/evil.png'), png);
fs.writeFileSync(path.join(tmp, 'outside/other.png'), png);
fs.writeFileSync(path.join(tmp, 'docs/images/a.png'), png);
fs.writeFileSync(path.join(tmp, 'docs/notes.txt'), 'not an image');
const note = path.join(tmp, 'docs', 'note.md');
fs.writeFileSync(note, '![ok](images/a.png)\n![s](../secret.txt)\n![t](notes.txt)\n![o](../outside/other.png)\n');
let junction = false;
try { fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'docs/images/link'), 'junction'); junction = true; } catch {}

const result = { runtime: process.versions, fixtureDirectory: tmp, checks: {} };
const c = result.checks;

// 1) 合成:非图片 / 目录外文件 / 目录联接 都不应被收入
const b = buildBundle(note, path.join(tmp, 'docs/images'));
const names = [];
{ // 读回 zip 里的文件名
  const zip = b.zip; let e = zip.length - 22; const n = zip.readUInt16LE(e + 10); let p = zip.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) { const nl = zip.readUInt16LE(p + 28), xl = zip.readUInt16LE(p + 30), cl = zip.readUInt16LE(p + 32); names.push(zip.toString('utf8', p + 46, p + 46 + nl)); p += 46 + nl + xl + cl; }
}
c.bundle = { entries: names, skipped: b.skipped, junctionCreated: junction,
  secretLeaked: names.some(x => /secret|notes\.txt/i.test(x)),
  outsideImageLeaked: names.some(x => /evil|other/i.test(x)) };

// 用真实 main.js,窗口隐藏
const electron = require('electron');
const OriginalWindow = electron.BrowserWindow;
const Module = require('module');
const originalLoad = Module._load;
const hiddenElectron = { ...electron, BrowserWindow: class extends OriginalWindow { constructor(o) { super({ ...o, show: false }); } } };
Module._load = function (id, ...a) { return id === 'electron' ? hiddenElectron : originalLoad.call(this, id, ...a); };
process.argv.push(note);
require(path.join(root, 'app/main'));
Module._load = originalLoad;
const delay = ms => new Promise(r => setTimeout(r, ms));
const js = (w, code) => w.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  const timer = setTimeout(() => { fs.writeFileSync(path.join(__dirname, 'windows-results.json'), JSON.stringify({ ...result, timeout: true }, null, 2)); app.exit(2); }, 60000);
  try {
    const blocked = [];
    session.defaultSession.webRequest.onErrorOccurred(d => { if (/iris-audit\.invalid/.test(d.url)) blocked.push(d.error); });
    const win = BrowserWindow.getAllWindows()[0];
    for (let i = 0; i < 100; i++) { if (await js(win, 'typeof window.loadFromNative === "function"').catch(() => false)) break; await delay(100); }
    c.readerLoaded = await js(win, 'typeof window.loadFromNative === "function"');
    c.readerBridges = await js(win, '({iris: typeof window.iris, irisReader: typeof window.irisReader})');

    // 2) ZIP:CRC / 伪造大小 / 声明过大 / 条目过多 / 正常包
    const corrupt = makeZip([{ name: 'note.md', data: Buffer.from('synthetic crc test') }]);
    corrupt.writeUInt32LE(0, 14); corrupt.writeUInt32LE(0, corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
    const lying = makeZip([{ name: 'note.md', data: Buffer.alloc(8 * 1024 * 1024, 65) }]);   // 实际 8MB,谎报 100 字节
    lying.writeUInt32LE(100, 22); lying.writeUInt32LE(100, lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    const huge = makeZip([{ name: 'note.md', data: Buffer.alloc(101 * 1024 * 1024) }]);      // 声明 101MB > 单文件上限
    const many = makeZip(Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.png`, data: Buffer.from('x') })));
    const good = makeZip([{ name: 'note.md', data: Buffer.from('# ok') }, { name: 'a.png', data: png }]);
    const run = buf => js(win, `(async()=>{ const d=Uint8Array.from(atob(${JSON.stringify(buf.toString('base64'))}),c=>c.charCodeAt(0)).buffer;
      try { const r = await unzip(d); return {accepted:true, entries:r.length} } catch(e) { return {accepted:false, error:e.message} } })()`);
    c.zip = { corruptCRC: await run(corrupt), lyingSize: await run(lying), declaredTooLarge: await run(huge), tooManyEntries: await run(many), valid: await run(good) };

    // 3) 网络请求默认被拒
    await js(win, `window.loadFromNative('<img src="https://iris-audit.invalid/pixel">','tracking.md',''); document.querySelector('#view img').loading='eager';`);
    await delay(700);
    c.remoteRequestsBlockedByDefault = blocked;

    // 4) HTML 文档 iframe 沙箱
    await js(win, `window.loadFromNative('<p>hi</p>','a.html','')`);
    await delay(300);
    c.iframeSandbox = await js(win, `document.querySelector('iframe') && document.querySelector('iframe').getAttribute('sandbox')`);

    // 5) 文档里的本地链接不能让主窗口跳走;本地文档改走受控打开流程
    const target = path.join(tmp, 'navigation-target.html');
    fs.writeFileSync(target, '<!doctype html><title>Synthetic navigation target</title><p id="probe">Synthetic</p>');
    // 与真实流程一致:文档带所在目录作 base,相对链接被改写成绝对路径,点击后应走受控打开而不是主窗口导航
    const baseUrl = require('url').pathToFileURL(path.dirname(target) + path.sep).href;
    await js(win, `window.loadFromNative(${JSON.stringify('[local target](navigation-target.html)')},'link.md',${JSON.stringify(baseUrl)}); document.querySelector('#view a').click();`);
    await delay(1500);
    c.localNavigation = { url: win.webContents.getURL(), title: win.getTitle(), bridgeExposed: await js(win, 'typeof window.iris') };

    // 6) 主页:损坏的近期列表应被清洗,桥只在主页存在
    await win.loadFile(path.join(root, 'app/home.html'));
    c.home = { bridges: await js(win, '({iris: typeof window.iris, irisReader: typeof window.irisReader})'),
      recent: await js(win, 'iris.recent().then(x => ({ok:true,value:x}),e => ({ok:false,error:e.message}))') };
  } catch (e) { result.error = e.stack; }
  clearTimeout(timer);
  fs.writeFileSync(path.join(__dirname, 'windows-results.json'), JSON.stringify(result, null, 2));
  app.exit(result.error ? 1 : 0);
});
