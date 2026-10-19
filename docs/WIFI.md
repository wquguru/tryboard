# Wi-Fi（ESP32-C3 / ESP32-S3）逆向笔记与实现

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

（模型代码现在在 `crates/soc/src/wifi/`，C3 / S3 共用，见文末「S3」一节；轮询表是 `WifiLayout::rf_polls`。）

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

## 阶段 3：认证、关联、DHCP（wifi-connect ✅）

空中流程（`--wifi-log` 实录）：带 SSID 的定向探测请求逐信道扫描 → ch6 收到探测响应 → 去认证（IDF 连接前的惯例）→ 开放系统认证 → 关联（AID 1）→ 数据帧 DHCP DISCOVER / OFFER / REQUEST / ACK → 两次 ARP 冲突检测（不能回应）→ 空数据帧通告省电。拿到 IP 约在启动后 0.69 秒（模拟时间）。

- 已关联后虚拟 AP 每 102.4ms 发信标，否则芯片会因信标丢失断线。
- 虚拟局域网（`wifi/net.rs`）：网关 192.168.4.1（MAC 02:54:42:ff:00:01），DHCP 分配 192.168.4.100/24，网关兼 DNS；ARP 只替网关和局域网其它地址回应，不回应芯片自己的地址（否则 DHCP 冲突检测失败）；ICMP 回显。
- 数据帧：ToDS 方向 a1=BSSID、a2=源、a3=目的；FromDS 方向 a1=目的、a2=BSSID、a3=源；载荷前 8 字节 LLC/SNAP（AA AA 03 00 00 00 + 以太类型）。AP 不带 WMM / HT 元素，所以芯片发普通数据帧（非 QoS）。
- 虚拟互联网（`wifi/tcp.rs`）：所有域名解析到网关；网关 80 端口跑一个最小 HTTP/1.1 服务（`/`、`/hello.txt`、`/api/time`，可注入自定义页面），TCP 只做被动打开，不重传（虚拟网络不丢包）。

CPU 修正：ESP32-C3 硬件支持非对齐访存（`esf_buf_alloc_dynamic` 往非对齐地址写 32 位哨兵 0xDEADBEEF），rv32 核加了 `misaligned_ok`，C3 打开；riscv-tests 仍按规范报异常。

## 阶段 4a：HTTP（wifi-http ✅，开放网络）

`esp_http_client` 依次 GET `http://tryboard.local/hello.txt`（`.local` 走 mDNS：查询发往 224.0.0.251:5353，虚拟网关按"传统单播"回给查询方端口）和 `http://example.com/api/time`（普通 DNS → 网关）。空中流程：DNS → ARP 网关 → TCP 三次握手 → HTTP 请求 → 响应 + FIN → ACK / FIN。

顺带补了硬件随机数寄存器 WDEV_RND_REG（0x600260B0）：之前读回常数，lwIP 选端口 / DNS 事务号时会一直等"新随机数"。现在是固定种子的 xorshift，结果可复现。

## 阶段 4b：WPA2-PSK（wifi-wpa2 ✅、wifi-wpa2-bad ✅）

空中流程（`--wifi-log`）：探测 → 认证 → 关联（关联请求带 RSN IE）→ AP 3ms 后发 EAPOL 1/4 → 终端回 2/4（AP 用 PTK 的 KCK 验 MIC）→ AP 发 3/4（安装、Secure、加密密钥数据 = RSN IE + GTK KDE，KEK 做 AES Key Wrap）→ 终端回 4/4 → 端口放行，之后的数据帧全部 CCMP。

前置：硬件 SHA / AES 加速器（`crypto_hw.rs`）。`esp_fast_psk` 用 SHA 块模式算 PBKDF2（4096 × 2 × 2 块），mbedTLS 的 HMAC-SHA1 走 SHA DMA 模式，GTK 解封走 AES DMA（ECB）。没建模时 `sha_hal_read_digest` 读到全零直接 abort。

### MAC 硬件加密
| 地址 | 含义 | 来源 |
|---|---|---|
| 0x60033814 | 密钥表有效位图（位 i = 槽 i） | hal_crypto_set_key_entry / clr_key_entry |
| 0x60034400 + 40i | 槽 i：字 0 = 对端 MAC 字节 0..3；字 1 低 16 位 = MAC 字节 4..5，位 30 = 组密钥（其余高位是算法 / 槽类别，未用）；字 2..9 = 密钥（内存字节按小端装载） | 同上，get_key_entry 反向解码 |
| 0x60033800 / 0x60033804 / 0x60033840 | 加密引擎初始化（hal_crypto_init 写 0x30000、或上 0x19） | hal_crypto_init，未建模 |

- 发送：驱动交给硬件的受保护数据帧 = 802.11 头 + 8 字节 CCMP 头（PN 已填，ExtIV 位、密钥号）+ 明文 + 8 字节 MIC 空位。MAC 模型按 a1 找成对密钥，加密后替换整帧。
- 接收：硬件按 a2 找密钥（a1 组播 → 组密钥）解密，写进接收缓冲的是 头（受保护位保留）+ CCMP 头 + 明文 + 原 MIC；驱动 `ieee80211_crypto_decap → ccmp_decap` 校验 PN 递增后按 cipher 的头 8 / 尾 8 字节剥掉。解密失败的帧丢弃（计入 rx_dropped）。
- 实测槽位：GTK 槽 0（字 1 = 0x48CC0200），PTK 槽 4（字 1 = 0x086C0200），对端都是 BSSID。

### 错口令
AP 收到 MIC 不对的 2/4 静默丢弃，按 hostapd 节奏重发 1/4（100ms、1s、1s）。IDF 收到第 4 个 1/4 后自己去认证，事件里 `reason=15`（4WAY_HANDSHAKE_TIMEOUT）；之后它把这个 BSSID 拉黑（libnet80211 `cnx_add_to_blacklist`），重连扫描不再选它，报 `reason=205`（CONNECTION_FAIL）。若终端一直不放弃，AP 在第 4 次发出 1/4 后 1s 发去认证（原因 15）。


## S3（P2-08：s3-wifi-init / scan / connect / http / wpa2 ✅）

结论：S3 与 C3 的 Wi-Fi MAC 是同一代硬件，C3 的 MAC 模型不改寄存器就能用。模型从 `crates/esp32c3/src/wifi/` 搬到 `crates/soc/src/wifi/`（tryboard-soc），
`WifiMac::new(WifiLayout::C3 | WifiLayout::S3)`，通过 `tryboard_soc::Mem`（rd8 / rd32 / wr8 / wr32）借芯片总线读写描述符；两颗芯片的 SocBus 都在 MMIO 分发里把 0x60033000–0x60036000 交给它。

逐项核对（依据：IDF 头文件 + S3 固件实跑）：
| 项 | C3 | S3 | 来源 |
|---|---|---|---|
| MAC 寄存器（中断、发送队列、接收链、TSF、密钥表） | 0x60033000 起 | 相同 | 同一份 MAC 模型在 S3 上走完扫描 → 认证 → 关联 → 四次握手 → DHCP → HTTP |
| 中断源 | ETS_WIFI_MAC_INTR_SOURCE = 0 | 相同（S3 经两核中断矩阵，Wi-Fi 任务在核 0） | soc/*/include/soc/interrupts.h |
| 接收元数据头 wifi_pkt_rx_ctrl_t | 12 字 | 相同（头文件里 S3 与 C3 走同一分支） | esp_wifi/include/local/esp_wifi_types_native.h |
| 描述符（lldesc）、地址高位 0x3FC00000 | — | 相同（S3 DRAM 0x3FC88000 起） | — |
| PHY 校准轮询 | 0x6000E050 / 0x6000E04C / 0x60006174 / 0x60033D14 | 相同，**另加** SENS_SAR_TSENS_CTRL（0x60008850）：libphy `temperature_sensor_get_raw_value` 写 DUMP_OUT（位 24）后等 READY（位 8），读 OUT（位 7..0） | `--trace` 停在该函数的轮询；S3 periph.rs 的 SensAdc 给 READY 与原始值 104（≈ 25 ℃） |
| 硬件随机数 WDEV_RND_REG | 0x600260B0 | **0x6003507C**（落在 MAC 地址范围里，先于 MAC 分发处理） | soc/*/include/soc/wdev_reg.h |
| SHA / AES 加速器 | 0x6003B000 / 0x6003A000，GDMA 外设号 7 / 6 | 相同 | reg_base.h、hwcrypto_reg.h、gdma_channel.h；`crypto_hw.rs` 改成不依赖具体 SoC（寄存器写前由 SoC 取 GDMA 链头） |
| 蓝牙 / 共存寄存器 | — | Wi-Fi-only 固件启动期只读写 BT 基址 0x60011000 两个字共 18 次，读回上次写入值即可，不需要专门应答 | `--unimpl 500` 全表 |

没用到、没做的：S3 的 SHA-384/512 模式（WPA2 只用 SHA-1）、TSENS 随温度变化、802.11n / 省电、蓝牙。
QEMU 对照：乐鑫 QEMU 的 esp32s3 机器没有 Wi-Fi 模型（只有 ESP32 的 open_eth 网卡），无法做 S3 Wi-Fi 对照；判定与 C3 版相同的串口输出。

## 阶段 5：固件自建热点 + 虚拟手机配网（C-02：softap-prov ✅、c3-softap-wpa2 ✅、s3-softap-prov ✅）

固件开 WIFI_MODE_AP / APSTA 时，空中多了"另一端"：浏览器侧不再只是路由器，还要有一部去连板子热点的手机。
- **AP 接口帧**：固件经 AP 接口发出的帧在 Tx 描述符头里标了接口号；模型按它填 Rx 元数据 `hdr[0]` 第 29 位（`Air.ap_if`）回送，固件的 hostapd 才认这是给 AP 的帧。World 从芯片自己发出的信标里学到 `ap_mac`，地址 2 == `ap_mac` 的帧都交给手机。
- **虚拟手机**（`soc/src/wifi/phone.rs`）：被动扫描（只听芯片信标）→ 开放认证 → 关联 →（WPA2 时）作为请求方走四次握手（复用 `wpa.rs` 的 PRF / MIC / AES-KW）→ DHCP 客户端拿 192.168.4.2 → 联网探测：DNS 查 `connectivitycheck.gstatic.com`、GET `/generate_204`，回的不是 204 就判「需要登录此网络」，记下跳转地址 → 用户点「打开」才 GET 登录页 → 解析 `<form>` 的 action / method / 字段 → POST `application/x-www-form-urlencoded`。最小 TCP 客户端（单连接、按模拟时间重传），HTTP/1.1 `Connection: close`。
- **定时器**：手机的重试 / 超时并进 World 的 `next_timer` / `poll`，按模拟时间推进；同样的输入序列 → 同样的帧序列（重放逐字节一致）。
- **路由器换网段**：拿起手机时世界里加一台虚拟路由器 `MyHome` / `12345678`（WPA2，信道 6），芯片配网后去连它。热点用了 192.168.4.0/24，路由器挪到 **192.168.5.1**，分给芯片 **192.168.5.100**；只有芯片还没从路由器拿过地址（`!net.leased`）时才挪，正在用的租约不会被改掉。没拿手机时世界与以前逐字节相同（`wifidiff` 对现有 Wi-Fi 用例逐字节比对）。
- **重启**：固件自己 `esp_restart()` 时（`Machine::reboot`）手机保留：被热点断开后它记着这个网络，信标再出现就自动重连（与真手机一致）。
- **动作**（脚本 / 输入日志 `phone=`）：`on`（拿起手机，开始听信标）/ `join,ssid[,口令]` / `leave` / `open`（打开探测到的登录页）/ `get,url` / `post,url,body`（url 空 = 当前页表单的 action）。CLI 另有 `--ap-phone [ssid[,口令]]` / `--ap-post body`（自动打开、自动提交，**只给命令行用**；网页每一步都是显式的 `phone=` 事件）。
- **网络页签记录**：`tcp.rs` 记芯片当客户端时的 DNS / HTTP / 被拦连接（`NetRow`：时刻、方法、去向 虚拟 / 真实 / 未放行、地址、状态、耗时），wasm `tb_net_json` 给网页。

没做：iPhone 的探测地址（captive.apple.com）与各家系统弹不弹登录页的差异（必须上真机）、手机侧 HTTPS、一次连多部手机、WPA3 / SAE。

## 阶段 6：真实网络开关（C-03：http-real-virtual ✅、http-real-replay ✅）

网页顶栏「真实网络」（默认关）打开后，芯片发往 `tryboard.local` 以外的 HTTP 请求由浏览器 `fetch` 真发出去。
- **内核**（`tcp.rs`）：收齐请求后按 `Host:` 判断；开着开关的进发件箱（`RealReq {id, method, url, ctype, body}`），网络页签加一行「真实 · 等待」。回复由 `netreply=` 送回：按 MSS 切段、最后一段带 FIN；状态 0 回 502 + `TRYBOARD_REALNET_ERROR <原因>`。芯片先断开 → 那一行记超时，迟到的回复丢掉。开着时 443 / 8443 的 SYN 回 RST（HTTPS 未放行），其他非 80 端口照旧拦截并写说明。
- **动作**：`realnet=1|0`、`netreply=编号,状态,毫秒,内容类型|原因,base64 正文`。CLI 不联网，遇到请求只在 stderr 报「真实网络请求 #n GET url」。
- **wasm**：`tb_realnet_set(on)`、`tb_net_outbox()`（JSON 用 `tb_phone_json_ptr` 读）、`tb_net_reply(p, len)`（0 成功 / 1 看不懂）；`tb_net_json` 每行第 7 项是说明，外加 `"realnet"`；`tb_net_version` 含行改写次数。
- **网页**：`web/src/realfetch.ts`（fetch + CORS 诊断）、worker / simrun 的 `pumpNet`、网络页签「本次已记录 N 条回复 · 保存回复，离线重放」。

没做：HTTPS、MQTT 等非 HTTP 出网、WPA3、TAP、原始 TCP 出网。
