# RS-2 xiaozhi 式 AI 语音场景调研

日期：2026-10-20。只调研，没有改代码。

## 1. 结论

- **能做，但要换做法：不跑原版 xiaozhi 固件，而是自己写一份「xiaozhi 协议兼容」的最小固件（路线 B）**，再配一个虚拟服务端，按脚本回放回复。原版固件有四道坎：
  1. 托管授权 ❌：它依赖 esp-sr / esp_audio_codec / esp_audio_effects，都是乐鑫修改版 MIT，LICENSING 已判不托管。
  2. 它在 S3 上必建 `AfeAudioEngine`（esp-sr），要用 PIE（EE.*）SIMD 指令；我们的 Xtensa 核遇到这些指令报非法指令（`core/crates/xtensa/src/lib.rs:5`）。
  3. 主线已要求 IDF ≥ 6.0.1，本机只有 5.5.1，模拟器也只在 5.5.1 上验过。
  4. 默认 OTA 地址是 https（api.tenclass.net），我们不做 TLS。
- 唤醒词（WakeNet）在所有路线里都不做，改成**按键说话**（BOOT → `listen` manual 模式）。
- 网络缺口集中在一处：要在 `tcp.rs` 上加 **WebSocket（ws://，80 端口，长连接，服务端主动推送）**。TLS、MQTT、UDP 都不需要。
- CPU 时间够用：Opus 复杂度 0 估计占模拟 CPU 约 30%。音频按模拟时间计时，所以 CLI 验收结果是确定的；网页 0.52× 实时只影响听感，不影响对错。

## 2. 协议摘要（来自 xiaozhi-esp32 `docs/websocket.md`、`mqtt-udp.md`、`main/ota.cc`）

**OTA / 激活**
- 请求：向 `ota_url` 发 POST（有正文时；没有就 GET），头带 `Device-Id`（MAC）、`Client-Id`（UUID）、`Activation-Version`、`User-Agent`、`Accept-Language`。
- 回复 JSON 里有这些对象：
  - `activation{code, message, challenge, timeout_ms}`
  - `websocket{…}` 或 `mqtt{…}`：固件把其中字符串 / 数字键原样存进 NVS（如 url、token）
  - `server_time{timestamp, timezone_offset}`
  - `firmware{version, url, force}`
- 激活：POST `<ota_url>/activate`，正文 `{algorithm:"hmac-sha256", serial_number, challenge, hmac}`，回 202 表示继续等，回 200 表示成功。
- 关键：**WebSocket 地址由 OTA 回复下发**，所以虚拟 HTTP 服务器可以把任何固件引到 `ws://tryboard.local/...`。

**WebSocket**
- 握手头：`Authorization: Bearer <token>`、`Protocol-Version`、`Device-Id`、`Client-Id`。
- 设备发 hello：`{"type":"hello","version":1,"features":{"mcp":true},"transport":"websocket","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}`。
- 服务端 10 s 内回 hello（`transport`、可选 `session_id`、下行 `audio_params`，常见 24 kHz；与设备输出采样率不同时设备会重采样）。
- 二进制帧：v1 是裸 Opus；v2 是 16 字节头（version / type / reserved / timestamp / size）；v3 是 4 字节头（type / reserved / size）。
- JSON 消息：
  - 设备 → 服务端：`listen{state: start|stop|detect, mode: auto|manual|realtime}`、`abort`、`mcp`（JSON-RPC 2.0；旧的 `iot` 已弃用）
  - 服务端 → 设备：`stt{text}`、`llm{emotion}`、`tts{state: start|sentence_start|stop, text}`、`mcp`、`system{command:reboot}`、`alert`

**MQTT + UDP**：MQTT 只传控制 JSON。服务端 hello 下发 `udp{server, port, key, nonce}`；UDP 包是 16 字节头（type=1、flags、len、ssrc、timestamp、sequence，网络字节序）+ AES-CTR 加密的 Opus，丢弃序号回退的包。

**参考板 bread-compact-wifi**（S3）：
- INMP441：WS4 / SCK5 / DIN6，16 kHz
- MAX98357A：DOUT7 / BCLK15 / LRCK16，24 kHz
- SSD1306 128×32/64：SDA41 / SCL42
- BOOT 键 GPIO0，LED GPIO48

这些器件我们都已建模。

## 3. 我们的缺口

| 项 | 现状（代码位置） | 要补的 |
|---|---|---|
| TCP | `soc/src/wifi/tcp.rs`：只被动打开，只听 80 端口；HTTP 一问一答后 `Connection: close`；不重传 | 长连接；服务端随时主动发段（`real_reply` 是异步注入段的先例）；窗口 / ACK 记账 |
| WebSocket | 无 | 101 升级、解码客户端掩码、组帧和分片、ping/pong、close；按脚本推 JSON 和二进制 |
| OTA 端点 | 虚拟 HTTP 只回固定内容 | `/xiaozhi/ota/` 回 websocket.url / token；`/activate` 回 200 |
| TLS（wss / https） | 无（443 端口回 RST） | 不做：固件改用 ws:// 和 http:// |
| MQTT / UDP | UDP 只有 DHCP / DNS / mDNS | 不做（以后要做就单列一项） |
| 真实网络 | 只放行 HTTP fetch | 不做：浏览器 WebSocket 不能带 Authorization 头，而且连第三方 AI 服务要人拍板 |
| PIE（EE.*） | 未实现 | 本项绕开；要跑 esp-sr / esp-dsp 得另立 PLAN 项 |
| Opus 解码（服务端侧） | 不准引入第三方 crate | 服务端不解码上行，只核对帧数、长度、TOC 字节；下行用离线预编码的 Opus |
| 网页 | `web/src/audio.ts`（喇叭用 AudioWorklet）、`micinput.ts`（浏览器麦克风 / 测试 WAV） | 语音面板：会话状态、stt / tts 字幕、脚本选择、按住说话 |

## 4. CPU 估算

- micro-opus 在 S3 上的实测（240 MHz，16 kHz，20 ms 帧，复杂度 0）：每帧约 4.1 ms，约 98 万周期。
- 换成 60 ms 帧：约 290 万周期。按我们 160 MHz、1 IPC 计算约 18 ms，即说话时占模拟时间约 30%（复杂度 5 约 60%）。
- 解码比编码便宜得多。按键说话是半双工，编码和解码不会同时跑。
- 网页满负荷是 0.52× 实时：说话段大约要 1.5–2 倍墙钟时间。实时麦克风会卡顿，所以验收和默认演示都用测试 WAV。喇叭按模拟时间出声，慢的时候会断续，可以先缓冲再播。
- 注意：我们 IPC 恒为 1、不算 cache 未命中，周期数和真机不同。所以 F-09b 第一步先在模拟器里跑 micro-opus 的 encode_benchmark，用实测数字替换这里的估算。

## 5. 路线对比

| | A 跑用户自建的原版 xiaozhi | B 自写兼容固件（推荐） | C 自定义 PCM 协议 |
|---|---|---|---|
| 做法 | 用户自己用 IDF 6 编译，把 OTA_URL 改成 http://tryboard.local；我们只提供虚拟服务端 | IDF 5.5.1 + esp_websocket_client（Apache-2.0）+ micro-opus（Apache-2.0 / 上游 libopus BSD）；SSD1306 显示字幕，BOOT 键说话；只讲 OTA、hello、listen、stt、tts、二进制 v1 这个子集 | WebSocket 直接传 16 kHz PCM，不编解码 |
| 能不能托管 | ❌（用户固件可以跑） | ✅ 附 LICENSES.txt | ✅ |
| 阻塞点 | PIE（AFE）、IDF 6、显示器驱动各式各样；C3 版不用 AFE，但仍要 IDF 6 | micro-opus 带 Xtensa DSP 优化，需确认是不是 PIE | 不兼容 xiaozhi，「像 xiaozhi」的说服力弱 |
| 工作量 | F-09a 之后再加 2–3 个会话，结果不确定 | F-09a 2 个会话 + F-09b 2–3 个会话 | 比 B 少 1 个会话 |
| 判定 | 可选附加项，不进验收 | 主线 | B 实测 Opus 太慢时的退路 |

## 6. 推荐与修订后的 brief 要点

**F-09a 虚拟服务端（S3 / C3 共用 `soc/wifi`）**
- `tcp.rs` 支持长连接和服务端主动推送：抽出 `Conn` 状态机，80 端口按 `Upgrade: websocket` 分流，复用 `real_reply` 的注入方式。
- 新文件 `wifi/ws.rs`：101 握手（SHA-1 / base64 自己写，或复用 crypto.rs）、掩码、分片、ping、close。
- 新文件 `wifi/xiaozhi.rs`：OTA / 激活回复、hello 对答，脚本「收到 listen stop 和 N 帧上行 → stt → tts start → sentence_start → 预编码 Opus 帧（按 60 ms 节奏发）→ tts stop」，下行采样率宣告 16 kHz（省掉重采样）。
- 脚本动作：`xz=on|script,<名>|say,<文本>`，空中日志 `[xz]`，网络页签加 WS 行。
- 单元测试：握手、掩码、分片、脚本时序。
- 记录写进 docs/WIFI.md 新增「阶段 7」。

**F-09b 示例固件 + 网页 + 验收**
- 第 0 步：在模拟器里跑 micro-opus encode_benchmark，拿到实测负载，同时排查 PIE；不行就换纯 C 的 libopus（BSD），或退到路线 C。
- 新增 `firmware/s3-xiaozhi-lite`（引脚照 bread-compact-wifi），通过 accept.json 加 3 个用例：
  - 正常一轮：串口有 hello、`stt`、`tts`，喇叭测得预期频率和 RMS，OLED 显示字幕
  - 服务端 10 s 不回 hello → 固件报超时并重连
  - 中途 `abort`
- 下行素材：用 opus-tools 离线把合成音或 CC0 语音编码成 Opus，只提交生成脚本和小文件；不用商用 TTS 的输出。
- 网页语音面板（新增 4 语 i18n 键），新写 `tools/webtest/xiaozhi.mjs`：导出输入后 CLI `--inputs` 重放串口逐字节一致，含 390×844，另做 agent-browser 走查。
- 选型层标注：语音链路是「行为模拟」，唤醒词和 AEC 标「必须上真机」。

## 7. 授权

- xiaozhi-esp32 本体和协议文档是 MIT：可以按文档写服务端和固件，沿用 s3-ai-dash 的先例，不复制代码。
- 原版 bin：不托管；用户上传自己编的可以跑。
- 自写固件要用的组件：
  - esp_websocket_client：Apache-2.0
  - micro-opus：注册表标 Apache-2.0，上游 Opus 是 BSD-3
  - esp_xiaozhi 组件：Apache-2.0，可选依赖 esp-sr，不用
  - 以上都要先写进 LICENSING / DECISIONS
- 社区服务端（Python / Java / Go）只看协议，不搬代码；它们的许可证本次没有核实。
- 命名用描述性写法：「兼容 xiaozhi 协议的语音助手示例」；不用 xiaozhi 作产品功能名，也不用它的图标。

## 8. 需要人拍板的点

1. 是否装 IDF 6.x（多占几 GB 磁盘，仅路线 A 需要）。
2. 是否把 PIE（EE.*）单独立项：做了能解锁 esp-sr / esp-dsp / esp-nn，是 L 级工作量。
3. 是否在网页里提供「连 xiaozhi.me 真服务」：涉及第三方账号、浏览器头限制、隐私，建议不做。
4. 示例名称，以及语音素材来源（合成音还是 CC0 录音）。

## 9. 来源

- https://github.com/78/xiaozhi-esp32 （README，MIT，服务端列表）
- https://raw.githubusercontent.com/78/xiaozhi-esp32/main/docs/websocket.md
- https://raw.githubusercontent.com/78/xiaozhi-esp32/main/docs/mqtt-udp.md
- https://raw.githubusercontent.com/78/xiaozhi-esp32/main/main/ota.cc
- https://raw.githubusercontent.com/78/xiaozhi-esp32/main/main/idf_component.yml （idf ≥ 6.0.1、esp-sr 2.4.7、esp_audio_codec）
- https://raw.githubusercontent.com/78/xiaozhi-esp32/main/main/boards/bread-compact-wifi/config.h
- https://raw.githubusercontent.com/78/xiaozhi-esp32/main/main/audio/audio_service.cc
- https://components.espressif.com/components/esphome/micro-opus/versions/0.4.1/examples/encode_benchmark
- https://components.espressif.com/components/espressif/esp_xiaozhi/versions/0.1.0/readme
- https://raw.githubusercontent.com/espressif/esp-protocols/master/components/esp_websocket_client/LICENSE
- https://deepwiki.com/78/xiaozhi-esp32/8.4-device-activation-and-server-configuration （429，没读到正文）

## 10. F-09b-0 实测（2026-10-21）

**结论：PIE 没有命中。F-09b-1 继续走路线 B，用 micro-opus 定点 + Xtensa 优化（Kconfig 默认），复杂度 0；不需要换纯 C libopus，也不需要退到路线 C。PIE 不立项。**

### 10.1 做法
- 组件：`idf.py create-project-from-example "esphome/micro-opus=0.4.1:encode_benchmark"`，IDF v5.5.1，目标 esp32s3，`CONFIG_FREERTOS_UNICORE=y`、16 MB flash、八线 PSRAM（示例自带）。工程放在 git-ignored 的 `Reviews/f09b0/`，示例源码、managed_components、构建产物都不提交。
- 原版示例（20 ms 帧、完整矩阵）跑 20 s 模拟时间；另做 60 ms 变体，只改三处：`FRAME_SIZE = sample_rate * 60 / 1000`；`SPEECH_CONFIGS` 只留 VOIP 16 kbps 复杂度 0 / 5 / 10 和 AUDIO 16 kbps 复杂度 0 / 5；音乐循环关掉（`i < 0`）。输入是示例自带的 30 s 语音（LibriVox 公有领域，SILK 16 kHz），每组 500 帧。
- 三个构建：fx = 定点 + `OPUS_ENABLE_XTENSA_OPTIMIZATIONS=y`（示例默认）；fxnox = 定点 + 关 Xtensa 优化；fl = 浮点（`OPUS_FLOATING_POINT=y`，micro-opus 在 S3 上的默认值）+ Xtensa 优化。
- 运行：`tryboard run flash.bin --seconds 150 --expect "All encodes successful"`。帧耗时取 benchmark 自己用 esp_timer 测的值；esp_timer 走模拟时间，所以周期 = µs × 160（模拟器 `CPU_HZ` 固定 160 MHz，见 `soc/periph.rs:4`，固件里设的 240 MHz 不起作用）。

### 10.2 PIE（EE.*）
- 静态：`xtensa-esp32s3-elf-objdump -d` micro-opus 的 `.a`，四个构建里 EE.* 都是 0。用到的是 MAC16（fx 96 条：`mula.aa.ll`、`mula.dd.*.ldinc` 等，核心已实现，见 `xtensa/src/mac16.rs`）、MULSH、CLAMPS 和 FPU。对整个 app.elf 做 objdump 会数出约 1300 条「ee.*」，全是假的：Xtensa 的 literal 池和对齐填充在可执行段里，被线性反汇编当成指令（例如 `opus_encoder_ctl` 里紧跟 `call8` / `j` 的位置，旁边还有跳到不可能地址的 `l32r`）。
- 动态：四次运行共编码约 1 万帧（原版 20 ms 4500+，fx 2500，fxnox 2500，fl 1000）（20 ms 和 60 ms、复杂度 0 / 5 / 10、VOIP 和 AUDIO 模式；同时也跑了 Ogg/SILK 解码），没有 IllegalInstruction、没有 EXCCAUSE 0，四次都输出「All encodes successful: YES」。
- 没覆盖到：CELT 解码（输入是 SILK）、48 kHz 音乐配置。xiaozhi 下行是 16 kHz 语音，F-09b-1 的验收会跑到解码路径，到时候再确认。

### 10.3 每帧周期（16 kHz 单声道，60 ms 帧 = 960 样本，16 kbps）

| 构建 | 模式 | 复杂度 | 平均 µs / 帧 | 周期 / 帧 | 占模拟时间 |
|---|---|---|---|---|---|
| fx 定点 + Xtensa | VOIP | 0 | 11 028 | 1.76 M | 18.4 % |
| fx | VOIP | 5 | 28 017 | 4.48 M | 46.7 % |
| fx | VOIP | 10 | 42 913 | 6.87 M | 71.5 % |
| fx | AUDIO | 0 / 5 | 10 869 / 27 945 | 1.74 M / 4.47 M | 18.1 % / 46.6 % |
| fxnox 定点、关 Xtensa 优化 | VOIP | 0 / 5 / 10 | 13 252 / 34 819 / 56 398 | 2.12 M / 5.57 M / 9.02 M | 22 % / 58 % / 94 % |
| fl 浮点 + Xtensa | VOIP / AUDIO | 0 | 85 359 / 85 248 | 13.7 M | 142 %（跑不过实时，benchmark 自动跳过更高复杂度） |

- 原版 20 ms 帧（fx 同配置）：复杂度 0、10 kbps 2 242 µs ≈ 36 万周期；16 kbps 3 696 µs ≈ 59 万周期。
- 和 §4 的估算比：复杂度 0 是 1.76 M 周期 / 帧，比估的 2.9 M 低，占模拟时间 18 % 而不是 30 %；复杂度 5 约 47 %（估 60 %）。
- 浮点慢 7.7 倍，和 micro-opus README 的说法一致（「SILK 浮点编码比定点慢 4–6 倍，最低复杂度也跑不过实时」），说明不是模拟器的问题。另外浮点构建在示例默认的 16 000 字节主任务栈下会报「stack overflow in task main」并重启循环，栈改成 48 000 才跑通；没有用 QEMU 对照，暂时记作固件侧现象。**F-09b-1 必须显式写 `CONFIG_OPUS_FLOATING_POINT=n`**，因为 S3 上的默认值是浮点。
- 必须注明：模拟器 IPC 恒为 1、不算 cache 未命中和 PSRAM 延迟，CPU 频率固定 160 MHz，所以上面的周期数和真机（240 MHz、有 cache 停顿）不同，只能用来估模拟负载，不能当真机性能结论。

### 10.4 实时倍率
- 原生 CLI：原版示例单独跑，CPU 满负荷，20 s 模拟时间用了 23.5 s 墙钟，约 0.85×。三个变体并行跑（同一台 10 核机器，还开了 `--trace-tasks`）时是 0.60–0.79×，有互相干扰，不作数。
- 网页按 §4 的经验（约为 CLI 的 0.5×）估约 0.43×。
- `--trace-tasks`：编码期间 main 任务占 100 %（benchmark 不睡），IDLE 0 %。真实固件只在说话时编码，复杂度 0 时编码只占模拟时间约 18 %；如果空闲时间能快进，说话段的墙钟开销主要就是这 18 %（未单独测）。§4 的结论不变：验收和默认演示用测试 WAV，不用实时麦克风。
- 运行报告「unmodeled registers」共 97 个，最多的是 `0x600030c0` / `0x600030c4`（各 36 次）、`0x60008040`（24 次）、`0x60003008`、`0x600080dc`（各 22 次），都是启动阶段的 SPI0 和 RTC_CNTL 访问，和编码无关。

### 10.5 对 F-09b-1 的建议
- 用 micro-opus 0.4.1：`CONFIG_OPUS_FLOATING_POINT=n`、`CONFIG_OPUS_ENABLE_XTENSA_OPTIMIZATIONS=y`、编码复杂度 0（下行解码只是 SILK，比编码便宜）。复杂度 5 也能实时（占 47 %），但网页里墙钟开销翻倍多，不值得。
- 纯 C libopus 不需要：关掉 Xtensa 优化也只慢约 20 %，而且同样没有 PIE。路线 C 不需要。
- PIE（EE.*）不因 xiaozhi 立项；只有以后要跑 esp-sr / esp-dsp / esp-nn 时再议。
- 组件进仓库前，要先在 `docs/LICENSING.md` 加 micro-opus 一行（目前没有），并写 DECISIONS。

### 10.6 附录：版本和许可证（从组件包核对）
- esphome/micro-opus 0.4.1（`idf_component.yml`: `license: Apache-2.0`，url https://github.com/esphome-libs/micro-opus；dependencies.lock component_hash `c4cec51b6e45…`），根目录 `LICENSE` 是 Apache-2.0。
- 内含 `lib/opus`：`COPYING` 是 Xiph.Org 等的 BSD-3 条款，另有 `LICENSE_PLEASE_READ.txt`（IETF 贡献者 BSD 声明和专利许可指引）。
- 内含 `lib/micro-ogg-demuxer`：Apache-2.0。
- 示例测试音频：语音是 LibriVox《孙子兵法》第 1–2 章（Moira Fogarty 朗读，公有领域）；音乐是 Musopen 的贝多芬第三交响曲片段（公有领域）。都只在本地用，不提交。
