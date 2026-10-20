# F 专项：留存与传播（2026-10-20 起）

起因：2026-10-20 平台评估总分 3.0 / 5，内核约 L4、外壳约 L2。用户做出的东西存不下、传不出去，也跑不了我们以外的固件。本专项目标：把总分推到约 3.5（预估），重点补"留作品 → 传出去"两步，再拓宽固件和场景。

| 文件 | 内容 |
|---|---|
| `EVAL.md` | 评估：13 维 × L1–L5 分级、证据、用户旅程、优化项 O1–O14、session 拆分与并行波次 |
| `DISPATCH.md` | 派单手册：怎么建子代理 session、先后约束（依赖图、资源上限、冲突规则）、每个 F 项的完整提示词、每波收尾步骤 |
| `research/RS-*.md` | 波 0 深度调研，每个问题一个文件 |
| 画布 | https://claude.ai/artifact/GEvggYdYqbSXkNupMWv4MW |

## 状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 评估 | ☑ | `EVAL.md` |
| 波 0 调研 RS-1 … RS-6 | ☑ | 2026-10-20 完成，六份报告在 `research/` |
| 调研汇总 → 改写波次计划 | ☑ | `EVAL.md` §5.2–5.4 已修订：约 28 个实现 session、5 波 |
| F 批写入 PLAN.md、开工实现 | ◐ | 2026-10-20 人确认开工；波 1 ☑（`Reviews/batch-F1.md`）；波 2 ☑（`Reviews/batch-F2.md`）；F-04b 的阻塞（M5-01）已解除，待人定是否进波 3 |
| 波 2 F-01b `.tryboard` 文件 | ☑ | 2026-10-20 ⋯「下载 .tryboard 文件」+ 换固件 / 拖到页面打开；自带 bin 带 sha256 校验；share.mjs 17/17；`Reviews/ab/F-01b.md` |
| 波 2 F-02 分享卡 | ☑ | 2026-10-20 自写 QR（v1–40、ECC M）+ 1080×1350 卡片，MP4 优先、退 webm，另出 PNG；修 Safari 录屏扩展名；sharecard.mjs 15/15；`Reviews/ab/F-02.md` |
| 波 2 F-03 嵌入页 | ☑ | 2026-10-20 `/embed?s=` 点击加载、不写 localStorage；embed.mjs 19/19；`_headers` 的 frame-ancestors 需部署后验证；F-03b 原速回放未做；`Reviews/ab/F-03.md` |
| 波 2 F-04a 器件上台面（第 1 部分） | ◐ | 2026-10-20 DS18B20 / PIR / 光敏 / 继电器 / RC522 上网页（3D、接线、手机、输入日志）+ 3 个示例，parts.mjs 18/18；第 2 部分（ILI9341 / SH1106 等显示屏）等 F-04b |
| 波 2 F-07a UART + MicroPython | ☑ | 2026-10-20 UART RX 超过一个 FIFO、`\xNN` 串口转义、`mpy-c3-rawpaste` 用例（bin 由 `fetch_third_party.sh --micropython` 可选下载，缺失则跳过） |

## 调研结论汇总

**RS-1 MicroPython**（`research/RS-1-micropython.md`）
- 官方 v1.29.0 C3 版不改内核就能跑：REPL、raw REPL 写 main.py、Ctrl-C、复位后保留都正常。S3 只有 SPIRAM_OCT 版能起，原生约 0.92× 实时，浏览器里会低于实时 → O7 先做 C3。
- 发现内核 bug：UART 一次收超过 127 字节卡住（`soc/src/periph.rs:48/61`），F-07a 先修。
- 计划改动：F-07a 1 个 session，F-07b 1–2 个；刷新后重发 main.py，暂不做 littlefs 镜像。
- 需人拍板：二进制怎么给（推荐只链接 micropython.org，让用户自己上传）；PRODUCT.md 定位能否扩到"在这里改代码"；S3 是否只支持 OCT 版。官方 bin 含 BSD-4 等多种许可证且无 SBOM。

**RS-2 xiaozhi**（`research/RS-2-xiaozhi.md`）
- 原版固件跑不了：esp-sr / esp_audio_codec 在 LICENSING 是 ❌，用到 S3 SIMD（未实现），要 IDF ≥ 6.0.1，默认 HTTPS。
- 走路线 B：自写协议兼容固件（IDF 5.5.1 + esp_websocket_client + micro-opus + SSD1306），BOOT 键按住说话，不做唤醒词；虚拟服务端回放预编码 Opus。
- 计划改动：F-09a 2 个 session（长连接 TCP + WebSocket + 脚本服务端），F-09b 2–3 个；第 0 步先测 micro-opus 会不会用到 SIMD。
- 需人拍板：是否装 IDF 6；S3 SIMD 是否单列；是否连真 xiaozhi.me（推荐否）；示例名和语音素材来源。

**RS-3 兴趣数据**（`research/RS-3-interest.md`）
- 经典 ESP32 统治教程榜（CYD + ILI9341 居首），C3 Super Mini 是 C3 第一；C6 无量化证据。
- 计划改动：O10 保持 P1 并提前（F-10a SPI 移到波 2）；O4 重排为 ILI9341/ST7789、DS18B20、SH1106、PIR/LDR/继电器、RC522，AHT20/INA219/DS3231 降为 P1 的 F-04e；O8 先做 MIT/BSD 库，GPL 音频库不进；O14 保持 P2。
- 需人核：TFT_eSPI、ESP32Servo、OneWire、IRremote 许可证不明。

**RS-4 分享与嵌入**（`research/RS-4-share.md`）
- 状态 v1 走 `?s=`（deflate-raw + base64url），典型作品 312–588 字符；≤ 2k 进链接，2–8k 进链接但二维码不带运行记录，> 8k 或自带 bin 用 `.tryboard`。
- 分享卡用浏览器自带 MediaRecorder 录 MP4 + 自写二维码，零新依赖；嵌入用独立 `embed.html`，不需要 COOP/COEP。
- 计划改动：F-01 拆成 F-01a（URL）+ F-01b（`.tryboard`）；新增 F-03b 实时回放；顺手修 Safari 录屏扩展名 bug（`capture.ts:104-116`）。
- 复现缺口：实时麦克风输入不进日志；运行中改线不会重启仿真。

**RS-5 BLE 多 IDF**（`research/RS-5-ble-idf.md`）
- 现在"支持 IDF 5.1–5.5.1"实际只覆盖 5 个 bt-lib commit；5.1.0–5.1.5、5.2.0–5.2.3、5.3.0–5.3.1 和 Arduino 3.0.x 不匹配；Arduino 3.1.0–3.3.5 已覆盖。
- 除签名外还要放宽 osi 表版本检查到 0x10006–0x1000A，并在旧版本跳过 `pll_track`；F-08c 约 1–1.5 个 session，不需要装其他 IDF。
- 需人拍板：真机级验证要装 arduino-cli core 3.0.7（约 2–3 GB）；签名算不算衍生作品需人核。另：经典 ESP32 的 BLE 完全没覆盖，可能更重要。

**RS-6 画廊与 HIL**（`research/RS-6-gallery-hil.md`）
- 画廊分阶段：S0 作品进 URL + 仓库里的精选 JSON；S1 Cloudflare Pages + GitHub Issues 投稿；S2 Worker + R2 等有需求再上；始终不做账号。微信不认 og:image，动态 OG 收益下调。
- HIL：先买 C3 + S3 N16R8 + 逻辑分析仪 + 几个外设，约 ¥150–250（价格未核实）；`tools/hil/` runner 3–4 个 session。
- 需人拍板：报告末尾 10 项清单（上线、域名、备案、公开仓库、收用户 bin、账号、微信卡片、OG 依赖、采购、谁来实测）。

## 下一步要人决定的

1. ~~是否开工 F 批~~：2026-10-20 已确认，波 1、波 2 完成。F-04b 是否进下一波（M5-01 已合并）。
2. MicroPython 二进制分发方式和定位扩展（RS-1）。
3. xiaozhi 四项（RS-2）。
4. 四个 Arduino 库的许可证（RS-3）、BLE 签名的衍生作品问题（RS-5）。
5. RS-6 的 10 项清单，其中上线和采购按 §10 必须人定。
