# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org)
(pre-1.0: minor versions may break things). The web site's own "what's new" feed is generated separately by
`tools/build_web.sh`.

## [Unreleased]

## [0.1.0] - 2026-10-28

First tagged version, prepared for open-sourcing.

### Added
- Instruction-level cores: RISC-V RV32IMC (ESP32-C3, passes riscv-tests) and Xtensa LX6 / LX7 (classic ESP32, ESP32-S3,
  dual core, PSRAM), booting unmodified ESP-IDF v5.5 and Arduino images against the original mask ROM.
- Peripheral models with acceptance firmware: GPIO, UART, LEDC, RMT (WS2812, ultrasonic), I2C (SSD1306, BME280,
  MPU6050, QMI8658, touch panels), SPI LCD, ADC, I2S, PCNT, timers, USB HID keyboard / CDC on S3.
- Wi-Fi (open and WPA2-PSK, DHCP, HTTP, SoftAP provisioning) against a virtual network, optional real-network
  switch; BLE peripheral (NimBLE) with a virtual phone.
- 3D workbench in the browser (three.js, WebGPU / WebGL2): boards, breadboard, parts, wiring, room; sensors read the
  scene.
- Selection advisor (chip, board, BOM, pin map, power estimate with trust labels), a learning path with scripted
  checkpoints, an example library, and en / zh / ja / ko UI.
- `tryboard` CLI: run firmware with external parts, traces, logic-analyzer events, FreeRTOS task timelines, input-log
  replay.
- Apache-2.0 licence, contribution guide, code of conduct, security policy and CI.

[Unreleased]: ../../compare/v0.1.0...HEAD
[0.1.0]: ../../releases/tag/v0.1.0
