# tools/audio 声音素材来源

| 文件 | 来源 | 许可 |
|---|---|---|
| sine1k.wav | `gen_wav.py` 合成：1000 Hz 正弦，幅度 0.5，48 kHz 16 位单声道，1 秒 | 本项目自有（无第三方素材） |
| sweep.wav | `gen_wav.py` 合成：200 → 2000 Hz 指数扫频，幅度 0.5，48 kHz 16 位单声道，2 秒 | 本项目自有（无第三方素材） |
| saw50.wav | `gen_wav.py` 合成：50 Hz 上升锯齿波，-0.5 → 0.5，48 kHz 16 位单声道，1 秒（样本顺序检查，G-12） | 本项目自有（无第三方素材） |
| xz_mic.wav | `gen_xz_voice.py` 共振峰合成的「用户」语音（基频 130 → 110 Hz，四个元音音节），16 kHz 16 位单声道，1.5 秒，RMS 0.15 | 本项目自有（无第三方素材） |
| core/crates/soc/src/wifi/xz_voice.bin | `gen_xz_voice.py` 共振峰合成的「助手」语音（基频 230 → 190 Hz，1.2 秒），用 micro-opus 自带 libopus 编出的 `opus_demo` 编成 20 个 16 kHz 60 ms Opus 包（每包前加 u16 小端长度） | 本项目自有；编码器 libopus BSD-3（LICENSING 的 micro-opus 行） |

验收（`firmware/accept.json` 的 s3-i2s-mic）和网页麦克风示例都只用前两段（s3-xiaozhi-lite 的三个用例用 xz_mic.wav 和 xz_voice.bin）；改了生成参数要同时改验收期望值。
