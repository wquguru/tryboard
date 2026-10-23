<div align="center">

<img src="../logo.svg" width="72" alt="TryBoard">

# 试板 TryBoard

**买板之前先试板：在浏览器里跑你真实的 ESP32 固件。**

[English](../../README.md) · 简体中文 · [日本語](README.ja.md) · [한국어](README.ko.md)

[![Rust](https://img.shields.io/badge/内核-Rust%20→%20wasm-b7410e?style=flat-square&logo=rust&logoColor=white)](../../core)
[![Chips](https://img.shields.io/badge/芯片-ESP32--C3%20·%20S3%20·%20ESP32-0b76c8?style=flat-square)](../STATUS.md)
[![ESP-IDF](https://img.shields.io/badge/ESP--IDF-v5.5-e7352c?style=flat-square)](https://github.com/espressif/esp-idf)
[![three.js](https://img.shields.io/badge/3D-three.js-000?style=flat-square&logo=threedotjs&logoColor=white)](https://threejs.org)
[![Languages](https://img.shields.io/badge/界面-en%20·%20zh%20·%20ja%20·%20ko-0aa06e?style=flat-square)](../I18N.md)

</div>

---

试板是一个指令级 ESP32 模拟器，外加一张 3D 实验台。把 ESP-IDF 或 Arduino 编出来的 `flash.bin` 拖进来，
在面包板上接好零件，同一个二进制就会点灯、转舵机、刷屏幕、连 Wi-Fi 和蓝牙 ——
而且**结果确定**：同一份固件每次跑出来都一样，可以像测试一样验收。

它是给用 AI 写固件的人做的：网站给你任务书和通过条件，你的 AI 写代码，
试板告诉你能不能跑通、该买哪颗芯片和哪些零件，以及哪些风险只能上真机排除。

## 三层

**内核：跑真实的二进制。** 用 Rust 从零写的 RV32IMC 与 Xtensa LX6 / LX7 模拟器，编成 wasm。
固件不用改，配合原厂掩膜 ROM 启动；FreeRTOS 调度、S3 双核、PSRAM 都在，外设模型与 QEMU、ESP-IDF 测试输出对拍。

**世界：传感器读的是场景。** three.js 实验台（WebGPU 优先、WebGL2 兜底），有开发板、面包板、零件和房间。
超声波是射线，IMU 读物理，屏幕显示真实帧缓冲，蜂鸣器走 Web Audio，虚拟手机能扫描、连接、订阅你的 BLE 外设。

**决策：该买什么。** 选型助手把一个项目变成芯片、开发板、BOM、引脚表和功耗估算，每个结论都标可信度：

| 标签 | 含义 |
|---|---|
| 仿真验证 | 真实固件在指令级内核上跑通，外设模型有验收 |
| 行为模拟 | 外部世界是行为级的（虚拟手机、虚拟 Wi-Fi 网络） |
| 估算 | 功耗、时序余量、线损按数据手册与标定模型估算 |
| 必须上真机 | 射频距离、天线、模拟噪声、严格时序，要用真板确认 |

## 现在能跑什么

| 模块 | ESP32-C3 | ESP32-S3 | ESP32 |
|---|---|---|---|
| CPU、中断、定时器、FreeRTOS | ✅ RV32IMC | ✅ LX7 双核、PSRAM | ✅ LX6 双核 |
| GPIO、UART、LEDC（PWM） | ✅ | ✅ | ✅ |
| I2C 与虚拟 SSD1306 / BME280 | ✅ | ✅（另有 MPU6050、QMI8658、触摸屏） | ✅ |
| ADC、RMT（WS2812、超声波）、SPI 屏、I2S | ✅ | ✅（另有 PCNT 编码器） | — |
| USB HID 键盘 / CDC | — | ✅ | — |
| Wi-Fi（开放网络、WPA2-PSK、HTTP） | ✅ | ✅ | 只到初始化 |
| BLE 外设（NimBLE）+ 虚拟手机 | ◐ 行为模拟 | — | — |

完整矩阵和验收依据见 **[docs/STATUS.md](../STATUS.md)**。每批都跑 <!-- stats:accept -->235<!-- /stats --> 个验收用例、<!-- stats:examples -->72<!-- /stats --> 个示例和 7 关学习路线（`tools/accept.sh`）。

## 快速开始

```bash
tools/fetch_third_party.sh          # ROM ELF（Apache-2.0）与 riscv-tests，下载到 third_party/
tools/build_web.sh                  # wasm 内核 + 网页资源
cd web && npm install && npm run dev   # http://localhost:5180
```

命令行跑固件、接外设：

```bash
cd core
cargo run -p tryboard-cli --release -- run ../firmware/build/blink/flash.bin
cargo run -p tryboard-cli --release -- run ../firmware/build/weather/flash.bin \
  --i2c ssd1306@0x3c,bme280@0x76 --env 23.5,45,101325 --oled
tools/check.py ../firmware/build/blink/flash.bin --level 01   # 按关卡判通过 / 不通过
```

构建验收固件需要 ESP-IDF v5.5（`tools/build_fw.sh`）。环境：Rust（含 `wasm32-unknown-unknown`）、Node 20+、Python 3.11+。

## 目录

```
core/       Rust workspace：rv32、xtensa、soc、esp32c3、esp32s3、esp32、elec、cli、wasm
web/        Vite + TypeScript + React + three.js 前端；多语言在 web/src/i18n
firmware/   ESP-IDF 验收固件、examples.json、levels.json
tools/      构建、验收、QEMU 对照、网页回归测试
docs/       架构、计划、设计、授权结论
```

贡献者与编程代理请先读 **[AGENTS.md](../../AGENTS.md)** 和 **[docs/I18N.md](../I18N.md)**。

## 致谢

试板建立在许多开源项目之上：

- **乐鑫** — [ESP-IDF](https://github.com/espressif/esp-idf)、[esp-rom-elfs](https://github.com/espressif/esp-rom-elfs)、
  [esp_lcd_gc9a01](https://components.espressif.com/components/espressif/esp_lcd_gc9a01)、
  [esp_lvgl_port](https://github.com/espressif/esp-bsp)，以及只作为独立对照进程使用的
  [乐鑫 QEMU 分支](https://github.com/espressif/qemu)
- **RISC-V** — [riscv-tests](https://github.com/riscv-software-src/riscv-tests)，用于 CPU 一致性测试
- **图形与界面** — [three.js](https://threejs.org)、[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)、
  [Manifold](https://github.com/elalish/manifold)、[React](https://react.dev)、[Radix UI](https://www.radix-ui.com)、
  [Tailwind CSS](https://tailwindcss.com)、[Vite](https://vite.dev)、[LVGL](https://lvgl.io)
- **电气对照** — [ngspice](https://ngspice.sourceforge.io)
- **3D 模型** — [KiCad 库](https://gitlab.com/kicad/libraries/kicad-packages3D)（CC BY-SA 4.0）与
  [Adafruit CAD Parts](https://github.com/adafruit/Adafruit_CAD_Parts)（MIT），用
  [occt-import-js](https://github.com/kovacsv/occt-import-js)、[glTF-Transform](https://gltf-transform.dev)、
  [meshoptimizer](https://github.com/zeux/meshoptimizer) 转换
- **字体** — [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC) 与
  [JetBrains Mono](https://www.jetbrains.com/lp/mono/)（SIL OFL 1.1）

逐个文件的来源、版权行和许可证全文生成在 `THIRD_PARTY_NOTICES.txt` 和 `/licenses` 页面里；背后的规则见 [docs/LICENSING.md](../LICENSING.md)。

## 说明

试板是独立项目，与乐鑫科技没有关联，也未获其认可。"ESP32" 指它模拟的芯片系列；3D 开发板是外观示意，非乐鑫官方模型。
兼容 Arduino 构建的固件。除非特别注明，模拟结果未经真机标定。本仓库尚未选定开源许可证。
