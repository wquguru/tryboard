# 授权结论与规则

2026-10-15 代理调研（一手来源，非法律意见）。上线 / 收费前要人复核，最好书面向乐鑫确认商标措辞与 ROM 分发。

## 结论
| 对象 | 结论 | 依据 |
|---|---|---|
| 乐鑫 ROM（`espressif/esp-rom-elfs`） | ✅ 可用、可随网站分发，需附 LICENSE / NOTICE 及 ROM 内第三方声明（Newlib BSD、miniz、TJpgDec 等） | 仓库 README："use the ELF files … under the terms of Apache License 2.0"，适用于编译产物 |
| `espressif/qemu` 里的 `pc-bios/*rom*.bin` | ⚠️ 无授权声明，**不用** | 改从 esp-rom-elfs 的 ELF 生成 |
| ESP-IDF（含 `*.rom.ld`、`soc/` 寄存器头） | ✅ Apache-2.0（soc 头为 Apache-2.0 OR MIT） | 可生成派生表，保留 NOTICE |
| `espressif/qemu` 源码 | ✅ 只作本机 / CI 对照进程、读来理解硬件；❌ 不得复制或翻译进我们的代码（否则整体 GPLv2） | GPLv2 |
| TRM / 数据手册 | ✅ 依据其中的事实（寄存器、行为）写模型；❌ 不在网站上逐字搬运文字 / 图表，链接原 PDF | 版权声明不授予任何 IP |
| "ESP32" / "Espressif" | 只能描述性使用，不能进产品名、不用乐鑫 logo；页脚声明"ESP32 is a trademark of Espressif Systems; not affiliated" | ESPRESSIF 为注册商标，ESP32 等已申请 |
| "Arduino" | 只用"compatible with Arduino"，不进名字 / 域名 / logo | arduino.cc/en/trademark |
| 开发板 3D / 图形 | 自己画；`esp-dev-kits` 文档图片与 Seeed OPL 库是 CC BY-SA 4.0，用了要署名并同协议；espressif.com 上的原理图 / PCB 下载**无授权，不用** | |
| 用户固件在模拟器里跑 | ✅ 不构成我们分发 | |
| 我们托管的示例固件 | arduino-esp32 LGPL-2.1、xiaozhi MIT、WLED EUPL-1.2、Tasmota GPL-3.0、ESPHome GPLv3：每个 bin 旁边给出协议、精确源码提交与构建配置 | |
| 开源 ROM 替代品 | 未找到 | |
| `espressif/esp_lcd_gc9a01` 2.0.4（组件管理器拉取，lens / spin 固件用） | ✅ Apache-2.0，可随示例固件分发，附 LICENSE | 组件包内 license.txt；registry 元数据 license=Apache-2.0；源码 github.com/espressif/esp-bsp（components/lcd/esp_lcd_gc9a01） |
| `espressif/cmake_utilities`（上一项的依赖，仅构建期 CMake 脚本） | ✅ Apache-2.0 | 组件包内 license.txt |

## 规则（硬性）
1. ROM 只从 esp-rom-elfs 发布的 ELF 提取，构建时生成，随附 LICENSE、NOTICE 与第三方声明；仓库里只放提取脚本，不放 bin。
2. 不复制 espressif/qemu 任何代码；QEMU 只以独立进程作对照。
3. 从 ESP-IDF 生成的表（寄存器地址、ROM 符号）保留来源与 NOTICE；网站有第三方授权页。
4. 板子模型自己建；用 CC BY-SA 素材时署名并同协议。
5. 托管示例固件：协议 + 源码提交 + 构建配置三件套。
6. 产品名中性（当前代号 TryBoard / 试板），描述里写"支持 ESP32 系列芯片""compatible with Arduino"，页脚非关联声明。
7. 收费前书面向乐鑫确认。

来源：github.com/espressif/esp-rom-elfs · docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html · github.com/espressif/qemu · arduino.cc/en/trademark · github.com/espressif/esp-dev-kits · github.com/Seeed-Studio/OPL_Kicad_Library
