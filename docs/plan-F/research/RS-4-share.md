# RS-4 分享与嵌入技术方案（2026-10-20）

结论：作品状态走查询参数 `?s=`（v1，deflate-raw + base64url），典型作品 300–600 字符；带自带 bin 或稠密输入的走 `.tryboard` 文件。分享卡用 MediaRecorder 优先录 MP4，不引入 muxer，不做 GIF；二维码自写。嵌入用独立入口 `embed.html`，点击后才加载。wasm 没用 SharedArrayBuffer，不需要 COOP/COEP。所有数字都在本机实测（脚本在会话 scratchpad，没进仓库）。

## 1. 台面状态

**现有状态在哪**

| 状态 | 位置 | 跨刷新 |
|---|---|---|
| 作品 / 示例 / 选板结果 | `main.tsx:44-70`（`work`、`example`、`cp`，custom 用 advisor 查询串，`custom.ts:201` 存储键 `custom:<fnv>`） | URL |
| 摆放（SceneSpec + ext5v） | `bomstore.ts` `tryboard-app-placed:<w>` | 是 |
| 改接线 WireMods（`wiring.ts:104`） | session，进时间线 `history.ts:18` | 否（DECISIONS 2026-10-17） |
| 环境 Env、热源 heat、超声初始距离 | session / 时间线 fold | 否 |
| 外壳布线 CaseHarness | `tryboard-app-harness:` | 是 |
| 装配记录 | `asmstate.ts:12` `tryboard-app-asm:` | 是 |
| 固件 | `session.ts:274 loadFirmware`；内置为 `fw/<id>/flash.bin`，`web/asset-hashes.json` 已有 10 位内容哈希 | 自带 bin 否 |
| 输入日志 | worker 用模拟时钟打戳，`inputlog.ts:52 InputLog`；头部（i2c/lcd/servo…）由场景经 `devsOf` 推出 | 否 |

**schema v1**（JSON，缺省值不写）
```
{ v:1, w:"weather"|"blank:<ex>"|"custom", sel?:"<advisor encode(s,false)，不带 have>", cp?:"04",
  fw:{ex:"weather",h:"c543d7f04d"} | {sha:"<sha256>",name,size},
  chip, scene?:SceneSpec /*与作品默认不同时才写*/, ext5v?, mods?:WireMods, harness?:CaseHarness,
  env?, heat?, dist?, loc:"zh",
  run?:{endMs, s:"<toScriptInline 文本>"} }
```
- InputLog 头部不重复存，打开时由 scene 推出（与 `devsOf` 同源），避免两份真相。
- 不存：检查点通过记录（挑战要公平）、`have`、最近固件、主题。
- `loc` 要存：worker 用 locale 生成人话文本（`worker.ts:575`）。
- **迁移**：只加可选字段时不升 v；改语义时升 v，并补一个 `migrate_n_to_n+1`，旧解码器永不删（旧链接散在群里）。v 高于本页能解的提示"需要新版本"。`fw.h` 与当前哈希不一致时照常打开，横幅提示"示例固件已更新，结果可能与分享者不同"，不宣称逐字节一致。
- **存储隔离**：打开 `?s=` 生成本地副本，键 `share:<fnv(s)>`（沿用 custom 的做法），不覆盖用户自己的同名作品。
- 片段 `#` 已被步骤路由占用（`shell.tsx:49 stepFromHash`），所以用查询参数；与 advisor 契约一致。
- **恢复**：用 `live.ts:419 seek(job)` 带 boot 参数 + 事件 + `untilMs=endMs` 重新上电快进，落到终态后继续实时跑。需要在 `inputlog.ts:94 action()` 旁补逆函数 `fromScript()`（CLI 侧对应 `cli/main.rs:184 parse_script`）。

## 2. 编码与长度

实测（zlib deflateRaw level 9 → base64url；浏览器 CompressionStream 结果相近）：

| 情形 | 原始 | 编码后 |
|---|---|---|
| weather 默认台面 | 393 | 312 |
| usbkey（4 件） | 500 | 374 |
| weather + 3 处改线 + 20 个事件 | 982 | 588 |
| lamp 200 次编码器 | 3701 | 942 |
| 拖 IMU 10 s（600 事件） | 22478 | 8336；差分编码后 3584 |

预算：≤2000 字符直接进链接（聊天、X、二维码都稳）；2000–8000 字符仍给链接，但二维码只编不带 `run` 的台面链接；>8000 字符或自带 bin 时，只出 `.tryboard`，链接退化成"台面 + 提示下载文件"。稠密 IMU 的差分编码留作 v2，P0 不做。

**`.tryboard` 文件**：`TRYBOARD 1\n` + 一行状态 JSON + `\n` + 原始 bin 字节，不压缩 bin，也不用 base64。打开时校验 sha256（crypto.subtle）。不选 zip：要自写 CRC / 中央目录，收益只是能解压给 CLI 用，而现有"导出输入日志"已经能做到。CLI 直接读 `.tryboard` 列为后续项。

## 3. 分享卡

| 方案 | 结论 |
|---|---|
| MediaRecorder（现有 `capture.ts:99`） | 首选。优先 `video/mp4;codecs=avc1` → `video/mp4` → webm。Safari 14.1+ 和 Chrome 新版能录 MP4，Firefox 落到 webm。**现有 bug**：`capture.ts:104` 只试 webm，Safari 上 mime 为空，录出的其实是 MP4，却被标成 `.webm` / `video/webm`（:115-116）。 |
| WebCodecs + MP4 muxer | P0 不做。mp4-muxer（MIT 5.2.2，156 KB，**已弃用**）；继任者 Mediabunny 是 MPL-2.0（10.9 MB），不在 LICENSING 内。自写最小 muxer（avc1 单轨）约 300 行，只在要 Firefox MP4 或逐帧离线渲染时才值得。 |
| GIF | 不做。gifenc 是 MIT（172 KB）；6 s、480 px、12 fps 的 GIF 有 2–6 MB，还得做调色板量化，不划算。静图沿用 `renderStill`（:70）出 PNG。 |
| 二维码 | 自写：字节模式、纠错 M、版本 1–25、8 种掩码按罚分选，约 250 行，gzip 约 3 KB。对照的 npm 包：qrcode（MIT 135 KB，带依赖）、qrcode-generator（MIT 556 KB）、nayuki（MIT 51 KB）；用任何一个都要先进 LICENSING 和 DECISIONS。屏幕上手机能稳定扫的上限大约是版本 25（L 级 1273 字节）。 |

卡片：1080×1350 合成画布，含 3D 帧、标题、芯片、二维码、短说明，`captureStream(30)` 录 6 s，循环播放交给播放器。移动端 Safari：MediaRecorder MP4 iOS 14.3+，CompressionStream deflate-raw 16.4+。

## 4. 嵌入 `/embed?s=`

- 独立入口 `embed.html`（加在 `vite.config.ts:98`），不走 `createShell`（`shell.tsx:494`）。只调用 `createSession`（`session.ts:67`）配一个 stage 元素。
- 去掉：顶栏、步骤条、左右栏、采购 / 装配 / 成品、⌘K、时间线、放件 / 改线。保留：3D 台面、运行 / 重启、可折叠串口、"在 TryBoard 打开"（新窗口，同一个 `s`）。按键、旋钮这类输入可以用，但不保存。
- 存储：只放内存，不写 localStorage。第三方 iframe 的存储会被分区，Safari 上会被拦。麦克风禁用。
- 懒启动：首屏是标题加 ▶，点了才拉 wasm（≤2 MB）和 three.js；点击同时算作音频所需的用户手势。
- 隔离：没有 SAB / Atomics（已 grep），不需要 COOP/COEP。`_headers` 按路径设规则：`/embed*` 设 `Content-Security-Policy: frame-ancestors *`，其余页面设 `frame-ancestors 'self'`。完整 CSP 要给 vite 内联脚本开口子，P0 不上。
- 博主贴的代码：
```
<iframe src="https://<域名>/embed?s=…" width="640" height="420" style="border:0;max-width:100%" loading="lazy"
 allow="fullscreen; autoplay" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="TryBoard"></iframe>
```
  `allow-same-origin` 必须带（worker、wasm 同源加载要用）。公众号、知乎不支持 iframe，只能发分享卡和链接。**公开部署要人拍板**；P0 只在本地验收。

## 5. 确定性漏洞

1. **实时麦克风**：`worker.ts:1043 micPush` 直接喂进核，不进日志（只有 WAV 名进日志，:644）。中途换音源（:1040 `mic`）也不记。分享时要么改用 WAV，要么标"含实时麦克风，无法复现"。
2. 真实网络：回包已作为 `netreply` 进日志（:518），可以离线复现，但 body 是 base64，体积大，通常只能走 `.tryboard`。
3. 运行中改线不重新上电（DECISIONS 2026-10-17），日志只覆盖本次上电之后。状态取"最后一次上电时的场景 + 当前 mods"；放件会触发 reboot，因此不受影响。
4. 墙钟：worker 的 `performance.now` 只管节奏，事件按模拟时钟打戳。网页从不调用 `tb_rtc_set`（只有 CLI `main.rs:1194` 调用），RTC 起点固定。`Date.now` 只出现在最近记录 / 保存时间这类 UI 里。`Math.random` 在 web/src 没有命中。
5. 示例固件重建后哈希会变，靠 `fw.h` 检出。
6. 启动时的 harness / realnet / pose 是否都进了日志，要在 F-01 里逐项核对（pose 已核，`live.ts:127`）。

## 6. 修订后的 brief

**F-01 台面状态（约 130 次调用；超 150 就拆成 F-01a URL + 内置固件、F-01b `.tryboard` + 自带 bin）**
- 新建 `web/src/app/sharestate.ts`：类型、`capture()`、`encode` / `decode`（CompressionStream）、`migrate`、`pack` / `unpack` `.tryboard`。
- `inputlog.ts:94` 加 `fromScript()`。`main.tsx:44-70` 解析 `?s=`，选 work、cp、键 `share:<fnv>`。`main.tsx:127` 用状态里的 scene 替换 `placed`。session 起来后依次：自带 bin 走 `session.ts:274`，`setWireMods`、env、harness，最后 `live.ts:419 seek` 到 endMs。
- `topbar.tsx:255` 菜单：新增"复制作品链接（含接线和操作）"和"下载 .tryboard"，原有"复制本页链接"保留；`.tryboard` 可以拖进页面或用换固件打开。
- DECISIONS 记"分享契约 v1"，并注明 2026-10-17"分享改动不做"已被取代；ARCH 写摘要；补 zh / ja / ko 键。
- 验收：`web/test/sharestate.test.ts`（往返、迁移、超长退化）。新增 `tools/webtest/share.mjs`，照 `replay.mjs:55-146`：weather 按 BOOT、改温度、改一根线、放一个件 → 加测试钩子 `__tbShare()` 取链接 → 新浏览器上下文打开 → seek 完成后 `__tbInputLog` 一致，指纹 === CLI `tryboard run … --inputs … --seconds endMs`。另测 blink bin 打包 `.tryboard` 的往返，以及哈希不一致时出横幅。agent-browser 走查写进 `Reviews/ab/F-01.md`。

**F-02 分享卡（约 90 次）**
- `capture.ts:104-116` 改 mime 优先级，扩展名 / type 跟着实际 mime 走（修 Safari 标错格式的 bug）。新建 `app/qr.ts`（自写）、`app/sharecard.ts`（合成画布，复用 `renderStill:70` 的版式）和分享对话框。
- 验收：`web/test/qr.test.ts`（RS 已知向量、容量边界）。`tools/webtest/sharecard.mjs`：卡片 blob 在 Chrome 上是 `video/mp4`，`<video>` 读到时长 6±0.5 s；PNG 存在；二维码用 Chrome `BarcodeDetector` 解码后等于 `__tbShare()`（headless 不支持就记进 STATUS，改用真机扫码，人工核一次）。390×844 下对话框无横向滚动。agent-browser 截图。

**F-03 嵌入（约 80 次；"实时回放日志"另立 F-03b，要在 worker 里加事件排程）**
- `vite.config.ts:98` 加 `embed`；新建 `embed.html` 和 `app/embed.tsx`；`public/_headers` 加 frame-ancestors 规则。
- 验收：`tools/webtest/embed.mjs` 用 `fixtures/` 里的宿主页套 sandbox iframe：点击前请求里没有 wasm；点击后串口出现预期文本；console 无错误；iframe 里 localStorage 键数不变；指纹与同一 `s` 的完整页一致。agent-browser 走查。
