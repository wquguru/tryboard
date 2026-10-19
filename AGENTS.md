# AGENTS.md — TryBoard 试板

给在这个仓库里工作的 AI 代理（Claude Code、Codex 等）和人看的总说明。`CLAUDE.md` 只是引用本文件。

## 1. 项目是什么
一个在浏览器里运行的 ESP32 系列模拟器，教育产品。目标：**硬件玩家在买板子之前，先在网页里把想做的项目跑一遍**，从而知道该买哪颗芯片、哪块板、哪些外设，以及哪些风险只能上真机才能排除。

三层：
1. **内核**：自研指令级模拟器（Rust → wasm），跑用户真实编译出来的固件（ESP-IDF / Arduino 产物）。
2. **世界**：浏览器 3D 场景（three.js，WebGPU 优先、WebGL2 兜底），开发板 / 面包板 / 外设 / 房间，传感器读数来自场景（摄像头看渲染画面，超声波是射线，IMU 来自物理）。
3. **决策**：选型 / BOM / 引脚 / 功耗估算，每个结论标可信度（仿真验证 / 行为模拟 / 估算 / 必须上真机）。

## 2. 硬性规则
- **授权**：见 `docs/LICENSING.md`（依据见 `LICENSING_REVIEW.md`）。没写进去的外部代码 / 二进制 / 素材不得进仓库或进网站。GPL / AGPL 代码（espressif/qemu、CircuitJS、SimulIDE 等）可以读来理解行为，但不复制、不逐行翻译、不照搬结构；参考了什么写进 DECISIONS，并用固件差分验证。
- **验收优先**：每个外设模型都必须有验收（见 §6）。没有验收的功能不算完成。
- **不要公开仓库、不要部署公网、不要发帖、不要对外发邮件、不要花钱**：要人点头（自主边界见 §10）。
- 不要为了让测试通过而削弱测试；不要删 `docs/` 内容来"简化"，过时就改。

## 3. 目录
```
AGENTS.md              本文件（规则、命令、路线图）
docs/PRODUCT.md        产品定位、用户、场景语料库
docs/PLAN.md           P0–P2 实现清单（ID、验收、状态）——自主推进的依据
docs/DESIGN.md         视觉与交互规范（设计画布的落盘版，代理以它为准）
docs/DESIGN_V2.md      设计 v2：logo、选型助手、实验台 v2、全站手机布局（与 DESIGN.md 冲突时以它为准）
docs/design-v2/        设计 v2 稿的源文件（内联样式静态 HTML，读源码取尺寸 / 颜色 / 文案）
docs/ARCH.md           架构、内存映射、启动方式、外设模型约定
docs/LICENSING.md      授权结论与规则（LICENSING_REVIEW.md 是逐条依据）
docs/DECISIONS.md      代理自主决定，等人复核
docs/STATUS.md         外设 × 芯片覆盖矩阵（由测试结果更新）
core/                  Rust workspace
  crates/rv32          RISC-V RV32IMC 核
  crates/soc           SoC 公共件（总线、MMIO 框架、外设模型）
  crates/esp32c3       ESP32-C3 SoC
  crates/cli           原生命令行运行器（跑固件、出 trace、跑测试）
  crates/wasm          浏览器绑定（裸 extern "C"，不用 wasm-bindgen）
firmware/              验收固件（ESP-IDF 工程）+ 构建产物（git 忽略）
web/                   前端（Vite + TS + three.js）
tools/                 构建、验收、对照（QEMU oracle）脚本
Reviews/               截图、trace、报告（git 忽略，每次重生成）
```

## 4. 环境
- Rust（rustup，含 `wasm32-unknown-unknown`）：`. ~/.cargo/env`
- ESP-IDF v5.5.1：`~/esp/esp-idf-v5.5`，用前 `. tools/idf_env.sh`（只装了 esp32c3、esp32s3 两套工具链 + qemu-riscv32 / qemu-xtensa）
- Python 3.12（brew）给 IDF 用；系统 python3 是 3.9
- Node 24（nvm）
- 磁盘只剩约 60GB：不要随手装大工具链，不要提交构建产物

## 5. 常用命令
| 做什么 | 命令 |
|---|---|
| 内核单元测试 | `cd core && cargo test` |
| 构建验收固件 | `tools/build_fw.sh [名字]` |
| 原生跑固件 | `cd core && cargo run -p tryboard-cli --release -- run ../firmware/build/<名字>/flash.bin` |
| 带外接器件跑 | `tryboard run <flash.bin> --i2c ssd1306@0x3c,bme280@0x76 --env 23.5,45,101325 --oled`（`--oled` 打印屏幕字符画）；S3 圆屏：`--spi gc9a01 --lcd-ppm Reviews/x.ppm`，再 `tools/ppm2png.py Reviews/x.ppm Reviews/x.png` 看图 |
| 线束估算（P2-11） | `tryboard run <flash.bin> --i2c ssd1306@0x3c,bme280@0x76 --i2c-wire 60`（I2C 排线 cm）；`--antenna-loss 30`（天线遮挡 dB）；结论打在 stderr 末尾 |
| 跑全部验收 | `tools/accept.sh [--no-web] [--no-qemu]`（输出 `Reviews/accept.md`；验收用例在 `firmware/accept.json`） |
| 定位卡死 / 崩溃 | `tryboard run <flash.bin> --trace 40`（打印最近跳转目标，自动加载同目录 app.elf 符号） |
| 逻辑分析仪事件 | `tryboard run <flash.bin> --trace-io Reviews/io.txt [--trace-pins 4,8]`（GPIO / PWM / WS2812 / I2C 事务，按周期盖戳；与网页逐条对拍：`node tools/webtest/traceio.mjs`） |
| FreeRTOS 任务时间线（C-04） | `tryboard run <flash.bin> --trace-tasks Reviews/tasks.json`（Perfetto 打开；stderr 末尾每任务 CPU 占用）；网页对拍 `node tools/webtest/tasks.mjs` |
| 下载第三方输入（ROM、riscv-tests） | `tools/fetch_third_party.sh` |
| QEMU 对照 | `tools/oracle_qemu.sh <名字>` |
| 外部 3D 模型（STEP → glb，只用 LICENSING ✅ 来源） | `(cd tools/models && npm ci)` 一次；`node tools/models/fetch.mjs && node tools/models/convert.mjs`（清单 `tools/models/models.json`，产物 + SOURCES.md 在 `assets/models/<名字>/`） |
| 构建 wasm + 网页 | `tools/build_web.sh` |
| 本地试网页 | `cd web && npm run dev` |
| 网页冒烟测试 | `node tools/webtest/webtest.mjs <示例> <期望文本>`（截图到 `Reviews/web/`） |
| 关卡验收 | `tools/check.py <flash.bin> --level 04`；`tools/check.py --ref --all` 跑全部参考固件（关卡定义在 `firmware/levels.json`） |
| 关卡 / 装配 / 首页网页测试 | `node tools/webtest/levels.mjs`（含拖拽装配、网页与命令行指纹对拍）；拍照录像 `media.mjs`、线束与 USB 小键盘 `harness.mjs` |
| 实验台交互 / 手机布局回归 | `node tools/webtest/wiremode.mjs`（连线模式、改接、撤销重做）；`node tools/webtest/mobile.mjs`（390×844 各页无横向滚动、抽屉开合、主按钮可点） |
| BLE 虚拟手机（C-01） | `tryboard run <flash.bin> --ble-phone`（手机自动扫描→连接→读全部→订阅，空中日志 `[ble]` 打在 stderr）；手动：输入日志行 `秒:ble=scan` / `ble=connect` / `ble=read 2A19` / `ble=sub 2A37` / `ble=write 0x0019 01`（`0x` 开头是句柄，否则是 UUID），`--inputs <文件>` 重放 |
| 输入日志重放对拍 | `node tools/webtest/replay.mjs`（网页按 BOOT、调温度 → 导出输入 → `tryboard run --inputs` 重放，串口逐字节、指纹相同） |
| 浏览器验收（新功能必做） | `agent-browser skills get core` 先读用法；`cd web && npx vite preview --port 5180` 起服务后 `agent-browser open <url>` → `snapshot` / `click` / `screenshot Reviews/ab/<项>.png` → `console` / `errors`；用 Read 看截图。并行子代理各用自己的端口和 `--session <名字>`，不要抢同一个浏览器 |

## 6. 工作方式
1. **改需求先改文档**，再写代码。自主决定写进 `docs/DECISIONS.md`（日期、决定、理由、替代）。
2. **四层验收**（缺一层就在 STATUS 里标出来）：
   - CPU：riscv-tests（rv32ui / um / uc）全过；与 QEMU 做指令级差分
   - 驱动：ESP-IDF 示例 / test_apps 在模拟器里跑出与 QEMU（或真机日志）一致的串口输出
   - 场景：语料库项目（见 `docs/PRODUCT.md`）能启动并出现预期行为
   - 硅片：真机 HIL（暂缺硬件，结论标"未经真机标定"）
3. **看过结果才能说完成**：网页改动必须用 `agent-browser` 走一遍该功能的主流程（打开 → 操作 → 截图并用 Read 看图 → 控制台无 error），记录写进 `Reviews/ab/<PLAN ID>.md`；涉及模拟结果的要和命令行指纹对拍。puppeteer 脚本（tools/webtest）保留做回归，不能代替 agent-browser 的人眼检查。测试失败、跳过都写进汇报和 `docs/STATUS.md`。声音类功能读 Web Audio 分析数据判断；headless 帧率不作数，只查无报错。
4. 未实现的寄存器访问不准静默：记录到 trace（`unimpl` 计数），验收报告里列出 Top N。
5. 代码风格：Rust 2021，`cargo fmt`、`cargo clippy` 无警告；注释中文、只写"为什么"；不引第三方 crate 除非写进 DECISIONS（当前允许：无）。网页侧 npm 依赖同样要先写进 DECISIONS（名字、版本、许可证、体积、理由），只用 LICENSING.md 里 ✅ 的；按需懒加载，wasm 首包仍 ≤ 2MB。
6. 页面按 `docs/DESIGN.md` + `docs/DESIGN_V2.md` 做；断点 `md`（< 768px 为手机，不再用 max-[760px]），手机触控目标 ≥ 44px、390×844 下无横向滚动；logo 用 `web/src/ui/logo.tsx`，不要另画；3D 器件优先按真实尺寸程序生成，外部模型来源和署名写进素材目录 `SOURCES.md`（授权页从它生成）。

## 7. Git
- 本地仓库，默认分支 `main`，**暂无远端**（要建远端先问人）
- 一个里程碑或独立功能一次提交，提交前 `cargo test` + `tools/accept.sh` 通过；提交信息中文
- 构建产物、固件 bin、IDF 生成物不提交

## 8. 路线图
细项、验收和状态在 `docs/PLAN.md`（P0 / P1 / P2 / P3）；下表是里程碑总览，两者对应：P0 ≈ M3 + M9 + M10 主线，P1 ≈ 电气 / 测量 / 3D 装配，P2 ≈ M2 余项 + M6 S3 Wi-Fi + M8 音频 + 新作品。

状态：☐ 未开始 / ◐ 进行中 / ☑ 完成

| # | 里程碑 | 完成标准 |
|---|---|---|
| M0 | ☑ 内核起步（ESP32-C3） | RV32IMC 核过 riscv-tests；直接启动 IDF `hello_world` 打印与 QEMU 一致；FreeRTOS 调度、`vTaskDelay` 正常 |
| M1 | ☑ GPIO 与网页 | `blink` 在浏览器里驱动 3D 板载 LED；wasm 首包 ≤ 2MB（不含 3D 素材）；串口面板 |
| M2 | ◐ 常用外设 | LEDC、RMT（WS2812）、I2C（SSD1306、BME280）、SPI、ADC、定时器；各有验收固件 |
| M3 | ◐ 面包板与 3D 世界 | 拖放元件、连线、舵机 / 灯带 / 屏幕在 3D 里有反馈；拖拽装配成成品（SVG，已有） |
| M4 | ◐ ESP32-S3（Xtensa LX7） | 同 M0–M2 验收在 S3 上通过 |
| M5 | ◐ USB OTG | S3 冒充键盘 / 网卡，浏览器里的虚拟电脑 / 手机能枚举并响应（键盘 HID、CDC 串口已通：s3-usb-keyboard / s3-usb-cdc、作品 usbkey；网卡未做） |
| M6 | ◐ Wi-Fi | 在 netif 层替换，HTTP / MQTT 示例可达浏览器侧虚拟网络（C3：开放网络与 WPA2-PSK 已通） |
| M7 | ◐ BLE | VHCI 层虚拟控制器 + 虚拟手机（C3 NimBLE 外设已通：c3-ble-hr，见 PLAN C-01；S3、上传 ELF 路线未做） |
| M8 | ☐ 音频 / 摄像头 | I2S 麦克风 / 喇叭接 Web Audio；摄像头读 3D 渲染画面；小智类项目可跑 |
| M9 | ◐ 选型决策层 | 项目模板 → 芯片 / 板 / BOM / 引脚 / 功耗，带可信度标注 |
| M10 | ◐ 发布准备 | 落地页（首页 `/`）、7 关路线（并入实验台检查点）、示例库、授权清单（`/licenses` + NOTICES）；UI v2（PLAN U-01–U-06：logo、选型助手、实验台 v2、全站手机）已完成。**上线前必须问人** |

## 9. 子代理与上下文预算
2026-10-15 会话复盘：缓存读取共 4.95 亿 token，其中 3.74 亿来自 10 个 fork 子代理。每个 fork 启动时都继承了主会话 33–66 万的上下文，而且每次工具调用都要重读一遍。主会话本身也一路涨到 68 万才压缩。规则：
1. **并行开发不用 fork**，用全新的 `general-purpose` 子代理（`isolation: "worktree"`）。任务说明要能独立成立，按 `docs/AGENT_BRIEF.md` 的模板写：目标、要读的文件、验收命令、提交方式。不要指望它"记得"主会话。
2. **fork 只在确实需要主会话里尚未落盘的推理时用**，而且要在主会话上下文还小（< 15 万）的时候用。
3. **结论先落盘再派工**：子代理要知道的东西写进 `docs/`（ARCH、DECISIONS、STATUS），它自己去读，比继承整段对话便宜两个数量级。
4. **自动压缩线 20 万**：`.claude/settings.json` 里设了 `autoCompactWindow: 200000`（默认要到约 96.7 万才压缩）。每个里程碑提交、汇报完，也可以由人手动执行 `/compact`（模型自己触发不了）。
5. **长输出不进上下文**：构建 / 验收日志重定向到 `Reviews/` 再 `tail` 或 `grep`；截图先裁到要看的区域再 Read。

## 10. 自主推进边界
人已同意（2026-10-16）：按 `docs/PLAN.md` 从 P0 推进到 P2，每批结束汇报一次，不等确认继续。
- **可以直接做**：写代码、改文档、在本地 main 提交、开 worktree 子代理、引入 DECISIONS 里登记过且 LICENSING ✅ 的依赖、替换旧页面（旧链接要重定向）、下载 LICENSING ✅ 的素材到构建流程。
- **必须问人**：建远端 / 推送、部署公网、对外发邮件或发帖、花钱（买零件、付费服务）、注册账号、删除用户数据、收费 / 广告 / 联盟、改授权结论里 ❌ 的项。
- **卡住时**：某项做不成（技术或授权），标 ✗ 写原因进 PLAN 和 STATUS，继续做下一项，不硬凑、不削弱测试。
- **每批结束**：accept.sh 全过、PLAN 状态更新、提交、写 `Reviews/batch-P<n>.md`（做了什么、截图、未完成项），再向人汇报。
