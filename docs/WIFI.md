# Wi-Fi（ESP32-C3）逆向笔记与实现

目标：用户上传的 .bin（IDF / Arduino）在模拟器里能扫描、连上虚拟 AP、拿到 IP、做 HTTP。
信息来源：ESP-IDF v5.5.1 的预编译 Wi-Fi 库（libpp / libnet80211 / libphy，Apache-2.0 二进制）反汇编、ROM ELF 符号、IDF 头文件。不参考任何 GPL 实现。

调试工具：
- `tools/wifi_iter.sh <固件> [秒] [参数]`：重编 CLI、运行、打印停止点并反汇编
- `tryboard run ... --watch 0x6003xxxx`：记录访问该 MMIO 地址的 PC（按 PC 汇总读写次数与最后值）
- `tryboard run ... --dump-intc`：打印中断源 → CPU 线映射、使能、阈值

## 阶段 1：驱动初始化（wifi-init ✅）

`esp_wifi_init` 本身不碰硬件；`esp_wifi_start` 里 `esp_phy_enable` 做完整 PHY 校准（没有 NVS 里的校准数据，走 full calibration），然后 `hal_init` 初始化 MAC。卡住的地方全是"等硬件完成"的轮询，给出就绪值即可（`crates/esp32c3/src/wifi/mod.rs::rf_read`）：

| 地址 | 谁在等 | 就绪条件 |
|---|---|---|
| 0x6000E050 | ROM `rom_pkdet_vol_start` / `rom1_read_sar2_code` | 位 26..24 == 7（SAR 空闲） |
| 0x6000E04C | libphy `txdc_cal_v70` | 位 24 = 比较完成（位 30 是比较结果，校准做二分查找，值无所谓） |
| 0x60006174 | ROM `rom_iq_est_enable`（FE 块） | 位 16 = IQ 估计完成 |
| 0x60033D14 | libpp `hal_init`（MAC） | 写位 1 后等位 0 |

模拟前端寄存器（regi2c）已在 HLE 里存取；校准算出来的值不影响后续功能（射频不真实发射）。

顺带修了一个 SYSTIMER 的通用 bug：单次模式比较器在计数 ≥ 目标时会反复置中断位，而真机只在装载（COMPx_LOAD / 使能）后触发一次。esp_timer 把闹钟设在过去时会导致中断风暴，Wi-Fi 启动正好触发了这个情形。

## 选型：在寄存器 + DMA 描述符层模拟 MAC（方案 a）

证据：IDF 5.5 的数据通路函数大多不在 ROM 里执行——`wDev_ProcessFiq`（IRAM）、`wDev_ProcessRxSucData`、`ppProcTxDone`、`lmacProcessTxComplete` 都由 IDF 自己的库提供（ROM 里的同名函数被替换），ROM 里留下的多是跳转桩（`__call_*`）和经 `pp_wdev_funcs` 函数表的间接调用。按 ROM 地址 HLE（方案 b）拦不住真正执行的代码；按 app 符号 HLE（方案 c）要求用户上传 ELF。
寄存器 + 描述符层只依赖硬件接口，不依赖 IDF / Arduino 的具体版本与链接地址，用户上传 .bin 就能用。

## 阶段 2：发送 / 接收与扫描（wifi-scan ✅）

### MAC 寄存器（基址 0x60033000）
| 地址 | 含义 | 来源 |
|---|---|---|
| 0x60033C34 | 中断使能（驱动写 0x19A879E0） | hal_init |
| 0x60033C3C | 中断状态（读） | hal_mac_interrupt_get_event |
| 0x60033C40 | 中断清除（写 1 清） | hal_mac_interrupt_clr_event |
| 0x60033D08 − 8q | 发送队列 q（0..4）：位 19..0 = 描述符地址低 20 位（高位 0x3FC00000），位 31/30 = 启动 | mac_tx_set_plcp0、hal_mac_txq_enable |
| 0x60033CB0 | 发送完成位图（位 3..0 对应队列） | hal_mac_get_txq_state(2) |
| 0x60033CAC | 写 1 清发送完成位 | hal_mac_clr_txq_state(2) |
| 0x60034320 − 76q | 队列 q 的发送结果：位 15..12 结果码（0 成功 / 1 RTS 错 / 2 CTS 超时 / 4 发送错 / 5 ACK 超时），位 23..16 传给 lmacProcessTxSuccess | hal_mac_get_txq_pmd、lmacProcessTxComplete 跳转表 |
| 0x60033084 | 位 31 = 接收使能 | ic_enable_rx |
| 0x60033088 | 第一个接收描述符地址 | mac_rxbuf_init |
| 0x60033090 | 最近填好的接收描述符（低 20 位，高位取 0x60033C64 = 0x3FC00000） | wdevProcessRxSucDataAll |
| 0x60035018/1C | TSF 计时器（微秒，64 位） | hal_get_tsf_time |
| 0x60035118 | 省电模块中断状态（TBTT / TSF 定时器） | hal_pwr_interrupt_get_event |

### 中断事件位（wDev_ProcessFiq）
0x80 发送完成（lmacPostTxComplete）、0x4000 / 0x1000000 接收完成（lmacProcessRxSucData → pp_post(25)）、0x80000 发送超时、0x100 冲突、0x8000 信标过滤、0x200000 → pp_post(14)。中断源 0（WIFI_MAC）。

### 描述符（lldesc）
字 0：size[11:0]、length[23:12]、EOF 位 30、owner 位 31（1 = 硬件）；字 1：缓冲区；字 2：下一个。
发送：长度含 4 字节 FCS（硬件生成），帧内容不含。
接收：缓冲区开头是 48 字节元数据（`wifi_pkt_rx_ctrl_t`，C3 共 12 个字），随后是 802.11 帧 + FCS；描述符 length = 48 + 帧长 + 4，置 EOF、owner 清 0。
元数据里用到的字段：字 0 低 8 位 RSSI、位 28 = 命中接口 0（STA；位 29 是接口 1/AP，驱动据此丢弃不属于已启用接口的帧）；字 2 位 19..16 信道；字 3 时间戳（µs）；字 5 低 8 位噪声底；字 11 低 12 位 sig_len（含 FCS），最高字节 rx_state（0 或 245 视为正常）。

### 实现
- `wifi/mod.rs`：发送队列启动时沿描述符链取帧 → 交给虚拟世界 → 按 1Mbps 空口时间安排"发送完成"（单播且目标存在 = 成功，否则 ACK 超时）与回应帧到达；回应帧写入下一个 owner=1 的接收描述符。
- `wifi/world.rs`：4 个虚拟 AP（TryBoard-WiFi 开放 ch6 −42dBm、TryBoard-WPA2 WPA2 ch1 −55dBm、Neighbor-5G-Ext WPA2 ch11 −78dBm、CoffeeShop 开放 ch6 −70dBm）。当前信道从探测请求的 DS 元素推断，只有同信道的 AP 回探测响应。
- CLI：`--wifi-log` 打印空中日志（每帧的时间、方向、长度、信道、RSSI、类型）。

扫描结果（4 个 AP，SSID / 信道 / RSSI / 加密方式全对，按 RSSI 排序）与 IDF 的主动扫描流程一致：每个信道一个探测请求、驻留约 120ms。
