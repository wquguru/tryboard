# tryboard（本地包，尚未发布）

试板 TryBoard 的命令行：wasm 内核 + 乐鑫 ROM + 关卡定义打成一个 npm 包，不装 Rust / Python 就能在本机验收固件。
判定规则、输出格式、运行指纹、退出码与仓库里的 `tools/check.py` 一致。

```
npx ./tryboard-0.1.0.tgz check app.bin --level 04
npx ./tryboard-0.1.0.tgz run flash.bin --seconds 3 --i2c ssd1306@0x3c,bme280@0x76 --env 23.5,45,101325
```

在仓库里构建：`tools/build_npm.sh`（产物 `packages/tryboard/tryboard-0.1.0.tgz`）。

## 第三方
- `rom/*.elf`：来自 https://github.com/espressif/esp-rom-elfs ，Apache License 2.0，见 `LICENSE-esp-rom-elfs.txt` 与 `NOTICE.txt`。
