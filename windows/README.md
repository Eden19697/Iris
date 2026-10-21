# Iris for Windows

Windows 版离线 Markdown / HTML 阅读器:一个 Electron 外壳 + 与 macOS 版**共用**的阅读页(`../src/reader.template.html`)。构建后不依赖网络。

## 功能

- 阅读页功能与 macOS 版一致:Markdown(GFM)、LaTeX、代码高亮、Mermaid、图片放大、目录、深色模式、实时编辑预览、打印。
- 启动后是首页,两个入口:
  1. **直接打开文件**:`.md` / `.html` / `.txt`,或已经做好的 `.mdz` 图文包。
  2. **合成图文包并打开**:依次选 md 文件 → 图片文件夹 → 保存位置,生成一个 `.mdz` 保存在本地并立刻打开;下次直接打开这个 `.mdz` 即可。
- 首页有「最近打开」;阅读时 `Ctrl+H` 回首页。
- 安装版可把 `.md` / `.markdown` / `.html` / `.mdz` 关联到 Iris,双击即开。

## 运行与构建

需要 [Node.js](https://nodejs.org) 20 LTS 或更新版本,Windows 10/11 x64。

```powershell
cd windows
npm install
npm start          # 先本地运行
npm run dist       # 生成安装包,产物在 windows\out\
```

产物:

- `Iris Setup 1.0.0.exe` — 安装版(可选安装目录)
- `Iris 1.0.0.exe` — 免安装便携版

`npm start` / `npm run dist` 会先执行 `npm run reader`:用仓库根目录的 `src/reader.template.html` 和 `vendor/` 生成 `app/reader.html`。
这个脚本(`scripts/build-reader.js`)与根目录的 `build_html.py` 输出一致,所以 Windows 上不需要安装 Python。`app/reader.html` 是生成物,不提交。

> 没有代码签名证书,exe 未签名,首次运行 SmartScreen 会提示「未知发布者」,点「更多信息 → 仍要运行」。
> 安装包体积较大(约 100MB+,Electron 运行时),超过 GitHub 单文件 100MB 限制,不放在仓库里。

## 安全默认值

针对不可信文档做过一轮审查,详见 [`../review/2026-10-21-windows/WINDOWS_REVIEW.md`](../review/2026-10-21-windows/WINDOWS_REVIEW.md)。要点:

- 文档里的链接不会让主窗口跳转:网页交给系统浏览器,本地文档走受控的打开流程。
- 原生桥只提供给应用自己的首页 / 阅读页,所有 IPC 校验发送 frame 与精确 URL。
- **默认拒绝文档发起的任何网络请求**(离线阅读器)。需要时在菜单「显示 → 允许文档加载网络资源」临时开启,每次启动恢复关闭。
- 合成图文包只收所选文件夹与 md 所在文件夹内的图片文件,不跟随符号链接,并限制数量与大小。
- `.mdz` 解压有大小 / 条目上限,校验 CRC 与结构;过大或损坏的包整体拒绝。
- HTML 文档在沙箱 iframe 中渲染,只允许脚本(不开放表单、弹窗)。

## 目录

- `app/main.js` — 主进程:窗口、菜单、首页 / 阅读页切换、IPC、网络策略
- `app/preload.js` — 只向首页 / 阅读页暴露最小的桥
- `app/bundle.js` — 合成 `.mdz`(纯 Node 的 zip 写入与路径边界检查)
- `app/home.html` — 首页
- `scripts/build-reader.js` — 生成 `app/reader.html`
- `../review/2026-10-21-windows/windows_checks.cjs` — 可重跑的回归测试(载入真实 `main.js` 与阅读页)

## 回归测试

```powershell
cd windows
npm install
npm run reader
$env:ELECTRON_RUN_AS_NODE = $null
.\node_modules\electron\dist\electron.exe ..\review\2026-10-21-windows\windows_checks.cjs
```

结果写入 `review/2026-10-21-windows/windows-results.json`(已被忽略)。
