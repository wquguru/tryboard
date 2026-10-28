# F-05 找故障挑战关卡

EVAL §4 O5：给玩家一个「有故障的台面」，找出原因并修好（改线、改参数或换固件）；网页判过、`tools/check.py` 判过、指纹一致。

## 1. 关卡格式

关卡照旧写在 `firmware/levels.json`，多一个 `fault` 字段：

```jsonc
{
  "id": "fault-wire", "work": "faults", "ref": "weather",   // ref = 台面上原来那份固件（不是答案）
  "args": [...],                                             // 台面的共同部分（器件、环境）
  "fault": {
    "args": ["--i2c-wire", "60"],      // 拿到手时的台面（叠加在 args 上，同名开关替换）
    "fix": ["--i2c-wire", "20"],       // 参考修法之一：改台面（可省）
    "fix_ref": "s3-adc1-wifi",         // 参考修法之一：换固件（可省）
    "knobs": [{ "flag": "--i2c-wire", "name": "...", "options": [{ "v": "60", "label": "..." }, ...] }]
  },
  "numeric": [...]                     // 判定条件和普通关卡一样
}
```

- 判定只看（固件、台面开关）两样，不管玩家用哪种修法：改线、换电源、换固件都行。
- `knobs` 列出玩家能改的台面开关，每个开关对应一个 CLI 参数；网页关卡面板给同样的选项。
- 叠加规则（check.py `merge_args` 与 web/src/faults.ts `mergeArgs` 一致）：overlay 里的开关替换 base 里同名开关的值，没有的追加在后面。玩家给的开关再替换一次。

## 2. 判定方式

| 场景 | 命令 | 期望 |
|---|---|---|
| 参考自检（`--ref --all` 的一部分） | `tools/check.py --ref --level fault-wire` | 跑两遍：「拿到手」（ref + fault.args）必须 FAIL，「修好」（ref + fix，或 fix_ref + fault.args）必须 PASS；两样都对才算这关通过 |
| 玩家改台面 | `tools/check.py --ref --level fault-wire --i2c-wire 20` | 用台面原固件 + 玩家的开关跑一遍 |
| 玩家换固件 | `tools/check.py app.bin --level fault-wire` | 玩家固件 + 拿到手的台面（可再加开关） |

网页：检查点面板里选开关（默认是「拿到手」的值），点「用台面上的固件运行」或拖入自己的 .bin，跑的就是同一组参数；面板下方的命令行带着当前开关。指纹规则不变（串口 + 标准报告），所以网页和 CLI 同一组输入指纹一致；`tools/webtest/faults.mjs` 逐关逐组对照。

## 3. 关卡

| id | 现象（玩家看到的） | 原因 | 修法 | 判定条件 | 用到的开关 |
|---|---|---|---|---|---|
| fault-wire | 气象站屏幕亮着，但温度读成 11.83 ℃、湿度 4.3 %（实际 23.5 ℃ / 45 %），没有报错 | I2C 线总长 60 cm，400 kHz 下上升沿 381 ns > 300 ns，读回字节里 0→1 的位丢了（估算模型 `elec::i2cbus`） | 线缩到 ≤ 40 cm（`max_wire_cm(2, 400k)` = 40.81）；或固件把 I2C 降到 100 kHz（上限 1000 ns） | 温度 / 湿度 / 气压读数在 ±0.02 ℃ / ±0.1 % / ±0.02 hPa 内 | `--i2c-wire` |
| fault-power | 舵机一动板子就重启，串口反复出现 `rst:0xf (BROWNOUT_RST)` | 舵机从 USB 5 V 取电，启动电流把 5 V 拉到约 1 V，3V3 掉到欠压阈值 2.44 V 以下 | 舵机改由外接 5 V 供电（`--power ext`） | 第一次上电就扫完 11 次：串口出现 `TRYBOARD_OK s3-brownout (boot 1)` | `--power`（`--servo 4` 固定在 args） |
| fault-antenna | 连 Wi-Fi 一直失败，`断开 reason=2`，拿不到 IP | 金属板压在 WROOM 天线区，约 45 dB 衰减，信号 −87 dBm 低于连接门限 −82 dBm | 移开金属（或换塑料板），衰减 0 dB | 串口出现 `拿到 IP` 和 `TRYBOARD_OK wifi-connect` | `--antenna-loss` |
| fault-adc | 旋钮读数在 Wi-Fi 启动前正常（raw ≈ 1447），启动后读取失败 `ESP_ERR_TIMEOUT` | S3 的 ADC2 被 Wi-Fi 占用（GPIO11 = ADC2 ch0） | 换固件：改用 ADC1 引脚（GPIO4 = ADC1 ch3，台面已把同一路电压接到 GPIO4），参考 `s3-adc1-wifi` | Wi-Fi 启动后读数 raw 在 1440 ± 60 内 | 无（只能改固件） |

拿到手时 4 关的参考结果都 FAIL，修好后都 PASS（`check.py --ref --all` 两遍都跑）。

## 4. 没做的候选及原因

- **上拉电阻缺失**：要在 `soc/i2c.rs` 的总线负载里加上拉阻值覆盖；该文件正由 M5 会话改动，本条目不碰。电气模型（`elec::i2cbus::pullup_ohm`）已有「无模块上拉只剩内部 45 kΩ」的分支，以后加 `--i2c-pullup` 开关即可做成一关。
- **引脚接错**：内核不知道 `--i2c` 器件接在哪个 GPIO（SDA / SCL 固定由关卡文字约定），接线错误只能由网页接线检查（wirecheck）发现，做不到 CLI 一致。
- **欠压**不需要新开关：`--servo 4 --power usb` 已经能复现（P1-02 的 `s3-brownout`）。
