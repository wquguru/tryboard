# F 专项派单手册

本文件给主会话照着派子代理用：怎么建 session、每个 session 的提示词、先后约束、每波合并和收尾。计划依据见 `EVAL.md` §5，调研结论见 `README.md`。

**状态：2026-10-20 人确认开工，F 批已写进 `docs/PLAN.md`。** 与 M5 专项的重叠按 PLAN.md F 节处理：F-10a 并入 M5-10、F-10b / F-10d 并入 M5-12（下面这两段提示词保留作参考，不再单独派），F-04b 等 M5-01 合并后再派。下面的行号于 2026-10-20 在 `6c9640f` 上核对（波 3 条目在 `774de94` 上复核，波 4 条目在 `030786c` 上复核）；派单前主会话用 `grep -n` 再确认一遍，行号漂了就改本文件再派。

## 1. 怎么建一个 session

每个 F 项一个全新子代理，不用 fork（AGENTS.md §9 第 1 条）。主会话的 `Agent` 调用：

```
Agent({
  description: "F-01a share state v1",       // 3–5 个英文词
  subagent_type: "general-purpose",
  isolation: "worktree",
  model: "opus",                              // 只有 F-06 用 "sonnet"；必须显式写（§9 第 15 条）
  prompt: <§3 公共部分> + "\n\n" + <§4 对应项>
})
```

- 同一波的子代理在**同一条消息里**一起发，才会并行跑。
- 子代理跑在后台，完成时主会话收到通知；不要轮询、不要读它的 `.output` 文件。
- 网页类子代理各用自己的端口和 agent-browser session 名（见 §4 每项的「端口」）。
- 子代理不准再派子代理（§9 第 6 条），已写进公共部分。

## 2. 先后约束

### 2.1 依赖图

```
F-01a ──┬─> F-01b
        ├─> F-02
        ├─> F-03 ──> F-03b
        ├─> F-07b  (还要 F-07a + 人定 MicroPython 分发方式)
        └─> F-11
F-04b ─┐
F-04c ─┼─> F-04a   (三个都合并后才开)
F-04d ─┘
F-07a ──> F-07b
F-09a ──> F-09b    (还要人定 RS-2 四项)
F-10a ──> CYD 示例（F-10a 范围内）
无依赖：F-04e、F-05、F-06、F-08a、F-08b、F-08c、F-10b/c/d
```

「依赖」指上游**已合并到 main**，不是已派出。下游子代理从合并后的 main 建 worktree，读得到上游的接口。

### 2.2 资源约束

- 同时在跑的 worktree ≤ 6；同时编译 core（`cargo build/test`）的 ≤ 3（磁盘约 55 GB，每个 worktree 编 Rust + wasm + 固件几个 GB）。
- 改 `core/crates/esp32/src/lib.rs` 的（F-10a–d）同一时间 ≤ 2 个。
- **和 M5 专项的冲突**：`docs/PLAN.md` 的 M5-00…M5-13 也在改 `core/crates/esp32`、`soc/src/devices/lcd.rs`、`spec.ts`。F 批和 M5 批不要同一波碰同一文件；派 F-04b、F-10x 前先看 M5 进度。
- 合并完的 worktree 立即删除（`git worktree remove`）。

### 2.3 追加式冲突（主会话合并时处理）

| 文件 | 规则 |
|---|---|
| `web/src/i18n/{zh,ja,ko}/*.ts` | 新键加在分组末尾；合并后跑 `cd web && node --test test/i18n.test.ts` |
| `firmware/accept.json`、`firmware/examples.json` | 追加；合并后 `tools/golden.py save` |
| `core/crates/soc/src/devices/mod.rs` | `pub mod` 行追加，按字母序排好 |
| `docs/STATUS.md`、`docs/PLAN.md` | 子代理只改自己 ID 那一行 |

## 3. 公共部分（每个 prompt 开头原样拼上）

```
你在 TryBoard 仓库（<repo-root>，本地 git，分支 main）的独立 worktree 里工作，执行 F 专项的一个条目。
先读：AGENTS.md（规则、命令）、docs/plan-F/README.md 的「调研结论汇总」、本条目列出的调研文件和源码入口。docs/ 用中文写，代码注释用英文。
规则摘要：
- 授权：只能用 docs/LICENSING.md 里 ✅ 的来源；GPL 代码可读不可抄；新 npm / crate 依赖先写 docs/DECISIONS.md（目前 crate 一个都不允许）。
- 网页：所有可见文字走 t()，en / zh / ja / ko 一起加，新键加在分组末尾；手机 390×844 无横向滚动，触控目标 ≥ 44px；页面照 docs/DESIGN.md + DESIGN_V2.md。
- 验收：改 core 跑 `cd core && cargo test && cargo clippy -- -D warnings`；改仿真结果的要和 CLI 指纹对照；网页改动用 agent-browser 走查（端口、session 名见本条目），截图 Reviews/ab/<ID>.png 并用 Read 看，console / errors 无 error，记录写 Reviews/ab/<ID>.md。
- 不削弱任何已有测试；不删 docs 内容。
省 token：不得再派子代理；单次工具输出 > 2 万字符先重定向到 Reviews/ 再 grep / head；读代码先 `grep -n` 再看命中处 ≤ 60 行，不整文件 cat；查到的位置和签名记在笔记里，压缩后不重读；工具调用超过约 150 次时先提交阶段性成果，在汇报里写清剩余工作。
完成后：在 worktree 分支提交（英文提交信息，末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`）；更新 docs/STATUS.md 自己那一行、docs/plan-F/README.md 状态表里自己那一项；自主决定写进 docs/DECISIONS.md。
汇报（≤ 300 字）：做了什么、验收结果（贴通过 / 失败的行）、遗留问题、改动了哪些公共接口（别的条目会依赖它）。不要贴大段日志。
```

## 4. 各条目提示词

格式：先是派单参数，再是拼在公共部分后面的正文。

### 波 1（6 个并行：F-01a、F-04b、F-04c、F-04d、F-05、F-06）

#### F-01a 台面状态 v1 与分享链接
参数：`model: "opus"`，端口 5181，agent-browser session `f01a`。预计 90 次调用。
```
条目 F-01a：台面状态 v1 + 分享链接（内置固件）。
先读：docs/plan-F/research/RS-4-share.md 全文（状态格式、实测大小、复现缺口都在里面），RS-6-gallery-hil.md 的 A4 节（隐私）。
入口：
- web/src/app/shell.tsx:49 stepFromHash —— `#` 已被步骤路由占用，状态放 `?s=`
- web/src/app/session.ts:67 createSession、web/src/app/store.ts:11 createStore —— 收集与恢复台面状态
- web/src/inputlog.ts:158 toScript / :173 cliArgs —— 输入日志转脚本文本；需要新增反向的「脚本文本 → 事件」解析
- web/src/live.ts:446 seek —— 恢复时重新上电并快进
- web/src/app/topbar.tsx:250 更多菜单 —— 打开「分享」项
- web/src/advisor/state.ts:1 —— 选型页已有的 URL 分享约定，格式风格对齐
- web/src/app/bomstore.ts、asmstate.ts —— 台面摆放现在存在 localStorage
目标：把台面（作品 id、固件 id + 10 位内容哈希、与作品默认值不同的器件和接线改动、电源、harness、环境、语言、输入日志脚本 + 结束时间）编码成版本化 v1 JSON → deflate-raw → base64url 放进 `?s=`；打开链接时恢复并快进到同一状态，存成本地副本（新 key），不覆盖用户自己的作品。
范围：
- 做：编码 / 解码 / 版本字段 / 校验失败给提示；分享前剥掉 Wi-Fi SSID / 密码和真网回包（RS-6）；> 8k 字符时提示「下个版本支持导出文件」（F-01b 做）。
- 先核实：启动 harness、真网开关是否已经进输入日志；缺的补进日志并在汇报里写。
- 不做：`.tryboard` 文件（F-01b）、分享卡（F-02）、嵌入（F-03）、用户自带 bin。
接口约束：导出 `encodeState(state) / decodeState(str)` 和状态 v1 的 TypeScript 类型，放 web/src/app/sharestate.ts；F-01b、F-02、F-03 都会用。把格式摘要写进 docs/ARCH.md 新的一节。
验收：
- 新增 tools/webtest/share.mjs：开示例 → 按 BOOT、改温度 → 生成链接 → 新页打开链接 → 串口输出和 CLI `tryboard run --inputs` 重放逐字节一致、指纹相同。
- node tools/webtest/replay.mjs、levels.mjs、mobile.mjs 仍通过。
- agent-browser 走查：分享 → 复制链接 → 新标签打开 → 状态一致；390×844 也走一遍。
```

#### F-04b ILI9341 / SH1106 模型 + 裸屏验收
参数：`model: "opus"`，不需要浏览器。预计 110 次调用。
```
条目 F-04b：ILI9341 + SH1106 仿真模型，以及 ST7789 / ILI9341 裸屏模块在 C3、S3 上的 CLI 验收。
先读：docs/plan-F/research/RS-3-interest.md §3（器件优先级），docs/STATUS.md 显示屏相关行。
现状（已核对）：core/crates/soc/src/devices/lcd.rs:28 LcdKind::parse 已有 st7789 / st7789l / ili9342(c/e) / gc9a01 等，ST7789 模型已存在（M5 专项做的）；SH1106、ILI9341 没有。
入口：
- core/crates/soc/src/devices/dcs.rs:60 起 PanelSpec 常量（M5-01 的参数化 DCS 面板；ILI9342C 在 :129）—— ILI9341 加一个 PanelSpec（240×320 竖屏、MADCTL 默认值、ID），lcd.rs:8 LcdKind / :28 parse 加名字
- core/crates/soc/src/devices/ssd1306.rs —— SH1106 参照它写（页寻址、132 列 RAM 偏移 2），新文件 sh1106.rs
- core/crates/soc/src/devices/mod.rs —— 注册（追加式）
- core/crates/cli/src/main.rs:208 `--i2c`、`--spi` 解析 —— 加名字
目标：Arduino / IDF 常见用法下，ILI9341、ST7789（240×240 和 240×320）、SH1106 在 C3 和 S3 上能出正确画面。
范围：
- 做：模型 + 单元测试；新固件 firmware/c3-ili9341、firmware/s3-st7789、firmware/c3-sh1106（IDF esp_lcd 驱动，ILI9341 用 IDF 组件管理器里 ✅ 的驱动，查不到许可证就自己发命令）；accept.json 各加用例，用 --lcd-ppm / --oled 截图核对画面。
- 不做：网页拖放和 3D 外观（F-04a）；经典 ESP32 上的 CYD（等 F-10a）；触摸 XPT2046。
验收：cargo test + clippy；tools/build_fw.sh 三个固件；tools/accept.sh --no-web 新用例通过；PPM 转 PNG 后 Read 看一眼。
```

#### F-04c DS18B20 单总线
参数：`model: "opus"`，不需要浏览器。预计 100 次调用。
```
条目 F-04c：DS18B20 单总线温度传感器模型 + CLI 验收。
先读：RS-3-interest.md §3。
入口：
- core/crates/soc/src/devices/pins.rs:237 Dht11 —— 现有的 GPIO 时序器件，照它的结构写 Ds18b20（复位脉冲 / 存在脉冲 / 时隙读写、ROM 命令 0x33/0xCC/0x55/0xF0、功能命令 0x44/0xBE、CRC8）
- core/crates/esp32c3/src/periph.rs 里 DHT11 的挂接方式（grep -n -i dht11）
- core/crates/cli/src/main.rs:325 `--dht11` —— 照着加 `--ds18b20 <gpio>[,count]`，温度跟 `--env`
目标：OneWire + DallasTemperature 风格的读数在 C3、S3 上正确，支持同一总线 2 个器件（SEARCH ROM）。
范围：做模型、CLI 开关、单元测试、firmware/c3-ds18b20（IDF 自写 OneWire 时序或 ✅ 组件）、accept 用例（温度随 --env 变化、断线时读到 85℃/-127 的报错路径）。不做网页。
注意：OneWire 库许可证 RS-3 标为不明，不要把 Arduino 的 OneWire 拉进固件。
验收：cargo test + clippy；tools/build_fw.sh c3-ds18b20；accept.sh --no-web 新用例通过。
```

#### F-04d PIR / LDR / 继电器 + RC522
参数：`model: "opus"`，不需要浏览器。预计 100 次调用。
```
条目 F-04d：PIR（HC-SR501）、LDR、继电器模块 + RC522 RFID 的仿真模型和 CLI 验收。
先读：RS-3-interest.md §3。
入口：
- core/crates/soc/src/devices/pins.rs —— PIR（输出高电平保持时间、重触发）、继电器（GPIO 负载 + 吸合状态）放这里
- LDR 走 ADC：grep -n "fn adc\|Adc" core/crates/esp32c3/src/periph.rs core/crates/esp32s3/src/*.rs，确认 C3 / S3 ADC 模型怎么接电压
- RC522：新文件 core/crates/soc/src/devices/rc522.rs（SPI 从机，寄存器读写 + REQA / 防冲突 / SELECT 足够读 UID；不做 MIFARE 认证和读块）；SPI 从机挂接参照 lcd.rs 的 SPI 路径
- core/crates/cli/src/main.rs —— 加 `--pir <gpio>`、`--ldr <gpio>`、`--relay <gpio>`、`--spi rc522`，脚本动作 `pir=1`、`lux=<n>`、`card=<uid hex>`
目标：这四种教程常见器件能在 C3、S3 上被固件读到并有可观察的状态。
范围：模型 + CLI + 脚本动作 + 单元测试 + firmware/c3-pir-relay、firmware/c3-rc522 + accept 用例。不做网页。
验收：cargo test + clippy；tools/build_fw.sh 两个固件；accept.sh --no-web 新用例通过；脚本动作的输入日志能被 `--inputs` 重放。
```

#### F-05 故障挑战关卡
参数：`model: "opus"`，端口 5182，agent-browser session `f05`。预计 120 次调用。
```
条目 F-05：3–5 个「找故障」挑战关卡，网页和 tools/check.py 判定一致。
先读：docs/plan-F/EVAL.md §4 的 O5；firmware/levels.json 现有关卡格式；docs/PLAN.md 里关卡相关条目。
入口：
- tools/check.py:70 evaluate、:35 fingerprint —— 判定逻辑
- firmware/levels.json —— 关卡定义
- web/src/views/ 关卡页（grep -n "levels.json\|checkpoint" web/src/views/*.ts* 找入口）
- core/crates/cli/src/main.rs：已有 `--net-fault`(:384)、`--i2c-wire`(:365)、`--power usb|ext`(:347)、`--antenna-loss`(:368)；**欠压和接线故障的开关没有**
目标：玩家拿到一个「有故障的台面」，找出原因并修好（改线、改参数或换固件），网页判过、CLI 判过、指纹一致。
范围：
- 先设计 3–5 个关卡写进 docs/plan-F/F-05-levels.md（每关：现象、原因、修法、判定条件），候选：I2C 线太长丢包、Wi-Fi 天线被挡、上拉电阻缺失、电源带不动舵机（欠压）、引脚接错。
- 需要的 CLI 开关缺什么补什么（欠压可以在 elec crate 里做，grep -n brownout core/crates/elec）；每个新开关加单元测试。
- 不做：新器件。
验收：tools/check.py --ref --all 通过；新增 tools/webtest/faults.mjs 网页判定与 check.py 一致；agent-browser 走一关（含 390×844）。
```

#### F-06 公开数字自动生成
参数：`model: "sonnet"`，不需要浏览器。预计 40 次调用。
```
条目 F-06：README 和首页上的公开数字由脚本从真实数据生成，不再手写。
现状：README.md 写 91 个验收用例 / 44 个示例 / wasm 230 KB，实际约 125 / 52 / 1.24 MB（gzip 435 KB）。
入口：README.md、docs/readme/README.{zh-CN,ja,ko}.md 里的数字；首页数据（grep -rn "accept\|examples" web/src/views/showcase.ts web/home.html 找数字出处）；firmware/accept.json、firmware/examples.json；tools/build_web.sh 产出的 wasm 大小。
目标：新增 tools/stats.py，统计用例数、示例数、器件数、芯片数、wasm 原始和 gzip 大小，输出 JSON（web 构建读它）并用标记块 `<!-- stats:begin -->…<!-- stats:end -->` 重写四份 README 里的数字。
范围：只改数字和生成脚本，不改 README 其他文字；tools/build_web.sh 里调用它。
验收：python3 tools/stats.py --check 在数字过期时非零退出；跑一次后四份 README 数字一致；cd web && npm run build 成功。
```

### 波 2（F-01a 和 F-04b/c/d 合并后）：F-01b、F-02、F-03、F-04a；core 侧 F-07a、F-10a

#### F-01b `.tryboard` 文件
参数：`model: "opus"`，端口 5183，session `f01b`。预计 50 次调用。
```
条目 F-01b：`.tryboard` 作品文件（导出 / 导入），覆盖链接装不下（> 8k 字符）和用户自带 bin 的情况。
先读：RS-4-share.md 的文件格式一节；docs/ARCH.md 里 F-01a 写的状态 v1 格式；web/src/app/sharestate.ts（F-01a 的接口）。
入口：web/src/app/sharestate.ts encodeState / decodeState；topbar.tsx:250 更多菜单；现有上传 bin 的入口（grep -n "upload\|\.bin" web/src/app/*.tsx）；web/src/app/capture.ts:117 download。
目标：文件 = 头行（magic + 版本）+ 状态 JSON + 原始 bin；导入时 sha256 校验 bin，恢复和 F-01a 同一路径；拖文件到页面也能打开。
不做：上传到服务器。
验收：tools/webtest/share.mjs 增加 .tryboard 往返用例（含自带 bin）；agent-browser 导出 → 刷新 → 导入走一遍。
```

#### F-02 分享卡
参数：`model: "opus"`，端口 5184，session `f02`。预计 90 次调用。
```
条目 F-02：分享卡 —— 6 秒 MP4 + 二维码 + 链接。
先读：RS-4-share.md 分享卡一节（为什么不做 GIF、不引 muxer、二维码自写）。
入口：
- web/src/app/capture.ts:158 recordCanvas —— 现在只试 webm（:163），文件名写死 .webm（:175）；Safari 实际录出 MP4 却命名 .webm，这个 bug 一起修（按 rec.mimeType 定扩展名）
- capture.ts:70 renderStill —— 静态图的排版可复用
- web/src/app/sharestate.ts —— 取分享链接
目标：一键生成「画面 + 作品名 + 二维码 + 短链接」的卡片，优先 MP4（isTypeSupported 选 mp4，退 webm），同时给 PNG 静态版。
范围：自写 QR 编码器 web/src/app/qr.ts（约 250 行，字节模式 + ECC M，带单元测试对照已知向量）；链接 > 2k 字符时二维码里去掉运行记录。不引新 npm 依赖。
验收：web 单元测试覆盖 QR；新增 tools/webtest/sharecard.mjs（生成卡片、用解码校验二维码内容 = 链接）；agent-browser 生成一次并 Read 截图。
```

#### F-03 嵌入
参数：`model: "opus"`，端口 5185，session `f03`。预计 80 次调用。
```
条目 F-03：独立的 embed.html，让别人用 iframe 嵌入一个可运行的作品。
先读：RS-4-share.md 嵌入一节。
入口：web/vite.config.* :98 build.input（加 embed 入口）；web/app.html 和它的主入口（grep -n "createSession" web/src/app/main.tsx）；web/src/app/sharestate.ts；部署头文件（grep -rn "_headers" web tools）。
目标：`/embed.html?s=...` 显示精简台面（无顶栏菜单、无编辑），点一下才加载 wasm 并运行；右下角「在 TryBoard 打开」。
范围：不写 localStorage；`_headers` 只对 embed 路径设 `Content-Security-Policy: frame-ancestors *`；文档里给出嵌入代码（`sandbox="allow-scripts allow-same-origin"`）。不做实时回放（F-03b）。**不部署到公网。**
验收：新增 tools/webtest/embed.mjs（本地页面 iframe 嵌入 → 点击 → 串口出字）；wasm 首包仍 ≤ 2 MB；agent-browser 在一个本地测试页里嵌入走一遍。
```

#### F-04a 器件上台面
参数：`model: "opus"`，端口 5186，session `f04a`。预计 130 次调用。
```
条目 F-04a：把所有已建模器件（含 F-04b/c/d 新加的 ILI9341、ST7789、SH1106、DS18B20、PIR、LDR、继电器、RC522）放进网页元件库，可拖放、可接线、手机可用，并有 3D 外观。
先读：docs/DESIGN_V2.md 实验台和手机元件库相关节；F-04b/c/d 在 docs/STATUS.md 里的行（确认 CLI 名字和引脚）。
入口：
- web/src/bench3d/spec.ts:10 器件类型联合（gc9a01 是参照样例）
- web/src/bench3d/modules.ts —— 3D 外观（按真实尺寸程序生成）
- web/src/app/place.ts:61 placeDef —— 放置步骤和接线需求
- web/src/catalog/parts.ts —— 元件库条目
- 手机元件库：grep -n "drawer\|parts" web/src/app/mobile.tsx
目标：台面上能放这些器件，接线后网页传给 wasm 的参数和 CLI 开关一致；手机 390×844 能选、能放。
范围：不新增仿真模型。每个器件的 i18n 名称和说明四语一起加。
验收：tools/webtest/levels.mjs、wiremode.mjs、mobile.mjs 通过；新增至少 2 个示例进 examples.json（如 ILI9341 + DS18B20 温度屏），网页与 CLI 指纹一致；agent-browser 每种器件拖一次并截图。
```

#### F-07a UART 修复 + MicroPython 验收
参数：`model: "opus"`，不需要浏览器。预计 60 次调用。
```
条目 F-07a：修 UART 一次收 > 127 字节卡住的 bug，让 MicroPython 的 raw-paste 上传可用，并加 MicroPython 验收用例。
先读：docs/plan-F/research/RS-1-micropython.md 全文。
入口：
- core/crates/soc/src/periph.rs:48 STATUS 读 rxfifo_cnt 被 `.min(127)` 截断；:61 写 INT_CLR 后，FIFO 里还有数据时不会再拉起 RXFIFO_FULL / TOUT 中断 —— 两处一起修，行为对照 TRM（rxfifo_cnt 是 10 位，FIFO 深度按芯片）
- core/crates/cli/src/main.rs:475 `--script` —— 支持 `\xNN` 转义（发 Ctrl-C / Ctrl-D / raw-paste 控制字节）
目标：MicroPython v1.29.0 C3 官方 bin 上，raw-paste 一次送 128 字节以上的 main.py 能完整执行。
范围：
- tools/fetch_third_party.sh 加可选下载 MicroPython C3 bin 到 third_party/（git 忽略），不提交二进制。
- accept.json 加用例：文件不存在就 skip（不是 fail）；存在则启动到 `>>>`、raw-paste 写 1 KB main.py、软复位后输出正确。
- 不做网页（F-07b）。
验收：cargo test + clippy；tools/golden.py check 全部字节一致（UART 改动会影响所有固件，必须先在未改动的树上 save）；accept.sh --no-web 通过。
```

#### F-10a 经典 ESP32 SPI（含 CYD）
参数：`model: "opus"`，不需要浏览器。预计 120 次调用。派之前确认 M5 专项没有同时在改 `core/crates/esp32`。
```
条目 F-10a：经典 ESP32 的通用 SPI（SPI2 / SPI3，HSPI / VSPI）主机模型，跑通 CYD（ESP32-2432S028，ILI9341 + XPT2046）。
先读：RS-3-interest.md §1、§6（为什么 CYD 优先）；docs/STATUS.md 经典 ESP32 那一列。
入口：
- core/crates/esp32/src/lib.rs:2 文件头注释（C3 / S3 模型复用和 offset 补丁的约定）；:136 外设表；:160 unimpl 计数
- core/crates/esp32/src/periph.rs:435 Spi1（flash / PSRAM 用的，参照结构）
- C3 / S3 的 GP-SPI 模型（grep -rn "struct Gpspi\|struct Spi2" core/crates）—— 能复用就加 offset 补丁，寄存器布局不同再单写
- core/crates/soc/src/devices/lcd.rs —— F-04b 加的 Ili9341
目标：经典 ESP32 上 IDF esp_lcd + ILI9341 出正确画面；CYD 板定义（引脚）能用。
范围：SPI 主机（含 DMA 若 IDF 驱动必须用）、XPT2046 触摸做成可选的第二步（时间不够就留给后续，汇报里写清）；固件 firmware/esp32-cyd；accept 用例。不做 RMT / ADC / I2S。
验收：cargo test + clippy；tools/oracle_qemu.sh 能对照的部分对照；accept.sh --no-web；unimpl top N 里不再有 SPI2/3 寄存器。
```

### 波次调整（2026-10-20，F2 收尾后）

M5 专项已全部合并（M5-01 DCS 面板、M5-10 GP-SPI、M5-11 RMT TX、M5-12 I2S + ADC1/ADC2）。因此：
- **F-10b、F-10d 不再派**（M5-12 已覆盖，`esp32/src/sens.rs` 含 ADC2）；F-10a 只剩 CYD 示例，改名 F-10a2，等 F-04b 的 ILI9341 合并。
- 磁盘约 39 GB：同时 worktree ≤ 5，编 core 的 ≤ 3。

| 波 | 条目 | 前提 |
|---|---|---|
| 3 | F-04b、F-04e、F-08c、F-08a、F-03b | 无（F-08a 主要跑 arduino-cli，和另外三个 core 条目错开 cargo build） |
| 4 | F-04a2、F-10a2、F-10c、F-08b、F-09a-1；F-11 第一步（交互稿，出稿即停） | 波 3 合并（F-04a2 / F-10a2 要 F-04b） |
| 5 | F-09a-2 | F-09a-1 合并 |
| 需人 | F-07b（MicroPython 分发 / 定位）、F-09b（RS-2 四项）、F-11 第二步（审稿后）、arduino-cli core 3.0.7（F-08c 的 Arduino 3.0.x 部分） | 人拍板后单独派 |

#### F-04a2 显示屏上台面（波 4）
参数：`model: "opus"`，端口 5186，session `f04a2`。预计 100 次调用。
```
条目 F-04a2：把 F-04b 新加的 ILI9341、SH1106 以及已有的 ST7789（240×240 / 240×320）放进网页元件库，可拖放、可接线、手机可用，有 3D 外观和实时画面。
先读：F-04a 第一部分的做法（web/src/catalog/parts-bench.ts、web/src/partsdev.ts、tools/webtest/parts.mjs）；F-04b 在 docs/STATUS.md 的行（CLI 名字、引脚）。
入口：web/src/bench3d/spec.ts 器件类型（gc9a01 是屏的参照）、web/src/bench3d/modules.ts、web/src/app/place.ts placeDef、web/src/catalog/parts-bench.ts（新条目加这里，parts.ts 已到 1461 行）。芯片相关常量只能放 web/src/chipid.ts。
目标：接线后网页传给 wasm 的参数和 CLI `--spi` / `--i2c` 一致；3D 屏上出帧。
范围：不新增仿真模型；i18n 四语一起加。
验收：levels.mjs、wiremode.mjs、mobile.mjs、parts.mjs 通过；新增 ≥ 2 个示例进 examples.json（如 ILI9341 + DS18B20 温度屏、SH1106 + PIR），网页与 CLI 指纹一致；agent-browser 每种屏拖一次并截图（含 390×844）。
```

#### F-10a2 CYD 示例（波 4）
参数：`model: "opus"`，不需要浏览器。预计 80 次调用。和 F-10c 同时改 `core/crates/esp32`，合并时处理。
```
条目 F-10a2：经典 ESP32 上跑通 CYD（ESP32-2432S028，ILI9341 + XPT2046）。
先读：RS-3-interest.md §1、§6；docs/PLAN.md M5-10 行（GP-SPI + DMA 已做，firmware/esp32-spi-lcd 是参照）；F-04b 的 ILI9341 PanelSpec（core/crates/soc/src/devices/dcs.rs）。
目标：firmware/esp32-cyd（IDF esp_lcd + ILI9341，CYD 引脚：屏 HSPI 13/14/15/2、背光 21）出正确画面；CYD 板定义可用；XPT2046 触摸作为可选第二步（时间不够就留给后续，汇报里写清）。
验收：cargo test + clippy；accept.sh --no-web 新用例；--lcd-ppm 截图转 PNG 后 Read 看。
```

### 波 3：F-03b、F-07b、F-08a、F-08b、F-08c、F-04e

#### F-03b 实时回放
参数：`model: "opus"`，端口 5187，session `f03b`。预计 60 次调用。
```
条目 F-03b：分享链接 / 嵌入页可以选「按原速回放」，按时间轴重演输入日志，而不是快进到结尾。
入口：web/src/live.ts:446 seek（快进路径，参照）；web/src/inputlog.ts 事件时间戳；web/src/app/sharestate.ts（F-01a）；web/src/embed/run.ts（F-03 的 embed 入口）。
目标：回放时按钮、温度变化在 3D 和串口按原时间出现；可暂停、可跳到结尾。
验收：回放结束时指纹与快进结果一致；agent-browser 在 embed 页走一遍。
```

#### F-07b MicroPython 网页编辑
参数：`model: "opus"`，端口 5188，session `f07b`。预计 120 次调用。**开工前提：人已决定 MicroPython bin 的分发方式和 PRODUCT.md 定位。**
```
条目 F-07b：网页里编辑 main.py 并在 MicroPython 固件上运行。
先读：RS-1-micropython.md；docs/PRODUCT.md；docs/DECISIONS.md 里人对 MicroPython 分发方式的决定（按那个做）。
入口：串口面板和输入框（grep -n "serial\|uart" web/src/app/dock.tsx）；上传 bin 的入口；F-07a 的 `\xNN` 脚本支持；F-01a 的 sharestate.ts（main.py 文本要进作品状态）。
目标：检测到 MicroPython 固件时出现 main.py 编辑器 + 运行 / Ctrl-C / Ctrl-D 按钮；运行 = raw-paste 上传（按提示符握手，不用固定延时）+ 软复位；刷新后自动重发保存的 main.py。
范围：先改 docs/PRODUCT.md 定位并记 DECISIONS；编辑器不引大依赖（textarea + 等宽字体即可，若要语法高亮先写 DECISIONS）；不做 littlefs 镜像。
验收：新增 tools/webtest/micropython.mjs（编辑 → 运行 → 串口输出 → 导出输入 → CLI 重放一致）；agent-browser 含 390×844。
```

#### F-08a / F-08b Arduino 库矩阵
参数：各 `model: "opus"`，不需要浏览器。各约 100 次调用。两个可以同时派。
```
条目 F-08a（显示与传感器 10 例）/ F-08b（Wi-Fi、BLE、舵机、灯带 10 例）：用 arduino-cli（esp32 core 3.3.2，已装）编译常用 Arduino 库的官方示例，进 accept 矩阵。
先读：RS-3-interest.md §2（Top 20 库和许可证）；docs/M5STACK.md §7（Arduino 产物上站点前的规则）；firmware/ 里已有的 Arduino sketch 构建方式（grep -rn "arduino-cli" tools）。
目标：每个库一个示例在 C3（必要时 S3）上跑出预期串口输出或画面；跑不通的记录原因（缺哪个外设 / 指令）到 docs/STATUS.md。
范围：只用 MIT / BSD / Apache 的库；GPL（ESP32-audioI2S、ESP8266Audio）不进；TFT_eSPI、ESP32Servo、OneWire、IRremote 许可证不明，只进本地 accept，不做成站点示例。库版本钉死写进构建脚本。
验收：accept.sh --no-web 新用例通过；矩阵表写进 docs/STATUS.md。
```

#### F-08c BLE 多 IDF 版本
参数：`model: "opus"`，不需要浏览器。预计 100 次调用。
```
条目 F-08c：让 IDF 5.1.0–5.3.1 和 Arduino 3.0.x 编出的 C3 / S3 BLE 固件也能识别和运行。
先读：docs/plan-F/research/RS-5-ble-idf.md 全文（commit 对照表和三处改动）。
入口：
- core/crates/soc/src/ble/sig.rs、sig_xt.rs、tools/ble_sigs.py —— 签名生成与匹配
- core/crates/esp32c3/src/ble.rs:170、core/crates/esp32s3/src/ble.rs:198 —— osi 表版本检查 0x10009..=0x1000A，放宽到 0x10006..=0x1000A
- esp32c3/src/ble.rs:103、esp32s3/src/ble.rs:120 pll_track 钩子 —— 版本 ≤ 0x10006 时跳过
目标：按 RS-5 补齐缺失 bt-lib commit 的签名变体，加覆盖自测（每个 commit 的库链进空 ELF 后 `ble_sigs.py check` 全部命中）。
范围：bt-lib 下载到 git 忽略的 third_party/，不提交；不装其他 IDF；不装 arduino-cli 3.0.7（要人同意）。
验收：cargo test + clippy；tools/golden.py check 字节一致；c3-ble-hr 等现有 BLE 用例不变；15 个 C3 + 40 个 S3 镜像误匹配为 0。
```

#### F-04e AHT20 / INA219 / DS3231
参数：`model: "opus"`，不需要浏览器。预计 90 次调用。
```
条目 F-04e：AHT20、INA219、DS3231 三个 I2C 器件模型 + CLI 验收。
入口：core/crates/soc/src/devices/bme280.rs（I2C 传感器参照）、pcf8563.rs（RTC 参照）、ina3221.rs（电流计参照）；mod.rs 注册；cli main.rs:208 `--i2c` 名字表。
目标：`--i2c aht20@0x38,ina219@0x40,ds3231@0x68` 可用，读数跟 `--env` / 电气模型走。
验收：cargo test + clippy；一个 IDF 固件读三者；accept 用例。
```

### 波 4：F-09a、F-10b、F-10c、F-11

#### F-09a xiaozhi 虚拟服务端（2 个 session，先派 F-09a-1）
参数：`model: "opus"`，不需要浏览器。每个约 120 次调用。
```
条目 F-09a-1：虚拟网络支持长连接 TCP 和 WebSocket。
先读：docs/plan-F/research/RS-2-xiaozhi.md §2、§3、§6；docs/WIFI.md。
入口：core/crates/soc/src/wifi/tcp.rs:15 Conn、:98 Tcp、:465 on_segment（现在是一次性 HTTP，80 端口）、:278 real_reply（注入方式参照）、:604 b64_encode；crypto.rs（SHA-1 有没有，没有就自写）。
目标：抽出 Conn 状态机支持长连接和服务端主动发送；80 端口按 `Upgrade: websocket` 分流到新文件 wifi/ws.rs（101 握手、掩码、分片、ping、close）。
验收：单元测试（握手、掩码、分片、半关闭）；golden.py check 现有网络用例字节一致。

条目 F-09a-2（F-09a-1 合并后）：wifi/xiaozhi.rs 脚本服务端。
目标：OTA / 激活回复、hello 对答；脚本「收到 listen stop 和 N 帧上行 → stt → tts start → sentence_start → 预编码 Opus 帧（60 ms 节奏）→ tts stop」；脚本动作 `xz=on|script,<名>|say,<文本>`，空中日志 `[xz]`；docs/WIFI.md 加「阶段 7」。
验收：单元测试覆盖脚本时序；CLI 下用一个最小 WebSocket 客户端固件（可先用 IDF esp_websocket_client 示例）跑通一轮。
```

#### F-10b / F-10c 经典 ESP32 ADC、RMT（F-10b 已由 M5-12 覆盖，只派 F-10c）
参数：各 `model: "opus"`，不需要浏览器，两个可以同时派（都改 `esp32/src/lib.rs`，合并时处理）。
```
条目 F-10b：经典 ESP32 ADC1 / ADC2 模型。现状（已核对）：core/crates/esp32/src/lib.rs:173 `Adc` 只存电压，"no ADC model yet"。
目标：IDF adc_oneshot（含校准）读数正确，接上 F-04d 的 LDR 和电气模型；ADC2 与 Wi-Fi 冲突的行为如实模拟或标「必须上真机」。
验收：固件 esp32-adc + accept；unimpl top N 不再有 SAR ADC 寄存器。

条目 F-10c：经典 ESP32 RMT 收（RX）和载波。现状（已核对）：lib.rs:147 `rmt` 字段 / :720 route_rmt，RMT TX 已由 M5-11 实现（模型本体在 soc/src/rmt.rs），RX / 载波 / APB FIFO 记为 unimpl（:87 rmt_unmodelled）。
目标：IR 接收（RMT RX）和 IR 发射（载波）可用，配一个 IR 遥控器器件（脚本动作 `ir=<nec code>`）。
验收：固件 esp32-ir + accept；lib.rs:87 rmt_unmodelled 范围缩小。
```

#### F-11 环境脚本时间轴
参数：`model: "opus"`，端口 5189，session `f11`。预计 120 次调用。
```
条目 F-11：环境脚本时间轴 —— 在时间轴上编排温度、光照、距离、按钮等变化，作为作品状态的一部分。
先读：EVAL.md §4 O11；docs/DESIGN_V2.md 实验台节；F-01a 的状态格式。
目标：第一步出交互稿（docs/plan-F/F-11-timeline.md + 一张静态 HTML 原型），在汇报里停下等人看；人确认后第二步实现。
验收（第二步）：时间轴导出的输入日志能被 CLI `--inputs` 重放，指纹一致。
```

### 波 5：F-09b、F-10d

#### F-09b xiaozhi 示例（2–3 个 session）
参数：`model: "opus"`。**开工前提：人已拍板 RS-2 四项。**
```
条目 F-09b-0（先派，约 40 次调用）：在模拟器里跑 micro-opus 的 encode_benchmark（S3），确认有没有用到未实现的 PIE / EE.* 指令以及实时倍率。只出结论写进 RS-2-xiaozhi.md 末尾，不改代码。
条目 F-09b-1：firmware/s3-xiaozhi-lite（IDF 5.5.1 + esp_websocket_client + micro-opus 或 F-09b-0 定的替代 + SSD1306，BOOT 键按住说话），accept 3 个用例（正常一轮、10 s 无 hello 重连、中途 abort）；下行 Opus 素材用合成音或 CC0 语音离线编码，只提交生成脚本和小文件。
条目 F-09b-2：网页语音面板 + tools/webtest/xiaozhi.mjs（导出输入后 CLI 重放串口逐字节一致，含 390×844）+ agent-browser；选型层标注「行为模拟」，唤醒词和 AEC 标「必须上真机」。
入口与细节见 RS-2-xiaozhi.md §6。
```

#### F-10d 经典 ESP32 I2S（已由 M5-12 覆盖，不派）
参数：`model: "opus"`。
```
条目 F-10d：经典 ESP32 I2S（扬声器 / 麦克风），复用 soc 里 C3 / S3 的 I2S 音频路径（grep -rn "struct I2s" core/crates）。
验收：固件 esp32-i2s-tone + accept，用 Web Audio analyser 数据判频率和 RMS（AGENTS.md §6 第 3 条）。
```

## 5. 每波收尾（主会话）

1. 子代理汇报逐个读（只读 ≤ 300 字的汇报，不读 `.output`）；失败或遗留写进 README 状态表。
2. 按依赖顺序合并到 main：先 core，再 web；冲突按 §2.3。
3. 合并后跑：`cd core && cargo test`、`tools/accept.sh`（全量，含 web）、`cd web && node --test test/i18n.test.ts`、`python3 tools/lint_comments.py`；改了仿真行为的跑 `tools/golden.py check`，确认后 `save`。
4. 删合并完的 worktree。
5. 更新 `docs/plan-F/README.md` 状态表、`docs/PLAN.md` F 批状态、`docs/STATUS.md`；提交（英文信息）。
6. 写 `Reviews/batch-F<波号>.md`（做了什么、截图、未完成项），向人汇报；人 `/clear` 后再开下一波。
7. 波 5 结束后按 `EVAL.md` §2 重新打分，更新画布。
