# Iris macOS 防御性审查

日期：2026-10-16。范围：Mac 源码、当前 `dist/Iris.app` 资源与签名、macOS 26.3（25D125）的系统 WebKit。本文不评估 Windows / Android。

结论：发现四项优先修复的安全问题，以及一项发布配置问题。当前版本不宜将第三方文档视为可信输入。

## 1. [P1] 合成图文包会收集授权目录以外的文件

位置：`src/main.swift:80–93`，以及 `inside()` 的 `42–45` 行。

文档中的 `![x](../outside/private.txt)` 只要目标存在，就进入 `add()`，随后直接读入 ZIP。这里既没有将真实路径限制在 Markdown 目录 / 用户选择的图片目录内，也没有验证引用目标确实是图片。目录扫描还会接受扩展名为 `.png` 的符号链接；`standardizedFileURL` 不能阻止链接指向目录以外。

复现使用模拟私密文件，实际产物 `synthetic-result.mdz` 同时包含：

- `assets/private.txt`：通过 `../` 引用收进来的模拟私密内容。
- `images/innocent.png`：通过图片符号链接收进来的同一段模拟内容。

这会把阅读功能的问题扩大到文件分享：用户选择“合成图文包”后，原本未选择的本地内容可能随包被分享出去。受影响范围仍受当前进程文件访问权限和 macOS 隐私权限约束。

修复：先解析符号链接并规范化真实路径，再检查其是否位于明确授权的根目录；拒绝越界路径及非普通文件，校验图片类型，增加单文件 / 总量 / 数量上限。目录外引用如需支持，应先明确列出并让用户选择具体文件，不能自动读取。

证据：[package-results.json](package-results.json)、[native_checks.py](native_checks.py)。测试调用从源码提取的原始 `MdzBundle`，未修改其逻辑。

## 2. [P1] 沙箱 HTML 子页面仍能调用原生桥

位置：`src/main.swift:249–259`；相关 HTML 设置位于 `src/reader.template.html:262`。

HTML 预览 iframe 允许执行脚本。系统 WebKit 实测：文档中的脚本可以调用 `window.webkit.messageHandlers.native.postMessage(...)`，Swift 收到的 `frameInfo.isMainFrame` 为 `false`。iframe 的同源隔离不等于原生桥隔离。

生产处理函数未检查发送 frame、页面 URL 或当前页面状态。`home:recent` 也只检查扩展名与文件存在性，没有要求路径属于真实最近列表。因此，文档子页面可以发起本应属于应用首页的打开文件指令，或触发原生选择面板。此测试验证了桥接消息到达；为避免副作用，测试接收器没有继续调用生产面板或读取该路径。本项不声称单凭子页面消息就已实现内容外传。

修复：同时验证主 frame 和精确的可信应用页面 URL；首页命令只在首页接受，最近文件只能使用原生端签发的标识 / 列表成员。减少暴露到文档执行环境的桥能力。[Apple 的 WKScriptMessage 文档](https://developer.apple.com/documentation/webkit/wkscriptmessage)提供了发送 frame 信息。

证据：[bridge-results.txt](bridge-results.txt)，其中明确记录 `mainFrame=false` 与伪造的 `home:recent` 指令。

## 3. [P1] 不可信页面可以替换主阅读页，截获后续打开内容

位置：`src/main.swift:138–171`。`App` 没有实现主页面导航的允许列表，`deliver()` 则总是对当前页面执行 `window.loadFromNative(文档全文, ...)`。

复现步骤：在真实阅读页渲染一条指向模拟本地 HTML 的 Markdown 链接，然后点击；主 WebView 从阅读页导航到该 HTML。该页面定义自己的 `window.loadFromNative`。随后执行与生产 `deliver()` 相同的文档注入方式，不可信页面成功接收到 `IRIS_SYNTHETIC_NEXT_OPEN_CONTENT`。

攻击需要先发生主页面导航，例如用户点击文档中的链接。进入该状态后，后续通过菜单或 Finder 打开的文件可能被交给不可信页面；这次测试只捕获模拟字符串，没有打开或外传真实文档。仅修复第 2 项的子 frame 检查不足以阻止此问题，因为此时发送方已经是主 frame。

修复：用 `WKNavigationDelegate` 阻止主 frame 离开打包的可信首页 / 阅读页；文档链接应通过原生打开文档流程处理，外部链接通过明确的外部打开策略处理。每次注入文档内容前再次验证当前可信页面与加载状态；同时收缩 `allowingReadAccessTo: /` 的读取范围。

证据：[navigation-results.txt](navigation-results.txt)。原生探针使用实际 `dist/reader.html`、相同桥配置和读取根目录；交付的内容是测试常量。

## 4. [P1] ZIP 解压没有实际输出上限，且接受损坏数据

位置：`src/reader.template.html:326–348`，尤其 `345–346` 行。

系统 WebKit 实测：

| 样例 | 输入大小 | 行为 |
|---|---:|---|
| 合法 store ZIP | 121 B | 正常读取 7 B |
| 合法 deflate ZIP | 123 B | 正常读取 7 B |
| CRC 与内容不一致 | 121 B | 仍然接受 |
| 声称解压后仅 1 B 的 ZIP | 2,164 B | 实际解压并接受 2,097,152 B |

`Response(...).arrayBuffer()` 一次性收集全部解压输出，未限制单条目、总输出或条目数；原生加载也先完整读入 ZIP 并做 Base64 复制。恶意压缩包可造成高内存占用，进一步导致卡顿或进程被系统终止。测试为避免资源压力，只解压了 2 MiB，没有实施真实内存耗尽。CRC 不校验则会让损坏文档被静默呈现，是另一个完整性缺陷。

修复：原生读取前限制压缩文件体积；JS 端采用能在流读取期间累加并中止的实际字节上限，限制单条目 / 总输出 / 数量，不能只信目录里的声明大小。严格校验目录和本地头边界、压缩方式、加密标记、实际长度与 CRC；出错时整体拒绝加载。

证据：[zip-results.txt](zip-results.txt)。这些结果来自 macOS 系统 WebKit 执行实际阅读页的 `unzip()`，不是只在其他 JS 引擎中推测。

## 5. [P2] 声明的最低系统版本与现有二进制不一致

位置：`src/Info.plist:11`、`build.sh:11`。

`LSMinimumSystemVersion` 声明 `11.0`，但 `xcrun vtool -show-build dist/Iris.app/Contents/MacOS/Iris` 显示现有二进制的 `minos 16.0`。构建脚本未显式指定部署目标。两处最低版本要求不一致，不能据 plist 宣称支持 macOS 11。本次未在旧版 macOS 上实际启动验证。

修复：先确定真实支持范围，再统一 Swift 部署目标、plist 和发布说明；还要核查旧系统的 WebKit 是否支持所用 API，特别是压缩流能力。

## 已通过的检查与边界

- `swiftc -typecheck` 通过；仅发现 `allowedFileTypes` 弃用警告。
- 当前 `dist/Iris.app` 通过 `codesign --verify --deep --strict`。这不代表已公证或已具备安全隔离。
- App 内的 `reader.html` 与 `dist/reader.html` SHA-256 相同：`702a90d4684bca38281eee632a4e1872ac7cde4beba09c28a7e4a041aef2b69f`；首页资源也与源码一致。
- 系统 WebKit 的基础 Markdown 清洗测试通过：普通 `<script>`、`onerror` 和 `javascript:` 链接样例未执行。证据：[sanitization-results.txt](sanitization-results.txt)。这不是对所有 XSS 变种的证明。
- 没有修改应用源码、已打包 App 或安装包。本目录新增的是报告、测试脚本、生成的 Swift 探针及模拟结果。
- 原生探针复用实际阅读页、生产配置和交付方式；并非对整个发布二进制进行 Finder / 菜单端到端操作，也没有测试旧系统、真实内存耗尽或真实敏感文件。

重跑：在此工作目录执行 `python3 review/2026-10-16/native_checks.py`，需要可用的 macOS 图形会话、系统 WebKit 和 Swift 命令行工具。模拟输入位于脚本创建的临时目录，WebKit 使用非持久存储。

建议修复顺序：第 1–3 项信任边界 → 第 4 项资源与完整性限制 → 第 5 项发布要求；修复后重新运行同一批探针，确保恶意样例被拒绝且正常样例仍可打开。

---

## 修复状态(2026-10-16,已重跑 `native_checks.py`,25 项全部 PASS)

| # | 问题 | 修复 | 复验 |
|---|---|---|---|
| 1 | 合成图文包收集授权目录外文件 | `PathGuard` 先解析符号链接再校验是否在 md 目录/所选图片目录内;只收普通图片文件;单图 25 MB、总量 200 MB、2000 个文件上限;被拒绝的引用会列在警告里 | 合成包中不含模拟私密内容,正常图片仍收录 |
| 2 | 沙箱 iframe 可调用原生桥 | `BridgeGuard`:必须是主框架 + 来自应用自带的 home/reader 页面 + 与当前页面类型匹配;`home:recent` 只接受原生最近列表中的路径 | iframe 消息被生产守卫拒绝;合法首页/阅读页命令仍接受 |
| 3 | 不可信页面可替换主阅读页并截获后续内容 | `NavPolicy`(`WKNavigationDelegate`):主框架只能停留在自带页面;http(s) 交系统浏览器;本地文档链接走原生"打开文档"流程;`deliver()` 前再校验当前页面。读取范围由 `/` 收缩到 App 资源目录,文档图片改由 `irisdoc://` 方案提供,且只能读到当前文档目录内的资源(解析符号链接后校验) | 点击链接后主页面仍为阅读页,后续内容未被截获;`../`、`%2e%2e`、符号链接逃逸均被拒绝 |
| 4 | ZIP 解压无输出上限、不校验 CRC | 流式读取并按声明大小中止;单文件 64 MB / 总量 256 MB / 2000 条目 / 压缩包 128 MB 上限(原生端另有文件大小预检);校验目录与本地头边界、加密、ZIP64、压缩方式、CRC | 合法 store/deflate 通过;CRC 错误与虚报大小被拒绝 |
| 5 | 最低系统版本声明与二进制不一致 | 部署目标统一为 macOS 13.3(页面依赖 DecompressionStream 与正则后行断言,需 Safari 16.4 的 WebKit);通用二进制(arm64 + x86_64) | `vtool` 显示两个架构 minos 均为 13.3 |

注意:探针直接复用 `src/main.swift` 中的生产策略函数(`NavPolicy`、`BridgeGuard`、`PathGuard`)与实际 `reader.html`,但不是对完整 App 的 Finder/菜单端到端自动化;另外手动验证了真实 App 中相对路径图片可正常显示。未在 macOS 13.3 的旧系统上实际运行。
