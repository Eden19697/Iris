# Iris

离线 Markdown / HTML 阅读器。macOS 版是 Swift 外壳(WKWebView),Windows 版是 Electron 外壳,两者共用同一个完全自包含的阅读页(`src/reader.template.html` 生成的 `reader.html`),构建后不依赖网络。

## 功能
- Markdown(GFM)、LaTeX 公式(KaTeX)、代码高亮、Mermaid 流程图/顺序图
- 点击图片/图表放大查看(滚轮、捏合、拖动)
- `.mdz` 图文包:把 Markdown 与图片合成一个文件,也可打开 zip;支持「合成图文包」
- 首页与最近打开、深色模式、目录、实时编辑预览、打印
- HTML 文件在沙箱 iframe 中渲染

## 构建(macOS)
需要 Xcode 命令行工具和 Python 3。

```bash
./build.sh
```

生成 `dist/Iris.app`(arm64 + x86_64,最低 macOS 13.3,ad-hoc 签名,未公证)。首次打开如被 Gatekeeper 拦截:右键 → 打开。

## 下载
到 [Releases](https://github.com/Eden19697/Iris/releases) 下载 `Iris-1.0.dmg`,打开后把 Iris 拖进「应用程序」。应用未经 Apple 公证:首次打开请右键 → 打开(或在「系统设置 → 隐私与安全性」中点「仍要打开」)。自行打包:`./make_dmg.sh`。

## 构建(Windows)
需要 Node.js 20 LTS 或更新版本。详见 [`windows/README.md`](windows/README.md)。

```powershell
cd windows
npm install
npm run dist      # 产物在 windows\out\:安装版与便携版 exe
```

未签名,首次运行 SmartScreen 会提示,点「更多信息 → 仍要运行」。

## 目录
- `src/main.swift` — 原生外壳、安全策略(`PathGuard` / `NavPolicy` / `BridgeGuard`)、`.mdz` 写入
- `src/reader.template.html` — 阅读页模板;`build_html.py` 把 `vendor/` 里的库和字体内联成 `dist/reader.html`
- `src/home.html` — 首页(macOS)
- `windows/` — Windows 版:Electron 外壳、首页、`.mdz` 合成;阅读页由 `windows/scripts/build-reader.js` 用同一份模板和 `vendor/` 生成
- `review/` — 安全审查报告与可重跑的探针:macOS `python3 review/2026-10-16/native_checks.py`;Windows 见 `review/2026-10-21-windows/`

## 许可证
本项目以 [MIT](LICENSE) 发布。`vendor/` 中的第三方组件(marked、DOMPurify、highlight.js、KaTeX、Mermaid)各自遵循其许可证,详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
