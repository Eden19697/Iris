# Iris Windows 防御性审查

> 2026-10-21 的审查记录。正文中的位置和行号对应**修复前**的源码;文末「修复状态」是修复后的复测结果。
> 本文只评估 Windows 版,macOS 版见 `review/2026-10-16/MAC_REVIEW.md`。

日期：2026-10-21。检查对象：Windows 版源码(现位于 `windows/`)、打包产物 `app.asar`、发布文件，以及当时随附的命令行打包脚本 `Iris-Pack.ps1`(该脚本未收入本仓库,功能已由应用内「合成图文包」取代)。

结论：发现需要修复的安全边界、资源限制和文件打开问题。本轮为审查，未修改应用源码或重新生成安装包。不能据此认定已发现系统命令执行漏洞，也不能将本轮筛查视为完整渗透测试。

## 验证方法与范围

- 已逐字节确认发布目录的 app.asar 中 main.js、reader.html、bundle.js 与当前源码一致。
- dist 便携版与 out 便携版 SHA256 一致：`2FC3C45648D410FE858AEB69E32BA8E46AE54A78989D53734C0EA0A9E9483C14`。
- 使用项目自带 Electron 31.7.7 / Chromium 126.0.6478.234 执行隐藏窗口测试，并载入实际 main.js 和 reader.html。
- 测试采用独立临时 userData 及合成文件；测试期间 HTTP/HTTPS 请求在发送前取消。未读取实际私密文件，未向外部服务发送测试数据。
- main.js、bundle.js、preload.js 均通过 `node --check`。
- 没有进行安装卸载、文件关联注册、SmartScreen、不同 Windows 版本、真实超大包耗尽内存或完整依赖漏洞库扫描。

## 1. P1：主窗口可导航到非应用 HTML，仍注入原生桥

位置：`app/main.js:117-138`、`app/preload.js:3-8`。

main.js 只处理新窗口，没有限制当前窗口的 will-navigate；preload 在后续载入的页面继续暴露 window.iris。IPC 处理器也没有核验 senderFrame 是否是应用自己的主页/阅读页。

复现：在阅读页渲染一个指向同盘合成 HTML 的相对 Markdown 链接，再点击。主窗口从 reader.html 导航到了 一个同盘的合成 HTML(`navigation-target.html`)，新页面中 `typeof window.iris === 'object'` 为 true。

影响：用户点击文档链接后，不受信任 HTML 可在应用主窗口执行脚本，并访问近期文件列表及打开/合成等原生入口；应用界面也会被替换。尚未证明任意代码执行或静默读取任意文件内容。

建议：禁止文档触发主窗口导航；本地文档交给受控打开流程，外部网页仅在明确点击且协议验证后交给系统浏览器。所有 IPC 检查发送 frame 与精确应用 URL，仅向受信任顶层页面提供桥。HTML 继续在隔离 iframe 中显示。

## 2. P1：图片引用可以把目录外任意类型文件收进图文包

位置：`app/bundle.js:79-106`；同类逻辑见 `dist/tools/Iris-Pack.ps1:19-35`。

扫描所选图片目录时检查图片扩展名，但处理 Markdown 的图片引用时仅检查目标是否是文件。既允许 `..` 逃出选择目录，也不要求目标是图片。

复现：文档仅含 `![image](../secret.txt)`；选择 docs 目录后，输出 ZIP 中存在 `assets/secret.txt`，其内容为测试字符串 `SYNTHETIC_PRIVATE_CONTENT`。

影响：合成来源不可信的 Markdown 时，引用的配置、文本等文件可能在用户未察觉的情况下进入包；用户随后分享包会泄露这些文件。本测试只使用了合成文本。

建议：默认将收集范围限制在用户选择目录内，使用 realpath 后判断边界，避免符号链接绕过；校验图片类型。跨目录资源若需兼容，应明确列出待收集清单，并由用户确认。为全部资源提供数量及总大小限制。

## 3. P1：Electron 运行时已结束支持

位置：`package.json:12`、实际 runtime 及 node_modules/electron/package.json。

项目实际使用 Electron 31.7.7，Chromium 126.0.6478.234。官方已将 Electron 31 标记为结束支持：

- https://releases.electronjs.org/release/v31.7.7
- https://releases.electronjs.org/release/v34.0.0
- https://releases.electronjs.org/schedule

这是需要更新的基础安全风险；本轮没有逐一核实 CVE 的可利用性，不据此声称存在某个已成功利用的引擎漏洞。

建议：升级到升级实施时仍受支持的稳定分支，并回归 HTML sandbox、preload、打印、拖放、文件关联和安装包。不要只提升 package.json 而不重建发布文件。

## 4. P2：ZIP 解压没有资源上限，也不校验完整性

位置：`app/main.js:41-43`、`app/reader.html:3582-3606`。

主进程同步读取整个包并转为 base64，渲染进程再复制为数组。解压过程累计保留所有条目，没有限制包大小、条目数、单条目展开大小或总展开大小；使用 arrayBuffer() 一次性收集展开数据。也没有 CRC 校验，未完整验证 ZIP 结构、加密标志和展开大小。

受控复现：8,270 字节的 ZIP 展开得到 8,388,608 字节；将本地头与中央目录 CRC 均改成错误值，仍成功解压。没有实施真实内存耗尽测试。

影响：高压缩比文件或大量条目可能造成界面卡顿、内存占用过大甚至退出；损坏文件可能被当作有效内容使用。

建议：在文件读取前限制大小；采用成熟 ZIP 解析库，在流式展开期间累计实际字节数并中止超限，校验 CRC 与结构，并在 worker 中解压；捕获所有异步载入失败。合成端的同步目录遍历和压缩也需要大小上限与后台执行。

## 5. P2：阅读页打开/拖放文件时相对图片目录丢失

位置：`app/reader.html:3625-3652`、`:3664`；对比 `app/main.js:48-49`。

Windows 阅读页右上角“打开文件”走 HTML input，不走 window.iris.openFile。openFiles 在单文档分支调用 load(text, doc.name)，没有设置 base；主进程的打开流程则会提供文件目录。

复现：用 File 对象模拟选择含 `![image](photo.png)` 的 note.md，curBase 为空，图片被解析为 应用目录下的 `app/photo.png`，而不是原文件目录。

影响：同一个文件通过菜单/主页打开可显示图片，通过阅读页按钮或单文件拖入却可能丢图，且标题/近期列表更新路径也不同。

建议：Windows 统一调用原生打开流程；拖放通过受限 preload 获取路径后交给主进程打开，保留多文件资源导入功能并显式定义其行为。校验路径是可读普通文件。

## 6. P2：离线阅读自动请求网络图片

位置：`app/reader.html:3437-3478`、`:3518-3522`、阅读页 head 缺少 CSP。

Markdown 的 https 图片保留原地址；HTML iframe 允许脚本及表单，且没有默认禁网策略。上下文隔离和 iframe sandbox 不能阻止跟踪请求。

复现：载入包含远程图片的 Markdown，将隐藏窗口中的图片设为 eager 后，webRequest 捕获了对 `https://iris-audit.invalid/pixel` 的请求。测试拦截器已取消发送。

影响：打开不可信文件可能向文档提供方暴露联网、IP 和阅读时间等信息；“Offline reader”目前不代表默认禁网。

建议：默认阻止文档发起网络请求，明确提供允许远程资源的选项；同时限制 HTML iframe 中脚本、表单、弹窗能力。给阅读页加入与现有内联库兼容的 CSP，不能只依赖内容清洗。

## 7. P2：近期文件 JSON 仅验证顶层数组

位置：`app/main.js:19-20`、`:124-126`、`app/home.html` 的 refresh。

readRecent 接受任何数组项；后续直接调用 path.basename(p)。复现：隔离 profile 写入 `[null,{}]`，iris.recent() 抛 ERR_INVALID_ARG_TYPE。主页 refresh 没有捕获该 Promise 拒绝，近期列表无法正常恢复。

建议：读取时只保留长度受限的有效字符串路径，限数量、去重；采用临时文件写入后原子替换；主页捕获失败并恢复空列表。

## 其他加固项（静态发现）

- `dist/tools/Iris-Pack.ps1:39-40` 在创建新 ZIP 前先删除同名现有 mdz。若之后失败，旧包已丢失。应先写同目录临时文件，成功校验并关闭后再替换。
- bundle.js 按 basename/归档路径去重；多个目录同名资源可能静默保留第一个，resolveFile 的 byName 回退也可能显示错误图片。建议检测冲突并明确重写引用。
- main.js 的 executeJavaScript、loadFile、shell.openExternal 等 Promise 缺少完整失败处理；对话框打开期间关窗也缺少存活检查。
- Get-AuthenticodeSignature 检查便携版和安装包均为 NotSigned。该项不是恶意软件判定，但会影响来源验证和 Windows 下载运行体验；建议正式发布时签名。
- Markdown 已使用 DOMPurify；BrowserWindow 已启用 contextIsolation 与 sandbox；HTML iframe 未开放 allow-same-origin，这些是现有有效防线，应保留。

## 复测

可重跑的动态测试:`review/2026-10-21-windows/windows_checks.cjs`。它载入真实的 `windows/app/main.js` 与由模板生成的 `reader.html`,使用独立临时 profile 和合成文件,不触碰真实近期记录;结果写入同目录 `windows-results.json`(已被 `.gitignore` 忽略)。

```powershell
cd windows
npm install
npm run reader
$env:ELECTRON_RUN_AS_NODE = $null
.\node_modules\electron\dist\electron.exe ..\review\2026-10-21-windows\windows_checks.cjs
```

---

## 修复状态(2026-10-21 复测)

复测脚本:`windows_checks.cjs`(见上)。已用打包后的真实程序做端到端验证(主页 IPC、`.mdz` 启动、图片加载)。

**共用阅读页**:Windows 版现在使用与 macOS 相同的 `src/reader.template.html`(由 `windows/scripts/build-reader.js` 内联 `vendor/` 生成,与 `build_html.py` 输出逐字一致),不再单独维护一份阅读器。模板里为 Windows 增加的改动都以 `window.irisReader` 是否存在为条件(macOS 上不存在,行为不变),或是对两端都更安全的修正(同名资源不再取错、原生载入失败有提示)。

| 编号 | 状态 | 做法 | 复测结果 |
|---|---|---|---|
| P1-1 导航/桥 | 已修 | `will-navigate`/`will-redirect` 一律拦截:http(s) 交系统浏览器,本地 md/html/mdz 走受控打开,其余忽略;preload 只在 home/reader 顶层页面暴露桥,主页与阅读页桥分离;所有 IPC 校验 `senderFrame` 为顶层且 URL 精确匹配;`open-recent` 只允许近期列表内的文件 | 点击指向本地文档的链接:主窗口仍是 reader.html,`window.iris` 为 undefined |
| P1-2 合成收文件 | 已修 | 范围限定为所选文件夹 + md 所在文件夹(realpath),只收图片扩展名,不跟随符号链接/联接点;上限 1000 个/单个 30MB/总计 80MB;同名冲突与被拒文件在保存后列出;PowerShell 工具同步修复 | `secret.txt`、`notes.txt`、目录外图片、联接点内图片均未入包 |
| P1-3 Electron | 已修 | 31.7.7 → 44.9.3;electron-builder 24 → 26.18 | 打包后程序正常运行;`npm audit --omit=dev` 0 个 |
| P2-4 ZIP | 已修(见遗留) | 包大小/条目数/单文件/总展开上限;流式展开,实际字节超过声明即中止;校验 CRC、结构、加密标志、ZIP64;主进程读取前检查大小;所有载入失败有提示 | 错 CRC、谎报大小、声明过大、条目过多 4 类全被拒,正常包可用 |
| P2-5 相对图片目录 | 已修 | 阅读页"打开文件"与单文件拖入改走原生流程(带文件所在目录) | 见"未验证" |
| P2-6 网络请求 | 已修 | 会话层默认取消所有 http/https/ws/wss/ftp 请求;菜单"显示 → 允许文档加载网络资源"可临时开启(每次启动恢复关闭);权限请求一律拒绝;HTML iframe 沙箱收紧为仅 `allow-scripts`(去掉表单、弹窗) | 远程图片请求被 `ERR_BLOCKED_BY_CLIENT` 拦下 |
| P2-7 近期列表 | 已修 | 读取时只保留有效绝对路径字符串、限长、去重、最多 10 条;写入先临时文件再原子替换;主页捕获失败 | 损坏的 `[null,{},"relative.md",42]` 被清洗为空列表 |
| 其他:同名资源 | 已修 | 合成端检测并报告冲突;阅读端文件名回退只在唯一时生效 | — |
| 其他:Iris-Pack 先删后写 | 已修 | 先写同目录临时文件,成功后替换 | 旧包被正常替换,无残留 tmp |
| 其他:Promise/关窗 | 已修 | `executeJavaScript`/`loadFile`/`openExternal` 加失败处理;对话框返回后检查窗口存活 | — |
| 其他:未签名 | 未修 | 需要代码签名证书 | — |

### 遗留 / 未验证

- **未签名**:需购买证书,不是代码能解决的。
- **ZIP 解压未放入 worker**:现为流式异步解压并设上限,极端情况下 CRC 计算仍会占用页面线程片刻。
- **Electron 45.0.0 今天刚发布**,选用了更稳的 44.9.3;后续应定期升级。
- **构建工具链** `npm audit` 仍报 `sprintf-js` 中危(经 electron-builder 间接依赖),只在构建机上运行,不进入发布包。
- **未实际操作验证**:阅读页点"打开文件"/单文件拖入的新原生路径(依赖系统对话框和拖放);`http(s)` 链接交给系统浏览器(避免测试时真的打开浏览器);安装/卸载、文件关联、不同 Windows 版本。
- 允许加载网络资源开关打开后,HTML 文档中的脚本仍可联网,这是用户主动选择的结果。
