const { app, BrowserWindow, Menu, dialog, shell, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { buildBundle } = require('./bundle');

const DOC_RE = /\.(md|markdown|txt|html?|mdz|zip)$/i;
const BUNDLE_RE = /\.(mdz|zip)$/i;
const MAX_PACKAGE = 100 * 1024 * 1024;   // .mdz 最大 100MB(经 base64 送入页面,过大会拖垮内存)
const MAX_TEXT = 20 * 1024 * 1024;       // 单个文本/HTML 最大 20MB

const HOME_URL = pathToFileURL(path.join(__dirname, 'home.html')).href;
const READER_URL = pathToFileURL(path.join(__dirname, 'reader.html')).href;

let win = null;
let view = null;     // 'home' | 'reader'
let ready = false;   // 当前页面脚本已执行完(did-finish-load 时 isLoading() 仍为 true,不能用它判断)
let pending = null;  // 等待当前页面加载完后打开的文件
let allowRemote = false;   // 默认禁止文档发起任何网络请求

const alive = () => !!win && !win.isDestroyed();
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const fileArg = argv => argv.slice(app.isPackaged ? 1 : 2).find(a => DOC_RE.test(a) && isFile(a));

// IPC 只接受应用自己的主页 / 阅读页的顶层 frame
const fromTop = (e, url) => alive() && e.senderFrame === win.webContents.mainFrame && String(e.senderFrame.url).split('#')[0].toLowerCase() === url.toLowerCase();

// ---- 最近打开 ----
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
function cleanRecent(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (typeof p !== 'string' || p.length > 1024 || !path.isAbsolute(p) || !DOC_RE.test(p) || out.includes(p)) continue;
    out.push(p);
    if (out.length >= 10) break;
  }
  return out;
}
function readRecent() {
  try { return cleanRecent(JSON.parse(fs.readFileSync(recentFile(), 'utf8'))); } catch { return []; }
}
function addRecent(file) {
  const abs = path.resolve(file);
  const list = cleanRecent([abs, ...readRecent()]);
  const tmp = recentFile() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(list)); fs.renameSync(tmp, recentFile()); } catch {}
  try { app.addRecentDocument(abs); } catch {}
}

// ---- 页面切换 ----
function loadView(name) {
  view = name; ready = false;
  win.loadFile(path.join(__dirname, name + '.html')).catch(() => {});
}
function showHome() {
  if (!alive() || (view === 'home' && ready)) return;
  pending = null;
  win.setTitle('Iris');
  loadView('home');
}

function deliver(file) {
  if (!alive()) return;
  let st;
  try { st = fs.statSync(file); } catch (e) { dialog.showErrorBox('无法读取文件', e.message); return; }
  if (!st.isFile()) { dialog.showErrorBox('无法打开', '这不是一个普通文件:\n' + file); return; }
  const name = path.basename(file);
  let js;
  if (BUNDLE_RE.test(file)) {
    if (st.size > MAX_PACKAGE) { dialog.showErrorBox('文件太大', `图文包超过 ${MAX_PACKAGE >> 20}MB,无法安全打开。`); return; }
    let b64;
    try { b64 = fs.readFileSync(file).toString('base64'); }
    catch (e) { dialog.showErrorBox('无法读取文件', e.message); return; }
    js = `window.loadBundleB64(${JSON.stringify(b64)}, ${JSON.stringify(name)})`;
  } else {
    if (st.size > MAX_TEXT) { dialog.showErrorBox('文件太大', `文本文件超过 ${MAX_TEXT >> 20}MB,无法安全打开。`); return; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { dialog.showErrorBox('无法读取文件', e.message); return; }
    const base = pathToFileURL(path.dirname(file) + path.sep).href;
    js = `window.loadFromNative(${JSON.stringify(text)}, ${JSON.stringify(name)}, ${JSON.stringify(base)})`;
  }
  win.webContents.executeJavaScript(js).catch(e => dialog.showErrorBox('打开失败', String(e && e.message || e)));
  win.setTitle(name);
  addRecent(file);
}

function openPath(file) {
  if (!file) return;
  if (!alive()) { pending = file; return; }
  pending = file;
  if (view !== 'reader') { loadView('reader'); return; }   // did-finish-load 之后再投递
  if (ready) { const f = pending; pending = null; deliver(f); }
}

// ---- 入口 ----
async function pickFile() {
  if (!alive()) return;
  const r = await dialog.showOpenDialog(win, {
    title: '打开文件',
    properties: ['openFile'],
    filters: [{ name: 'Markdown / HTML / 文本 / 图文包', extensions: ['md', 'markdown', 'txt', 'html', 'htm', 'mdz', 'zip'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (!r.canceled && r.filePaths[0]) openPath(r.filePaths[0]);
}

async function makeBundle() {
  if (!alive()) return;
  const m = await dialog.showOpenDialog(win, {
    title: '第 1 步:选择 Markdown 文件',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (m.canceled || !m.filePaths[0] || !alive()) return;
  const mdPath = m.filePaths[0];
  const mdDir = path.dirname(mdPath);

  const d = await dialog.showOpenDialog(win, {
    title: '第 2 步:选择存放图片的文件夹(默认是 md 所在文件夹)',
    defaultPath: mdDir,
    properties: ['openDirectory'],
  });
  if (d.canceled || !d.filePaths[0] || !alive()) return;

  let out;
  try { out = buildBundle(mdPath, d.filePaths[0]); }
  catch (e) { dialog.showErrorBox('合成失败', e.message); return; }

  const s = await dialog.showSaveDialog(win, {
    title: '第 3 步:保存图文包(以后直接打开这个文件即可)',
    defaultPath: path.join(mdDir, path.basename(mdPath).replace(/\.(md|markdown)$/i, '') + '.mdz'),
    filters: [{ name: 'Iris 图文包', extensions: ['mdz'] }],
  });
  if (s.canceled || !s.filePath) return;
  // 先写临时文件再替换,失败时不会损坏已有的同名包
  const tmp = s.filePath + '.tmp';
  try { fs.writeFileSync(tmp, out.zip); fs.renameSync(tmp, s.filePath); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} dialog.showErrorBox('保存失败', e.message); return; }

  const notes = [];
  if (out.missing.length) notes.push('引用了但没有找到的图片:\n' + out.missing.slice(0, 15).join('\n') + (out.missing.length > 15 ? '\n…' : ''));
  if (out.skipped.length) notes.push('出于安全未收入(不是图片,或不在所选文件夹 / md 所在文件夹内):\n' + out.skipped.slice(0, 15).join('\n') + (out.skipped.length > 15 ? '\n…' : ''));
  if (out.conflicts.length) notes.push('同名资源冲突,仅保留了第一个:\n' + out.conflicts.slice(0, 15).join('\n'));
  if (notes.length && alive()) {
    await dialog.showMessageBox(win, {
      type: 'warning', title: '图文包已保存,但有提示',
      message: `已保存图文包,包含 ${out.count} 个图片文件。`,
      detail: notes.join('\n\n'),
    });
  }
  openPath(s.filePath);
}

ipcMain.handle('home:open', e => { if (fromTop(e, HOME_URL)) return pickFile(); });
ipcMain.handle('home:bundle', e => { if (fromTop(e, HOME_URL)) return makeBundle(); });
ipcMain.handle('home:open-recent', async (e, p) => {
  if (!fromTop(e, HOME_URL) || typeof p !== 'string' || !DOC_RE.test(p)) return;
  if (!readRecent().includes(p)) return;     // 只允许打开近期列表里的文件
  if (!isFile(p)) { await dialog.showMessageBox(win, { type: 'info', message: '这个文件已经不存在了', detail: p }); return; }
  openPath(p);
});
ipcMain.handle('home:recent', e => {
  if (!fromTop(e, HOME_URL)) return [];
  return readRecent().map(p => ({ path: p, name: path.basename(p), dir: path.dirname(p), exists: isFile(p) }));
});
ipcMain.handle('reader:pick', e => { if (fromTop(e, READER_URL)) return pickFile(); });
ipcMain.on('reader:drop', (e, paths) => {
  if (!fromTop(e, READER_URL) || !Array.isArray(paths) || paths.length !== 1) return;
  const p = paths[0];
  if (typeof p === 'string' && p.length < 1024 && DOC_RE.test(p) && isFile(p)) openPath(p);
});

// 文档里的链接绝不能让主窗口跳转:网页交给系统浏览器,本地文档走受控打开流程,其余忽略
function guardNavigation(e, url) {
  e.preventDefault();
  let u;
  try { u = new URL(url); } catch { return; }
  if (u.protocol === 'http:' || u.protocol === 'https:') { shell.openExternal(u.href).catch(() => {}); return; }
  if (u.protocol === 'file:') {
    let p;
    try { p = fileURLToPath(u); } catch { return; }
    if (DOC_RE.test(p) && isFile(p) && !path.resolve(p).toLowerCase().startsWith(__dirname.toLowerCase() + path.sep)) openPath(p);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 780, backgroundColor: '#1c1c1e',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, preload: path.join(__dirname, 'preload.js') },
  });
  const wc = win.webContents;
  wc.on('did-finish-load', () => {
    ready = true;
    if (view === 'reader' && pending) { const f = pending; pending = null; deliver(f); }
  });
  wc.on('will-navigate', guardNavigation);
  wc.on('will-redirect', guardNavigation);
  wc.on('will-attach-webview', e => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });

  const first = pending || fileArg(process.argv);
  pending = first || null;
  loadView(first ? 'reader' : 'home');

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '主页', accelerator: 'CmdOrCtrl+H', click: showHome },
      { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: pickFile },
      { label: '合成图文包并打开…', accelerator: 'CmdOrCtrl+Shift+B', click: makeBundle },
      { type: 'separator' },
      { label: '打印…', accelerator: 'CmdOrCtrl+P', click: () => alive() && win.webContents.print() },
      { type: 'separator' }, { role: 'quit', label: '退出' } ] },
    { label: '编辑', submenu: [{ role: 'copy', label: '拷贝' }, { role: 'selectAll', label: '全选' }, { role: 'paste', label: '粘贴' }] },
    { label: '显示', submenu: [
      { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'resetZoom', label: '实际大小' }, { role: 'togglefullscreen', label: '全屏' },
      { type: 'separator' },
      { label: '允许文档加载网络资源(默认关闭)', type: 'checkbox', checked: false, click: mi => { allowRemote = mi.checked; } } ] },
  ]));
}

function lockDownSession() {
  const ses = session.defaultSession;
  // 离线阅读器:默认拒绝任何文档发起的网络请求(图片、脚本、表单、WebSocket 等)
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_d, cb) => cb({ cancel: !allowRemote }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (alive()) { if (win.isMinimized()) win.restore(); win.focus(); }
    openPath(fileArg(argv));
  });
  app.on('open-file', (e, f) => { e.preventDefault(); openPath(f); });
  app.whenReady().then(() => { lockDownSession(); createWindow(); });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!alive() && app.isReady()) createWindow(); });   // macOS:点 Dock 图标
}
