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

> 你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：`git worktree add ../tb-<ID> -b <ID> main`，之后只在 `../tb-<ID>` 里改。先读 AGENTS.md 与 docs/internal/AGENT_BRIEF.md（模板里的验收、worktree 软链、省 token、汇报要求全部照做；不得派子代理）。任务是 docs/PLAN.md 的 <ID> 行。

---

### G-06 · M5Dial 编码器（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-06 -b G-06 main，之后只在 ../tb-G-06 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-06 行。

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
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-07 -b G-07 main，之后只在 ../tb-G-07 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-07 行。

目标：判断 480×480 AMOLED 板（ws-amoled216：CO5300 + CST9220 + AXP2101 + PCF85063）在网页上能否撑起一个 LVGL 时钟 / 手表作品。
背景：GC9A01 240×240 的 LVGL 网页实时倍率约 0.5×（PLAN P2-07，Xtensa 预解码缓存 + worker 调度）。AMOLED 示例：firmware/examples.json 里 s3-co5300、s3-amoled-i2c、s3-ai-dash（board ws-amoled216）；3D 板在 web/src/bench3d/scene.ts:317 amoledBoard。
做法：tools/build_web.sh 后 vite preview，用 puppeteer 或页面暴露的模拟时钟钩子（参考 tools/webtest/aidash.mjs、tools/webtest/embed.mjs 的取样方式）测：模拟秒 / 墙钟秒、LCD 帧间隔、滑动翻页的响应延迟；同机对比 GC9A01 的 lens 或 tilt 作品；CLI 侧用 `tryboard run` 测纯核心速度区分「核心慢」还是「渲染 / 传帧慢」（LCD 帧从 worker 传主线程的路径看 web/src/worker.ts）。
产出：docs/DECISIONS.md 一条（数字表 + 结论：可直接做 / 先优化哪里 / 不建议），PLAN G-07 改 ☑ 并写结论一句。不改产品代码；若发现一处明显低成本优化，只写进结论不动手。
完成后：提交 docs 改动（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-08 · 选型可信度核对（默认模型；等 G-09 / G-10 合并后派）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-08 -b G-08 main，之后只在 ../tb-G-08 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-08 行。

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
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-09 -b G-09 main，之后只在 ../tb-G-09 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-09 行。

目标：INA219（电流 / 电压）和 DS3231（RTC + 温度）在网页实验台可放、可接线、可跑，结果与 CLI 一致。
已知：CLI 已有模型（core/crates/soc/src/devices/mod.rs:81-82，PLAN F-04e：INA219 读电气模型 USB 5V，DS3231 温度跟 --env），accept 用例 c3-i2c-trio。网页缺：wasm I2C 种类表（core/crates/wasm/src/lib.rs:349 附近数字 → 名称映射，web/src/i2cdevs.ts:12 KIND 同步，aht20 = 13 是最近一个范例）、元件库 / 3D / 手机。
照抄的范例：commit e69af2b（F-04a2 显示屏上网页）改动的文件清单：web/src/app/devs.ts、place.ts、bom.ts、session.ts、bench/placing.tsx、bench/ui/conf.tsx、tools/webtest/parts.mjs、firmware/examples.json；零件定义在 web/src/catalog/parts.ts:687（ds3231）/ :704（ina219）与 web/src/catalog/parts-bench.ts。3D 按真实尺寸程序生成。
验收：cargo test；tools/build_web.sh；parts.mjs 加 c3-i2c-trio（网页 / CLI 指纹一致，改环境温度后 DS3231 读数跟随）；agent-browser 桌面 + 390，记录 Reviews/ab/G-09.md。i18n 四语。wasm 首包仍 ≤ 2 MB。
不做：选型可信度（G-08 统一改）。
完成后：PLAN G-09 ☑ + STATUS（F-04e 行「网页未接」同步改），提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-10 · CYD + XPT2046 上网页（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-10 -b G-10 main，之后只在 ../tb-G-10 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-10 行。

目标：「Cheap Yellow Display」（经典 ESP32 + ILI9341 320×240 + XPT2046 电阻触摸）在网页能选、能看屏、能点屏，结果与 CLI 一致。
已知：CLI 已通（PLAN F-10a2）：core/crates/machine/src/boards.rs:375 预设 id "cyd"（HSPI 14/13/15/2、BL 21）；触摸 `--spi xpt2046`（VSPI 25/32/39/33、IRQ 36），脚本动作 touch= / release；固件 esp32-cyd、esp32-cyd-touch（accept 通过）。网页缺：板预设下拉（web/src/app/bench/preset.tsx，现列 12 块 M5 板，worker 侧 web/src/worker.ts 调 tb_board_preset）、3D 外壳（参考 web/src/bench3d/m5shell.ts 的参数化生成与 LCD 纹理，scene.ts:317 分派）、点屏 → xpt2046 触摸（参考 AMOLED / M5 触摸屏的点屏映射）、示例上架 firmware/examples.json。
验收：cargo test；tools/build_web.sh；m5board.mjs 扩展或新 webtest：CYD 屏画面、点屏重放与 CLI `--board cyd --spi xpt2046 --inputs` 指纹一致；agent-browser 桌面 + 390，记录 Reviews/ab/G-10.md。i18n 四语。
合并：G-09 也改 wasm/lib.rs 与元件库，若 G-09 已在 main，先 rebase。
完成后：PLAN G-10 ☑ + STATUS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-11 · 蓝牙未识别提示（sonnet）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-11 -b G-11 main，之后只在 ../tb-G-11 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-11 行。

目标：用户上传的固件用了 BLE 但签名没认出时（Arduino 3.0.x、IDF 5.5.1 以外版本等，见 PLAN F-08c / E-04 / E-09），网页明确告诉用户原因和可用版本，不静默。
入口：wasm 已有 tb_ble_state()（0 无 BLE / 1 认出 / 2 用了但没认出）与 tb_ble_json（state 2 时 {"error": reason}），见 web/src/wasm.gen.ts:176-181。先 grep 网页现在哪里读 tb_ble_state（蓝牙坞面板），确认 state 2 时界面实际显示什么（截图）。
要做：state 2 → 串口面板上方或蓝牙坞显示一条提示：原因 + 「已验证：IDF 5.5.1（C3 / S3 / 经典 ESP32）、IDF 5.1–5.3.1（C3）」类事实（以 docs/STATUS.md 蓝牙行为准）；选型结论不受影响。文案走 t()，en / zh / ja / ko 同时加。
复现固件：找一个签名不命中的 BLE 固件（Reviews 或 third_party 里旧 IDF 构建产物），没有就在 core 单测里构造并在网页用 ?debug=1 注入状态。
验收：cd web && npm test；python3 tools/lint_comments.py；agent-browser 截图 Reviews/ab/G-11.png（桌面 + 390），记录 Reviews/ab/G-11.md。
完成后：PLAN G-11 ☑，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 200 字。
```

### G-12 · M5 PDM 麦克风样本颠倒（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-12 -b G-12 main，之后只在 ../tb-G-12 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-12 行。

目标：查清并修复 PLAN M5-13 遗留「M5Unified PDM 麦克风样本成对颠倒」，不让 esp32-pdm-mic 回退。
入口：经典 ESP32 I2S 模型 core/crates/esp32/src/i2s.rs:234 pdm_rx、:450 encode_rx（:455-457 pdm / RX_MSB_SHIFT 分支）；S3 侧 core/crates/soc/src/i2s.rs:500 encode_rx 作对照；DECISIONS 里搜 M5-13 / PDM 的记录。
做法：先写最小复现（M5Unified 草图读已知递增样本 / 正弦，打印前 8 个样本；IDF esp32-pdm-mic 同样打印），对照 ESP32 TRM 的 PDM RX 字序（可读 espressif/qemu 理解但不得抄）判定谁对；若是寄存器（如 RX_CHAN_MOD / 字节序位）没建模，按位实现而不是对某个草图特判。
验收：cargo test；tools/golden.py check（差异须逐条解释并写进 DECISIONS）；新 accept 用例覆盖 M5 PDM 顺序；tools/accept.sh --no-web 相关用例。
完成后：PLAN G-12 ☑ + M5-13 遗留注明，STATUS 更新，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-13 · M5Dial 蜂鸣器（默认模型；G-06 合并后派）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-13 -b G-13 main，之后只在 ../tb-G-13 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-13 行。

目标：M5Dial 板载蜂鸣器能出声（后续「Dial 计时器」作品要用），做不到就明确标需真机。
已知：core/crates/machine/src/boards.rs:130 m5dial 预设 note「buzzer is I2S 1-bit on G3 (no model)」，outputs 里 ("buzzer", 3)。先确认 M5Unified 在 Dial 上实际怎么驱动 G3（读 M5Unified 源码，MIT 可参考），是 I2S 输出还是 LEDC。S3 I2S 输出与网页喇叭链路已有（F-09b MAX98357A：I2S → Web Audio，参考 xiaozhi 示例与 tools/webtest/xiaozhi.mjs 的 analyser 判定）。
要做：把 G3 的输出接到现有喇叭 / 蜂鸣器音频通路（单声道、1 位按电平或 PCM 包络转音频），网页 3D 上 Dial 发声；CLI 能导出 WAV 或打印 RMS。
验收：Arduino M5Dial 草图 M5.Speaker.tone(2000, 200) 的 accept 用例（频率 / RMS 判定）；网页 analyser 有能量（headless 帧率不算）；golden 不变；agent-browser 走查记录 Reviews/ab/G-13.md。若判断成本过高：DECISIONS 写原因，选型结论里 Dial 蜂鸣器标「需真机」，PLAN 标 ✗。
完成后：PLAN G-13 ☑ / ✗ + STATUS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-14 · Grove ENV 单元 3D（sonnet；G-06 合并后派）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-14 -b G-14 main，之后只在 ../tb-G-14 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-14 行。

目标：M5 板接了 Grove ENV III / ENV IV（SceneSpec.grove，见 PLAN M5-09d）时，3D 里在外壳 Grove 口画出单元和线，取消时消失。
入口：web/src/bench3d/m5shell.ts（Grove 口位置在尺寸表里，「Grove 口仅画在壳上」）；SceneSpec.grove 的读法 grep `grove` 于 web/src/bench3d/scene.ts。单元按真实尺寸程序生成（M5 Unit 外壳 24×32×8 mm 左右，以 docs.m5stack.com 尺寸为准），不引入外部模型。
验收：tools/webtest/m5board.mjs 不减断言全过；agent-browser AtomS3 + ENV IV、StickC Plus2 + ENV III 截图（桌面 + 390），记录 Reviews/ab/G-14.md；console 无 error。
完成后：PLAN G-14 ☑，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 200 字。
```

### G-15 · 红外自发自收例子（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-15 -b G-15 main，之后只在 ../tb-G-15 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-15 行。

目标：一个示例把红外发射和接收串起来：同一块 C3 用 IR LED（LEDC 38 kHz 载波，PLAN F-08h）发 NEC，接收头（PLAN F-08i，GPIO5，IRremote 接收走 50 µs 定时器读电平）收回并打印；用户在网页上能看到两端。
入口：firmware/arduino/lib-irremote-rx（接收范例）、自写 NEC 发送示例（PLAN F-08f，不参考 IRremote 源码）、IR LED「眼睛」解码 LEDC 包络（commit c1bbd6e）；接收头模型的 Drive 直接驱动 GPIO 输入电平。先确认模型里 IR LED 输出能否直接驱动同场景的接收头（光路），不能就加一条最小的「LED → 接收头」耦合（同场景、无距离 / 角度模型，DECISIONS 记一句）。
验收：accept 新用例（串口逐条解出发出的地址 / 命令）；parts.mjs 或新 webtest 网页 / CLI 指纹一致；agent-browser 走查 Reviews/ab/G-15.md。授权：IRremote 只用已获批部分（docs/LICENSING.md）。
完成后：PLAN G-15 ☑ + STATUS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

---

# 第三轮（2026-10-23 定）：作品线 G-05b – G-17c

G-06 – G-13、G-15 已合并 main；G-14 仍用上面那段。

| 波 | 可并行 | 说明 |
|---|---|---|
| 3 | G-14、G-05b、G-16a、G-17a | 三个作品线都改 `web/src/app/types.ts` WorkId、`works.ts`、`catalog/templates.ts`、`firmware/levels.json`、i18n，均为追加；合并顺序 G-05b → G-16a → G-17a，后合的先 rebase |
| 4 | G-05c、G-05d、G-16b、G-17b | 各等本线上一段合并 |
| 5 | G-16c、G-17c | 同上 |

作品全套文件的范例（照抄结构，不要从零摸索）：红外夜灯三段 —— 阶段一 `git show --stat 8ae7326`（固件、levels / accept / examples.json、works.ts、types.ts、templates.ts、parts-bench.ts、catalogmap.ts、custom.ts、catalog.test.ts），网页流程 `0602832`（home/cards.ts、steps/irlamp.tsx、steps/product.tsx、steps/shop.tsx、views/*product.ts、levels.mjs、mobile.mjs），组装 / 3D `1e2de60`（steps/assemble.tsx、works3d-irlamp.ts、works3d.ts、views/templates.ts、asm3d.mjs）。

成品板作品（G-16 / G-17）是第一次：没有面包板、不用接线。阶段一的会话先看 `web/src/app/works.ts` 与 shop / bench 步骤是否假设了面包板，在 DECISIONS 写清成品板作品怎么走四步（采购只买板 + 配件、台面直接上板预设、组装改为支架 / 外壳），再动手。

### G-05b · 温湿度上云网页流程（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-05b -b G-05b main，之后只在 ../tb-G-05b 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）、docs/internal/plan-G/BRIEFS.md「第三轮」开头的范例说明。任务是 docs/PLAN.md 的 G-05b 行。

背景：作品 cloud 阶段一已在 main（固件 firmware/c3-cloud：C3 + AHT20 SDA6 / SCL7 0x38 + Wi-Fi + esp-mqtt，data / cmd `interval=<1–60>` / ack 主题；检查点 cloud-1..4 在 firmware/levels.json）。DECISIONS「2026-10-22 G-05」记着网页缺 aht20 场景件导致示例读数失败——G-09 已把 AHT20 放上网页实验台（看 G-09 合并 e2b6d56 的改动找 SCENE_TYPE / 放置入口），先把 c3-cloud 示例的 scene.parts 补上 AHT20 并确认网页读数正确。网页 MQTT 发布面板已有（F-08g，网络页签）。
要做：照红外夜灯 0602832 的结构做 cloud 的首页卡片、采购、台面、2D 产品页（当前温湿度 + 最近上报 + 「从云端改间隔」按钮走 mqtt= 动作进输入日志）。
验收：cd web && npm test；tools/build_web.sh；levels.mjs 加 cloud 检查点网页 / CLI 指纹一致；mobile.mjs 加 cloud 用例；agent-browser 首页 → 采购 → 台面 → 一键内置固件 → cloud-1..4 全绿 → 产品页改间隔，桌面 + 390，记录 Reviews/ab/G-05b.md。i18n 四语。
不做：组装 / 3D（G-05c）、配网（G-05d）。
完成后：PLAN G-05b ☑ + STATUS，worktree 分支提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-05c · 温湿度上云组装 / 3D（默认模型；G-05b 合并后）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-05c -b G-05c main，之后只在 ../tb-G-05c 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）、docs/internal/plan-G/BRIEFS.md「第三轮」开头。任务是 docs/PLAN.md 的 G-05c 行。

要做：照 1e2de60（红外夜灯组装 / 3D）给 cloud 做组装模板与 3D 成品。装法影响至少一处且要反映到仿真：AHT20 贴着板子 / 稳压器放 → 读数偏高（用 --env 偏移或已有发热模型，先 grep enclosure.ts 里 aht20 的处理），对应检查点在错误装法下复测失败。3D 成品：外壳 + 读数小屏或云端曲线面板，读数随仿真变。
验收：asm3d.mjs / interact webtest 不减断言并加 cloud 用例；check.py --ref --all；agent-browser 桌面 + 390，记录 Reviews/ab/G-05c.md。
完成后：PLAN G-05c ☑，G-05 主行在三段都完成时改 ☑；提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-05d · 温湿度上云「手机配网」（默认模型；G-05b 合并后）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-05d -b G-05d main，之后只在 ../tb-G-05d 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-05d 行。

目标：c3-cloud 首次开机没有 Wi-Fi 凭据时开 SoftAP 配网页，手机配好后存 NVS、连路由、再上云；作品加一关「手机配网」。
入口：firmware/c3-cloud（现硬编码凭据，先 grep wifi_config）；配网做法照 firmware/c3-softap-prov（AGENTS.md 命令表：`--ap-phone --ap-post 'ssid=..&pass=..'`，脚本动作 phone=on / join / open / post）；网页回归参考 tools/webtest/softap.mjs。注意 C-02 记录：虚拟路由器与 SoftAP 地址冲突的处理已在 PLAN C-02 行写明，先读。
要做：固件加配网分支（已有凭据直接连，保持 cloud-1..4 原判定不变）；levels.json 加新检查点（放在 cloud-1 前或后，DECISIONS 说明顺序）；网页台面能触发虚拟手机配网。
验收：accept 新用例；tools/check.py --ref --all（原 cloud-1..4 仍过）；golden 差异逐条解释；网页 softap 式用例网页 / CLI 指纹一致；agent-browser 走查 Reviews/ab/G-05d.md。
完成后：PLAN G-05d ☑ + STATUS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-16a · Dial 计时器阶段一（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-16a -b G-16a main，之后只在 ../tb-G-16a 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）、docs/internal/plan-G/BRIEFS.md「第三轮」开头（成品板作品要先写 DECISIONS）、docs/M5STACK.md §7（Arduino 构建产物上站规则）。任务是 docs/PLAN.md 的 G-16a 行。

目标：新作品「Dial 计时器」（WorkId `dialtimer`，M5Dial）固件 + 检查点 + 登记，CLI 全通。
已有能力：板预设 core/crates/machine/src/boards.rs:130 m5dial（GC9A01 圆屏、FT3267 触摸、BM8563 RTC、编码器 G40/41、按键 A G42、蜂鸣器 G3）；编码器网页可转（G-06）；蜂鸣器出声（G-13：M5Unified Speaker on G3，accept `arduino-m5-dial-tone` 2000 Hz，报告行 `[tryboard] I2S buzzer ...`）；现有草图 arduino-m5-dial-demo / -tone 在 firmware/arduino/ 下可作起点；CLI `tryboard run <bin> --board m5dial`，编码器脚本动作 enc= / encsw=，按键 / 触摸动作看 accept.json 里 m5dial 用例。
固件（Arduino + M5Unified，串口打印用中文，照现有作品）：旋钮调分钟（1–60）、按 A 开始 / 暂停、倒计时屏上显示、到点蜂鸣 3 声、触摸屏取消。
检查点 dialtimer-1..4 建议：① 开机屏显示 05:00 且旋钮 +3 → 08:00；② 开始后计时走（模拟时间推进，串口 / 屏读数）；③ 到点蜂鸣（频率 / 次数判定，用已有判定或新加——新判定须 check.py 与 web/src/checks.ts 同步）；④ 运行中触摸取消回到设定。参考固件放 firmware/levels.json 的 ref。
登记：照 8ae7326 的文件清单（works.ts、types.ts、templates.ts、examples.json、catalogmap.ts、i18n 四语）。
验收：tools/build_arduino.sh（或现有 Arduino 构建脚本）；accept 新用例；tools/check.py --ref --all；npx 指纹一致；cd web && npm test。
不做：网页流程（G-16b）、组装 / 3D（G-16c）。
完成后：PLAN G-16a ☑ + STATUS + DECISIONS（成品板四步怎么走），提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-16b · Dial 计时器网页流程（默认模型；G-16a 合并后）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-16b -b G-16b main，之后只在 ../tb-G-16b 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）、docs/DECISIONS.md 里 G-16a 关于成品板四步的决定。任务是 docs/PLAN.md 的 G-16b 行。

要做：照 0602832 的结构做 dialtimer 首页卡片、采购（成品板 + 配件，无面包板）、台面（直接 Dial 板预设，3D 外壳 web/src/bench3d/m5shell.ts，转环 = 编码器）、产品页（3D Dial 可转可按可触、蜂鸣经 Web Audio 可听；手机产品键 开始 / +1 / -1 / 取消）。
验收：levels.mjs 加 dialtimer 检查点网页 / CLI 指纹一致；mobile.mjs、m5board.mjs 不减断言；声音以 analyser 数据判定；agent-browser 桌面 + 390，记录 Reviews/ab/G-16b.md。i18n 四语。
完成后：PLAN G-16b ☑，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-16c · Dial 计时器装法 / 成品（默认模型；G-16b 合并后）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-16c -b G-16c main，之后只在 ../tb-G-16c 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）、DECISIONS 里 G-16a 的成品板决定。任务是 docs/PLAN.md 的 G-16c 行。

要做：照 1e2de60 给 dialtimer 做成品板的「组装」步：支架 / 外壳选择，至少一处装法影响反映到仿真（如蜂鸣孔朝下贴桌 → 响度降低、dialtimer-3 响度判定失败；或磁吸底座挡住转环）；3D 成品场景（桌面上的 Dial，可转可按、到点发声）。
验收：asm3d.mjs 加 dialtimer 用例；check.py --ref --all；agent-browser 桌面 + 390，记录 Reviews/ab/G-16c.md。
完成后：PLAN G-16c ☑，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-17a · AMOLED 桌面时钟阶段一（默认模型）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-17a -b G-17a main，之后只在 ../tb-G-17a 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）、docs/internal/plan-G/BRIEFS.md「第三轮」开头（成品板作品要先写 DECISIONS）、DECISIONS「2026-10-22 G-07」（速度结论）。任务是 docs/PLAN.md 的 G-17a 行。

目标：新作品「AMOLED 桌面时钟」（WorkId `amoclock`，板 ws-amoled216：S3 + CO5300 480×480 + CST9220 触摸 + AXP2101 + PCF85063）固件 + 检查点 + 登记，CLI 全通。
起点：firmware/s3-ai-dash（同板 IDF + LVGL，屏 / 触摸 / PMIC / RTC 驱动和 lcd_regions 区域检查都在，accept 用例 s3-ai-dash / -swipe / -usage）；BLE 用 firmware/s3-ble-hr（NimBLE，`--ble-phone`、`ble=write` 动作）的做法。G-07：数字 / 跳秒表盘网页可 1×，不做扫秒针和整屏动画。
固件（串口中文）：表盘页（PCF85063 时:分:秒，每秒局部刷新）、温度页（AXP2101 或芯片温度，二选一并说明）、电量页（AXP2101 电量 / 充电），左右滑动翻页；电源键短按息屏 / 亮屏；BLE 写一个特征值对时（写入 epoch 秒 → 设 RTC）。LVGL + NimBLE 在 S3 上内存不够或签名不命中时，第 4 关改为串口对时，DECISIONS 记原因。
检查点 amoclock-1..4 建议：① 开机表盘显示 RTC 时间（区域像素 + 串口）；② 滑动到电量页且数值跟 AXP2101 设定变；③ 电源键息屏（背光 / 亮度 0x51 为 0）再亮；④ 手机对时后时间正确。判定复用 lcd_regions 等现有项，新判定须 check.py 与 web/src/checks.ts 同步。
登记：照 8ae7326 的文件清单 + i18n 四语。
验收：tools/build_fw.sh amoclock 固件；accept 新用例；tools/check.py --ref --all；npx 指纹一致；cd web && npm test。
不做：网页流程（G-17b）、组装 / 3D（G-17c）、ES8311 声音（只是应答空壳）。
完成后：PLAN G-17a ☑ + STATUS + DECISIONS，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-17b · AMOLED 时钟网页流程（默认模型；G-17a 合并后）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-17b -b G-17b main，之后只在 ../tb-G-17b 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）、DECISIONS 里 G-16a / G-17a 的成品板决定。任务是 docs/PLAN.md 的 G-17b 行。

要做：照 0602832 做 amoclock 首页卡片、采购（成品板 + 支架）、台面（ws-amoled216，3D 板在 web/src/bench3d/scene.ts amoledBoard；点屏 = 触摸，与 s3-ai-dash 示例同）、产品页（点屏滑动、电源键、「手机对时」按钮走 BLE 虚拟手机动作进输入日志；手机产品键 左 / 右 / 电源 / 对时）。
验收：levels.mjs 加 amoclock 检查点网页 / CLI 指纹一致；mobile.mjs 加用例；agent-browser 桌面 + 390，记录 Reviews/ab/G-17b.md。i18n 四语。
完成后：PLAN G-17b ☑，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```

### G-17c · AMOLED 时钟装法 / 成品（默认模型；G-17b 合并后）

```
你在 TryBoard 仓库（<repo-root>）工作。先建 worktree：git worktree add ../tb-G-17c -b G-17c main，之后只在 ../tb-G-17c 里改。先读 AGENTS.md、docs/internal/AGENT_BRIEF.md（验收、worktree 软链、省 token、汇报要求照做；不得派子代理）。任务是 docs/PLAN.md 的 G-17c 行。

要做：照 1e2de60 给 amoclock 做支架 / 外壳装法，至少一处影响反映到仿真（如板背贴金属底座 → 天线损耗（已有 `--antenna-loss`）→ BLE 对时失败，amoclock-4 复测失败）；3D 成品：桌面支架上的方形 AMOLED，表盘随仿真走、可点可滑。
验收：asm3d.mjs 加 amoclock 用例；check.py --ref --all；agent-browser 桌面 + 390，记录 Reviews/ab/G-17c.md。
完成后：PLAN G-17c ☑，提交（英文信息 + Co-Authored-By 行），汇报 ≤ 300 字。
```
