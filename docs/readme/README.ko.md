<div align="center">

<img src="../logo.svg" width="72" alt="TryBoard">

# TryBoard

**보드를 사기 전에, 실제 ESP32 펌웨어를 브라우저에서 돌려 보세요.**

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · 한국어

[![Rust](https://img.shields.io/badge/core-Rust%20→%20wasm-b7410e?style=flat-square&logo=rust&logoColor=white)](../../core)
[![Chips](https://img.shields.io/badge/chips-ESP32--C3%20·%20S3%20·%20ESP32-0b76c8?style=flat-square)](../STATUS.md)
[![ESP-IDF](https://img.shields.io/badge/ESP--IDF-v5.5-e7352c?style=flat-square)](https://github.com/espressif/esp-idf)
[![three.js](https://img.shields.io/badge/3D-three.js-000?style=flat-square&logo=threedotjs&logoColor=white)](https://threejs.org)
[![Languages](https://img.shields.io/badge/UI-en%20·%20zh%20·%20ja%20·%20ko-0aa06e?style=flat-square)](../I18N.md)

</div>

---

TryBoard는 3D 작업대를 갖춘 명령어 수준 ESP32 시뮬레이터입니다. ESP-IDF나 Arduino로 빌드한 `flash.bin`을 넣고
브레드보드에 부품을 배선하면, 같은 바이너리가 LED를 깜빡이고 서보를 돌리고 디스플레이에 그리고 Wi-Fi와 BLE로 통신합니다.
게다가 **결정적**이어서 같은 펌웨어는 매번 같은 결과를 내고, 테스트처럼 검증할 수 있습니다.

AI로 펌웨어를 작성하는 사람을 위해 만들었습니다. 사이트가 작업 지시서와 통과 조건을 주면 AI가 코드를 쓰고,
TryBoard가 제대로 동작하는지, 어떤 칩과 부품을 사야 하는지, 실제 하드웨어로만 확인할 수 있는 위험은 무엇인지 알려 줍니다.

## 세 개의 계층

**코어 — 실제 바이너리를 실행합니다.** Rust로 처음부터 작성한 RV32IMC / Xtensa LX6·LX7 에뮬레이터를 wasm으로 컴파일했습니다.
수정하지 않은 ESP-IDF 이미지를 정품 마스크 ROM과 함께 부팅하며 FreeRTOS 스케줄링, S3 듀얼 코어, PSRAM을 지원합니다.
주변장치 모델은 QEMU와 ESP-IDF 테스트 출력과 대조해 검증합니다.

**월드 — 센서는 장면을 읽습니다.** three.js 작업대(WebGPU 우선, WebGL2 대체)에 보드, 브레드보드, 부품, 방이 있습니다.
초음파 센서는 광선을 쏘고, IMU는 물리를 읽고, 디스플레이는 프레임버퍼를 그리고, 부저는 Web Audio로 울리며,
가상 스마트폰이 BLE 주변장치를 스캔·연결·구독합니다.

**결정 — 무엇을 살지.** 선정 도우미가 프로젝트를 칩, 보드, BOM, 핀 배치, 전력 추정으로 정리합니다.
모든 결론에는 신뢰도 라벨이 붙습니다.

| 라벨 | 의미 |
|---|---|
| 시뮬레이션 검증 | 실제 펌웨어가 명령어 수준 코어에서 동작하고, 주변장치 모델에 인수 테스트가 있음 |
| 동작 모델 | 외부 세계를 동작 수준으로 모델링(가상 스마트폰, 가상 Wi-Fi 네트워크) |
| 추정 | 전력, 타이밍 여유, 배선 손실을 데이터시트와 보정 모델로 산출 |
| 실기기 필요 | RF 거리, 안테나, 아날로그 노이즈, 엄격한 타이밍 — 실제 보드로 확인 |

## 지금 동작하는 것

| 항목 | ESP32-C3 | ESP32-S3 | ESP32 |
|---|---|---|---|
| CPU, 인터럽트, 타이머, FreeRTOS | ✅ RV32IMC | ✅ LX7 듀얼 코어, PSRAM | ✅ LX6 듀얼 코어 |
| GPIO, UART, LEDC(PWM) | ✅ | ✅ | ✅ |
| I2C와 가상 SSD1306 / BME280 | ✅ | ✅(MPU6050, QMI8658, 터치 패널 포함) | ✅ |
| ADC, RMT(WS2812, 초음파), SPI LCD, I2S | ✅ | ✅(PCNT 엔코더 포함) | — |
| USB HID 키보드 / CDC | — | ✅ | — |
| Wi-Fi(개방형, WPA2-PSK, HTTP) | ✅ | ✅ | 초기화까지만 |
| BLE 주변장치(NimBLE) + 가상 스마트폰 | ◐ 동작 모델 | — | — |

인수 테스트 근거를 포함한 전체 표는 **[docs/STATUS.md](../STATUS.md)**(중국어)에 있습니다. 매번 <!-- stats:accept -->215<!-- /stats -->개의 인수 테스트,
<!-- stats:examples -->63<!-- /stats -->개의 예제, 7단계 학습 코스를 실행합니다(`tools/accept.sh`).

## 빠른 시작

```bash
tools/fetch_third_party.sh          # ROM ELF(Apache-2.0)와 riscv-tests를 third_party/에 받기
tools/build_web.sh                  # wasm 코어 + 웹 에셋
cd web && npm install && npm run dev   # http://localhost:5180
```

명령줄에서 부품을 연결해 펌웨어 실행:

```bash
cd core
cargo run -p tryboard-cli --release -- run ../firmware/build/blink/flash.bin
cargo run -p tryboard-cli --release -- run ../firmware/build/weather/flash.bin \
  --i2c ssd1306@0x3c,bme280@0x76 --env 23.5,45,101325 --oled
tools/check.py ../firmware/build/blink/flash.bin --level 01   # 레벨 기준 통과 / 실패 판정
```

인수 테스트용 펌웨어를 빌드하려면 ESP-IDF v5.5가 필요합니다(`tools/build_fw.sh`). 필요 환경: Rust(`wasm32-unknown-unknown` 포함),
Node 20+, Python 3.11+.

## 구성

```
core/       Rust 워크스페이스: rv32, xtensa, soc, esp32c3, esp32s3, esp32, elec, cli, wasm
web/        Vite + TypeScript + React + three.js 프론트엔드, 다국어는 web/src/i18n
firmware/   ESP-IDF 인수 테스트 펌웨어, examples.json, levels.json
tools/      빌드, 인수 테스트, QEMU 비교, 웹 회귀 테스트
docs/       아키텍처, 계획, 디자인, 라이선스 판단(중국어)
```

기여자와 코딩 에이전트는 **[AGENTS.md](../../AGENTS.md)**와 **[docs/I18N.md](../I18N.md)**부터 읽어 주세요.

## 감사의 말

TryBoard는 많은 오픈 프로젝트의 성과 위에 서 있습니다.

- **Espressif** — [ESP-IDF](https://github.com/espressif/esp-idf), [esp-rom-elfs](https://github.com/espressif/esp-rom-elfs),
  [esp_lcd_gc9a01](https://components.espressif.com/components/espressif/esp_lcd_gc9a01),
  [esp_lvgl_port](https://github.com/espressif/esp-bsp), 그리고 독립된 비교용 프로세스로만 사용하는
  [Espressif QEMU 포크](https://github.com/espressif/qemu)
- **RISC-V** — CPU 적합성 테스트용 [riscv-tests](https://github.com/riscv-software-src/riscv-tests)
- **그래픽과 UI** — [three.js](https://threejs.org), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh),
  [Manifold](https://github.com/elalish/manifold), [React](https://react.dev), [Radix UI](https://www.radix-ui.com),
  [Tailwind CSS](https://tailwindcss.com), [Vite](https://vite.dev), [LVGL](https://lvgl.io)
- **전기적 기준** — [ngspice](https://ngspice.sourceforge.io)
- **3D 모델** — [KiCad 라이브러리](https://gitlab.com/kicad/libraries/kicad-packages3D)(CC BY-SA 4.0)와
  [Adafruit CAD Parts](https://github.com/adafruit/Adafruit_CAD_Parts)(MIT),
  [occt-import-js](https://github.com/kovacsv/occt-import-js), [glTF-Transform](https://gltf-transform.dev),
  [meshoptimizer](https://github.com/zeux/meshoptimizer)로 변환
- **글꼴** — [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC)와
  [JetBrains Mono](https://www.jetbrains.com/lp/mono/)(SIL OFL 1.1)

파일별 출처, 저작권 표시, 라이선스 전문은 `THIRD_PARTY_NOTICES.txt`와 `/licenses` 페이지에 생성됩니다.
관련 규칙은 [docs/LICENSING.md](../LICENSING.md)에 있습니다.

## 참고

TryBoard는 독립 프로젝트이며 Espressif Systems와 제휴하거나 승인을 받지 않았습니다. "ESP32"는 시뮬레이션 대상 칩 제품군을
가리킵니다. 3D 보드는 외형 예시이며 Espressif 공식 모델이 아닙니다. Arduino로 빌드한 펌웨어와 호환됩니다.
따로 밝히지 않는 한 시뮬레이션 결과는 실제 칩으로 보정되지 않았습니다. 이 저장소의 라이선스는 아직 정해지지 않았습니다.
