# M5Stack 支持可行性评估

2026-10-20。证据在 `Reviews/m5/`（git 忽略，可重新生成）：`boards.md`（docs.m5stack.com 逐板硬件表）、`autodetect.md`（M5Unified `3590358` / M5GFX `a8ebd7b` 源码里的探测顺序，带 file:line）、`gaps.md`（本仓库缺口，带 file:line）。本文只做评估，不改代码；动手前要先把 §6 的条目写进 PLAN。

## 1. 结论

- **可行，值得做，但先做共用底座，再逐板接入。** 主力在售的 M5 控制器里，ESP32-S3 板（AtomS3 / AtomS3R / Dial / CoreS3 / Cardputer / StickS3）都在我们已有的核心上；经典 ESP32 板（StickC Plus2 / Core2 / Atom Lite）卡在经典 ESP32 的 SPI / RMT / I2S 还没做。
- **难点不在芯片，在 M5GFX 的自动识别**：它直接操作 I2C / SPI 寄存器（不走 IDF 驱动），用三线 SPI 读回屏幕 ID、用 GPIO 软件 I2C 探测器件、个别板靠模拟量（G38 放电、触摸读数）区分。模拟器要在这些环节回答得和真板一样，用户的 M5Unified 程序才会走对分支。
- **第一块建议做 M5Dial，其次 AtomS3**：现有 GC9A01 圆屏、编码器（PCNT）、FT6236 系触摸都能复用，缺的是 SPI 读回、可配引脚和 BM8563。
- **不做**：Tab5（ESP32-P4）、NanoC6 / SwitchC6（ESP32-C6）、LLM / Linux 模块（非 ESP）、PaperS3 / PaperColor（S3 直驱电子纸 + 八线 PSRAM，暂缓）。选型页标「不可模拟」并说明原因。

## 2. 为什么值得做

- M5 是爱好者圈最大的 ESP32 成品整机生态之一；用户常见的问题是「买 CoreS3 还是 AtomS3R + 几个 Unit」，正好是选型层要回答的。
- 整机引脚和板载器件固定，适合做「板预设」：不用接线，验收边界清楚；外接只有 Grove 口，I2C Unit（ENV 系列等）模型小、复用度高。
- 生态以 Arduino + M5Unified / UiFlow 为主，编出来是普通固件；本机已装 arduino-cli + esp32 core 3.3.2，可以直接编 M5Unified 官方示例做验收固件。

## 3. 板卡与难度

| 板 | 芯片 | 板载器件（要模拟） | 现有可复用 | 新增 | 难度 |
|---|---|---|---|---|---|
| M5Dial（v1.1 换 StampS3A） | S3 | GC9A01 240×240、FT3267 触摸、BM8563 RTC、编码器、蜂鸣器、WS1850S RFID | gc9a01、ft6236、PCNT 编码器、pcf85063 时钟核 | 屏 ID 读回、引脚可配、BM8563（寄存器从 0x02 起，与 85063 不同）；RFID 可后做 | **S–M** |
| AtomS3 / AtomS3 Lite | S3 | GC9107 128×128（**2026-05 起 AtomS3R 改 ST7735**）、MPU6886、按键、红外；Lite 是 WS2812 | 通用 DCS 屏、mpu6050、RMT | SPI3、GC9107 / ST7735、MPU6886（WHO_AM_I 0x19） | **S–M** |
| AtomS3R（-CAM） | S3 PICO-1-N8R8，八线 PSRAM | 同上 + BMI270 + BMM150、LP5562 背光（I2C 0x30） | 同上 | BMI270（8 KB 配置上传）、LP5562、八线 PSRAM 待核 | M |
| CoreS3 / CoreS3-SE | S3 N16R8 | ILI9342C 320×240、FT6336U、AXP2101、AW9523、BMI270 + BMM150、BM8563、ES7210、AW88298、LTR-553、GC0308 摄像头（SE 无） | axp2101、ft6236、es7210 壳、I2S | ILI9342 C/E 区分（D9h 读回）、AW9523、BMI270、I2C1 挂设备、AW88298；摄像头需 LCD_CAM（L，随 M8） | **M–L** |
| Cardputer / Cardputer-Adv | S3（StampS3 / S3A） | ST7789 240×135、键盘（原版 74HC138 矩阵，Adv 是 TCA8418）、PDM 麦（原版）/ ES8311 + BMI270（Adv）、NS4168 喇叭 | ES8311、MAX98357A ≈ NS4168 | ST7789、键盘部件、I2S PDM 接收、TCA8418 | M |
| StickC Plus2 | 经典 ESP32-PICO-V3-02 | ST7789 135×240、MPU6886、BM8563、**无 PMIC**（G4 保持供电）、PDM 麦、红外、蜂鸣器 | 经典核心可启动、Wi-Fi | **经典 ESP32 GP-SPI + DMA**、eFuse 封装号、ADC、RMT、I2S | **L** |
| Core2 v1.0 / v1.1 / AWS | 经典 ESP32-D0WDQ6-V3 | ILI9342C、FT6336U、**v1.0 / AWS 为 AXP192，v1.1 为 AXP2101 + INA3221**、MPU6886、BM8563、NS4168、PDM 麦、AWS 版多 ATECC608B | axp2101（v1.1） | 经典 SPI、AXP192（M）、I2S、PSRAM（软失败可先跳过） | **L** |
| Atom Lite / Matrix | 经典 ESP32-PICO-D4 | SK6812（RMT）、Matrix 有 MPU6886 | — | 经典 RMT、触摸外设（Lite / Matrix 靠触摸读数区分） | M |

版本坑（P1-12 版本差异规则要覆盖）：Core2 PMIC 换代；AtomS3R 屏驱换代；Dial / Cardputer v1.1 换 StampS3A（G38 控制 RGB 供电）；Core2 屏 ILI9342C → ILI9342E；StickS3、PaperColor 用 M5 自家 PMIC M5PM1（0x6E，资料少）。完整表与「待核」清单见 `Reviews/m5/boards.md`。

## 4. 共用缺口（按挡住的板数排序）

| # | 缺口 | 现状（证据） | 影响 | 工作量 |
|---|---|---|---|---|
| 1 | SPI 屏读回（RDDID 0x04 / D9h）+ 三线半双工 + dummy 位 | SPI 读一律返回 0xFF（`core/crates/esp32s3/src/spi_lcd.rs:104-112`） | 7 块板屏幕识别失败 | M |
| 2 | 屏模型通用化：分辨率 / 偏移 / 引脚可配 | `LcdKind` 只有 GC9A01 / CO5300（`soc/src/devices/lcd.rs:8`），引脚是常量（`spi_lcd.rs:17`） | 7 块 | M（之后每种屏 S） |
| 3 | 外接 I2C 设备能挂到 I2C1 / 按引脚挂 | 只挂 I2C0（`machine/src/lib.rs:604-617`）；M5Unified 内部总线在 I2C1 | CoreS3、Core2 阻断，另 4 块降级 | S–M |
| 4 | M5 常用芯片模型 | 缺 MPU6886、BMI270(+BMM150)、BM8563、AXP192、AW9523、LP5562；FT6336U 的芯片 ID | 各板 | 多数 S，BMI270 / AXP192 M |
| 5 | S3 USB-Serial-JTAG 串口输出 | TX 存进 `usj_tx` 但没人读（`esp32s3/src/lib.rs:565-571`），状态也不报主机在线 | 所有 S3 板的 Arduino `Serial` 静默，串口验收做不了 | S–M |
| 6 | S3 SPI3 | 只有 spi2（`esp32s3/src/lib.rs:156`） | AtomS3 / AtomS3R / Cardputer | S |
| 7 | eFuse 封装号可配 | 经典 ESP32 固定为 0（`esp32/src/periph.rs:638-650`） | StickC Plus2 / Atom 识别错 | S |
| 8 | I2S PDM 接收 | 不支持 PDM（`soc/src/i2s.rs:303-306`） | 带 SPM1423 麦的板 | M |
| 9 | 经典 ESP32：GP-SPI + DMA、RMT、I2S、ADC、PSRAM | STATUS「ESP32」节：SPI / I2S / ADC ☐，RMT ✗，无 PSRAM | 全部经典板 | L（合计） |
| 10 | 网页「板预设」通用化 | 只有 `ws-amoled216` 会自动挂板载器件（`web/src/bench3d/boarddevs.ts:4`）；`m5-atoms3` 只是选型目录条目 | 所有 M5 板 | M |
| 11 | LCD_CAM / DVP 摄像头 | 不存在 | CoreS3、AtomS3R-CAM | L（归 M8） |

## 5. 自动识别的模拟要求（摘自 autodetect.md）

- 软件 I2C 探测要求总线是「线与 + 外部上拉胜过内部下拉」的电气行为，不能只在 I2C 控制器层回 ACK。
- 屏 ID 在 S3 上通过 MOSI 三线读回，dummy 时钟沿在事务外产生，差一位就认错屏。
- 失败探测每次最多等 200 ms、重试 5 次，会拖慢启动；识别结果缓存在 NVS，所以 flash 写入要持久。**预置 NVS 板型键可跳过全部探测**：可作为调试捷径，但不算验收（验收必须走完真实探测路径）。
- 少数板靠模拟量区分（StampS3 与 AtomS3 Lite 看 G38 放电；Atom Matrix 与 Lite 看触摸读数），要么建模，要么在板预设里写死并标「行为级」。

## 6. 验收路线

- 验收固件两条路：
  - **A. ESP-IDF 组件**（优先）：M5Unified / M5GFX 在 IDF 组件库里有发布，可以按现有 `tools/build_fw.sh`（纯 `idf.py`）建 m5-* 工程，不引入 Arduino 核心，同样走 M5GFX 直接操作寄存器的路径。组件下载 / 离线缓存是否顺利 **待核**。
  - **B. arduino-cli + esp32 core 3.3.2**（本机已装）：编 M5Unified 官方示例（Basic/Displays、IMU、Rtc、Touch、Button），最贴近用户实际写法；要给 build_fw.sh 加 arduino 分支。授权见 §7。
  - 两条路的输出都走 USB-Serial-JTAG（依赖缺口 5），产物都不提交。
- 对照源：QEMU 不模拟这些外设，没有 oracle。只能对照官方文档 / 论坛贴出的真机启动日志和屏幕照片；所有结论写「未经真机标定」。屏幕用 `--lcd-ppm` 截图与参考图逐像素比对（我们自己生成的参考）。
- 官方预编译固件（出厂测试 / UiFlow2 .bin）可以本地跑冒烟，但授权未查，不得进 `web/public/fw`。

## 7. 授权

- M5Unified、M5GFX：MIT；M5GFX 内含 LovyanGFX：FreeBSD（BSD-2）；附带字体（Adafruit BSD、IPA）要保留声明；`lgfx_qoi.c` 无许可头，待核。**三者都还不在 `docs/LICENSING.md`**：读源码理解行为可以，链接进验收固件 / 上站前先补 LICENSING 条目并在 DECISIONS 记录。
- arduino-esp32 核心：混合授权，源文件头分别是 LGPL-2.1（`cores/esp32/Arduino.h`、`Client.h` 等 Arduino 派生文件）和 Apache-2.0，也不在 LICENSING.md。本地编译验收没问题；**用 Arduino 编出的 .bin 放进 `web/public/fw` 当内置示例 = 分发链接了 LGPL 代码的二进制**，按 LICENSING.md 已有的 LGPL 固件规则处理：每个 bin 旁给协议、精确源码提交与构建配置（三件套，`arduino-blink` 已这样做）。
- 3D 外壳：M5Stack M5_Hardware（MIT）已是 ✅；去 logo。产品名照常提及，不用 M5 商标做页面品牌。

## 8. PLAN 条目

2026-10-20 人确认「完整实现并验证」，已写进 PLAN「M5」节（编号以 PLAN 为准，下表是评估时的初稿）。

| 建议 ID | 内容 | 验收 |
|---|---|---|
| M5-00 | 补 LICENSING（M5Unified / M5GFX / LovyanGFX / arduino-esp32）；验证 IDF 组件路线，必要时 build_fw.sh 加 arduino 分支 | `tools/build_fw.sh m5-hello` 产出 flash.bin |
| M5-01 | 底座：SPI 读回 + 三线 + 通用 DCS 屏模型（可配引脚 / 尺寸 / 偏移 / ID） | 现有 gc9a01 用例逐字节不变（golden）；新单测读 RDDID |
| M5-02 | 底座：I2C1 / 按引脚挂设备，软件 I2C 线与上拉；S3 SPI3；eFuse 封装号可配 | cargo test + 现有 accept 不变 |
| M5-03 | 底座：USB-Serial-JTAG 输出接 CLI / 网页串口 | Arduino `Serial.println` 在 CLI 与网页逐字节一致 |
| M5-04 | M5Dial 板预设（BM8563、FT3267 ID、编码器、蜂鸣器） | M5Unified 示例：识别为 board_M5Dial、圆屏画面、旋钮计数、触摸坐标 |
| M5-05 | AtomS3 / AtomS3 Lite（GC9107 / ST7735、MPU6886、WS2812） | 识别板型 + 屏 + IMU 读数随 3D 姿态变化 |
| M5-06 | 网页板预设通用化 + Grove 口接 Unit（ENV III / IV 先做） | agent-browser 走：选 M5 板 → 自动出现板载器件 → 接 ENV IV → 读数 |
| M5-07 | CoreS3（AW9523、ILI9342C、FT6336U、BMI270、AW88298；摄像头不做） | 识别 board_M5StackCoreS3；触摸、IMU、喇叭频谱 |
| M5-08 | Cardputer / Cardputer-Adv（ST7789、键盘部件、PDM / ES8311） | 键盘输入回显到屏 |
| M5-09 | 经典 ESP32 补 SPI+DMA / RMT / I2S / ADC（单独立项，非 M5 专属） | 各自 IDF 示例与 QEMU 对照 |
| M5-10 | StickC Plus2、Core2（AXP192）、Atom Lite | 依赖 M5-09 |

## 9. 风险

- M5 改版频繁（屏驱、PMIC、Stamp 模块），板预设要按版本拆，选型页要提示「买到的版本可能不同」。
- 行为级模拟（RTC、PMIC 电量、IMU）没有真机标定，只能给「行为模拟」可信度。
- 软件 I2C 线与、模拟量识别属于电气层，和 `crates/elec` 的边界要先在 ARCH 里定清楚，避免两套总线模型。
