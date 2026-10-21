# 授权结论与规则

2026-10-15 调研，2026-10-16 复核（逐条依据与原文见 `LICENSING_REVIEW.md`）。非法律意见；收费、广告、联盟上线前请律师看一遍。

## 结论
| 对象 | 结论 | 依据 |
|---|---|---|
| 乐鑫 ROM（`espressif/esp-rom-elfs`） | ✅ 可用、可随网站分发。附 Apache-2.0 全文、README 版权行（"Copyright (c) 2015-2022 Espressif Systems (Shanghai) Co. Ltd."）、ROM 第三方清单（Newlib BSD、Xtensa libhal MIT、TinyBasic Plus MIT、miniz 公有领域、TJpgDec、Zephyr USB Apache-2.0/BSD-3）。仓库没有 NOTICE 文件 | 仓库 README："use the ELF files … under the terms of Apache License 2.0" |
| `espressif/qemu` 里的 `pc-bios/*rom*.bin` | ⚠️ 无授权声明，**不用** | 改从 esp-rom-elfs 的 ELF 生成 |
| ESP-IDF（含 `*.rom.ld`、`soc/` 寄存器头） | ✅ Apache-2.0（soc 头为 Apache-2.0 OR MIT） | 可生成派生表，保留来源 |
| ESP-IDF 闭源库（esp32-wifi-lib、esp-phy-lib、esp32-bt-lib、esp-coex-lib） | ✅ Apache-2.0，可随固件分发 | 各仓库 LICENSE |
| BLE 控制器库签名（`espressif/esp32c3-bt-lib` 的 libbtdm_app*.a，Apache-2.0，"Copyright Espressif Systems (Shanghai) Co. Ltd."） | ◐ **需人复核**：仓库只存自己算出的掩码指令模式（`core/crates/soc/src/ble/sigs.rs`，S3 版 `sigs_xt.rs`（E-04，同一仓库的 esp32s3 库），均由 `tools/ble_sigs.py` 生成；重定位字段清零、只取每个函数前若干条指令），不存库的二进制、不存反汇编；库本身只由 `tools/fetch_third_party.sh` 下到 git 忽略的 `third_party/btlib/` 供生成签名，运行时只在用户自己的固件里出现。代理判断：Apache-2.0 允许派生，签名里仍含少量原指令字，按 Apache-2.0 §4 在 NOTICES 里署名即可；是否构成"派生作品"需人定（C-01，2026-10-19） | esp32c3-bt-lib LICENSE |
| `espressif/qemu` 源码（GPL-2.0） | ✅ 可以读源码理解硬件行为；❌ 不复制、不逐行翻译、不照搬函数结构；参考了什么行为写进 DECISIONS，并用固件差分验证 | GPLv2 §0（阅读不在许可范围内）；《计算机软件保护条例》第六、十七条 |
| 其他 GPL / AGPL 模拟器：CircuitJS（GPL-2.0）、SimulIDE（开发仓库 AGPL-3.0）、Velxio（AGPL-3.0 + 商业授权） | ✅ 可读；❌ 代码不进仓库 | 同上 |
| TRM / 数据手册 | ✅ 依据其中的事实（寄存器、行为、尺寸）写模型；❌ 不在网站上逐字搬运文字 / 图表，链接原 PDF | 版权声明不授予任何 IP |
| "ESP32" / "Espressif" | 描述性使用：产品型号（包括 3D 丝印上的 "ESP32-S3-DevKitC-1"、"ESP32-S3-WROOM-1" 字样）可以写；不进产品名；乐鑫 logo 不用，除非书面许可。ESPRESSIF 美国注册 6119571；ESP 有申请；ESP32 本身注册情况未查到 | 乐鑫 logo 指南只规定用法、不授予许可 |
| "Arduino" | 只用"compatible with Arduino"，不进名字 / 域名 / logo | arduino.cc/en/trademark |
| KiCad 官方库 / 乐鑫 KiCad 库 / Seeed OPL 的 3D 模型（CC BY-SA 4.0） | ✅ 可转 glTF 上网站，也可以给下载；纯转格式不算改编；集中署名；减面、去 logo 等改过的模型以 BY-SA 4.0 单独公开；场景和我们的代码属"合集"，不受 SA 影响 | CC BY-SA 4.0 §2(a)(4)、§1(a) |
| Adafruit CAD Parts、M5Stack M5_Hardware（MIT） | ✅ 可用，附版权与许可声明，去 logo；灯带写 WS2812，不写 NeoPixel（Adafruit 商标） | 各仓库 LICENSE |
| espressif.com / dl.espressif.com 下载件（原理图、PCB、DXF） | ❌ 无授权、网站条款限制商业使用；只读尺寸，自己建模 | 网站条款 |
| `esp-dev-kits` 文档图片 | ⚠️ README 写 CC BY-SA 4.0，文档站写不授予许可，冲突；在邮件 A 回复前不用 | |
| Fritzing parts（CC BY-SA 3.0） | ❌ 产品上不用（SA 会传到用户导出的图上） | |
| wokwi-elements（MIT）/ wokwi-boards（无许可证） | elements ✅ 可用；boards ❌ 不用 | |
| 用户固件在模拟器里跑 | ✅ 不构成我们分发 | |
| 我们自己的 ESP-IDF 示例固件（Apache / BSD / MIT 组件） | ✅ 附 `LICENSES.txt` + esp-idf-sbom 生成的 SPDX 清单；源码与构建配置作可复现性建议，不强制 | Apache-2.0 §4 |
| LGPL / GPL / EUPL 固件（arduino-esp32 LGPL-2.1、WLED EUPL-1.2、Tasmota GPL-3.0、ESPHome GPLv3） | 每个 bin 旁边给出协议、精确源码提交与构建配置（三件套） | 各许可证 |
| 乐鑫 MIT / 乐鑫修改版 MIT（esp-sr、ESP-ADF、esp_audio_codec、esp_audio_effects、esp_codec_dev 2.x 等） | ❌ 不托管含这些组件的固件（原文禁止为非乐鑫产品再分发）；构建脚本检测到 `LicenseRef-Espressif-Modified-MIT` 或 "ESPRESSIF MIT" 时拒绝发布；esp_codec_dev 锁 1.x（Apache-2.0） | 许可证原文 |
| M5Unified、M5GFX（M5Stack，MIT；M5GFX 内含 LovyanGFX，FreeBSD / BSD-2） | ✅ 可作为 Arduino 示例固件的库使用（M5-00）。条件：锁定提交（M5Unified `3590358…714a`、M5GFX `a8ebd7b…af72`，见 `tools/fetch_third_party.sh`）；库源码不进仓库；每个 bin 旁 `BUILD_INFO.txt` 记录库提交 + arduino-esp32 版本 + FQBN，并附 MIT / BSD 版权声明；M5GFX 内带的字体和第三方文件各有声明，托管含它们的 bin 前随 NOTICES 附上（见 REVIEW §15）：Adafruit GFX 字体 BSD、efont BSD、IPA 字体（IPA Font License v1.0，仅 `lgfx_font_japan` 用到时）、DejaVu、tjpgd（ChaN 自有宽松条款）、pngle / lgfx_qrcode（MIT）、miniz（公有领域）。`lgfx_qoi.c` 和 squix 生成的 Orbitron / Roboto / Satisfy / Yellowtail 字体头文件文件内无许可证头 | 各仓库 LICENSE；REVIEW §15 |
| F-08a Arduino 库（`tools/fetch_third_party.sh` 钉提交）：ArduinoJson（MIT）、U8g2（BSD-2；字体文件各有声明）、Adafruit SSD1306 / GFX / BME280 / MPU6050 / SHT31 / ILI9341（BSD）、Adafruit BusIO / DHT sensor library / RTClib（MIT）、Adafruit Unified Sensor（Apache-2.0）、ThingPulse esp8266-oled-ssd1306（MIT）、DallasTemperature（MIT）、MFRC522 miguelbalboa/rfid（Unlicense，公有领域） | ✅ 可链接进 Arduino 示例固件；源码不进仓库；上站点的 bin 按 arduino-esp32 LGPL 三件套 + `BUILD_INFO.txt` 记库提交，并随 NOTICES 附各库版权声明；U8g2 / GFX 字体上站前核一次 | 各仓库 LICENSE / license.txt（2026-10-20 读原文） |
| F-08b Arduino 库（`tools/fetch_third_party.sh` 钉发布标签提交）：FastLED（MIT）、WiFiManager tzapu（MIT）、PubSubClient knolleary（MIT）、NimBLE-Arduino h2zero（Apache-2.0）；ESP32Servo（仓库无 LICENSE 文件）与 IRremote（LICENSE 文件为 MIT，但简报列为未核）**只进本地 accept** | ✅ 前四个可链接进 Arduino 示例固件，源码不进仓库，上站点同 F-08a（三件套 + `BUILD_INFO.txt` + NOTICES）；ESP32Servo / IRremote 待人核，未核前不上站 | 各仓库 LICENSE（2026-10-20 读原文） |
| OneWire（PaulStoffregen，仓库无 LICENSE 文件，源文件头为自定宽松条款）、TFT_eSPI（Bodmer，混合：Adafruit BSD + 继承的 MIT + 作者条款） | ⚠️ 只做本地 accept（`arduino-lib-dallas` / `arduino-lib-tft-espi`），**不上站点**，待人核 | 源文件头 / license.txt |
| xiaozhi | 自身 MIT，**但依赖上一行的组件**，乐鑫书面许可前不托管 | |
| `espressif/esp_lcd_gc9a01` 2.0.4、`espressif/cmake_utilities` | ✅ Apache-2.0，可随示例固件分发，附 LICENSE | 组件包 license.txt |
| `espressif/esp_lcd_ili9341` **2.1.0**（F-04b，firmware/c3-ili9341 锁定） | ✅ Apache-2.0：2026-10-20 核组件包 license.txt 为标准 Apache-2.0 全文，注册表 url 指向 esp-bsp；依赖 cmake_utilities 0.5.3 同上。可随示例固件分发，附 LICENSE | 组件包 license.txt |
| `espressif/esp_websocket_client` **1.7.0**（F-09a-2，firmware/c3-xz-ws 锁定） | ✅ Apache-2.0：2026-10-21 核组件包 license.txt 为标准 Apache-2.0 全文，依赖只有 IDF ≥ 5.0。可随示例固件分发，附 LICENSE；1.8.0 注册表标 Custom 许可证，未核，不用 | 组件包 license.txt |
| `espressif/esp_lcd_co5300` **2.0.3**（E-01，firmware/s3-co5300 锁定）及其依赖 `espressif/cmake_utilities` 0.5.3 | ✅ Apache-2.0：2026-10-20 核 2.0.3 组件包 license.txt 为标准 Apache-2.0 全文（202 行，非乐鑫修改版 MIT），源码 SPDX Apache-2.0，注册表标注 Apache-2.0；cmake_utilities 0.5.3 包内 license.txt 同为 Apache-2.0。2.1.0 / 2.2.0 注册表标「Custom」（license.txt 内容与 2.0.3 相同），为免歧义不用。可随示例固件分发，附 LICENSE | 组件包 license.txt |
| `lvgl/lvgl` 9.2.2（组件注册表）、`espressif/esp_lvgl_port` 2.6.0 | ✅ LVGL 为标准 MIT（"Copyright (c) 2021 LVGL Kft"），esp_lvgl_port 为 Apache-2.0（源文件 SPDX 均为 Apache-2.0，示例为 CC0-1.0）；2026-10-16 核对组件包内 LICENCE.txt / license.txt，两者都**不是**乐鑫修改版 MIT，可随示例固件分发，附许可证。LVGL 源码里另带的第三方库（FreeType、ThorVG、lodepng 等）只在对应 Kconfig 打开时编译，s3-lvgl 没开 | 组件包 LICENCE.txt / license.txt |
| ngspice | 本机 tools/ 对照用 ✅；网页版：排除 `xspice/icm/table`（GPL）、`--disable-klu`、不 `--with-tcl`；numparam（LGPL）排除不掉，编成独立 wasm，附源码与构建脚本 | 各模块许可证 |
| three.js、three-mesh-bvh、three-gpu-pathtracer、glTF-Transform（MIT）；Manifold、Rapier（Apache-2.0）；Poly Haven HDRI（CC0） | ✅ 可用（引入前仍要写进 DECISIONS） | 各 LICENSE |
| React / React DOM、Radix UI（`radix-ui`）、Tailwind CSS、tailwind-merge、clsx（MIT）；class-variance-authority（Apache-2.0）；shadcn/ui 组件写法（MIT，只参考结构自己写，不整段复制） | ✅ 可用（2026-10-17 核对 npm 包 LICENSE；引入前写进 DECISIONS）。随网站分发的运行时进授权页 | 各 LICENSE |
| 字体：Noto Sans SC、JetBrains Mono（OFL-1.1） | ✅ 可自托管、转 WOFF2、子集化；附 OFL.txt；子集文件名不带保留名 "Source" | OFL |
| 参考价与店铺外链 | ✅ 人工核价 + 日期 + 来源；不写"最低价 / 最佳"；不用平台 logo。联盟链接（以后）要显著标"广告"，推荐逻辑与佣金脱钩，申请前读各联盟现行规范 | 《互联网广告管理办法》第九条第三款 |
| 开源 ROM 替代品 | 未找到 | |

## 规则（硬性）
1. ROM 只从 esp-rom-elfs 发布的 ELF 提取，构建时生成，随附 Apache-2.0 全文、版权行与 ROM 第三方清单；仓库里只放提取脚本，不放 bin。
2. GPL / AGPL 代码可读不可抄：不复制、不逐行翻译、不照搬结构；行为参考写进 DECISIONS 并有固件差分验证。QEMU 只以独立进程作对照。
3. 从 ESP-IDF 生成的表（寄存器地址、ROM 符号）保留来源。
4. 3D 器件优先按真实尺寸程序生成；用外部模型时只用上表 ✅ 的来源，来源与署名写进素材目录的 `SOURCES.md`。
5. 托管示例固件：自己的 Apache/MIT 固件附许可证清单；LGPL / GPL / EUPL 固件三件套；含乐鑫 MIT 组件的不托管。
6. 产品名中性（当前代号 TryBoard / 试板），描述里写"支持 ESP32 系列芯片""compatible with Arduino"，页脚非关联声明；3D 视图写"外观示意，非乐鑫官方模型"。
7. 上线前发出邮件 A、B（草稿见 `LICENSING_REVIEW.md` 第四节，要人点头才能发）；收费、广告或联盟上线前要有回复。
8. 网站有第三方授权页（`licenses.html`，地址 `/licenses`）和同时生成的 `THIRD_PARTY_NOTICES.txt`、`tryboard.spdx.json`，由构建脚本从各素材目录的 `SOURCES.md` 和 npm / cargo 依赖清单自动生成。页面是一页声明 + 下载入口；代码库、ROM、固件组件、3D 模型、字体、HDRI 的来源、版权行、许可证全文与修改说明在 NOTICES 文件里（2026-10-18 起，见 DECISIONS）。

来源见 `LICENSING_REVIEW.md` 末尾。
