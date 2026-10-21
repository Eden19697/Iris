const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 只给应用自己的两个页面提供桥;任何其他页面(包括被导航过去的文档)都拿不到
const page = (() => {
  try {
    const u = new URL(location.href);
    if (u.protocol !== 'file:' || window.top !== window) return '';
    const m = /\/(home|reader)\.html$/.exec(u.pathname);
    return m ? m[1] : '';
  } catch { return ''; }
})();

if (page === 'home') {
  contextBridge.exposeInMainWorld('iris', {
    openFile: () => ipcRenderer.invoke('home:open'),
    makeBundle: () => ipcRenderer.invoke('home:bundle'),
    openRecent: p => ipcRenderer.invoke('home:open-recent', String(p)),
    recent: () => ipcRenderer.invoke('home:recent'),
  });
}

if (page === 'reader') {
  // 阅读页:用原生对话框打开(保留文件所在目录,相对路径的图片才能显示)
  contextBridge.exposeInMainWorld('irisReader', { pickFile: () => ipcRenderer.invoke('reader:pick') });
  // 单个文件拖入:取真实路径交给主进程(多个文件仍由页面自己处理,作为"文档 + 图片"导入)
  window.addEventListener('drop', e => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length !== 1) return;
    try { ipcRenderer.send('reader:drop', [webUtils.getPathForFile(files[0])]); } catch {}
  }, true);
}
