# 竞品源码调研：mikroverk/esp32sim

- 查证日期：2026-10-19
- 对象：网站 https://mikroverk.github.io/esp32sim/ ；仓库 https://github.com/mikroverk/esp32sim（MIT）
- 调研提交：`f535f3b42293a76ab64c231a0425f35857ab6cf1`（2026-10-19 07:27 +0200；2588 个文件，约 62 MB）
- 方法：只读。没有运行对方仓库里的任何构建、脚本或程序，只用 grep 和读文件；网站用 WebFetch 看。下文"路径:行"都指对方仓库这个提交；我们自己的文件写成"我方 docs/…"。
- 写"未见"表示在源码和文档里都没找到，不代表一定没有。

## 一句话结论

esp32sim 是一个 Rust 写的"内核优先"模拟器：S3 成熟，C3/C6 是草稿，经典 ESP32 刚起步。它最强的是**真机标定方法学**：用 CCOUNT 微基准出"收据"JSON 定价，S3 用 JTAG 逐步对拍，C3/C6 用控制台差分。外设大多是事务级的，没有故障注入、功耗模型和传感器噪声，也没有 3D、装配或选型。

另外要修正我方 docs/RESEARCH_ESP_EMULATOR.md:54 的印象：**"真实外网 + NTP"只在原生 CLI 里成立，浏览器里没有 NAT**。

## 1. CPU 时序

- **默认模型**：1 条指令 = 1 周期。S3 跑 240 MHz，C3/C6 跑 160 MHz（docs/architecture.md:95）。缓存时序默认不建模（docs/architecture.md:123）。
- **执行引擎**：
  - 块解释器，每块最多 32 条。
  - 原生有 AArch64 JIT；浏览器另有 LX7 → WebAssembly JIT（docs/architecture.md:96-113）。
  - 解释器是 oracle：`--no-jit` 的输出必须完全相同。wasm-jit 的差分用例有 35,545 条（tests/README.md）。
- **可选代价模型**：`CostModel` trait，按事件计价，与设备共享同一条时间线（docs/architecture.md:162-164、202-210）。CLI 开关只对 S3 有效，在 cli/src/lib.rs:26-33、94-97、366-398：
  - `--approximate-timing`：默认 `issue:1, taken_branch:3, trap:3`；QUOS/QUOU 4、REMS/REMU 5、LOOP* 5、JX 6（esp32s3/src/approximate_timing.rs:84-87）。
  - `--approximate-memory N`、`--approximate-cache`：64 B 行、8 路，fill 120、writeback 96，自己标"provisional"（esp32s3/src/approximate_cache.rs）。缓存行填充和脏写回通过 rough_memory 服务按共享时间（`cycles_at`）计价（esp32s3/src/memory_cost_model.rs）。
  - `--memory-contention`。`--approximate-memory` 要求 `--boot rom`。
- **精确模型**：`Esp32S3SramCostModel`，带收据（esp32s3/src/timing.rs，423 行）。
  - 每个价格挂一个 `ReceiptId`，指向 esp32s3/tests/fixtures/{sram-cost,mmio-read,opcode-cost}-receipt.json。
  - MMIO 读分三档：fast 9 / APB 15 / NRX 18（timing.rs:210-213）。
  - 非 SRAM 取指、控制流、陷入这些没定价的事件，一律按名字拒绝（"unexplained tier"），不会默默给一个数。
- **浏览器**：主线已有 `?timing=hw`，只支持 S3（web/wasm/experiments.mjs:72；web/wasm/worker.js:145）。它的 `HW` 预设（experiments.mjs:24-34）就是实测价格：`jit_cache 96,160`、`cache_fill_service 160`、`icache_fill 404`、`control_prices`、`spi2_timing`、`measured_te`。
- **还没合并的部分**：精确拟合，以及 TinyDraw 跑出真机时长 0.96–1.0 的验证，都在 night/timed-0919 分支和 draft PR #91 上（docs/experiments.md:17，EX054 等）。统一 CPI2 拟合失败（EX130）。pocket-tank 模拟 7.4–8.0 tok/s，真机 12 tok/s（EX148，docs/experiments.md:161-181）。
- **速度**：
  - README.md:30："runs hello_world about 30 times faster than real time"。
  - 网站："block interpreter + AArch64 JIT, ~150–240 Minsn/s"。
  - Pocket Tank 在浏览器里 "Slower than real time"。

## 2. 真机对照方法（重点）

| 层 | 方法 | 证据 |
|---|---|---|
| 解码 | 与 objdump 对比 97.7 万 / 16.1 万 / 12.6 万条指令，0 不一致 | tests/README.md |
| 架构状态（S3） | JTAG lock-step：openocd + gdb `stepi`，走片上 USB-Serial/JTAG；每步对比 pc、a0–a15、ps、windowbase | docs/hardware-testing.md:1-65；hw/difftest.sh、hw/steptrace.py、hw/compare.py |
| 控制台（C3/C6） | 真机输出抓下来存档，与模拟输出逐行 diff：205/208、203/204 行一致，各找出 5 个 bug | hw/c3-hello-world-real.txt、hw/c6-hello-world-real.txt；网站 "console diff, 205/208 lines identical" |
| 时序（S3） | CCOUNT 微基准 → 收据 JSON → 价格表 | tools/fast-hardware/*、esp32s3/tests/fixtures/*-receipt.json |

**JTAG lock-step 细节**（hw/difftest.sh，26 行）：
- openocd 读真机 eFuse（`mdw 0x60007000 128`）和 strap（`0x60004038`）。
- gdb 用 steptrace.py 逐步记录真机状态。
- 模拟器用 `--efuse-regs --regs-init --strap --regtrace` 复刻同一初态。初态寄存器在 hw/reset-regs.txt（215 行）。
- compare.py（56 行）做三种归一化（docs/hardware-testing.md:56-61）：
  - 屏蔽 PS.INTLEVEL；
  - 隐藏窗口异常向量（0x40000000+0x180）；
  - 遇到 CCOUNT 延时循环重新对齐。
- 每步约 4 ms。
- 成绩：网站写 "JTAG lock-step, 8000 steps, 0 PC divergences"。docs/experiments.md:118（EX086）自认是部分对齐：第 15 步 a2 不一致，而且**不比周期**。

**CCOUNT 收据标定**：
- 探针（tools/fast-hardware/fp-probe/main/fp_timing.c、fp_blocks.S）先 `rsil 15` 关中断，再调 1024 次、每次 256 条指令；把相关与无关两种 cell 分开测，每格 9 个样本。
- 主价格表在 S3 v0.2 + IDF 6.1 上测，每格 100 个样本，复位 2–4 次。
- capture.py 用 pyserial + esptool 复位并收数。compare-gate.py 比较固件自己打印的计数器，真机一份、模拟一份。

**收据 JSON 结构**：
- `claim`；
- `scope`：芯片 QFN56 rev v0.2、IDF v6.1、xtensa-esp-elf 15.2.0、240 MHz、flash QIO 80 MHz、PSRAM octal DTR 80 MHz；
- `sources`（带 sha256）、`derivation`、`adopted`、`refused`。

推导示例：issue 9234 周期 = 18 开销 + 9216 条指令。

**已标定参数**（docs/experiments.md:80-108、161-181；esp32s3/src/timing.rs）：

| 项目 | 价格（周期） |
|---|---|
| 顺序发射 | 1 |
| 独立 SRAM load | +0 |
| load-use | +1 |
| 分支 跳 / 不跳 | 3 / 1 |
| J / JX | 3 / 6 |
| LOOP 建立 | 5 |
| QUO / REM | 4 / 5 |
| MMIO 读 fast / APB / NRX | 9 / 15 / 18 |
| call / return / ENTRY | 3 / 3 / 1 |
| 取指跨界 | +1 |
| FP add/mul/madd 结果延迟 | 4 |
| PIE load 结果就绪 | issue + 2 |
| 窗口异常进入 / 返回 | +6 / +2 |
| PSRAM 首行就绪 / 服务 / 写回 | 96 / 160 / 160 |
| flash icache 行（Tier-B） | 404（EX147） |
| SPI 20 / 40 MHz 大块传输 | 每字节 96 / 48 |
| 启动时长 | 30 次复位中位数 2.796813 s |

**范围限定**：
- 探针源码在 aliceisjustplaying/tinydraw，证据在 aliceisjustplaying/esp32sim 的清理分支。两处都**没有读**。
- C3/C6 没有时序标定，只做了控制台差分。

## 3. 外设时序与精度

- **粒度**：寄存器级，多数是事件 / 事务级（docs/peripherals.md:9-39）。
  - I2C 按编程的总线时钟给出字节 / ACK 截止时刻（EX216，docs/evidence/i2c-addressing-timing/README.md）。
  - **逐位**：有一个可选的 GPIO 波形模式，quantum = 1，按精确周期解码 bit-bang WS2812。S3 脉宽 96/192 周期，C3/C6 64/128（EX218，docs/evidence/gpio-bitbang-waveform/README.md）。内置板子默认都不开。浏览器的 `quantum` 设置要求 ≥ 64 且是 64 的倍数（web/wasm/experiments.mjs:6），所以**逐位模式只有原生 CLI 能用**。
  - `--vcd`：GPIO 边沿和中断线导出为 VCD（docs/architecture.md:155-156）。
  - `--irq-latency`：每条中断线从拉起到被响应的周期数（同上）。
- **缺口**（docs/peripherals.md:9-39）：LEDC 硬件渐变、S3 RMT RX 没有（I2S RX 在 peripherals.md:25 标 —，但 docs/cli.md:253-260 与 EX214 已有 I2S RX 麦克风输入，表格过时）；MCPWM 只做了一部分；SPI3、TWAI、SDMMC、USB-OTG 没有。
- **ADC**：
  - 做法是反解 ESP-IDF curve-fitting 校准：系数取自 IDF v5.5 `curve_fitting_coefficients`，Apache-2.0，见 esp-periph/src/sar_adc.rs（185 行）和 esp-periph/LICENSE-ADC。eFuse 用合成的默认值。
  - 实测表在 docs/evidence/adc-host-2026-10-02/README.md（EX207），例如 C3 0.5 V → raw 722 / 500 mV。
  - 明确不建模的（docs/peripherals.md:82-83）："Conversion timing, noise, continuous ADC/DMA, interrupt delivery, and data inversion are not modeled"。esp-periph/src/rtc_cntl.rs:83 又写了："Noise, INL beyond Espressif's fitted curve and chip-to-chip spread are not modelled"。
  - 有 `adcwave` 脚本输入。
  - ADC2 与 Wi-Fi 的仲裁：未见。
- **传感器噪声**：未见。RNG 是 xorshift。
- **功耗模型**：未见。

## 4. 网络

- **替换层**：Wi-Fi MAC 寄存器层，Espressif 闭源 blob 原样运行（docs/architecture.md:212-246）。链路如下：
  - WifiMac：TX 队列、RX 描述符环、中断、TSF（architecture.md:220）。
  - VirtualAp：真的 WPA2 四次握手，数据帧按 CCMP 格式封装、内容是明文（esp-soc/src/wifi.rs:119-351）。
  - VirtualNet 10.0.2.0/24：ARP / DHCP / ICMP echo / DNS / SNTP。SNTP 时间取宿主时钟（esp-soc/src/net.rs:1-128，`ntp_fraction` 在 :34）。
  - 用户态 NAT 转宿主 socket，**只有原生**。
- **浏览器**：docs/wasm.md:183-187 写的是 "No NAT. The browser has no sockets"，网关以外的连接会被拒绝。
  - 可选的以太网中继 ABI `esp32sim_ethernet_relay` / take / receive（docs/wasm.md:231-262），让页面把帧转给宿主上的助手程序。
  - 网站写 "NAT to the real network, HTTPS"，**但没说明这只在原生下成立**。
- **空口节奏**：帧间隔约 400 µs；要等驱动回收上一个描述符，或者等过 50 ms；到时仍没有可用描述符就丢帧并计数（docs/architecture.md:230-231；这个数字出自文档，源码 wifi.rs 里没 grep 到）。
- **故障注入**：未见，没有丢包、延迟、断线的旋钮。唯一的丢帧来源是缺描述符。
- **其它限制**（docs/networking-howto.md:76-91）：
  - 只支持一个 STA；SoftAP、ESP-NOW、漫游、省电、802.11n、WPA3、PMF 都没有。
  - 不能接入入站连接；mDNS 过不了 NAT。
  - RSSI 固定 -40 dBm（esp32c3/src/bus.rs:316），噪声底 -90（esp32s3/src/bus.rs:581）。
- **BLE**：
  - `--ble` 是 VHCI 层的虚拟控制器，S3/C3/C6 都有，需要 ELF 文件（docs/cli.md:35；docs/decisions.md:362）。
  - `--ble full` 是 C3 实验性的寄存器级链路控制器（esp32c3/src/ble_lc.rs；docs/cli.md:32-34），由 rev3 ROM 和 IDF v5.5.5 控制器推导而来。支持广播、扫描、一个虚拟 central（间隔 30 ms、MTU 23），输出 PDU 日志，时间戳精度半微秒。
- **802.15.4**：C6 有 MAC，还有 Contiki-NG 多节点共享介质、Cooja lock-step 对端。

## 5. 摄像头 / 音频 / 屏幕 / 触摸

- **摄像头**：OV5640 接在 LCD_CAM DVP 上（docs/boards.md:68-75）。图像来源：`--cam-image` 图片文件、`--cam-stream` RGB24 流（docs/cli.md:23、51、215-240）、浏览器上传图片或摄像头（getUserMedia，网页里 4 fps，docs/web-ui.md:71、84）。CLI 默认 `--cam-fps` 10（docs/boards.md:75）。**不是渲染画面**。
- **音频**：I2S TX 输出成 WAV 或 WebAudio（docs/peripherals.md:25）。麦克风从 I2S RX 的 `PcmInput` 注入，位置在 PCM/DMA 边界（docs/cli.md:253-260，EX214）。
- **屏幕**：ST7701S 480×480 RGB（docs/boards.md:84）、CO5300 368×448 QSPI（docs/boards.md:95）、ST7735、ST7789（docs/boards.md 各板器件表）。
- **触摸**：GT911（docs/boards.md:85）、CST820（docs/boards.md:97）。浏览器指针事件转成触摸点。

## 6. 测试与验收

tests/README.md 把测试分成几层：
- 解码语料与 objdump 对比。
- 语义测试，含三条执行路径的等价性：解释器、原生 JIT、wasm JIT。
- 外设单测和整机测试。
- 整机 golden（cli/tests/goldens.rs）：atech-script1、atech-sid、panel-sid、hello-s3/c3/c6/classic、ble-*、wifi-station-{s3,c3,c6}、crypto-tls-{c3,c6}、cooja-*。要求逐位一致，比较项是控制台、音频 SHA-256 和指令数。
- wasm-test.mjs。

确定性来自虚拟 quantum：wasm 256、原生 64，结果逐位可复现。设备时间是懒推进的，在寄存器访问时、定时器截止时，或最多 256 周期后才交付（docs/architecture.md:166-200）。

CI 不跑 `external_*` 测试，也不跑真机测试。每个实验有 EX 编号目录（docs/experiments.md），证据放在 docs/evidence/*/README.md。

## 7. 开发板建模格式

- 每块板是手写的 Rust，实现 `BoardModel` trait（docs/boards.md:7-36）。
- **没有数据文件或 BOM 格式**，也没有尺寸或 3D 信息（未见）。
- 已有的板：atech14、waveshare-cam、waveshare-lcd4b、waveshare-amoled18-v2、waveshare-c6-lcd147、ttgo-tdisplay、none（docs/boards.md）。
- 来源说明在 docs/architecture.md:248-269。

## 8. 对比表

### 8.1 它有、我们没有

| 能力 | 对方证据 | 我方现状 |
|---|---|---|
| CPU 时序模型 + 真机实测价格（S3） | esp32s3/src/timing.rs；approximate_timing.rs；web/wasm/experiments.mjs:24-34 | 1 指令 ≈ 固定周期，未标定（我方 docs/STATUS.md:100 只讲速度） |
| 真机 JTAG lock-step / 控制台差分 | hw/difftest.sh、hw/compare.py；hw/c3-hello-world-real.txt | 只与 QEMU 差分（docs/STATUS.md:8、38），真机 HIL 缺 |
| JIT（原生 AArch64 + wasm） | docs/architecture.md:96-113 | 解释器 + 批量执行（docs/STATUS.md:100） |
| C6、经典 ESP32 | README.md 芯片表 | 只有 C3、S3 |
| 真实外网 NAT（仅原生） | docs/architecture.md:212-246 | 虚拟互联网 4 AP（docs/STATUS.md:30、76） |
| BLE 寄存器级链路层（C3 实验） | esp32c3/src/ble_lc.rs | VHCI 签名路线（docs/STATUS.md:33），S3 未做（:79） |
| 802.15.4 / Thread（C6） | README.md、goldens cooja-* | 无 |
| 摄像头（OV5640 DVP） | docs/boards.md waveshare-cam | 无（M8 未开始） |
| QSPI / RGB 大屏、电容触摸 | docs/boards.md | GC9A01、SSD1306（docs/STATUS.md:28、68） |
| ADC 按 IDF 校准曲线反解，adc_cali 可用 | esp-periph/src/sar_adc.rs | 线性近似、eFuse 校准缺、adc_cali 不可用（docs/STATUS.md:21） |
| VCD 波形、`--irq-latency` | docs/architecture.md:155-156 | `--trace-io` 事件级，无 VCD |
| 逐位 GPIO 波形模式（quantum=1，原生） | EX218 | 未见（WS2812 只按 RMT 条目解码，docs/STATUS.md:24） |
| MicroPython、Linux 演示 | README.md | 无 |

### 8.2 我们有、它没有（或未见）

| 能力 | 我方证据 | 对方 |
|---|---|---|
| 3D 世界（器件、房间、传感器读场景） | docs/STATUS.md:101、154 | 未见 |
| 选型 / BOM / 功耗估算，带可信度 | AGENTS.md §1；docs/STATUS.md:204 | 未见 |
| 电气求解器（MNA，与 ngspice 对照）、接线错误 | docs/STATUS.md:88、93 | 未见 |
| I2C 线长、天线遮挡估算 | docs/STATUS.md:63、78、105 | RSSI 固定 -40，未见 |
| 错口令、断开等 Wi-Fi 失败路径的验收 | docs/STATUS.md:31（wifi-wpa2-bad） | 未见 |
| LEDC 硬件渐变 | docs/STATUS.md:20 | 无（peripherals.md 标 —） |
| RMT 接收（C3） | docs/STATUS.md:23 | S3 RMT RX 无 |
| PCNT、EC11、HC-SR04 | docs/STATUS.md:58、60、61 | 未见 |
| MPU6050 带确定性噪声 | docs/STATUS.md:70 | 传感器噪声未见 |
| USB OTG 设备（HID、CDC）+ 虚拟主机 | docs/STATUS.md:46、47 | USB-OTG 无 |
| FreeRTOS 任务时间线（Perfetto） | docs/STATUS.md:163 | 未见 |
| 逻辑分析仪（网页与 CLI 逐条对拍） | docs/STATUS.md:148 | 有 VCD（CLI），网页未见 |
| 关卡、装配、检查点、npm `tryboard check` | docs/STATUS.md:120、139 | 未见 |
| 授权页、SPDX | docs/STATUS.md:129 | NOTICE 文件，无 SPDX |

持平项：I2S 麦克风注入（我方 docs/STATUS.md:83；对方 docs/cli.md:253-260）。

## 9. 可借鉴清单

### 9.1 借思路（不搬代码，任何文件都可以参考）

1. **收据定价**：每个价格都附出处（scope、样本、sha256、推导、拒收项），模型遇到没定价的事件就按名字拒绝。来源 esp32s3/src/timing.rs、esp32s3/tests/fixtures/*-receipt.json。
2. **CCOUNT 微基准探针设计**：`rsil 15` 关中断；相关与无关两种 cell 分开测；扣掉固定开销。来源 tools/fast-hardware/fp-probe/。
3. **JTAG lock-step 的归一化规则**：INTLEVEL 掩码、窗口向量隐藏、CCOUNT 循环重对齐。来源 docs/hardware-testing.md:56-61。
4. **真机输出存档做控制台差分**：低成本，能先于 HIL 做。来源 hw/*-real.txt。
5. **可选逐位波形模式**：quantum=1，GPIO 输出带周期戳，导出 VCD。`--irq-latency` 统计中断延迟。来源 EX218、docs/peripherals.md。
6. **空口按描述符回收节奏投递、缺描述符丢帧计数**：来源 docs/architecture.md:230-231。还有浏览器以太网中继 ABI（docs/wasm.md:231-262）。
7. **执行路径的 oracle 规则**：解释器是 oracle，加速路径的输出必须逐位一致；golden 包含指令数和音频 SHA-256。来源 tests/README.md。
8. **实验编号 + 证据目录的组织方式**：来源 docs/experiments.md、docs/evidence/。

### 9.2 可搬数据 / 代码（MIT；按我方 docs/LICENSING.md 必须先登记 DECISIONS，再经 SOURCES.md 进 NOTICES）

| 文件 | 内容 | 备注 |
|---|---|---|
| hw/difftest.sh、hw/compare.py、hw/steptrace.py | JTAG lock-step 流程 | 小脚本，适合重写；没有 S3 真机前用不上 |
| esp32s3/tests/fixtures/*-receipt.json | S3 实测价格 | 价格是事实数据；我们引用时写明出处和 scope |
| hw/reset-regs.txt | S3 复位后寄存器状态 | 可对照我们的复位值 |
| docs/evidence/adc-host-2026-10-02/README.md | ADC 电压 → raw 对照表 | 可做我们 ADC 校准的回归期望值（对方本身是由 IDF 曲线算出来的，不是真机数据） |

### 9.3 非 MIT 或来源不清：单列，不碰或绕道

| 文件 | 许可 / 问题 | 处理 |
|---|---|---|
| esp-periph/src/sar_adc.rs + esp-periph/LICENSE-ADC | Apache-2.0（转自 ESP-IDF） | 不从这里拿；直接从 ESP-IDF `curve_fitting_coefficients.c` 取，来源链更短，我方 LICENSING 已允许 IDF Apache |
| esp32c3/src/ble_lc.rs | MIT，但内容推导自 Espressif rev3 ROM 和 IDF 控制器 | 搬代码前先复核授权，只借思路 |
| hw/atech/flash-8M.bin、flash-0-1M.bin | 第三方产品固件 dump，授权不明 | 不复制 |
| web/wasm/fw/public/*.bin | 链接了 ESP-IDF（Apache）、Espressif 闭源 blob、NimBLE、pocket-tank（MIT） | 不复制 |
| examples/**/Vernon_ST7789T.* | Espressif Apache-2.0 | 不需要 |
| examples/hello_world*/main/*.c | CC0-1.0 | 不需要 |
| examples/ttgo-tdisplay/st7789py.py 及字体 | MIT（Russ Hughes） | 不需要 |
| tinydraw 仓库里的探针源码 | 没读，许可未知 | 用之前先查 |

## 对我们深入方向的建议

1. **网络故障注入：自己做，不需要借代码。**
   - 对方没有（docs/networking-howto.md:76-91 只列限制）。这是我们的差异点。
   - 在我方 VirtualAp → 虚拟网络这一层加丢包率、延迟 / 抖动、断线（deauth）、DNS 失败、AP 消失这几个旋钮，用确定性种子保证 CLI 和网页结果逐字节一致。
   - 借它的"缺描述符丢帧并计数"作为天然拥塞来源，还有"按描述符回收节奏投递"。
   - 验收用 IDF 重连 / 超时的打印（已有 wifi-wpa2-bad 的做法）。
2. **ADC 精度：借做法，数据直接从 ESP-IDF 取。**
   - 实现 eFuse ADC 校准字段（C3/S3 的 BLK 版本 + 校准值），让 `adc_cali_create_scheme_curve_fitting` 可用。
   - 正向模型用 IDF 曲线的逆，在其上叠加**我们已有的确定性噪声**，再加衰减档非线性。
   - 补 ADC2 与 Wi-Fi 冲突（对方未见）：Wi-Fi 启动后 ADC2 读返回 `ESP_ERR_TIMEOUT` 或无效值，并在选型层提示。
   - 用对方 EX207 的表做交叉回归。系数来源写进 DECISIONS。
3. **时序敏感代码检测：借思路。**
   - 先做两个便宜的：`--irq-latency` 风格的每线中断延迟统计；关中断或临界区时长的直方图。
   - 再把"没定价就按名字拒绝"用在结论上：可信度标签里，时序相关的结论如果依赖未标定价格，就自动降级为"必须上真机"。
   - 对 bit-bang、精确延时循环（读 CCOUNT / systimer 自旋）做静态 + 动态识别，给出警告。
4. **逻辑分析仪逐位波形：借思路。**
   - 我方 `--trace-io` 已按周期盖戳，差的是逐位 GPIO 和 VCD。
   - 加一个可选的"精细模式"：在被观察的引脚上以 1 周期粒度记录 GPIO 输出边沿，导出 VCD（PulseView 可读）。
   - 对方的逐位模式在浏览器不可用（quantum ≥ 64），我们可以把它做成网页里只对选中引脚、选中时间窗开启，形成差异。
   - 验收用 bit-bang WS2812，对照 EX218 的 96/192（S3）、64/128（C3）周期脉宽。
5. **CPU 时序模型 + 真机标定：借方法学；价格数据引用时登记。**
   - 第一步（无真机也能做）：建 `CostModel` 接口和收据 JSON 格式（claim / scope / sources+sha256 / derivation / adopted / refused）。先以对方公开的 S3 价格作为"引用、未经我方真机标定"的初值，可信度标"估算"。
   - 第二步（需要买板，先问人）：
     - 移植 CCOUNT 探针思路，自己写探针固件，在 S3 和 C3 上测，产出我们自己的收据；
     - 用片上 USB-Serial/JTAG 做 lock-step，规则照 compare.py 的三条归一化；
     - C3 走控制台差分，存档真机输出。
   - 目标指标参照对方：S3 hello 启动中位数 2.797 s；TinyDraw 时长比 0.96–1.0。
   - 注意：对方的 lock-step 只比架构状态、不比周期。周期准确性要靠收据和整程序时长对比。

## 未查清

- tinydraw 仓库里的探针源码、aliceisjustplaying/esp32sim 清理分支里的证据：没有读。
- 对方文档引用的本地归档证据：无法访问。
- night/timed-0919 分支、PR #91 的精确拟合细节：只看到主线文档里的描述。
- ADC2 与 Wi-Fi 仲裁、SoftAP、ESP-NOW：未见。
