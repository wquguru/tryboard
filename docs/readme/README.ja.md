<div align="center">

<img src="../logo.svg" width="72" alt="TryBoard">

# TryBoard

**ボードを買う前に、本物の ESP32 ファームウェアをブラウザで動かす。**

[English](../../README.md) · [简体中文](README.zh-CN.md) · 日本語 · [한국어](README.ko.md)

[![Rust](https://img.shields.io/badge/core-Rust%20→%20wasm-b7410e?style=flat-square&logo=rust&logoColor=white)](../../core)
[![Chips](https://img.shields.io/badge/chips-ESP32--C3%20·%20S3%20·%20ESP32-0b76c8?style=flat-square)](../STATUS.md)
[![ESP-IDF](https://img.shields.io/badge/ESP--IDF-v5.5-e7352c?style=flat-square)](https://github.com/espressif/esp-idf)
[![three.js](https://img.shields.io/badge/3D-three.js-000?style=flat-square&logo=threedotjs&logoColor=white)](https://threejs.org)
[![Languages](https://img.shields.io/badge/UI-en%20·%20zh%20·%20ja%20·%20ko-0aa06e?style=flat-square)](../I18N.md)

</div>

---

TryBoard は 3D ワークベンチ付きの命令レベル ESP32 シミュレータです。ESP-IDF や Arduino がビルドした `flash.bin` を
読み込み、ブレッドボードに部品を配線すると、同じバイナリが LED を点滅させ、サーボを回し、ディスプレイに描画し、
Wi-Fi や BLE で通信します。しかも**決定的**に動くので、同じファームウェアは毎回同じ結果になり、テストのように検証できます。

AI でファームウェアを書く人のためのツールです。サイトがタスク指示書と合格条件を示し、AI がコードを書き、
TryBoard が動くかどうか、どのチップと部品を買うべきか、実機でしか確認できないリスクは何かを教えてくれます。

## 3 つのレイヤー

**コア — 本物のバイナリを実行。** Rust でゼロから書いた RV32IMC / Xtensa LX6・LX7 エミュレータを wasm にコンパイル。
無改造の ESP-IDF イメージを純正マスク ROM と組み合わせて起動し、FreeRTOS スケジューリング、S3 デュアルコア、PSRAM に対応。
周辺機能モデルは QEMU や ESP-IDF のテスト出力と突き合わせて検証しています。

**ワールド — センサーはシーンを読む。** three.js のワークベンチ（WebGPU 優先、WebGL2 にフォールバック）に、ボード、
ブレッドボード、部品、部屋があります。超音波センサーはレイを飛ばし、IMU は物理演算を読み、ディスプレイはフレームバッファを
表示し、ブザーは Web Audio で鳴り、仮想スマホが BLE ペリフェラルをスキャン・接続・購読します。

**判断 — 何を買うか。** 選定アシスタントがプロジェクトをチップ、ボード、BOM、ピン配置、消費電力見積もりに落とし込みます。
すべての結論に信頼度ラベルが付きます。

| ラベル | 意味 |
|---|---|
| シミュレーション検証 | 本物のファームウェアが命令レベルのコアで動作し、周辺機能モデルに受け入れテストがある |
| 振る舞いモデル | 外部世界を振る舞いレベルでモデル化（仮想スマホ、仮想 Wi-Fi ネットワーク） |
| 見積もり | 消費電力、タイミング余裕、配線損失をデータシートと較正モデルから算出 |
| 実機が必要 | 無線の到達距離、アンテナ、アナログノイズ、厳密なタイミング — 実機で確認 |

## 現在動くもの

| 項目 | ESP32-C3 | ESP32-S3 | ESP32 |
|---|---|---|---|
| CPU、割り込み、タイマー、FreeRTOS | ✅ RV32IMC | ✅ LX7 デュアルコア、PSRAM | ✅ LX6 デュアルコア |
| GPIO、UART、LEDC（PWM） | ✅ | ✅ | ✅ |
| I2C と仮想 SSD1306 / BME280 | ✅ | ✅（MPU6050、QMI8658、タッチパネルも） | ✅ |
| ADC、RMT（WS2812、超音波）、SPI LCD、I2S | ✅ | ✅（PCNT エンコーダも） | — |
| USB HID キーボード / CDC | — | ✅ | — |
| Wi-Fi（オープン、WPA2-PSK、HTTP） | ✅ | ✅ | 初期化のみ |
| BLE ペリフェラル（NimBLE）+ 仮想スマホ | ◐ 振る舞いモデル | — | — |

受け入れテストの根拠を含む完全な表は **[docs/STATUS.md](../STATUS.md)**（中国語）にあります。<!-- stats:accept -->172<!-- /stats --> 件の受け入れテスト、
<!-- stats:examples -->52<!-- /stats --> 個のサンプル、7 段階の学習コースを毎回実行しています（`tools/accept.sh`）。

## クイックスタート

```bash
tools/fetch_third_party.sh          # ROM ELF（Apache-2.0）と riscv-tests を third_party/ に取得
tools/build_web.sh                  # wasm コア + Web アセット
cd web && npm install && npm run dev   # http://localhost:5180
```

コマンドラインで部品をつないでファームウェアを実行：

```bash
cd core
cargo run -p tryboard-cli --release -- run ../firmware/build/blink/flash.bin
cargo run -p tryboard-cli --release -- run ../firmware/build/weather/flash.bin \
  --i2c ssd1306@0x3c,bme280@0x76 --env 23.5,45,101325 --oled
tools/check.py ../firmware/build/blink/flash.bin --level 01   # レベルに対する合否判定
```

受け入れ用ファームウェアのビルドには ESP-IDF v5.5 が必要です（`tools/build_fw.sh`）。必要環境：Rust（`wasm32-unknown-unknown`
を含む）、Node 20+、Python 3.11+。

## 構成

```
core/       Rust ワークスペース：rv32、xtensa、soc、esp32c3、esp32s3、esp32、elec、cli、wasm
web/        Vite + TypeScript + React + three.js のフロントエンド。多言語化は web/src/i18n
firmware/   ESP-IDF 受け入れ用ファームウェア、examples.json、levels.json
tools/      ビルド、受け入れテスト、QEMU 比較、Web 回帰テスト
docs/       アーキテクチャ、計画、デザイン、ライセンス判断（中国語）
```

コントリビューターとコーディングエージェントは **[AGENTS.md](../../AGENTS.md)** と **[docs/I18N.md](../I18N.md)** から読んでください。

## 謝辞

TryBoard は多くのオープンプロジェクトの成果の上に成り立っています。

- **Espressif** — [ESP-IDF](https://github.com/espressif/esp-idf)、[esp-rom-elfs](https://github.com/espressif/esp-rom-elfs)、
  [esp_lcd_gc9a01](https://components.espressif.com/components/espressif/esp_lcd_gc9a01)、
  [esp_lvgl_port](https://github.com/espressif/esp-bsp)、そして独立した比較用プロセスとしてのみ使う
  [Espressif 版 QEMU](https://github.com/espressif/qemu)
- **RISC-V** — CPU 適合性テストの [riscv-tests](https://github.com/riscv-software-src/riscv-tests)
- **グラフィックスと UI** — [three.js](https://threejs.org)、[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)、
  [Manifold](https://github.com/elalish/manifold)、[React](https://react.dev)、[Radix UI](https://www.radix-ui.com)、
  [Tailwind CSS](https://tailwindcss.com)、[Vite](https://vite.dev)、[LVGL](https://lvgl.io)
- **電気的リファレンス** — [ngspice](https://ngspice.sourceforge.io)
- **3D モデル** — [KiCad ライブラリ](https://gitlab.com/kicad/libraries/kicad-packages3D)（CC BY-SA 4.0）と
  [Adafruit CAD Parts](https://github.com/adafruit/Adafruit_CAD_Parts)（MIT）。
  [occt-import-js](https://github.com/kovacsv/occt-import-js)、[glTF-Transform](https://gltf-transform.dev)、
  [meshoptimizer](https://github.com/zeux/meshoptimizer) で変換
- **フォント** — [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC) と
  [JetBrains Mono](https://www.jetbrains.com/lp/mono/)（SIL OFL 1.1）

ファイルごとの出典、著作権表示、ライセンス全文は `THIRD_PARTY_NOTICES.txt` と `/licenses` ページに生成されます。
その方針は [docs/LICENSING.md](../LICENSING.md) にあります。

## 注意事項

TryBoard は独立したプロジェクトであり、Espressif Systems とは提携しておらず、承認も受けていません。「ESP32」はシミュレート対象の
チップファミリーを指します。3D ボードはイメージであり、Espressif の公式モデルではありません。Arduino でビルドしたファームウェアに
対応しています。特記がない限り、シミュレーション結果は実機で較正されていません。このリポジトリのライセンスはまだ決まっていません。
