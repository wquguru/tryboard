# RS-5 BLE 签名放宽到多 IDF 版本（调研结论）

日期 2026-10-20。只调研，未改代码；未装任何 IDF / 工具链。证据用 `tools/ble_sigs.py` 的函数在临时目录复算，可按文末 sha 清单重现。

## 结论
**做 F-08c，但它不是"只补签名"**：要（1）补签名变体，（2）放宽 bt.c osi 表版本门槛，（3）`pll_track` 找不到时允许跳过。约 1–1.5 个会话；真机型 Arduino 验收需人批准装 arduino-cli 工具链（约 2–3 GB）。

## 1. 现状：声称 vs 实测
- 签名由 `ble_sigs.py gen / gen-xt` 从 `third_party/btlib/<ver>/<chip>/libbtdm_app*.a` 算：每个函数取对象码、清零重定位字段、按版本去重、截到在全部函数里唯一的最短前缀（≥24 单元）；`pll_track` 靠 `btdm_controller_enable` 调用前 24 字节内的 call 定位（`sig.rs:240`）。
- "覆盖 5.1–5.5.1"其实只是 **5 个 bt-lib 提交**（`fetch_third_party.sh`）：ed99228（标 "5.1-5.2"，实为 5.1.6 / 5.2.4–5.2.5）、daab5db（5.3.3）、72599d5（5.4.2）、3ff5291（5.5.0）、0c68809（5.5.1，也是 5.2.6 / 5.3.4 / 5.4.3 的回移）。实测固件只有 5.5.1。
- 覆盖应**按 bt-lib 提交而不是 IDF 版本号**算：同一大版本的补丁版各自带不同库。
- 运行时还有第二道门：`esp32c3/src/ble.rs:170`、`esp32s3/src/ble.rs:198` 只接受 OSI_VERSION 0x10009–0x1000A。S3 与 C3 共用 `bt/controller/esp32c3/bt.c`，一次分析两颗芯片都适用。

| bt-lib 提交 | IDF tag | Arduino-ESP32 | 现签名 | bt.c OSI（"未查"/? = 推断） | 门槛 |
|---|---|---|---|---|---|
| d7513eb / b438f60 | 5.1.0 / 5.1.1 | — | 缺 osi_reg + init | 0x6 / 5.1.1 未查（5.1.0 无 pll_track 调用） | ✗ |
| 0cfac1b / 9d40b3b / e5c0f72 | 5.1.2 / 5.1.3 / 5.1.4、5.2.1 | 3.0.0–3.0.1（IDF@442a798，OSI 0x7） | 缺 osi_reg + init | 0x7 | ✗ |
| 061e70c | 5.1.5 | 3.0.6–3.0.7（IDF@632e0c2，OSI 0x9） | 缺 init | 0x7? / 0x9 | 签名 ✗ |
| 393ac4c / 76ed411 / b8ef2c4 | 5.2.0 / 5.2.2 / 5.2.3 | — | 缺 1–2 个 | 0x7（5.2.2 / 5.2.3 未查） | ✗ |
| 4b13388 / bfdfe8f | 5.3.0（= 4.4.8 库）/ 5.3.1 | — | 缺 1–2 个 | 0x8（5.3.1 未查） | ✗ |
| d23ae97 / 4c16da1 | — | 3.1.0 / 3.1.1（OSI 0x9） | 8/8 | 0x9 | ✓ |
| ed99228 | 5.1.6、5.2.4–5.2.5 | 3.1.2–3.1.3 | 8/8 | 0x9 | ✓ |
| 6470c01 / aaf54a5 / 72599d5 | 5.3.2、5.4.0 / 5.4.1 / 5.4.2 | 3.2.0 / 3.2.1 | 8/8 | 0xA（5.3.2 / 5.4.0 / 5.4.1 未查） | ✓ |
| 3ff5291 / 0c68809 / 099a7e1 | 5.5.0 / 5.5.1 / — | 3.3.0 / 3.3.1 / 3.3.5 | 8/8 | 0xA | ✓ |
| 9b50531 / 16cda80 | 5.5.2 / 6.0 | — | 8/8 | 0xA | ✓ |

Arduino 3.3.6–3.3.12 改发分芯片 zip（c3 约 55–60 MB），IDF 提交没法免费查到，**未核实**，按 release/v5.5 推断大概率命中。Arduino 2.x（IDF 4.4，OSI 0x8、无 pll_track）不在范围内。缺口集中在 **Arduino 3.0.x 和 IDF 5.1.0–5.3.1**。

## 2. 免装 IDF 拿库
- `raw.githubusercontent.com/espressif/esp32c3-bt-lib/<sha>/<chip>/libbtdm_app*.a` 按提交直接下载，每个库约 1.5–2 MB。本次下了 19 个提交 × 2 芯片，共 68 MB；F-08c 实际要加 12–14 个提交，约 40 MB，放 git 忽略的 `third_party/`。
- 由 IDF tag 或 Arduino 提交查子模块 sha：`gh api repos/espressif/esp-idf/contents/components/bt/controller/lib_esp32c3_family?ref=<tag>`（未认证限额 60 次/小时，用 gh）。
- 授权：同 LICENSING 第 12 行（Apache-2.0）。版本越多，掩码指令字越多，但"是否算派生作品"仍**待人复核**，不能当作已解决。

## 3. 复算结果（临时目录，未入库）
- 把 5.1.0–5.3.1 的库并进去重新生成：C3 和 S3 都**无歧义报错**，各只多出 5 个变体（`btdm_controller_init` 2 个、`btdm_osi_funcs_register` 3 个），其余 6 个函数现有前缀已命中。
- 防误认：新变体扫 `firmware/build` 下 `c3-` / `s3-` 前缀的镜像（15 个 C3、40 个 S3），**零命中**。
- osi 表：5.1.0 / 5.1.4 / 5.3.0 / 5.5.1 的 bt.c 都是 26 个字段，偏移 36/52/56/100 都是 semphr_create / take / give / task_create；只有 5 个中断字段换了名字，位置不变。所以门槛可以放宽到 0x10006..=0x1000A。
- 旧 bt.c 调用的库函数是 5.5.1 的子集，HLE 不会多出要挡的库函数。

## 4. 比字节签名更稳的方案
| 方案 | 优点 | 缺点 | 工作量 |
|---|---|---|---|
| 路线 c：读 app.elf 符号 | 与版本无关；CLI 已有 ELF 符号读取（`cli/src/main.rs:107`） | 用户要多传一个文件；网页提示卡已有 | 约 1 会话，作后备 |
| 找 0xFADEBEAD 表的数据引用 | osi 表从 4.x 起就以 magic+版本开头；能先读出版本 | 只能定位 osi_reg，其余 7 个还是要签名 | 0.5 会话 |
| bt.c 调用顺序锚定 | 不依赖库 | 随编译器 / -O / bt.c 版本变化（5.5.1 比 5.1 多调约 20 个库函数），脆弱 | 1–2 会话，不推荐 |
| ROM 函数表 | — | 已否决（DECISIONS 2026-10-19） | — |

所以继续用签名作主路线（补变体便宜、零误认），路线 c 留作后备，以后单独立项。

## 5. F-08c 最小方案
1. `fetch_third_party.sh` 加 sha：d7513eb、b438f60、0cfac1b、9d40b3b、e5c0f72、061e70c、393ac4c、76ed411、b8ef2c4、4b13388、bfdfe8f（已命中的 6470c01 等 7 个可选，作回归用）。目录名用 tag，不再用"5.1-5.2"这类合并名。
2. 用 `gen` / `gen-xt` 重新生成 `sigs.rs` / `sigs_xt.rs`。
3. `ble_sigs.py` 加 `cover` 子命令：每个库 8/8 命中、库内零误认；`sigs_hit_only_ble_firmware` 照常跑。
4. C3 / S3 门槛改成 0x10006..=0x1000A；`locate` 找不到 pll_track 时返回 0、先不报错，留到 `S_OSI_REG` 读出 osi 版本再判：版本 ≤ 0x10006 且为 0 → 不挂钩；版本 ≥ 0x10007 且为 0 → 维持现有报错（真 setter 会经未初始化的 sdk_config 指针写内存）。
5. 免装验证：用已装的 5.5.1 工具链，把每个旧 `libbtdm_app.a` 链成裸 ELF（`--gc-sections -u <8 个符号>`、5.5.1 的 ROM ld、`--unresolved-symbols=ignore-all`），再 `esptool elf2image` 后跑 `ble_sigs.py check / check-xt`。这样能测到真实链接器松弛；`gen` 的对象码对比测不到。
6. 真验收（**需人批准**）：arduino-cli 装 esp32 core 3.0.7，编 BLE_server（Bluedroid）的 C3 和 S3 版。磁盘：libs zip 310 MB、解压约 1.5 GB，加两套 gcc 12，合计约 2–3 GB；单独装一个 IDF 版本约 4–5 GB。用 merged.bin 跑 `tryboard run --ble-phone`，判定同 c3-bluedroid-nus。也可以请人提供一份 Arduino 3.0.x 的 .bin + .elf。

## 风险
- 第 5 步的裸链接可能卡在缺符号上；只能证明签名在旧库上能命中，不能证明运行行为。
- 旧版 NimBLE / Bluedroid 主机可能发出虚拟控制器没实现的 HCI 命令，第 6 步才看得出来。
- Arduino 3.3.6+ 的库提交未核实；经典 ESP32（esp32-bt-lib，最常见的板）完全不在本项范围内，收益可能比补 5.1.x 更大。
