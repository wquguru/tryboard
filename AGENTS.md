# AGENTS.md — TryBoard 试板

给在这个仓库里工作的 AI 代理（Claude Code、Codex 等）和人看的总说明。`CLAUDE.md` 只是引用本文件。

## 1. 项目是什么
一个在浏览器里运行的 ESP32 系列模拟器，教育产品。目标：**硬件玩家在买板子之前，先在网页里把想做的项目跑一遍**，从而知道该买哪颗芯片、哪块板、哪些外设，以及哪些风险只能上真机才能排除。

三层：
1. **内核**：自研指令级模拟器（Rust → wasm），跑用户真实编译出来的固件（ESP-IDF / Arduino 产物）。
2. **世界**：浏览器 3D 场景（three.js，WebGPU 优先、WebGL2 兜底），开发板 / 面包板 / 外设 / 房间，传感器读数来自场景（摄像头看渲染画面，超声波是射线，IMU 来自物理）。
3. **决策**：选型 / BOM / 引脚 / 功耗估算，每个结论标可信度（仿真验证 / 行为模拟 / 估算 / 必须上真机）。

## 2. 硬性规则
- **授权**：见 `docs/LICENSING.md`。没写进去的外部代码 / 二进制 / 素材不得进仓库或进网站。参考 GPL 代码（如 espressif/qemu）只能"读规格、写自己的实现"，不得复制粘贴。
- **验收优先**：每个外设模型都必须有验收（见 §6）。没有验收的功能不算完成。
- **不要公开仓库、不要部署公网、不要发帖**：要人点头。
- 不要为了让测试通过而削弱测试；不要删 `docs/` 内容来"简化"，过时就改。

## 3. 目录
```
AGENTS.md              本文件（规则、命令、路线图）
docs/PRODUCT.md        产品定位、用户、场景语料库
docs/ARCH.md           架构、内存映射、启动方式、外设模型约定
docs/LICENSING.md      授权结论与规则
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
| 跑全部验收 | `tools/accept.sh [--no-web] [--no-qemu]`（输出 `Reviews/accept.md`；验收用例在 `firmware/accept.json`） |
| 定位卡死 / 崩溃 | `tryboard run <flash.bin> --trace 40`（打印最近跳转目标，自动加载同目录 app.elf 符号） |
| 下载第三方输入（ROM、riscv-tests） | `tools/fetch_third_party.sh` |
| QEMU 对照 | `tools/oracle_qemu.sh <名字>` |
| 构建 wasm + 网页 | `tools/build_web.sh` |
| 本地试网页 | `cd web && npm run dev` |
| 网页冒烟测试 | `node tools/webtest/webtest.mjs <示例> <期望文本>`（截图到 `Reviews/web/`） |

## 6. 工作方式
1. **改需求先改文档**，再写代码。自主决定写进 `docs/DECISIONS.md`（日期、决定、理由、替代）。
2. **四层验收**（缺一层就在 STATUS 里标出来）：
   - CPU：riscv-tests（rv32ui / um / uc）全过；与 QEMU 做指令级差分
   - 驱动：ESP-IDF 示例 / test_apps 在模拟器里跑出与 QEMU（或真机日志）一致的串口输出
   - 场景：语料库项目（见 `docs/PRODUCT.md`）能启动并出现预期行为
   - 硅片：真机 HIL（暂缺硬件，结论标"未经真机标定"）
3. **看过结果才能说完成**：网页改动要用浏览器自动化截图并用 Read 看图；测试失败、跳过都写进汇报和 `docs/STATUS.md`。
4. 未实现的寄存器访问不准静默：记录到 trace（`unimpl` 计数），验收报告里列出 Top N。
5. 代码风格：Rust 2021，`cargo fmt`、`cargo clippy` 无警告；注释中文、只写"为什么"；不引第三方 crate 除非写进 DECISIONS（当前允许：无）。

## 7. Git
- 本地仓库，默认分支 `main`，**暂无远端**（要建远端先问人）
- 一个里程碑或独立功能一次提交，提交前 `cargo test` + `tools/accept.sh` 通过；提交信息中文
- 构建产物、固件 bin、IDF 生成物不提交

## 8. 路线图
状态：☐ 未开始 / ◐ 进行中 / ☑ 完成

| # | 里程碑 | 完成标准 |
|---|---|---|
| M0 | ☑ 内核起步（ESP32-C3） | RV32IMC 核过 riscv-tests；直接启动 IDF `hello_world` 打印与 QEMU 一致；FreeRTOS 调度、`vTaskDelay` 正常 |
| M1 | ☑ GPIO 与网页 | `blink` 在浏览器里驱动 3D 板载 LED；wasm 首包 ≤ 2MB（不含 3D 素材）；串口面板 |
| M2 | ☐ 常用外设 | LEDC、RMT（WS2812）、I2C（SSD1306、BME280）、SPI、ADC、定时器；各有验收固件 |
| M3 | ☐ 面包板与 3D 世界 | 拖放元件、连线、舵机 / 灯带 / 屏幕在 3D 里有反馈 |
| M4 | ☐ ESP32-S3（Xtensa LX7） | 同 M0–M2 验收在 S3 上通过 |
| M5 | ☐ USB OTG | S3 冒充键盘 / 网卡，浏览器里的虚拟电脑 / 手机能枚举并响应 |
| M6 | ☐ Wi-Fi | 在 netif 层替换，HTTP / MQTT 示例可达浏览器侧虚拟网络 |
| M7 | ☐ BLE | VHCI 层虚拟控制器 + 虚拟手机 |
| M8 | ☐ 音频 / 摄像头 | I2S 麦克风 / 喇叭接 Web Audio；摄像头读 3D 渲染画面；小智类项目可跑 |
| M9 | ☐ 选型决策层 | 项目模板 → 芯片 / 板 / BOM / 引脚 / 功耗，带可信度标注 |
| M10 | ☐ 发布准备 | 落地页、示例库、授权清单。**上线前必须问人** |
