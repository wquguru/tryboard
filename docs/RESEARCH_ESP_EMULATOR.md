# 竞品调研：乐鑫 esp-emulator（及 esp32sim、Wokwi）

调研日期 2026-10-19。对象：`espressif/esp-emulator` v0.49.0（2026-10-13）。结论先行，依据在后。

## 0. 结论

1. **定位不重叠，用户友好度我们领先**：esp-emu 是给固件工程师的"无板 CI + 调试器"，网页版只有串口、GPIO 方块、寄存器、内存；没有任何外接器件。同一份 .bin，接了 I2C 器件或 USB 的项目在它那里**启动即报错**；SPI 屏幕能跑，但看不到画面（§2 实测）。
2. **覆盖度它远超我们**：7 颗芯片（我们 2 颗）、Wi-Fi 全套（SoftAP / WPA3 / 企业级 / 能上真实互联网的 NAT）、BLE、Thread、以太网、GDB、Perfetto 时间线、esptool 烧录。
3. **它是闭源二进制**（仓库挂 Apache-2.0 LICENSE 但没有源码，官方答复"还没决定是否公开"，issue #10）。所以"借鉴"只能借鉴**功能与交互**，不能读实现；可以把它当**独立进程对照**（同 QEMU）。
4. **两件事会改变我们的优先级**（详见 §4、§5）：
   - **BLE 要做，但"只传 .bin"比预想难**：C3 ROM 虽有 731 个 `r_*` 控制器函数，IDF 5.5 的 `libbtdm_app` 重新定义了其中 677 个（含全部 `r_hci_*`），并经 `r_*_funcs_p` 函数表调度 —— 和 Wi-Fi 当年否掉 ROM 地址拦截的情形一样，ROM 副本基本是死代码。可走的"只传 .bin"路线是**按预编译库字节签名定位**（libbtdm 是乐鑫发布的二进制，同一 IDF 版本里函数体逐字节相同，只差重定位）；不成就退到 esp-emu 的"再传 app.elf"。建议 2 周探针定路线。
   - **固件自建热点（SoftAP）比 WPA3 重要得多**：ESPHome / Tasmota / WiFiManager / 小智配网，第一次开机都是"板子开热点 → 手机连上去配网"。我们只有 STA。
5. **不追芯片数量**。追加芯片只按"选板会推荐、用户真会买"排序：经典 ESP32（LX6，新手保有量最大，我们的 Xtensa 核可复用）> C6 > 其余。

## 1. esp-emulator 事实（来源：README、Releases、issue #10、实测）

| 项 | 内容 |
|---|---|
| 形态 | Rust；`esp-emu` 命令行（Linux x64/arm64、macOS arm64）+ wasm 网页版（GitHub Pages，每个版本发布）；一行 curl 安装 |
| 授权 | 仓库 LICENSE 为 Apache-2.0，但**只发二进制、无源码**；issue #10 官方答复 "We haven't yet decided on the publishing source" |
| 节奏 | 0.39（8 月 10 日）→ 0.49（10 月 13 日），约每周一版；0.43 才加 S3 |
| 芯片 | C3、C5、C6、H2、P4（双核 + PIE SIMD）、S3（双核 LX7）、S31（早期）；内嵌各芯片 ROM ELF，**从真实 ROM 复位向量启动**（也可跳过） |
| 外设 | UART、USB-Serial-JTAG、GPIO、SYSTIMER、TIMG、PLIC/CLIC、eFuse、SPI flash、GDMA（含内存到内存）、GP-SPI、RMT、LEDC、PCNT、MCPWM、I2C（**只内置一个 EEPROM 从机 @0x50**）、看门狗；PMP / PMA / APM / TEE / PMS 权限控制 |
| 加密 | AES、SHA（含 512 / SM3）、RSA、ECC、HMAC、DS、XTS-AES 闪存加密、ECDSA、Key Manager |
| Wi-Fi | 内置 SoftAP：WPA2-PSK / WPA3-SAE（PMF、H2E）/ 企业级 802.1X（转发到 RADIUS）；DHCP；固件自建热点可被模拟站点连接；后端：用户态 NAT（smoltcp，DNS 转发、mDNS 改写给 Matter、IPv6、hostfwd）、Linux TAP、macOS vmnet |
| BLE | NimBLE（S31 另有 Bluedroid / 经典蓝牙）；后端 Bumble 虚拟控制器（TCP）或 Linux hci0；**需要 `--elf`** |
| Thread | C6 / H2 跑 OpenThread `ot_cli` / `ot_br`；`--thread-sim` 用 UDP 桥接两台；**需要 `--elf`** |
| 以太网 | OpenETH（IDF 的 QEMU 专用 MAC）、P4 GMAC |
| 开发工具 | `--gdb` / `--gdb-halt`；`--trace` 输出 Chrome Trace（Perfetto），读 `pxCurrentTCBs` 画每任务泳道 + PC 采样热点，不需固件插桩；`--uart-tcp` + `--strap-mode 0x02` 让 esptool / espefuse 走 `socket://`；`--control-tcp` 复位 / 擦写；`--inject-on` 串口注入；`--exit-on` 匹配即退出（CI 用） |
| 网页版 | 选芯片（**不自动识别**）→ 拖 merged .bin → Run。面板：串口（可输入）、MIPS / 实时倍率 / 模拟时间、核 PC、GPIO 方块（输出高亮）、寄存器、内存；Wi-Fi SSID / 密码；**托管页没有网络**（要本地起 WebSocket 代理，且 HTTPS 页面连不了 ws://） |
| 关联产品 | 官方在 issue #10 推荐 esp-zerocode.ai（"describe a device, get working firmware"），说用 esp-emu 作后端做虚拟测试 —— 这和我们"AI 写固件 → 实验台验收"的定位**直接相邻**，要持续关注 |

## 2. 实测：同一份 .bin 在两边的结果

用我们 `firmware/build/<名>/flash.bin`（merged 镜像），`esp-emu --chip … --firmware … --elf app.elf --timeout 8s`。串口输出 `Reviews/compete/<名>.txt` / `.err`，截图也在 `Reviews/compete/`（git 忽略，重跑即可再生）。

| 固件 | esp-emu | TryBoard | 说明 |
|---|---|---|---|
| hello / blink / nvs | ✅ | ✅ | nvs 跨 esp_restart 计数到 3，两边一致 |
| s3-psram（8MB OPI） | ✅ | ✅ | 写 78674 µs，与我们 STATUS 记录的 79 ms 几乎一样 |
| s3-dual | ✅（`delay 100ms took 93081 us`） | ✅ | 它的跨核计时偏 7%，我们是逐周期确定性交替 |
| s3-lvgl | ✅ FPS 34 | ✅ FPS 33–34，**且圆屏有画面** | 它的 SPI 后面没有屏幕，只是把字节发出去 |
| weather / s3-oled | ❌ `I2C scan: 0x50` → `ssd1306_init()` ESP_ERROR_CHECK 失败 | ✅ | 它只有 EEPROM 从机，没有 SSD1306 / BME280 |
| s3-usb-keyboard | ❌ `dcd_init 488: ASSERT FAILED` → `tinyusb_driver_install` 失败 | ✅ 虚拟电脑枚举并打出字 | 它没有 USB OTG 设备模式 |
| wifi-http（改成我们的 SSID、open） | 🟡 拿到 IP；`example.com` **真的访问到了互联网**；`tryboard.local` 解析失败 | ✅ 两个 GET 都成功（虚拟网络） | 真网 vs 可复现虚拟网，各有用处 |
| s3-wifi-http（默认参数） | ❌ 断开重连（SSID 不同） | ✅ | 不算它的缺陷，只是默认网络不同 |

速度：只各跑一次、启动方式不同（它走真 ROM、我们直接启动；它的 SPI 后面没设备），**不下结论**，量级相当。

网页版截图 `Reviews/compete/espemu-blink.png`：blink 跑起来是"串口滚 LED ON/OFF + GPIO 5 号方块变橙"，这就是它对"灯在闪"的全部表达。

## 3. 另外两个竞品

- **mikroverk/esp32sim**（MIT，**有源码**，362 星）：S3 成熟（块缓存 + JIT，hello 约 30× 实时）、C3 / C6 草稿、**经典 ESP32 早期**；有屏幕、触摸、LED、按键、音频、**摄像头**、Wi-Fi（能上真网 + NTP）、按开发板建模（Waveshare、LilyGO T-Display、S3-CAM）；S3 用 JTAG 与真机锁步对照；能跑 Linux 6.11、两个 C6 跑 Contiki RPL。**在"给玩家用"这条线上它离我们最近**，而且可读源码（MIT 可借鉴实现，引用要按 LICENSING 登记）。
- **Wokwi**：老牌，芯片最全（经典 / S2 / S3 / C3 / C6 / H2 / P4），元件生态最大，免费层有虚拟 Wi-Fi；收费 $7–25/月；不做选型、电气、可信度。

## 4. 我们该怎么做（三档）

每项标：可行性 / 用户价值 / 授权 / 结论可信度标签。

### A. 做（直接服务"买板前试一遍"）

| # | 项 | 为什么 | 可行性 | 体验设计要点 |
|---|---|---|---|---|
| A1 | **BLE（M7）技术探针 → 正式做** | 语料库"蓝牙遥控 / BLE 传感器"、小智配网都卡在这；esp-emu 有（要 ELF），Wokwi / esp32sim 未见 | 探针 2 周决定路线（§5） | 网页里一部**虚拟手机**（扫描列表、连接、读写特征值、通知曲线），像 nRF Connect 但只做 80% 常用操作；标"行为模拟" |
| A2 | **固件自建热点（SoftAP）+ 虚拟手机连上去** | ESPHome / Tasmota / WiFiManager / 配网页都是"板子开热点"；比 WPA3 / 企业级有用得多 | 高：已有 MAC 寄存器 + 描述符层，加 AP 角色 = 发 beacon / 回 auth / assoc、跑一个虚拟站点 | 虚拟手机（与 A1 同一个）Wi-Fi 列表里出现板子的热点 → 连上 → 内置浏览器打开 192.168.4.1 的配网页，能填表提交；这是用户最常见的"第一次真机体验" |
| A3 | **网页"真实网络"开关** | 用户想看自己的天气 / MQTT 项目真的连上公网；esp-emu 托管页做不到 | 中：浏览器发不了原始 TCP。只做 HTTP(S) / WebSocket / MQTT-over-WS：虚拟网络里放一个"出口"，把固件的 HTTP 请求转成 `fetch`（受 CORS 限制）；MQTT 走公共 WS 代理需人点头（外部服务） | 默认关（确定性、可重放）；打开时结果标"行为模拟 · 不可重放"，输入日志记下响应体以便重放 |
| A4 | **FreeRTOS 任务时间线** | 选型结论"这颗芯片跑得动吗"需要 CPU 占用证据；esp-emu 的 Perfetto 时间线很实用 | 高：CLI 已自动加载 app.elf；读 `pxCurrentTCB(s)` 即可。网页需可选上传 ELF（不传就只显示 CPU 总占用） | 接到现有逻辑分析仪 / 时间线：每任务一条泳道 + 各核占用百分比；CLI 加 `--trace-tasks out.json` 直接导出 Perfetto 格式 |
| A5 | **经典 ESP32（LX6）** | 选板目前会推荐 `esp32-devkitc` 但实验台拿 C3 代替跑（`catalogmap.ts` 写着"经典 ESP32 还不能仿真"）；新手手里最多的板 | 中：LX6 与 LX7 同族，`xtensa` crate 可复用，外设是旧一代（RMT / LEDC / I2C 布局不同，Wi-Fi 要重做 MAC 层），约等于半个 M4 | 按芯片换板已就绪，补一块 DevKitC 3D 板即可 |
| A6 | **esp-emu 作第二对照源** | 多一个独立实现做差分，尤其 S3 / Wi-Fi / 未来新芯片 | 高：仿 `tools/oracle_qemu.sh` 写 `tools/oracle_espemu.sh`，运行时下载、独立进程、不入仓库、不随网站分发 | 只在验收里用；先在 LICENSING 登记（"闭源二进制，仅本机对照"） |

### B. 可选（做了加分，不是主线）

| # | 项 | 说明 |
|---|---|---|
| B1 | GDB 远程调试（CLI `--gdb`） | 给"已有板子"那类用户；RSP 协议实现量中等；网页不做 |
| B2 | `--exit-on` / `--inject-on` / 退出码 | 我们已有 `--expect` / `--script`，补齐别名与文档即可，方便用户在自己的 CI 里用 |
| B3 | 芯片自动识别提示 | **已有**：`web/src/app/fwcheck.tsx` 按镜像头校验并自动换板（C3↔S3），不认识的芯片挂校验卡说明；esp-emu 网页版拖入 s3-hello 后芯片框仍停在 C3（实测）。剩下只是文案：在拖放区把"自动识别芯片"说出来 |
| B4 | WPA3-SAE | 新路由器默认 WPA3 过渡模式；但固件多数还是 WPA2 连得上，优先级低 |
| B5 | C6（含 802.15.4 / Thread） | 等 A1 / A5 之后；Matter / Thread 是"智能家居"进阶，选板已在推荐 C6 |

### C. 不做（或暂不做）

- **追芯片数量**（C5 / H2 / P4 / S31）：没有内部资料，追不上官方；P4 是"做产品"的芯片，不是新手第一块板。
- **esptool `socket://` 烧录**：需要真 ROM 下载模式，工作量大，而我们的"拖进来就跑"对目标用户更简单。
- **企业级 802.1X、TAP / vmnet、IPv6、Matter 配网 mDNS 改写**：给专业固件团队的，不是我们的用户。
- **为权限控制（PMP / PMS）而做**：只在某个语料库项目因为缺它而行为不对时再做；STATUS 里注明"坏指针不会被硬件拦截"。
- **嵌入 esp-emu 的 wasm 当内核**：授权不明，而且会让 TryBoard 变成别人内核的皮。

## 5. 待人决定：BLE 走哪条路

esp-emu 的 BLE / Thread 都要 `--elf`（按符号拦截），说明官方也选了"高层替换"。我们在 `docs/WIFI.md` 里因为"用户只传 .bin"否掉过按 ELF 符号拦截的方案。BLE 的三条路：

| 路线 | 做法 | 用户要上传 | 可行性 | 保真度 |
|---|---|---|---|---|
| a. 按 ROM 地址在 HCI 边界替换 | 在 ROM 的 `r_hci_*` 处接管 | 只要 .bin | ❌ 已排除：2026-10-19 用 nm 对比，`libbtdm_app.a` / `_flash.a` 重新定义了 ROM 731 个 `r_*` 中的 677 个（含 `r_hci_*`），且经 `r_ip_funcs_p` / `r_modules_funcs_p` 等函数表调度；ROM 里只剩 `__call_*` 跳转桩 | — |
| a′. 按预编译库签名定位 HCI 边界 | 为每个 IDF 版本（5.1–5.5）从 `libbtdm_app` 提取 `API_vhci_host_send_packet` / `API_vhci_host_register_callback` 等函数的字节签名（屏蔽重定位字段），在用户 .bin 里匹配到地址后接管，后面接我们自己的行为级链路层 + 虚拟手机 | **只要 .bin** | 待探针：签名在不同 sdkconfig（日志级别、IRAM 放置）下是否稳定；Arduino-ESP32 自带的库是否同版本 | 行为模拟 |
| b. 寄存器级仿 BLE 基带 | 让 ROM + libbtdm 的真控制器跑，模拟 RW-BLE 基带的交换存储器 / 事件表 / 定时 | 只要 .bin | 最难：连接事件对时序敏感，需大量逆向 | 最高（接近仿真验证） |
| c. 按 ELF 符号拦截（esp-emu 路线） | 拦 `esp_vhci_host_send_packet` 等 | .bin + **app.elf** | 最容易 | 行为模拟 |

**建议**：先做 2 周探针验证 a′（用 bleprph 在 3 种 sdkconfig、IDF 5.3 / 5.5、Arduino 各编一份测匹配率）；a′ 不成就 c（ELF 作为"进阶上传"，网页提示"BLE 需要再拖一个 app.elf"）；两条路的链路层与虚拟手机是同一份，不浪费。b 不进计划。

## 6. 依据与原始材料

- README：https://github.com/espressif/esp-emulator/blob/main/README.md
- Releases：https://github.com/espressif/esp-emulator/releases
- 源码与授权问题：https://github.com/espressif/esp-emulator/issues/10
- 网页版：https://espressif.github.io/esp-emulator/
- esp32sim：https://github.com/mikroverk/esp32sim
- Wokwi 价格：https://wokwi.com/pricing
- 截图：`Reviews/compete/espemu-home.png`、`Reviews/compete/espemu-blink.png`
