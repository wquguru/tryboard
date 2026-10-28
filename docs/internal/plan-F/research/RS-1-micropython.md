# RS-1 MicroPython 可行性（2026-10-20）

## 结论
**能，C3 现在就能跑。** 官方 v1.29.0 固件（IDF v5.5.2）不改 core 一行代码：C3 启动 → 首次格式化 littlefs → REPL 可交互；raw REPL 写 main.py → 软复位运行 → Ctrl-C 打断 → `machine.reset()` 后 main.py 仍在。S3 只有 **SPIRAM_OCT 变体**能跑（REPL 在 UART0 和 USB CDC 上都通）；通用 S3 构建（四线 PSRAM）在 0.137 s 内重启了 51 次。
- O7 选 **C3**：负载下原生约 4× 实时，S3 约 0.92× 实时，网页里 S3 会低于实时。
- 唯一要先修的 core 问题：UART 一次收到超过 127 字节就会卡住（见证据 4），F-07b 依赖这个修复。
- USB-Serial-JTAG 的 🟡 不挡路：MicroPython 同时往 UART0 输出，REPL 读写都走 UART0。

## 证据（固件只放在 /private/tmp/claude-501/rs1，没进仓库）
命令统一为 `target/release/tryboard run <bin> --seconds N [--uart-in|--script]`，日志写到 `rs1/*.out`。
1. **镜像**：三个 .bin 都是合并镜像，从 0x0 烧（magic 0xe9，头部字节 0x2f 表示 4 MB）。分区表只有 nvs / phy_init / factory(0x10000, 0x1f0000)，**没有 vfs 分区**：固件运行时把 0x200000–0x400000 注册成 vfs（littlefs2）。C3 的 boot.rs:167 会把 flash 补齐到 4 MB，所以这段地址能用。
2. **C3 REPL**：输出 `MicroPython v1.29.0 … ESP32C3`，`print(sum(range(100)))` → `4950`，`os.statvfs("/")` → 4096×512（2 MB）。`machine.freq()` = 160000000。模拟 5 s 用了墙钟 0.063 s（空闲时快进）。
3. **main.py 流程**（`--script` 分块发送）：`\x01` → `raw REPL; CTRL-B to exit` → 用 f.write 写入 → `\x04` 回 `OK` → `\x02\x04` → `MPY: soft reboot` → `tick 0 1617 / tick 1 1817 / tick 2 2017`（sleep_ms(200) 的间隔准确）。死循环里的 main.py 收到 `\x03` 后打印 `KeyboardInterrupt`；`machine.reset()` 后打印 `rst:0xc (RTC_SW_CPU_RST)`，main.py 照常运行，说明 flash 内容在复位后保留。
4. **UART 卡死**：一次 `--uart-in` 发 194 字节，只回显约 127 个字符，之后再无输出。怀疑的原因：`core/crates/soc/src/periph.rs:48` 的 STATUS 把计数上限截在 127，`:61` 的 INT_CLR 无条件清掉 RXFIFO_TOUT，`rx` 里还剩字节也不会重新置位，要等下一次 `push_rx`（`:74`）。另外，在 `--script` 和 `--uart-in` 里 `\n` 会被替换成换行（`main.rs:221/594`），Python 字符串里要换行只能用 `chr(10)`。
5. **raw-paste 握手**：`\x01` 之后发 `\x05A\x01`，回 `R\x01` 加窗口大小 `0x0080`（128 字节），说明设备端支持流控。但 128 字节的窗口仍然大于 127 的上限，所以必须先修第 4 条。
6. **S3**：通用版打印 `E esp_psram: External RAM could not be added to heap!` 后 abort，重启循环。SPIRAM_OCT 版 `gc.mem_free()` = 8315136；`--script '2.0:usbcdc=print(6*7)\n' --usb-log` 能枚举出 303a:4001 CDC-ACM，`USB serial received: "print(6*7)\r\n42\r\n>>> "`。
7. **速度**（解释器跑 `for i in range(100000): x+=i`）：C3 用了模拟时间 794 ms，模拟 4 s 花墙钟 0.92 s；S3 用了 760 ms，模拟 4 s 花墙钟 4.33 s。**未经真机标定**。
8. **未建模寄存器**：C3 访问最多的是 0x600c0028（760 次）和 0x60043014（500 次，USJ 中断清除轮询，无害）。S3 的 0x60008040（RTC_CNTL）被访问了 71336 次，可能是读 RTC 时间的忙等，值得排查。

## 推荐路线
- **(a) 启动到 REPL**：网页已经支持上传自己的 .bin（`web/src/app/main.tsx:336`），串口面板也有输入框（`app/dock.tsx:257-268` → `main.tsx:277` → `live.ts:397` → `worker.ts:681-700` → `tb_uart_push` `wasm/src/lib.rs:264`）。所以用户现在上传 C3 固件就能用 REPL，**不需要我们托管二进制**。还缺：Ctrl-C / Ctrl-D 按键（输入框只能整行提交）。
- **(b) 编辑 main.py 再重跑**：用 **raw-paste 模式**（实现不了时退回 raw REPL）经虚拟 UART 写文件，相当于在 worker 里做一个精简的 mpremote。每一步都按提示符判断（`>>> `、`raw REPL`、`R\x01`、`OK`、`\x04>`），**不要用固定延时**。流程：Ctrl-C ×2 → `\x01` → raw-paste 写文件 → `\x02` → `\x04` 软复位。
  - 页面刷新后要保持文件：把 main.py 文本存到本地，每次启动后重新注入。现在没有 `tb_flash_*` 导出，读不回 flash。
  - 预置文件也走同一流程。
  - 在 TS 里直接生成 littlefs2 镜像：没验证过，还要引入新依赖（littlefs 是 BSD-3，需先记进 DECISIONS），**不推荐**作为第一步。
- **对比**：raw REPL / raw-paste 不需要文件系统工具，能用于任何 MicroPython 固件版本，代价是每次启动多约 1 s 注入时间；littlefs 镜像能做到启动即生效，但要绑定 littlefs 参数（块大小 4096、vfs 偏移）；完整的 mpremote 协议（fs ls/cp）可以以后作为 raw-paste 的扩展再做。

## F-07a / F-07b brief 要点
**F-07a（core，约 1 个会话，model 默认）**
- 修 UART RX：在 `core/crates/soc/src/periph.rs:54-68` 的 INT_CLR 和读 FIFO（`:37-42`）之后，只要 `rx` 不空就重新置位 RXFIFO_TOUT（bit 8）。补单元测试。对比 golden，确认现有用例的输出逐字节不变。
- 让 `--script` 支持 `\xNN` 转义（`main.rs:594`），web 端 `simrun.ts:159` 同步改，保持一致。
- 验收前先跑 `tools/fetch_third_party.sh`（新增：把 MicroPython C3 v1.29.0 下载到 git-ignored 目录，校验 sha256）。在 `firmware/accept.json` 加用例 `--expect 'Type "help()"'`，并用 `--uart-in` 发一段 194 字节的 print，期望得到正确结果；文件不存在时跳过。
- 可选：S3 通用版（四线 PSRAM）的支持，以及 0x60008040 忙等的排查，单开一项。
- 在 STATUS 加一行 "MicroPython C3 ✅ / S3 仅 OCT"。

**F-07b（web，1–2 个会话；依赖 F-07a 和 F-01）**
- 在 `worker.ts:681-700` 旁边加一个 MicroPython 会话状态机（raw-paste 写文件 + 软复位），串口面板加 Ctrl-C / Ctrl-D 按键和 main.py 编辑器，所有文案走 `t()`，四种语言同时补。
- 按 §6 用 agent-browser 走一遍，写进 `Reviews/ab/F-07b.md`：上传 bin → 看到 `>>>` → 编辑 → 运行 → 输出 tick → 刷新页面后仍能运行。puppeteer 回归测试新增 `tools/webtest/mpy.mjs`。
- 开工前先改 PRODUCT.md 的定位，并记进 DECISIONS。

## 授权事项
- MicroPython 本身是 MIT（Damien P. George）。但二进制里还链接了：ESP-IDF / NimBLE / mdns（Apache-2.0）、littlefs / lwIP（BSD-3）、oofatfs（BSD-1）、TinyUSB（MIT）、uzlib（Zlib）、berkeley-db（**BSD-4，带广告条款**；固件里能搜到 `btree` 字符串），以及乐鑫 Wi-Fi / BT / PHY 二进制库（应为 Apache-2.0，**待核**）。
- 官方二进制**没有附 esp-idf-sbom**，LICENSING 第 27 行对"乐鑫修改版 MIT"的检查没法自动跑。从 idf_component.yml 看，C3 只依赖 mdns；S3 另外依赖 tinyusb 分支，没有用到修改版 MIT 组件，但这是人工判断。
- **只让用户自己上传固件：不需要改 LICENSING。**

## 需人拍板
1. 网站托管 MicroPython 二进制的方式三选一：(i) 托管官方 bin，附手写的 NOTICE（含 BSD-4 致谢）；(ii) 我们自己用 IDF 5.5.1 构建并生成 SBOM（会和官方 5.5.2 不一致）；(iii) 只给官方下载链接，由用户上传。建议先用 (iii)。
2. 是否接受 PRODUCT 定位扩展到"在这里改代码"（O7 / F-07b 的前提）。
3. S3 第一阶段是否只支持 OCT 变体（网页检测到 PSRAM 报错时提示用户换 OCT 变体）。
