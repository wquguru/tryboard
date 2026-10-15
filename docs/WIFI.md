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
