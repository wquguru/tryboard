# G 批第二轮：分会话提示词（G-06 – G-15）

2026-10-22 定。来源：过去 7 天新能力对照作品的缺口盘点（PLAN G-06 – G-15）。每段整体复制进一个新的 Claude Code 会话（`/clear` 后或新终端）。

## 派发顺序

| 波 | 可并行 | 说明 |
|---|---|---|
| 1 | G-06、G-07、G-09、G-10、G-11、G-12、G-15 | G-09 / G-10 都动 `core/crates/wasm/src/lib.rs` 与元件库，合并时先 G-09 后 G-10 |
| 1b | G-08、G-13、G-14 | G-08 等 G-09 / G-10 合并；G-13 / G-14 等 G-06 合并（都动 m5shell / boards） |
| 2 | Dial 计时器作品、AMOLED 时钟作品 | 等 G-06 / G-07 / G-13 结论再写提示词 |

人做：语音面板真浏览器麦克风走查（F-09c 只在 puppeteer 假设备验过）。

## 每段共用的开头（已写进下面每段，不用另贴）

> 你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：`git worktree add ../tb-<ID> -b <ID> main`，之后只在 `../tb-<ID>` 里改。先读 AGENTS.md 与 docs/AGENT_BRIEF.md（模板里的验收、worktree 软链、省 token、汇报要求全部照做；不得派子代理）。任务是 docs/PLAN.md 的 <ID> 行。

---

### G-06 · M5Dial 编码器（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-06 -b G-06 main，之后只在 ../tb-G-06 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-06 行。

目标：M5Dial 的旋钮在网页上能转，且网页与 CLI 结果一致；顺手接上 Core2 的 A/B/C 触摸键。
已知事实（不用再查）：
- 核心已接好：core/crates/machine/src/boards.rs:130 m5dial 预设 encoder: Some((40, 41))，:496 encoder_attach；网页回放 enc= / encsw= 直接调 tb_encoder_turn / tb_encoder_press（web/src/simrun.ts:196-197）。
- 缺口 1（3D）：web/src/bench3d/m5shell.ts:184-191 的橙色转环 pick 成按键 A。台灯编码器的拖动 / 滚轮 / 按下逻辑在 web/src/bench3d/pick.ts:113-180（ctx.encoder = {knob, hit, pos, pushed, y0}，见 web/src/bench3d/build.ts:360 的赋值）。让 Dial 的转环成为 ctx.encoder（转环 = 拖动 / 滚轮转、短按 = 编码器按键或按键 A，按真机：Dial 按下整个屏是按键 A G42），屏幕玻璃仍是触摸面。m5Shell 在 web/src/bench3d/scene.ts:317 创建。
- 缺口 2（分片）：web/src/simrun.ts:256 只有 j.encoder 才用 1 ms 分片，板预设带的编码器走 10 ms。先写复现：Dial + 快转 20 格，网页 vs `tryboard run --board m5dial --inputs` 指纹是否一致；不一致就让带编码器的板预设也走 1 ms（live 路径 web/src/live.ts 一并查）。
- 缺口 3：Core2 A/B/C 触摸区只画不接（PLAN M5-09c）。查 boards.rs 的 core2 预设和 FT6336 触摸坐标，把三个区点击映射成屏外触摸点（与 M5Unified 判定一致）。
验收：cargo test；tools/webtest/m5board.mjs 加 Dial 转动 + 按下、Core2 ABC 用例（网页 / CLI 指纹与回放一致）；用 Arduino M5Dial 编码器示例或 m5-probe 打印编码器计数；agent-browser 桌面 + 390×844（转环可拖、不误转视角），记录 Reviews/ab/G-06.md。
不做：Dial 蜂鸣器（G-13）、Grove 3D（G-14）。
完成后：PLAN G-06 ☑ + STATUS，worktree 分支提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-07 · AMOLED 网页速度实测（默认模型，只测不改）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-07 -b G-07 main，之后只在 ../tb-G-07 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-07 行。

目标：判断 480×480 AMOLED 板（ws-amoled216：CO5300 + CST9220 + AXP2101 + PCF85063）在网页上能否撑起一个 LVGL 时钟 / 手表作品。
背景：GC9A01 240×240 的 LVGL 网页实时倍率约 0.5×（PLAN P2-07，Xtensa 预解码缓存 + worker 调度）。AMOLED 示例：firmware/examples.json 里 s3-co5300、s3-amoled-i2c、s3-ai-dash（board ws-amoled216）；3D 板在 web/src/bench3d/scene.ts:317 amoledBoard。
做法：tools/build_web.sh 后 vite preview，用 puppeteer 或页面暴露的模拟时钟钩子（参考 tools/webtest/aidash.mjs、tools/webtest/embed.mjs 的取样方式）测：模拟秒 / 墙钟秒、LCD 帧间隔、滑动翻页的响应延迟；同机对比 GC9A01 的 lens 或 tilt 作品；CLI 侧用 `tryboard run` 测纯核心速度区分「核心慢」还是「渲染 / 传帧慢」（LCD 帧从 worker 传主线程的路径看 web/src/worker.ts）。
产出：docs/DECISIONS.md 一条（数字表 + 结论：可直接做 / 先优化哪里 / 不建议），PLAN G-07 改 ☑ 并写结论一句。不改产品代码；若发现一处明显低成本优化，只写进结论不动手。
完成后：提交 docs 改动（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-08 · 选型可信度核对（默认模型；等 G-09 / G-10 合并后派）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-08 -b G-08 main，之后只在 ../tb-G-08 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-08 行。

目标：选板 / 结果卡上的可信度不夸大。
入口：web/src/advisor/derive.ts:158-163 trustRows（零件按 simCoverage + PART_MAP / exampleOnly 定级）；web/src/advisor/catalogmap.ts:46 exampleOnly、EXAMPLE_ONLY、noModelParts；web/src/advisor/brief.ts:58；网页 I2C 器件表 web/src/i2cdevs.ts:12 KIND（wasm 能挂的器件）与 core/crates/soc/src/devices/mod.rs:44 make_i2c（CLI 能挂的器件）。
要做：
1. 规则：零件标「仿真验证 / 行为模拟」的前提是网页能跑（wasm 有模型且有示例或作品在网页可开）；只有 CLI 能跑的标「需真机确认」并注明「命令行可模拟」。列出现状所有零件的判定表写进 Reviews/ab/G-08.md。
2. 板预设里推断的项（core/crates/machine/src/boards.rs 各预设 note 字段，如 m5dial「encoder A/B order inferred」、Cardputer 键位待真机）在用到它们的结论里标「需真机确认」，即使 verified: true。
3. 加自动校验（web/test 单测或扩 tools/check_config.py）：故意把一个仅 CLI 零件标仿真能报出。
验收：cd web && npm test；tools/check_config.py --selftest；agent-browser 选含 INA219 / 带 Dial 的模板截图（桌面 + 390）。i18n：新文案走 t()，zh / ja / ko 同时加。
完成后：PLAN G-08 ☑ + STATUS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-09 · INA219 + DS3231 上网页（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-09 -b G-09 main，之后只在 ../tb-G-09 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-09 行。

目标：INA219（电流 / 电压）和 DS3231（RTC + 温度）在网页实验台可放、可接线、可跑，结果与 CLI 一致。
已知：CLI 已有模型（core/crates/soc/src/devices/mod.rs:81-82，PLAN F-04e：INA219 读电气模型 USB 5V，DS3231 温度跟 --env），accept 用例 c3-i2c-trio。网页缺：wasm I2C 种类表（core/crates/wasm/src/lib.rs:349 附近数字 → 名称映射，web/src/i2cdevs.ts:12 KIND 同步，aht20 = 13 是最近一个范例）、元件库 / 3D / 手机。
照抄的范例：commit e69af2b（F-04a2 显示屏上网页）改动的文件清单：web/src/app/devs.ts、place.ts、bom.ts、session.ts、bench/placing.tsx、bench/ui/conf.tsx、tools/webtest/parts.mjs、firmware/examples.json；零件定义在 web/src/catalog/parts.ts:687（ds3231）/ :704（ina219）与 web/src/catalog/parts-bench.ts。3D 按真实尺寸程序生成。
验收：cargo test；tools/build_web.sh；parts.mjs 加 c3-i2c-trio（网页 / CLI 指纹一致，改环境温度后 DS3231 读数跟随）；agent-browser 桌面 + 390，记录 Reviews/ab/G-09.md。i18n 四语。wasm 首包仍 ≤ 2 MB。
不做：选型可信度（G-08 统一改）。
完成后：PLAN G-09 ☑ + STATUS（F-04e 行「网页未接」同步改），提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-10 · CYD + XPT2046 上网页（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-10 -b G-10 main，之后只在 ../tb-G-10 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-10 行。

目标：「Cheap Yellow Display」（经典 ESP32 + ILI9341 320×240 + XPT2046 电阻触摸）在网页能选、能看屏、能点屏，结果与 CLI 一致。
已知：CLI 已通（PLAN F-10a2）：core/crates/machine/src/boards.rs:375 预设 id "cyd"（HSPI 14/13/15/2、BL 21）；触摸 `--spi xpt2046`（VSPI 25/32/39/33、IRQ 36），脚本动作 touch= / release；固件 esp32-cyd、esp32-cyd-touch（accept 通过）。网页缺：板预设下拉（web/src/app/bench/preset.tsx，现列 12 块 M5 板，worker 侧 web/src/worker.ts 调 tb_board_preset）、3D 外壳（参考 web/src/bench3d/m5shell.ts 的参数化生成与 LCD 纹理，scene.ts:317 分派）、点屏 → xpt2046 触摸（参考 AMOLED / M5 触摸屏的点屏映射）、示例上架 firmware/examples.json。
验收：cargo test；tools/build_web.sh；m5board.mjs 扩展或新 webtest：CYD 屏画面、点屏重放与 CLI `--board cyd --spi xpt2046 --inputs` 指纹一致；agent-browser 桌面 + 390，记录 Reviews/ab/G-10.md。i18n 四语。
合并：G-09 也改 wasm/lib.rs 与元件库，若 G-09 已在 main，先 rebase。
完成后：PLAN G-10 ☑ + STATUS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-11 · 蓝牙未识别提示（sonnet）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-11 -b G-11 main，之后只在 ../tb-G-11 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-11 行。

目标：用户上传的固件用了 BLE 但签名没认出时（Arduino 3.0.x、IDF 5.5.1 以外版本等，见 PLAN F-08c / E-04 / E-09），网页明确告诉用户原因和可用版本，不静默。
入口：wasm 已有 tb_ble_state()（0 无 BLE / 1 认出 / 2 用了但没认出）与 tb_ble_json（state 2 时 {"error": reason}），见 web/src/wasm.gen.ts:176-181。先 grep 网页现在哪里读 tb_ble_state（蓝牙坞面板），确认 state 2 时界面实际显示什么（截图）。
要做：state 2 → 串口面板上方或蓝牙坞显示一条提示：原因 + 「已验证：IDF 5.5.1（C3 / S3 / 经典 ESP32）、IDF 5.1–5.3.1（C3）」类事实（以 docs/STATUS.md 蓝牙行为准）；选型结论不受影响。文案走 t()，en / zh / ja / ko 同时加。
复现固件：找一个签名不命中的 BLE 固件（Reviews 或 third_party 里旧 IDF 构建产物），没有就在 core 单测里构造并在网页用 ?debug=1 注入状态。
验收：cd web && npm test；python3 tools/lint_comments.py；agent-browser 截图 Reviews/ab/G-11.png（桌面 + 390），记录 Reviews/ab/G-11.md。
完成后：PLAN G-11 ☑，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 200 字。
```

### G-12 · M5 PDM 麦克风样本颠倒（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-12 -b G-12 main，之后只在 ../tb-G-12 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-12 行。

目标：查清并修复 PLAN M5-13 遗留「M5Unified PDM 麦克风样本成对颠倒」，不让 esp32-pdm-mic 回退。
入口：经典 ESP32 I2S 模型 core/crates/esp32/src/i2s.rs:234 pdm_rx、:450 encode_rx（:455-457 pdm / RX_MSB_SHIFT 分支）；S3 侧 core/crates/soc/src/i2s.rs:500 encode_rx 作对照；DECISIONS 里搜 M5-13 / PDM 的记录。
做法：先写最小复现（M5Unified 草图读已知递增样本 / 正弦，打印前 8 个样本；IDF esp32-pdm-mic 同样打印），对照 ESP32 TRM 的 PDM RX 字序（可读 espressif/qemu 理解但不得抄）判定谁对；若是寄存器（如 RX_CHAN_MOD / 字节序位）没建模，按位实现而不是对某个草图特判。
验收：cargo test；tools/golden.py check（差异须逐条解释并写进 DECISIONS）；新 accept 用例覆盖 M5 PDM 顺序；tools/accept.sh --no-web 相关用例。
完成后：PLAN G-12 ☑ + M5-13 遗留注明，STATUS 更新，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-13 · M5Dial 蜂鸣器（默认模型；G-06 合并后派）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-13 -b G-13 main，之后只在 ../tb-G-13 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-13 行。

目标：M5Dial 板载蜂鸣器能出声（后续「Dial 计时器」作品要用），做不到就明确标需真机。
已知：core/crates/machine/src/boards.rs:130 m5dial 预设 note「buzzer is I2S 1-bit on G3 (no model)」，outputs 里 ("buzzer", 3)。先确认 M5Unified 在 Dial 上实际怎么驱动 G3（读 M5Unified 源码，MIT 可参考），是 I2S 输出还是 LEDC。S3 I2S 输出与网页喇叭链路已有（F-09b MAX98357A：I2S → Web Audio，参考 xiaozhi 示例与 tools/webtest/xiaozhi.mjs 的 analyser 判定）。
要做：把 G3 的输出接到现有喇叭 / 蜂鸣器音频通路（单声道、1 位按电平或 PCM 包络转音频），网页 3D 上 Dial 发声；CLI 能导出 WAV 或打印 RMS。
验收：Arduino M5Dial 草图 M5.Speaker.tone(2000, 200) 的 accept 用例（频率 / RMS 判定）；网页 analyser 有能量（headless 帧率不算）；golden 不变；agent-browser 走查记录 Reviews/ab/G-13.md。若判断成本过高：DECISIONS 写原因，选型结论里 Dial 蜂鸣器标「需真机」，PLAN 标 ✗。
完成后：PLAN G-13 ☑ / ✗ + STATUS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-14 · Grove ENV 单元 3D（sonnet；G-06 合并后派）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-14 -b G-14 main，之后只在 ../tb-G-14 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-14 行。

目标：M5 板接了 Grove ENV III / ENV IV（SceneSpec.grove，见 PLAN M5-09d）时，3D 里在外壳 Grove 口画出单元和线，取消时消失。
入口：web/src/bench3d/m5shell.ts（Grove 口位置在尺寸表里，「Grove 口仅画在壳上」）；SceneSpec.grove 的读法 grep `grove` 于 web/src/bench3d/scene.ts。单元按真实尺寸程序生成（M5 Unit 外壳 24×32×8 mm 左右，以 docs.m5stack.com 尺寸为准），不引入外部模型。
验收：tools/webtest/m5board.mjs 不减断言全过；agent-browser AtomS3 + ENV IV、StickC Plus2 + ENV III 截图（桌面 + 390），记录 Reviews/ab/G-14.md；console 无 error。
完成后：PLAN G-14 ☑，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 200 字。
```

### G-15 · 红外自发自收例子（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-15 -b G-15 main，之后只在 ../tb-G-15 里改。先读 AGENTS.md、docs/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-15 行。

目标：一个示例把红外发射和接收串起来：同一块 C3 用 IR LED（LEDC 38 kHz 载波，PLAN F-08h）发 NEC，接收头（PLAN F-08i，GPIO5，IRremote 接收走 50 µs 定时器读电平）收回并打印；用户在网页上能看到两端。
入口：firmware/arduino/lib-irremote-rx（接收范例）、自写 NEC 发送示例（PLAN F-08f，不参考 IRremote 源码）、IR LED「眼睛」解码 LEDC 包络（commit c1bbd6e）；接收头模型的 Drive 直接驱动 GPIO 输入电平。先确认模型里 IR LED 输出能否直接驱动同场景的接收头（光路），不能就加一条最小的「LED → 接收头」耦合（同场景、无距离 / 角度模型，DECISIONS 记一句）。
验收：accept 新用例（串口逐条解出发出的地址 / 命令）；parts.mjs 或新 webtest 网页 / CLI 指纹一致；agent-browser 走查 Reviews/ab/G-15.md。授权：IRremote 只用已获批部分（docs/LICENSING.md）。
完成后：PLAN G-15 ☑ + STATUS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```
