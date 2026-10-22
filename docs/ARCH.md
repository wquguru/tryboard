# 架构

## 总览
```
用户固件（flash 镜像 / app.bin）
      │
      ▼
core/（Rust）  rv32 核 ──► SocBus（存储 + MMIO 外设）──► 事件：控制台、GPIO 变化
      │ 编译为 wasm（零依赖，~100KB）
      ▼
web/（Vite + TS）
  Worker：按墙钟节奏推进模拟（1× 实时 / 加速），每 ~4ms 回传状态
  主线程：three.js 3D 工作台、串口监视器、控制条
```

## crate 分层（R-05，2026-10-19）
- `tryboard-soc`（`crates/soc`）：所有芯片共用的部件，芯片差异用 `*Layout` 参数化。外设模型 `periph`（CPU_HZ、Uart、Systimer、Timg）、`i2c`、`spiflash`、`rmt`、`ledc`、`pcnt`、`i2s`、`gpspi`、`gdma`、`crypto_hw`、`sigin`（输入去毛刺）、`adc`、`usb/`（DWC2 + 虚拟主机，R-06 从 esp32s3 搬来）；芯片接口 `chip`（`trait Chip`、`Stop`，R-06）；外接器件 `devices/`（引脚器件、音频、GC9A01、SSD1306、BME280、IMU、触摸）；记录 `iotrace`、`vcd`、`tasktrace`；`boot::find_app`（分区表找 app）、`boot::image_chip_id`；Wi-Fi `wifi/`、BLE 内核 `ble/`。依赖只有 `tryboard-elec`（I2C 线长负载公式）。
- `tryboard-esp32c3`：只剩 C3 本体——`Esp32c3` / `SocBus` / `Stop`、存储映射常量、`lcd_pin` / `i2s_pin` 接线、`periph`（中断矩阵 Intc、`src` 中断源号、GPIO、EXTMEM、SARADC）、`boot`（ROM 装载、eFuse、`parse_app`（芯片 ID 5）、BLE 挂钩）、`hle`、`timing`、`ble`（RISC-V 侧 VHCI HLE）、`crypto_hw_tests`（经 C3 总线驱动 SHA / AES 寄存器）。为兼容 crate 内路径，lib.rs 用 `pub(crate) use tryboard_soc::{devices, i2c, …}`（R-06 起不再对外转发）。每个芯片 crate 的 `src/chip.rs` 实现 `trait Chip`。
- `esp32s3` / `esp32` 只依赖 `tryboard-soc`，不再依赖 `tryboard-esp32c3`；`machine` 只在 `Machine::boot` 构造处点名 `Esp32c3` / `Esp32s3` / `Esp32`（另读两个 `periph::NPINS` 元数据）；`cli` / `wasm` 依赖 machine、soc、elec 和 CPU 核 crate（rv32 / xtensa），不依赖任何芯片 crate（R-06 起）。

## 启动方式（ESP32-C3）
1. ROM：从 esp-rom-elfs 的 `esp32c3_rev3_rom.elf` 装 `.text`（0x40000000）、`.rodata`（DROM 掩膜窗口 0x3FF00000 → ROM 物理 0x40040000）、各 `.data*` 初值（DRAM 顶部 0x3FCDE710 以上）。
2. 解析 flash：分区表 0x8000 → factory / ota_0 → ESP 镜像头（0xE9）→ 段。
3. RAM 段直接拷进 SRAM；IROM（0x42xxxxxx）/ DROM（0x3Cxxxxxx）段按 64KB 页写 MMU 表（128 项，I/D 共用，线性地址 = vaddr & 0x7FFFFF）。
4. PC = 入口，SP = 0x3FCDE710（ROM `.stack_pro` 顶），与真 bootloader 跳入 app 时一致。

不跑 ROM bootloader 和 2nd stage bootloader（见 DECISIONS）。

## 存储映射（C3）
| 区域 | 地址 | 实现 |
|---|---|---|
| SRAM（I/D 双映射） | IRAM 0x4037C000–0x403E0000；DRAM 0x3FC80000–0x3FCE0000 = IRAM 0x40380000 起 | 一块 400KB 缓冲 |
| ROM | 0x40000000–0x40060000；DROM 掩膜 0x3FF00000–0x3FF20000 | 只读 |
| Flash（cache） | IROM 0x42000000、DROM 0x3C000000，各 8MB | MMU 翻译后读 flash 缓冲 |
| RTC 内存 | 0x50000000–0x50002000 | 8KB |
| 外设 | 0x60000000–0x600D1000 | 见下 |

## 外设模型约定
- 每个外设一个结构体，`read(off)` / `write(off, v)`，有时间行为的用 `now`（CPU 周期）惰性计算，`update(now)` 返回下一个事件时间。
- 没有模型的地址：写入保存、读回原值，并计入 `unimpl`（验收报告列 Top N）。
- 启动期需要特定读回值的寄存器集中在 `boot.rs::special_read`，每条注明原因。
- 中断：外设给出电平 → 中断矩阵（源 → CPU 线）→ 使能 / 优先级 / 阈值裁决 → `cpu.irq_line`。边沿型线锁存，写 CPU_INT_CLEAR 清除。
- 时间：CPU 恒定 160MHz、每条指令 1 周期（CPI 模型以后按真机标定）。SYSTIMER 16MHz、APB 80MHz、XTAL 40MHz、RC 慢时钟 136kHz。WFI 时直接快进到下一个定时器事件。

## Wi-Fi（ESP32-C3 / ESP32-S3 共用，`crates/soc/src/wifi/`，细节见 docs/WIFI.md）
- 分层：闭源驱动（libpp / libnet80211 / wpa_supplicant）照常跑；模拟器在 MAC 寄存器 + DMA 描述符层扮演硬件（`mod.rs`），空中帧交给虚拟世界（`world.rs` 的 4 个 AP → `net.rs` 局域网 → `tcp.rs` 虚拟互联网）。
- 芯片无关：`WifiMac::new(WifiLayout::C3 | S3)`，`read(a, now)` / `write(a, v, now, mem) -> Option<存回值>` / `update(now, mem) -> 下一事件` / `rf_read(a, 存值)`；内存经 `tryboard_soc::Mem`（GDMA 的 `DmaMem` 是它的别名）。两颗芯片的 SocBus 把 `wifi: Option<Box<WifiMac>>` 在发送 / 推进时临时取出、借总线访问描述符；密钥表在 MAC 里另存一份副本。差异只有射频轮询表（`rf_polls`）和芯片侧的随机数寄存器、温度传感器（见 WIFI.md「S3」）。
- WPA2-PSK（`wpa.rs` + `crypto.rs`）：虚拟 AP 是认证方，关联后发起四次握手（PMK = PBKDF2-HMAC-SHA1、PTK = PRF-384、MIC = HMAC-SHA1-128、GTK 用 AES Key Wrap），握手完成后空中数据帧一律 CCMP；消息 1 / 3 按 hostapd 节奏重传（100ms、1s、1s），4 次没回应发去认证（原因 15）。
- 加解密分两处，与真机一致：
  - **四次握手在固件里**（IDF wpa_supplicant），它用 mbedTLS → 硬件 SHA / AES 加速器（`crypto_hw.rs`，块模式 + DMA 模式）。
  - **数据帧 CCMP 在 MAC 硬件里**：驱动把 PTK / GTK 写进密钥表（0x60034400 起每项 40 字节，有效位图 0x60033814，字 1 位 30 = 组密钥），发送时帧里已有 CCMP 头（PN）和 8 字节 MIC 空位，MAC 模型按 a1 查成对密钥加密后上"空中"；接收时按 a2 查成对 / 组密钥解密，CCMP 头与 MIC 位置保留（驱动的 `ccmp_decap` 校验 PN 后剥掉）。
- 固件自建热点（C-02，`phone.rs`）：芯片经 AP 接口发的帧按 Rx 头 `hdr[0]` 第 29 位回送；World 从芯片信标学到 `ap_mac`，发给它的帧交给虚拟手机（扫描 / 认证 / 关联 / WPA2 请求方 / DHCP / DNS / HTTP，联网探测判「需要登录」）。手机定时器并进 World 的 `next_timer`，固件自己重启时保留。拿起手机时多一台路由器 MyHome（192.168.5.1，芯片拿 .100）。脚本动作 `phone=`；wasm `tb_phone_cmd / tb_phone_json / tb_net_json`，网页底部坞「网络」页签（`web/src/app/netpane.tsx`，数据 `netfeed.ts`），固件发过 Wi-Fi 帧（或拿起过手机）才出现。
- 真实网络（C-03，`tcp.rs` 发件箱 + `web/src/realfetch.ts`）：开关开着时，Host 不是 tryboard.local 的 HTTP 请求交给浏览器 fetch，回复写成脚本动作 `netreply=` 进输入日志再施加给内核，实时 / 验收 / 回退 / CLI 重放只认这条动作；HTTPS 与非 HTTP 端口不放行。wasm `tb_realnet_set / tb_net_outbox / tb_net_reply`。细节见 WIFI.md 阶段 6。
- 密码学原语全部自己实现（`wifi/crypto.rs`：SHA-1、HMAC、PBKDF2、PRF、AES-128/192/256、Key Wrap、CCM、CCMP），按 FIPS 180 / RFC 2202 / RFC 6070 / IEEE 802.11 附录 / FIPS 197 / RFC 3394 / RFC 3610 / NIST SP 800-38A 测试向量做单元测试。

## SHA / AES 加速器（ESP32-C3 / S3，`crates/soc/src/crypto_hw.rs`）
- 两颗芯片寄存器排布相同；`ShaHw::write(off, v, 链头, mem)` / `AesHw::write(off, v, (输入链头, 输出链头), mem)` 不依赖 SoC，链头由 SoC 先从自己的 GDMA（`sha_link` / `aes_links`）取。
- SHA（0x6003B000）：SHA-1 / 224 / 256，START / CONTINUE 处理 TEXT 寄存器里的一块，DMA_START / DMA_CONTINUE 从 GDMA 取 BLOCK_NUM 块；H 寄存器按"摘要字节小端装载"存（`sha_hal_read_digest` 直接 memcpy 成摘要）。BUSY 恒为 0。
- AES（0x6003A000）：128 / 256 位，单块模式（TEXT_IN → TEXT_OUT）与 DMA 模式（ECB / CBC / OFB / CTR / CFB8 / CFB128，IV 寄存器随运算更新），DMA 完成 STATE = 2、写 DMA_EXIT 回 0。
- GDMA 不在这里建模：按 OUT/IN_PERI_SEL（AES = 6、SHA = 7）找到接到本外设的通道，读 OUTLINK / INLINK 描述符地址，沿 lldesc 链读写、清 owner 位。GDMA 模型落地后改成走它的接口（见 DECISIONS）。

## 芯片无关外壳（`core/crates/machine`）
- `Machine { hw: Box<dyn tryboard_soc::chip::Chip>, chip: Chip, … }`（R-06）：`Machine::boot` 按镜像头芯片 ID（0 / 5 / 9）构造对应 SoC 装箱，之后所有调用都走 trait（运行、控制台、GPIO 读写、PWM、ADC、WS2812、I2C 器件、OLED、SPI 圆屏、trace、Wi-Fi / BLE / USB、调试状态）。按芯片的 `match` 只剩构造处和 `enum Chip` 元数据表（id、名字、ROM 文件、BOOT / RGB 引脚、引脚数；启动前 CLI 就要用）。
- 分派按批次：`Chip::run(cycles)` 一次跑一批，指令循环在芯片 crate 里单态化；动态分派开销摊到整批上（R-06 实测速度与改前相差在噪声内）。
- 只有部分芯片有的功能（PCNT、ADC 模型、圆屏、I2S 器件、BLE、USB、`--watch` / `--dump` / `--dump-intc`、时序报告）在 trait 里有缺省实现（None / false / 空），machine 和 CLI 按「有没有」处理，不按芯片类型判断。

### 新增一款芯片（清单）
1. 新建 `core/crates/<chip>`，只依赖 `tryboard-soc`（和对应 CPU 核 crate）；共用外设从 soc 拿，差异用 `*Layout` 参数化。
2. 在 `<chip>/src/chip.rs` 实现 `tryboard_soc::chip::Chip`：
   - 必须实现：`run` / `run_traced` / `reboot` / `hold` / `cycles` / `instret` / `pc` / `cores` / `debug_state` / `rom_banner`；`mmio_window` / `bus_poke` / `peek` / `unimpl` / `kick_events` / `kick_pins`；`console_take` / `console_push` / `uart_push`；`gpio_level` / `gpio_enable` / `gpio_reset_level` / `gpio_drive` / `gpio_log` / `pin_pwm` / `ws2812` / `analog_set`；`i2c0` / `i2c` / `pins` / `audio` / `audio_mut`；`iotrace` / `tasktrace`；`wifi` / `wifi_mut`。
   - 按需覆盖（缺省 = 没有）：`pcnt_count`、`adc_model(_mut)`、`lcd_attach` / `lcd` / `spi2_stats`、`attach_speaker` / `attach_mic`、`timing_line` / `timing_json`、`ble` / `ble_mut` / `ble_error`、`usb` / `usb_mut`、`set_watch` / `watch_hits` / `dump` / `intc_report`。
   - 芯片自己的 `Stop` 在 `chip.rs` 里转成 `tryboard_soc::chip::Stop`（故障描述文字进金标准，定了就别改）。
3. 登记：`machine` 的 `enum Chip` 加一项（`ALL`、`id`、`name`、`rom_file`、`boot_pin`、`rgb_pin`、`npins`），`Machine::boot` 加一个构造分支；`tryboard-elec` 的 `ChipKind` 加一项（供电 / 功耗表）；machine、cli、wasm 的 Cargo.toml 只有 machine 需要加依赖。
4. ROM：`tools/fetch_third_party.sh` 拉对应 ROM ELF（LICENSING ✅ 才行）；`core/crates/machine/tests/mmio_fuzz.rs` 加一个 `<chip>_mmio_fuzz`。
5. 验收：`firmware/` 加该芯片的 hello / blink 等用例并写进 `firmware/accept.json`；`tools/golden.py save` 补金标准；跑 `cargo test`、`tools/accept.sh`、`tools/golden.py check`；R-13 的 id 交叉检查（固件 JSON / 目录 / CLI 名）要能认出新芯片；`docs/STATUS.md` 加一行。
- 线束（P2-11，估算）：`Machine::harness`（I2C 排线总长、天线遮挡 dB）是外部世界，跨软件复位保留、复位后重新挂到新总线 / Wi-Fi 模型上。I2C 控制器按 `tryboard-elec::i2cbus` 的公式（总线电容 → 上升时间，和固件配置的 SCL 频率对应的规范上限比）决定读回字节是否丢 0→1 的位、地址是否不应答；虚拟世界按遮挡降低所有 AP 的 RSSI，低于门限扫描收不到 / 认证不回。CLI `--i2c-wire` / `--antenna-loss`，脚本 `i2cwire=` / `antenna=`，wasm `tb_i2c_wire` / `tb_antenna_loss` / `tb_harness_report`
- USB 关卡观察（P2-12）：`tryboard_machine::usb_report_lines` 给出"USB 主机：状态"与"USB 键盘输入: …"两行，CLI `--usb-log` 与 wasm `tb_usb_report` 共用；关卡带 `--usb-log` 时进观察记录（指纹）

## FreeRTOS 任务时间线（C-04，`crates/soc/src/tasktrace.rs`，C3 / S3 共用）
- 只靠 .bin：FreeRTOS 换任务的最后一步都是"栈指针 ← 新任务 TCB 第 0 字（pxTopOfStack）"。CPU 核在 `lw sp,0(rs1)`（RISC-V）/ `l32i(.n) a1,aN,0`（Xtensa，fast 路径里是 Op::Generic）执行后调总线钩子 `Bus::sp_loaded(core, base)`，核号取 PRID。
- 判 TCB（IDF v5.5 布局）：`mem[T+16]==T`（xStateListItem.pvOwner）、`mem[T+36]==T`（xEventListItem.pvOwner）、T+52 起是可打印任务名；优先级 T+44、绑核 T+68。签名不对的 SP 装载忽略（中断栈、协程切换等）。
- 被切出任务的状态：状态链表仍是就绪表 → ready；事件链表非空 → wait（等队列 / 信号量）；否则 blocked（延时 / 挂起）；签名坏了 → gone（删除）。恢复 PC 从新栈帧读（RISC-V 偏移 0、Xtensa 4）。
- 记录 16 字节：`t u64 | core u8 | prev u8 | task u16 | pc u32`（小端，周期戳），任务表按 TCB+名字去重（TCB 复用 = 新条目）；缓冲满了计 dropped，不覆盖。默认关，`tasks_enable(cap)` 打开；软件复位继续记、换核上无任务记 NO_TASK。
- `report::{slices, usage, chrome_json}`：每核切片、占用、Chrome Trace Event JSON（进程 1 每核一轨、切片名 = 任务名；进程 2 每任务一轨，在跑 + 「等待」段）。微秒用整数算、半数进位，网页 `web/src/app/tasktrace.ts` 逐字相同。
- 时间片：CLI `--trace-tasks` 强制 1 ms 片，与网页 worker 相同，切换周期两边逐个一致（`tools/webtest/tasks.mjs`）。
- wasm 导出：`tb_tasks_enable(cap)`、`tb_tasks_take() -> 字节数` + `tb_tasks_ptr()`（取走增量记录）、`tb_tasks_json() -> 字节数` + `tb_tasks_json_ptr()`（`{"cores","dropped","tasks":[{name,prio,core,tcb}]}`）。worker 每次 flushIo 发 `{type:'tasks', reset, data, table, chip}`，网页 `taskStore` 收；底部坞「任务」页签（`web/src/app/tasks.tsx`）画泳道、最近 1 s 占用、导出 Perfetto、可选上传 app.elf 把恢复 PC 翻成函数名。

## 供电网络（`core/crates/elec`，C3 / S3 共用）
- `mna.rs`：节点电压法 + 隐式欧拉；元件 R / C / V（理想或带内阻）/ I / Limit（带限流的源）/ Ldo / Load（恒流，低于 vknee 退成电阻）/ Motor（舵机电机：max(0,(min(v,vcmd)−emf)/r)）。分段线性元件用 Katzenelson 法解（见 DECISIONS「电气模型」），稠密 LU 部分主元。`spice.rs` 读 SPICE 子集（R/C/V/I、.op、.tran，`*tb:` 行写自定义元件），CLI `tryboard elec-net` 用它与 ngspice 对照（`tools/elec/compare.py`）
- `board.rs`：开发板网络（5V 轨、3V3、舵机红线、外接 5 V 四个节点；USB 口 0.5 A 限流、外接 5 V 2 A、SGM2212 LDO、去耦电容、芯片 / 模块 / 舵机负载；5 V 模块（HC-SR04）接了才在 5V 轨上加恒流负载）。固定 100 µs 一步、只走整步。3V3 < 门限（S3 2.44 V / C3 2.51 V）持续 0.12 ms → 欠压复位，按住到电压回升
- `servo.rs`：SG90 二阶动力学（比例控制 + 电机 + 减速箱），给电流和角度，不影响固件读数
- 接法：`Machine { hw: Box<dyn Chip>, elec: Board }`。`Machine::run` 跑完一段后按这段的活动（忙的核数 = 指令数 / 周期数、Wi-Fi 收发帧、舵机脚 PWM 脉宽）推进 `elec`；触发欠压就以 `Stop::Reset(15)` 结束，调用方 `reboot(15)`；按住期间 `run` 不执行指令、只走时间。`reboot` 往串口补 ROM 头三行（`rst:0x..`），第一次上电不补
- CLI：`--power usb|ext`（默认 usb）、`--servo GPIO`（接了就 1 ms 一片）、`--elec-report`（`[tryboard] 电气 …` 各节点最低电压、峰值电流、复位次数与时刻）、脚本动作 `power=usb|ext`；`tryboard elec-net 网表 [--at 秒,…]`
- wasm：`tb_power_set(0 usb|1 ext)`、`tb_servo_attach(pin)`、`tb_elec_v(1 5V|2 3V3|3 舵机|4 外接)`、`tb_elec_i(0 USB|1 外接|2 舵机|3 3V3|4 芯片)`、`tb_elec_stat(0..8)`（最低电压、峰值电流、复位次数、是否按住）、`tb_elec_brownout_t(i)`、`tb_servo_angle()`、`tb_elec_report()`（文字同 CLI，读 `tb_report_ptr`）

## 浏览器
- wasm 导出见 `core/crates/wasm/src/lib.rs`（`tb_*`）。没有 import，实例化时传 `{}`。主线程先读镜像头判断芯片、下载对应 ROM，再 `tb_boot`；`tb_chip` / `tb_boot_pin` 告诉前端换哪块板、BOOT 键在哪个脚；S3 的 GPIO32 以上用 `tb_gpio_level_hi` / `tb_gpio_enable_hi`。
- 资源：`/wasm/tryboard.wasm`、`/rom/esp32c3_rev3_rom.elf`（附 Apache-2.0 LICENSE）、`/fw/<示例>/flash.bin` 与 `/fw/examples.json`。
- 渲染：three.js WebGL2 + 后期泛光（LED 发光）。WebGPU 等 three 的 WebGPU 渲染器稳定后再切。
- 页面（站内链接不带 .html 后缀，统一由 `src/ui/links.ts` 生成；DESIGN_V2 §7.2）：`app.html` 工作台（采购 / 实验台 / 组装 / 成品四步，`src/app/`；示例 = `?work=blank&example=<id>#bench`）、`index.html` 首页 `/`（React，`src/home/App.tsx`；带 `?example=` 时先跳到工作台示例；作品卡的示意图 / 真实固件运行在 `src/home/cards.ts`）、`home.html` / `advisor.html` / `levels.html` 旧地址跳转页（纯 html，`<head>` 里跳，保留 query 和 hash）、`select.html` 选板 `/select`（React，`src/advisor/App.tsx`，见下节）。公共资源加载在 `assets.ts`；首页的实时运行用 `live.ts`（包一层 worker.ts）。
- 资源缓存（R-19，托管缓存）：`tools/asset_hashes.py` 在 build_web.sh 末尾（字体切片、gzip 旁文件之后、vite 之前）对 `web/public` 里固定文件名的大资源（`wasm/*.wasm`、`rom/*.elf`、`fw/examples.json`、`fw/*/{flash.bin,src.json,src.zip}`、`audio/*.wav`、`fonts/fonts.css`）算 sha256 前 10 位，写 `web/asset-hashes.json`（git 忽略）；vite.config.ts `assetHashes()` 把它内联进每个 HTML（`window.__TB_ASSETS__`，gzip 约 1.8 KB）并给 fonts.css 链接加 `?v=`。`web/src/assetver.ts` `assetUrl(url, key?)` 查表加 `?v=<hash>`（`.gz` 旁文件用原文件的 hash；没有表 = dev 未构建 / node 测试 / npm CLI → 原样；b64 打包页不加）；`fetchBuf` 内部调用，另外 `examples.ts`、`code.tsx`（src.json）、checkpoint 下载链接显式调用。新增固定名资源要进 `PATTERNS` 并走 `assetUrl`。woff2 由 subset.py 直接按内容命名（`tb-mono.<hash>.woff2`，head.modified 固定，重建逐字节相同）。
  托管建议：`web/public/_headers`（Netlify / Cloudflare Pages 语法，vite 原样拷到 dist）把 `/assets/*`、`/fonts/*`、`/wasm/*`、`/rom/*`、`/fw/*`、`/audio/*` 设 `public, max-age=31536000, immutable`，页面（`/`、`/app` 等及 `.html`）设 `no-cache`；同一路径只能有一条规则写 Cache-Control（Cloudflare Pages 会把重复值用逗号拼起来，Netlify 未核实），所以不写 `/*`。其余路径（favicon、og.png、models/*.glb、NOTICES）用托管默认（两家默认都是 `max-age=0, must-revalidate`，靠 ETag 回 304）。别的托管（S3 + CloudFront、nginx、GitHub Pages）照这两类配：GitHub Pages 不能自定义头（统一 max-age=600），只能吃到 `?v=` 的「内容变 URL 必变」，拿不到长缓存。查询串必须进 CDN 缓存键（CloudFront 默认不进，要在缓存策略里打开），否则新旧版本会串。长缓存目录下还有不带 hash 的 `rom/*.txt`、`fonts/OFL-*.txt`（许可证文本，页面不链接），改了要等缓存过期——它们只随上游许可证变。
- SVG 视图（`src/views/`）：`bench`（面包板）、`product`（成品）、`assembly`（拖拽装配，装完切到成品）、`showcase`（成品示意，不跑固件）。视图只画，数据来自模拟器帧（OLED 像素、各脚 PWM 占空比、板载 WS2812）；舵机角度由 50 Hz 脉宽换算。
- SVG 视图补充：`templates.ts` 是装配模板（零件、装法、检查、影响、成品工厂），`assembly.ts` 只是通用引擎；`lcdproducts.ts` 是圆屏成品（spin / lens），画面来自 worker 的 `lcd` 消息（GC9A01 240×240 RGBA，变化才发、≤ 30 帧/秒）。3D 实验台里圆屏是一块圆形贴图（board3d.ts `roundLcdModule`）。
- PWM 观察：CLI 与网页在汇总行之后都输出 `[tryboard] PWM GPIOn 变化 占空比@时刻 …`（三位小数相同的相邻记录合并），关卡用它判"脉宽依次出现的台阶"（`pwm.steps`）和"稳定以后的值"（`pwm.from` 秒）。
- 第 07 关这类"多个成品可选"的关用 `variants`，CLI 和网页都展开成 `07-spin` 这样的子关（`expand` / `expandLevels`）。
- 供电（P1-02 / P1-04）：worker 的 `boot` / `seek` 带 `servo`、`power`；`power` 消息在线切换（记进输入日志 `supply` 事件，导出 `power=usb|ext`）；tick 带 `elec`（`ElecFrame`：节点电压、电流、3V3 最低、峰值、复位次数、按住、舵机角度）和 `brownouts`（新复位的模拟时刻）。实验台：供电属性面板 / 快捷卡片显示实时值并切换供电，时间线记"欠压复位"，工具条"万用表"点针读电压（`pinscope.meterVolts`），3D 舵盘用动力学角度（`Bench.setServoAngle`）。验收 worker（verify-worker.ts）认 `--servo / --power` 参数与 `power=` 脚本，接了舵机也 1 ms 一片
- 作品专属检查点（`spin-1`、`spin-2`、`lens-1`、`lens-2`）是 levels.json 顶层条目，带 `"work"` 字段；作品走哪几个检查点写在 `web/src/app/works.ts`（首页卡片的检查点数也读它）。小黄：spin-1 → spin-2 → 07-spin；透镜：lens-1 → lens-2 → 07-lens（07 的变体就是"合体"，带装配）。
- 圆屏判定：观察记录在"非黑像素"行之后追加颜色统计 `[tryboard] LCD 颜色 #rrggbb N 像素，重心 x,y`（圆内各非黑颜色，前 12 种、≥ 50 像素，`Gc9a01::color_report`，CLI 与 wasm 共用）；levels.json 的 `lcd_colors` 按颜色容差求和、可限水平重心，`serial_count` 数串口某段文字出现的次数。
- 实时运行（worker.ts）时间片固定 1ms（`tb_run(160000)`），外部输入只在时间片之间施加，并按施加那一刻的 CPU 周期记进输入日志（`inputlog.ts`）。CLI `--inputs` 同样全程 1ms 一片、在时间片开头施加 `t ≤ 当前模拟时间` 的输入，所以网页上的一串操作导出后能逐周期重放（S3 双核交替点也一致）。格式见 DECISIONS 2026-10-16「输入日志」。
- 蜂鸣器（audio.ts）：worker 对 `watchPwm` 的引脚每片采样占空比与频率（`tb_pin_pwm_freq`），变化带模拟时刻放进 tick 的 `pwmEvents`；主线程把模拟时刻映射到 AudioContext 时间轴（领先 60ms，偏离超过 0.4s 重新对齐），方波振荡器 + 增益开关。测试读 `window.__tbAudio`。
- 逻辑分析仪事件（P1-05，`crates/soc/src/iotrace.rs`）：SocBus 里一个有上限的环形缓冲，按 CPU 周期盖戳记 GPIO（只记 watch 掩码里的脚，在 `gpio_changed` 里比较）、PWM（`update` 里 LEDC 修改计数或 GPIO 使能 / 矩阵变了才扫各脚 `pin_pwm`）、WS2812 帧（`route_rmt` 里解码器帧数变了）、I2C 事务（`I2c::run_commands` 按命令表产生 START / ADDR / DATA / STOP，时刻按 SCL 位推算，SocBus 写完寄存器后搬进缓冲）。CLI `--trace-io` 每片取走写文本；wasm `tb_io_take` 拷成 16 字节记录，worker 攒着随 tick 发 `io` 消息（上电 / 回退先发 reset），主线程 `app/iotrace.ts` 的 IoStore 按通道整理、解 I2C 事务，`app/analyzer.ts` 画。格式与上限见 DECISIONS「逻辑分析仪事件缓冲」
- ⌘K（P1-06，`app/cmdk.ts` + 纯函数 `app/cmdmatch.ts`）：候选 = 命令（含按输入生成的"把室温设为 N ℃""回到第 n 次运行"）+ 零件 + 引脚（listPins）+ 检查点 + 运行；执行走 store / session / 时间线现有接口
- 关卡验收：`firmware/levels.json` 是唯一来源，判定规则在 `tools/check.py` 和 `web/src/checks.ts` 各写一份、逐条对应。浏览器里由 `verify-worker.ts` 按**模拟时间**跑（不看墙钟），时间片 / 脚本施加 / PWM 采样照搬 CLI `run` 的循环；观察记录用 wasm 的 `tb_report`（与 CLI `--gpio-log --ws2812-log` 同格式）。运行指纹 = FNV-1a(串口原始字节 + `\n#report\n` + 规范化观察记录)，`tools/webtest/levels.mjs` 逐关核对网页与命令行指纹相同。

## wasm 接口与 worker 消息（R-07）
- `web/src/wasm.gen.ts` 由 `tools/gen_wasm_ts.py` 从 `core/crates/wasm/src/lib.rs` 生成，不手改；改了导出就重跑脚本（accept.sh 会查是否过期）。
- 主线程 ↔ worker 的消息类型只在 `web/src/simmsg.ts` 定义，worker.ts / live.ts / app 各处都从它 import。
- wasm 只编译一次（R-23）：`assets.ts` `loadWasmModule()` 缓存 `WebAssembly.Module`，`boot` / `seek` / 验收 job 里 `wasm` 是 Module（结构化克隆共享代码）；`boot` / `seek` 的 ROM / 固件带 `romId` / `flashId`（live.ts 按 ArrayBuffer 身份编号），worker 已有该 id 时省略字节（ROM 每芯片一份、固件只留最新）。`simrun.ts` 的 `SimJob.wasm` 字节或 Module 都收（npm CLI 传字节）。

## 网页 2D 界面（React，2026-10-17 起，见 DECISIONS 同日）
- 栈：React 19 + Tailwind v4（`@tailwindcss/vite`）+ shadcn 风格组件（Radix 原语），仍是 Vite 多页面构建，不用 Next.js。公共件在 `web/src/ui/`：`tailwind.css`（唯一的颜色变量定义 + `@theme` 映射，亮暗两套）、`cn.ts`、`components.tsx`（Button / Badge / Card / Chip / Checkbox / Collapsible / StatusList / Table / ThemeToggle）。新组件先加到这里，页面里不重复写一套。
- 页面入口：`<页面>.html` 里只放 `<div id="root">` 和 `src/<页面>/main.tsx`；`<head>` 的主题内联脚本保留（首帧前定 data-theme）。Tailwind preflight 只在引了 `ui/tailwind.css` 的页面生效，没迁的页面不受影响。
- 颜色：只用 token 类（`bg-surface`、`text-muted`、`border-line`…），不写十六进制。浅底上的文字用 `*-ink`（`text-accent-ink`、`text-ok-ink`…，WCAG AA 4.5:1），白字蓝底用 `bg-accent-strong`；原色（`accent` / `ok` / `warn` / `bad`）只用于边框、圆点、图形。暗色下 ink 与原色相同。页面不各自定义变量。首页沿用 DESIGN §2 的白底蓝色（A 版）；原 site.css 的暖灰橙色板没有页面在用，已删除，没有映射进 `ui/`（DECISIONS 2026-10-17「首页、关卡页迁 React」）。台面渐变 `--stage-bg` 也在 tailwind.css 里（不是颜色 token，用 `[background:var(--stage-bg)]`）。
- 命令式模块（three.js 场景、worker、wasm、canvas 逻辑分析仪 / 波形 / 示波器）不进 React 渲染：组件里 `useRef` 拿容器、`useEffect` 里创建并在清理函数里销毁。每秒十次以上的数据（模拟时间、串口流、tick 帧）不放进 React state：直接写 DOM ref 或 canvas，或经外部 store + `useSyncExternalStore` 且节流到 ≤ 10 Hz。
- 旧实验台（index.html，`src/lab/`）已在 U-07（2026-10-17）删除：功能全部并入 app.html 的实验台步骤（`src/app/steps/bench.tsx` + `src/app/session.ts`），示例卡、麦克风声源、换固件、元件库、输入日志导出都在那里。元件编辑器的数据与冲突检查仍在 `src/editor.ts`。`views/views.css`（装配视图）由 app.html / home.html 共用。
- 不用 `innerHTML` / `dangerouslySetInnerHTML`（JSX 默认转义）；确有必要（如授权页的生成 HTML）写明来源可信的理由。
- 测试契约：`tools/webtest/*.mjs` 依赖的 id / class / `data-*` / 文案保持不变；确要改，同一提交里改测试脚本，判据不放宽。每迁一页要做：新旧页面状态逐条文字对比（脚本放 `Reviews/ab/react/`）、agent-browser 亮色 / 暗色 / 390px 宽走查截图、`agent-browser a11y` 零违规、console 无 error、`tools/accept.sh --no-qemu` 全过。

## 网页实验台目标结构（R-08 ～ R-12，2026-10-19）
- `app/steps/bench.tsx` 只留 `benchStep()` 骨架（< 500 行）：建 `BenchCtx`、按顺序挂各分节、汇总卸载。原闭包里的共享变量（ctx、bench 句柄、openGroups、选中件、unsubs 等）收进显式 `BenchCtx`（`app/bench/ctx.ts`），各分节写成 `app/bench/<分节>.ts(x)`，导出 `mount<分节>(b: BenchCtx): () => void`（返回清理函数），分节之间不互相 import，只经 BenchCtx 的字段 / 回调通信。
- `board3d.ts` 的 `createBench()` 拆到 `web/src/bench3d/`：`boards.ts`（开发板）、`modules.ts`（器件网格，原 `*Module()` / `*Model()`）、`pick.ts`（拾取与拖放）、`wires.ts`（导线）、`stage.ts`（渲染器、相机、灯光、后处理、shaderWarm、渲染循环），另有 `util.ts`（共用材质 / 纹理）、`spec.ts`（PartSpec / SceneSpec）、`ctx.ts`（显式上下文 `BenchCtx`，各 `mount*(ctx)` 按原顺序挂载）、`scene.ts`（场景状态、setScene）、`build.ts`（各器件摆放）、`inspect.ts`（高亮、故障、热区、量尺）；`board3d.ts` 只留 `createBench` 组装与对外 `Bench` 接口，外部 import 路径不变。
- 实验台 UI 组件库原 `app/benchv2.tsx` → `app/bench/ui/`（按组件分文件，去掉 v2 命名）。
- 帧调度（R-11 已落地）：`ui/frame.ts` 是全页唯一的 rAF 循环，其余文件不得直接调 `requestAnimationFrame` / `cancelAnimationFrame`（`tools/lint_size.py` 的 raf 规则，allow 列表为空）。新代码一律：
  - 每帧：`const off = onFrame((t, dt) => …, { priority, el?, visible?, immediate? })`，返回退订函数（原来存 rAF id 的字段改存它，停止 / 卸载时调用）。`priority` 用 `PRIO`：`sim` 0（模拟驱动的状态）→ `render` 10（3D 渲染）→ `warm` 11（shaderWarm 的逐帧计数，必须在渲染之后）→ `ui` 20（DOM 叠层、动画，缺省）；同优先级按订阅顺序。
  - `el`：该元素不在屏幕上（滚出视口、所在步骤 display:none）时跳过，用 IntersectionObserver，不每帧读布局；3D 视图都传自己的容器。`visible()` 是自定义条件，每帧调用，要便宜。`immediate` 订阅时先同步跑一次（原来「先调一次 tick 再排 rAF」的写法）。
  - `dt` 是该订阅者距上次被调用的毫秒数（首帧 0），被跳过或页签隐藏期间的间隔会整段算进去，动画要自己限幅（如 `Math.min(0.05, dt / 1000)`）。
  - 一次性：`afterFrame(fn)`（测量布局、下一帧聚焦，返回取消函数）、`await nextFrame()`；合并到每帧一次的写法用布尔标记 + `afterFrame`（见 `dock.tsx` 的 stick / peek）。
  - 没有订阅者时不排下一帧；`document.hidden` 时暂停，visibilitychange 恢复；单个订阅者抛错只 `console.error` 一次，不影响其他订阅者与循环。测试用 `createFrameLoop(env)` 注入假 rAF / document（`web/test/frame.test.ts`）。
- 按需加载：底部坞各面板（分析仪 / USB / BLE / 网络 / 任务 / 代码）与非当前步骤（选购 / 组装 / 成品）用 `React.lazy` / 动态 `import()`，首屏只含实验台与串口。
- 测试契约不变：webtest 依赖的 id / class / `data-*` / 文案保持；拆分是纯搬移，不改行为。

## 引脚器件、PCNT、RMT 接收（P2-01 / P2-04 / P2-05）
- 引脚器件（`crates/soc/src/devices/pins.rs`，C3 / S3 的 SocBus 都挂 `pins: PinDevices`）：输出带精确时刻波形的外接器件放在 SoC 里，不在 1 ms 时间片之间施加。`poll(now)` 给出到 now 为止的驱动 `(周期, 引脚, 电平)`，SoC 的 `pins_update` 按时刻写 `gpio.ext_in / ext_driven` 并调 `gpio_changed(t)`（照常触发 GPIO 中断、iotrace、PCNT / RMT 接收）；下一次要问的时刻进 `next_event`（WAITI 快进也会停在这里）。`gpio_changed` 在电平变化时调 `pins.on_level(t, 电平)`，让器件看到芯片输出（HC-SR04 的 Trig）
  - EC11 编码器：A/B 正交，一格四个沿、沿间隔 0.5 ms（`ENC_EDGE_CYCLES`），顺时针 A 先落；`turn(steps)` 排队，`press(down)` 按下接地 / 松开悬空。上电驱动 A=B=1（模块上拉）
  - HC-SR04：Trig 高 ≥ 10 µs 的下降沿后 250 µs 拉高 Echo，宽 2 × 距离 / 343 m/s；2–400 cm，`None` / 超量程 38 ms；回波没结束时的触发不理。距离由外部（脚本 `dist=`、网页射线）设
- 红外链路（`devices/ir.rs` 的 `IrLink`，挂在 `pins.ir`）：眼睛看红外 LED 引脚。RMT 发送按真实载波边沿喂 `feed(t, 电平)`（`PinDevices::rmt_ir`）；LEDC 不逐周期翻引脚，改由 `trace_pwm` 每次 PWM 重扫（LEDC rev 变化或 GPIO 矩阵变化）调 `PinDevices::ledc_ir(t, pin, pwm)` → `IrLink::feed_carrier(t, on, hz)`：0 < 占空比 < 1 为包络开（载波 = LEDC 频率），0 / 100 % / 关输出为包络关；包络关时把整段当一个 burst 交给与 RMT 相同的成帧 / NEC 解码（20–60 kHz 才算载波，否则计入 unmodulated）。trace_pwm 在 pins_update 之后，帧结束（15 ms 空闲）在下一次 update 判出，记录时刻按帧末计算，不受影响
- 外设输入取样：S3 `feed_inputs(t, 电平)`、C3 `feed_rx` 在每次 `gpio_changed` 与 RMT 发送改了引脚之后，按 GPIO 矩阵（FUNCn_IN_SEL_CFG：S3 sel[5:0] / inv[6] / 经矩阵[7]，常量 0x38 / 0x3C；C3 sel[4:0] / inv[5] / 经矩阵[6]，常量 0x1E / 0x1F）算出 PCNT 16 路输入（信号 33..48）与 RMT 接收输入（信号 = RMT_SIG_IN0 + i，与输出同号）的电平，带时刻喂进去。电平没变也可以喂（内部只认跳变）
- 毛刺滤波（`sigin.rs` 的 `Deglitch`，PCNT 与 RMT 接收共用）：跳变先挂起，稳定满门限才生效，所以两个沿都推迟门限时长、脉宽不变；短于门限的脉冲被吞掉。挂起的跳变到期时刻进 `next_event`
- PCNT（`pcnt.rs`，0x60017000，中断源 41，只有 S3）：4 单元 × 2 通道，寄存器按 pcnt_reg.h；脉冲输入的沿按 pos / neg 动作（1 加 2 减）、按同通道控制输入的电平用 hctrl / lctrl 改写（1 反向、2/3 禁止）；CTRL 的 rst 位置 1 期间计数清零、pause 位暂停。每步后比较：到 h_lim（>0）/ l_lim（<0）触发事件并清零，否则 thres0 / thres1 / 0；有事件就锁存 STATUS[6:2]（替换上一次）、置 INT_RAW 单元位；zero_mode 按变化方向更新。IDF `pulse_cnt` 的 accum_count 靠"到限清零 + 中断里读 STATUS 累加"
- RMT 接收（`rmt.rs`，S3 通道 4–7 / C3 通道 2–3，按 `RmtLayout` 的 `rx_conf0`、`rx_mem_shift`、`rx_end/err/thr_bit` 参数化）：CONF1.rx_en 上升后等第一个跳变；每段电平按通道分频的 tick 写半个条目（时长上限 0x7FFF）；电平保持 ≥ idle_thres tick 结束：当前电平写成时长 0 的半条目、补齐最后一个条目，置 RX_END；STATUS 的 mem_waddr_ex = 通道起始条目号 + 已写条目（IDF 减去起点得到条目数）。rx_lim + 回绕时每 lim 个条目置阈值中断（乒乓），不回绕写满置出错并停止。mem_wr_rst 复位写指针
- 对外：CLI `--encoder A,B[,SW]`、`--sonar TRIG,ECHO`、`--dist 厘米`，脚本动作 `enc=+N|-N`、`encsw=1|0`、`dist=厘米`（负数 = 没有障碍物），结尾打印 `[tryboard] 编码器 转了 N 格…PCNT 单元 0 计数 C` / `[tryboard] 超声波 触发 N 次，回波 M 次，最近一次 Echo W µs`；接了这两种器件时 CLI 与 simrun 都 1 ms 一片。wasm `tb_encoder_attach(a,b,sw|-1)`、`tb_encoder_turn`、`tb_encoder_press`、`tb_encoder_pos`、`tb_pcnt_count(u)`、`tb_sonar_attach`、`tb_sonar_distance`、`tb_sonar_stat(0 触发 / 1 回波 / 2 宽度µs)`
- 网页：`PartSpec` 加 `encoder {a,b,sw?}`、`hcsr04 {trig,echo,divider?,cm?}`；worker `boot` / `seek` 带 `encoder` / `sonar`（seek 时 cm 给 NaN，初始距离就是日志 0 时刻那条 `dist`），消息 `enc` / `encsw` / `dist` 进输入日志（`dist` 施加前取整到 0.01 cm，导出脚本两位小数才逐周期重放），tick 带 `pins`（`PinDevFrame`）。InputLog 加 `encoder` / `sonar`，`cliArgs` 拼 `--encoder` / `--sonar`。3D：编码器旋钮左右拖（14 px 一格）、滚轮一格、按住 150 ms = 按下；HC-SR04 立在面包板前、探头朝 +x，前方障碍物可沿探头方向拖，距离 = 从发射头沿朝向打到障碍物的射线（3D 里最远摆 100 cm，更远只用滑块）；接线检查 W2 认 Echo 的 1k/2k 分压（`BenchWire.divider`，改接线 `noDivider` 拆掉）。供电：编码器 0.66 mA 进 3V3，HC-SR04 15 mA 进 5V 轨（`Board::module_current_5v`，接了才加元件，没接时网络与以前逐位相同）
## IMU 与触摸（P2-02 / P2-03，`crates/soc/src/devices/{imu,mpu6050,qmi8658,cst816s}.rs`，C3 / S3 共用）
- 和 SSD1306 / BME280 一样是 `I2cDevice`，挂 I2C0：`make_i2c("mpu6050" | "qmi8658" | "cst816s", addr)`。读写都自动递增（QMI8658 只在 CTRL1.ADDR_AI=1 时），读事务开始（`start(read)`）时锁存全部输出寄存器，突发读拿到的是同一个样本。
- 姿态 `Pose { pitch, roll, yaw, dpitch, droll, dyaw }`（度、°/s）：传感器 X 沿模块长边、Y 沿短边、Z 垂直芯片朝上；R = Rz(yaw)·Ry(pitch)·Rx(roll)（右手，正 pitch = X 端朝下、正 roll = Y 端朝上）。加速度计读 Rᵀ·(0,0,1) g，陀螺读欧拉角速率换算的机体角速度；量程 / 灵敏度按数据手册，叠确定性噪声（样本序号哈希）。样本序号按 CPU 周期 / 输出率算，只用于 DATA_RDY / STATUS0 与噪声；姿态在两次输入之间保持（不外推）。片上温度 = 环境温度（`env_set` 一起改）。
- 触摸：`Machine::touch(x, y, down)` 先找 I2C0 上的 `Cst816s`（`press / release`，记按下时刻判长按），没有再找 `Ft6236`（P2-18，`make_i2c("ft6236", 0x38)`，12 位坐标、单触点、事件位按下 / 接触 / 抬起），并在 `touch_int` 配了引脚时驱动 INT：按着 0、抬起 1（`touch_int_attach` 先驱动成 1）。
- 对外：CLI `--i2c mpu6050@0x68,qmi8658@0x6b,cst816s@0x15`、`--touch-int GPIO`，脚本动作 `imu=p,r,y[,dp,dr,dy]`、`touch=x,y`、`release`（`machine::parse_imu / parse_touch`）；wasm `tb_i2c_attach(3|4|5, addr)`、`tb_imu_set(p, r, y, dp, dr, dy)`、`tb_touch_int(pin)`、`tb_touch(x, y, down)`；simrun（网页验收 + npm 包）认同样的脚本动作与 `--touch-int`。
- 网页：输入日志事件 `imu`（施加前取到 0.01°，与脚本精度一致）/ `touch`，InputLog 顶层 `touchInt`；worker 收 `{type:'input', act}`。姿态源三个：实验台倾斜滑块（属性面板 + 快捷卡片）、3D 里按住 IMU 模块拖（`Bench.onPose`，轨迹球改台面 rig 的四元数）、成品页倾角仪盒子（`app/tilt3d.ts`）；都经 `session.setPose`：`PoseRate` 按墙钟算欧拉角速率一起施加，停 150 ms 补一次速率 0。`imupose.ts` 是纯函数（three 坐标 Q = M·R·Mᵀ，M 把传感器轴换成 three 的 Y 朝上坐标）。
- board3d：有 IMU 时整块台面（rig：面包板 + 开发板 + 外接件）绕 IMU 模块按姿态转；建模前 rig 复位成单位变换（零件按世界坐标挂进来）。IMU 模块平插（GY-521 8 针 / QMI8658 6 针，针在 f 行、跳线落 j 行）。触摸圆屏：场景里同时有 `gc9a01` 和 `cst816s` 时圆屏画 12 针触摸版，射线命中屏面网格的 UV → (u·240, (1−v)·240) → `Bench.onTouch`；测试接口 `lcdPoint(x, y)`、`imuScreenPos()`。ScenePickApi 新 id：`mpu6050`、`qmi8658`、`cst816s`（针 `cst816s:TP_SDA` 等）。
- AMOLED 板 I2C 器件（E-02）：`devices/{cst9220,axp2101,pcf85063,codec}.rs`，`make_i2c("cst9220" | "axp2101" | "pcf85063" | "es8311" | "es7210", addr)`。`Machine::touch` 依次找 Cst816s → Ft6236 → Cst9220（16 位大端寄存器，0xD000 报点 + 0xAB 应答）；`battery_set / pwrkey / rtc_set / pmic_unimpl`；CLI `--battery PCT[,usb]`、`--rtc EPOCH`，动作 `bat=pct[,usb]`、`pwrkey=short|long`（`machine::parse_battery`），wasm `tb_battery / tb_pwrkey / tb_rtc_set`。
- M5 板 I2C 器件（M5-04）：`make_i2c` 新增 `mpu6886`（= `Mpu6050::mpu6886`，同一类型，姿态 / 温度胶水不变）、`bmi270`（`Bmi270`，`aux: Option<Bmm150>` 挂 0x10，M5Unified 的 AUX 手动读写 + 数据模式；配置上传 0x5B/0x5C/0x5E，0x59=1 后 0x21=1）、`bmm150`、`bm8563` / `pcf8563`（`Pcf8563`，与 pcf85063 共用 `pcf85063::RtcClock`）、`aw9523`（`pin / output / led_dim / set_input / int_pending`）、`axp192`（`rail_mv(Rail::{Dcdc1,Dcdc2,Dcdc3,Ldo2,Ldo3,Exten})`、`gpio(0..4)`、`set_battery / pwrkey`、库仑计）、`lp5562`（`pwm(Channel::{B,G,R,W})`）、`tca8418`（`press / release(row,col)`、`int_active`）、`ft6336` / `ft3267`（= `Ft6236::with_cipher`）、`ina3221`（`set_channel(ch, bus_mv, shunt_uv)`）、`ltr553`（`Codec::ltr553` 壳）、`aw88298`（16 位大端壳，`reg(r)`）。`Machine::battery_set / pwrkey` 先找 Axp2101 再 Axp192，`rtc_set` 先 Pcf85063 再 Pcf8563，`imu_set / env_set` 加 Bmi270；`pmic_unimpl()` 改为返回 `(芯片名, 列表)`。wasm 的数字器件表未扩展。
- 供电网络：`module_current` 加 mpu6050 3.9 mA、qmi8658 1.7 mA、cst816s 2.5 mA（估算，与 parts.ts 同源）。

## 按引脚的 I2C 总线 + GPIO 位拨（M5-02，`crates/soc/src/i2cpins.rs`，C3 / S3 / ESP32）
- 两种挂法并存：旧的 `--i2c kind@addr` / `Machine::i2c_attach` 仍直接挂 I2C0 控制器（`I2c::devices`），不看引脚，golden 不变；新的「引脚总线」`PinBus { sda, scl, pullup, devices }` 按 SDA/SCL 焊盘标识，放在各 SocBus 的 `i2c_pins: PinBuses`。
- 控制器路由：写 I2C0 / I2C1 寄存器时，`PinBuses::routed(func_out, mask, sda_sig, scl_sig)` 找两个焊盘的 GPIO 矩阵输出都选了该控制器 SDA/SCL 信号的那条总线，`I2c::write_with` 把它的器件临时接到控制器器件表后面，写完再拆回。信号号：S3 I2CEXT0 89/90、I2CEXT1 91/92；ESP32 29/30、95/96；C3 53/54。I2C1 没有旧式器件。
- 位拨：`gpio_changed` 开头调 `i2c_pins_settle`：两个焊盘仍是 GPIO 自己驱动（func_out = 普通 GPIO）时，把焊盘电平喂给 `PinBus::on_lines`，状态机（START / 重复 START / STOP、地址 + 读写位、ACK、读时逐位输出、主机 NACK 后停发）驱动 SDA：拉低走 `ext_driven/ext_in`（线与），释放则回到上拉；最多迭代 4 次直到稳定。焊盘交给外设时状态机复位并放开 SDA。器件对象和控制器路径是同一批，所以位拨与 i2c_master 看到同一份寄存器。
- 上拉：`pullup = true`（默认）把两个焊盘写进 `board_pullup`，板上上拉胜过内部下拉（M5GFX `_detect_i2c_device` 开下拉读 1 的检测能通过）；`nopull` 时开漏输出 1 仍按 D-03 读 1。
- 接口：Rust `Machine::i2c_bus_add(sda, scl, pullup) -> Option<usize>`（焊盘已被别的总线占用返回 None）、`Machine::i2c_attach_bus(bus, kind, addr) -> bool`（kind 同 `make_i2c`）；`env_set / imu_set / touch / battery_set / pwrkey / rtc_set / oled` 先找 I2C0 再找引脚总线。CLI `--i2c-bus sda=N,scl=N[,nopull]:kind@addr,...`（可重复）。wasm `tb_i2c_bus_add(sda, scl, pullup) -> i32`（-1 失败）、`tb_i2c_attach_bus(bus, kind, addr) -> i32`。供 M5-05 板预设使用。
- eFuse 封装号：`Machine::set_efuse_pkg(pkg)` / CLI `--efuse-pkg N` / wasm `tb_efuse_pkg`，默认不变。S3 / C3 写 BLK1 PKG_VERSION（word 0x44/4+3 的 bit 21..23，0..7；S3 0 = QFN56、1 = PICO）；ESP32 写 BLK0 RDATA3 CHIP_PACKAGE（bit 9..11 + 4BIT bit 2，0..15），pkg 5（PICO-D4）同时把 APB_CTRL_DATE bit 31 清零（M5GFX 遇到该位会把 5 当成 6 = PICO-V3-02）。
- 经典 ESP32 四线 PSRAM（M5-14，`esp32/src/psram.rs`）：`Machine::set_psram_mb(mb)` / `Chip::set_psram(bytes)` / CLI `--psram MB` / wasm `tb_psram`，0 / 2 / 4 / 8 MB，默认无；`--efuse-pkg 6`（PICO-V3-02）隐含 2MB。SPI1 写 USR 时若 SPI_PIN（0x3FF42034）选 CS1（CS0_DIS=1、CS1_DIS=0）交给 `QuadPsram`：0x9F 读 ID（0D 5D EID，EID[7:5] 0/1/2 = 2/4/8MB；兼容 8 位命令 + 24 位地址与 IDF DCLK 的 32 位地址高字节编码），0x03/0x0B/0xEB 读、0x02/0x38 写；无芯片时 MISO 全 0xFF。DRAM1 窗口 0x3F800000..0x3FC00000 走 PRO / APP MMU 第 1152..1279 项（`SocBus::psram_mmu` / `psram_mmu_app`，32KB 页，位 8 无效），复位值为恒等映射（IDF low/high 写回循环在 2MB 芯片上也读 +2MB）。flash JEDEC 容量字节随镜像头：`boot::jedec_for_size` = max(头部大小, 4MB) 的 log2。
- 验收：soc 单元测试 `bitbang_scan_and_register_read`；固件 `s3-i2c-bitbang`（S3，SDA 11 / SCL 12）和 `esp32-i2c-bitbang`（ESP32，21 / 22，同一份 main.c）做上拉检测、位拨扫描 + 读 BME280 ID、I2C1 非默认引脚扫描 + 读 ID、删总线后再位拨扫描。

## Xtensa LX7 核（ESP32-S3，`core/crates/xtensa`）
- 配置取自 ESP-IDF `components/xtensa/esp32s3/include/xtensa/config/core-isa.h`：64 个物理 AR、窗口 ABI、16 位密度指令、零开销循环、MUL16/MUL32/MULUH/MULSH/DIV32、NSA/MIN/MAX/SEXT/CLAMPS、布尔寄存器、S32C1I、硬件非对齐访存、VECBASE 复位 0x40000000。
- 取指按首字节 op0 判长度（8..=13 为 2 字节，否则 3 字节）；`Bus::fetch` 默认逐字节读，SoC 可重写成快路径。
- 窗口：`a(i)` = 物理 `ar[(WINDOWBASE*4 + i) & 63]`。每条指令执行前按它用到的最高四元组做溢出检查（`max_quad`，宁可多估），撞到 WINDOWSTART 中别的活帧就把最老的那帧溢出：EPC1 = 本指令、PS.OWB = 原 WB、WB 转到被溢出帧，按到下一帧的距离选 OF4/OF8/OF12 向量；RETW 发现调用者帧已不在寄存器里则走 UF 向量。PS.WOE=0 或 EXCM=1 时不检查（处理程序本身不会递归溢出）。
- 向量偏移（相对 VECBASE）：OF4 0x000、UF4 0x040、OF8 0x080、UF8 0x0C0、OF12 0x100、UF12 0x140、Kernel 0x300、User 0x340、Double 0x3C0。
- 循环：顺序执行到 LEND 且 LCOUNT≠0、EXCM=0 时回到 LBEG；循环体末尾是已跳转的分支时以分支为准。
- 未实现（下一切片）：中断裁决与 level 2–7 向量、CCOMPARE 定时器中断、FPU 与协处理器禁用异常、MAC16、PIE（EE.*），这些编码目前按非法指令处理。
- 验收：`tools/xtensa-tests/*.S` 自检汇编（`build.sh` 用 xtensa-esp32s3-elf-gcc 构建），`cargo test -p tryboard-xtensa` 跑全部并统计六个窗口向量的命中次数；`window` 测试必须六种都触发。

## ESP32-S3 SoC（`core/crates/esp32s3`）
- 存储映射（soc/esp32s3/include/soc/soc.h）：SRAM 512KB 一块缓冲，以 IRAM 0x40370000 为 0：SRAM0 32KB（只有 I 总线）、SRAM1 416KB（I 0x40378000 = D 0x3FC88000）、SRAM2 64KB（只有 D 总线，0x3FCF0000）。ROM 0x40000000–0x40060000，DROM 掩膜 0x3FF00000 → ROM 物理 0x40040000（与 C3 相同）。RTC 慢速内存 0x50000000、快速内存 0x600FE000（各 8KB）。
- cache 窗口：IROM 0x42000000、DROM 0x3C000000 各 32MB，共用 512 项 MMU（0x600C5000，线性地址 = vaddr & 0x1FFFFFF，64KB 页）；表项位 13..0 页号、位 14 无效、位 15 选 PSRAM。默认板型 N16R8：16MB flash（GD25Q128，JEDEC C8 40 18）+ 8MB PSRAM。
- 直接启动同 C3：ROM 各 .data* 初值装进 DRAM 顶部、_putc1 / g_uart_print / g_usb_print、rom_spiflash_legacy_data（0x3FCEFFE4）、RTC_XTAL / APB 存储寄存器（S3 上是 RTC_CNTL 0xC0 / 0xC4）。窗口 ABI 的入口处理：以 PS.CALLINC=0 进 call_start_cpu0，SP = ROM .stack_pro 顶（0x3FCEB710）；先执行入口的 ENTRY，再在 [sp-12] 填一个指向 ROM .stack_app 空闲区的指针——窗口溢出处理程序溢出最老一帧时会从那里取"调用者 SP"存 a4..a11。
- 中断：S3 的中断矩阵只把源映射到 CPU 线（INTERRUPT_CORE0_*_MAP，偏移 4×源；核 1 的表在 +0x800）；级别 / 类型是 Xtensa 配置固定的（core-isa.h）。`SocBus::update` 按两张矩阵算出每个核的外部线，轮到哪个核执行就 `cpu.set_irq_lines(lines[k])`；裁决与进向量在核里。
- 双核：固件调 ROM 的 `ets_set_appcpu_boot_addr(call_start_cpu1)` 时 HLE 记下入口，运行循环随即启动核 1（栈 = ROM .stack_app 顶 0x3FCED710，PRID 0xABAB，周期数与核 0 对齐）。两核按 256 周期量子交替：核 0 跑一个量子，核 1 追到核 0 的时间；核 0 的 WAITI 快进不越过量子，除非核 1 也在 WAITI（这时一起快进到下一个事件）。指令级交替保证 S32C1I 原子；外设看到的时间取两核中较快者，保持单调。
- 执行快路径（P2-07，不改变任何结果）：`run_core` 调 `Cpu::run_batch` 连续执行，每条指令后用 `Bus::attention` 做与原来逐步循环相同的检查（irq_dirty、外设时间推进到 next_event、落进 ROM 异常向量区）；取指走 64KB 页缓存（IRAM / ROM / 经 MMU 翻译的 IROM 页，写 MMU 时作废）；SRAM 读写在 `Bus::load/store` 里内联；CCOMPARE 记下一次触发的绝对周期，没到就不算。基准见 Reviews/ab/P2-07.md
- HLE：rom_i2c_* 在 ROM 函数入口（ENTRY 之前）拦截，此时窗口仍是调用者的：参数在 a(4·CALLINC+2..)，返回地址在 a(4·CALLINC)（高 2 位为 CALLINC），返回值写回 a(4·CALLINC+2)，PC 直接回到调用点之后。
- 软件复位：`mmio_write` 看 RTC_CNTL_OPTIONS0 的复位位（脉冲，存回的值去掉它们）。SW_PROCPU_RST / SW_SYS_RST 记 `reset_request`，写它的那个核在下一条指令前停下，`run` 返回 `Stop::Reset(12 / 3)`；SW_APPCPU_RST（esp_restart 先复位并停住另一个核）直接把核 1 停掉。`Esp32s3::reboot` 用一条新总线重新直接启动：先放进旧的 RTC 慢 / 快速内存和 RTC_CNTL_STORE0–3/6/7，再装镜像段（.rtc.data 被重新装载，与 bootloader 在非深睡唤醒时的做法一致；RTC_NOINIT 不在镜像里所以保留）；RTC_CNTL_RESET_STATE 读回复位原因（两核同值），`esp_reset_reason()` 结合 STORE6 里的提示得到 ESP_RST_SW。外部世界（引脚外部驱动、ADC 电压、I2C 器件、GPIO 记录、WS2812 解码）搬到新机器；模拟时间继续。
- 八线 / 四线 PSRAM（`psram.rs` 的 `Psram`，`quad` 选协议，默认八线；`Machine::set_psram_quad` / `Chip::set_psram_quad` / CLI `--psram quad|octal`）：四线模式按 USER2 命令位宽 8 位解码 0x9F（ID 0D 5D 52：8MB、非 2T）/ 0x03 / 0x0B / 0xEB 读、0x02 / 0x38 写，24 位地址，0x35 / 0xF5 / 0x66 / 0x99 / 0xC0 只计数；命令位宽与模式不符或不认识的命令计入 unimpl 0x60002000。八线模式不 HLE，ROM 的 `esp_rom_opiflash_exec_cmd` 照常配 SPI1 寄存器；写 CMD 的 USR 位时若 SPI_MEM_MISC 选的是 CS1（CS0_DIS=1、CS1_DIS=0）就交给 `OctalPsram`：0x4040 / 0xC0C0 读写模式寄存器（MR1 厂商 0x0D AP、MR2 density 3 = 8MB / 第 3 代 / good-die，MR3 VCC=3V；写只落 MR0/4/8），0x0000 / 0x8080 同步读写存储体（与 cache 共用 `SocBus::psram`）。dummy、DTR 采样相位、驱动强度只存不用。
- 外设：与 C3 同族的模型直接复用 tryboard-soc（UART、SYSTIMER、TIMG、SPI1、LEDC、I2C + 器件、RMT + WS2812 + 接收、PCNT、GP-SPI2、GDMA + GC9A01、SHA / AES、引脚器件），Wi-Fi MAC 复用 tryboard-soc（`WifiLayout::S3`，中断源 0；WDEV_RND_REG 在 0x6003507C；SENS 温度传感器给 READY），按芯片参数化的是 RMT（`RmtLayout`：通道数、寄存器块起点、RAM 偏移、GPIO 矩阵信号号）与 GDMA（`GdmaLayout`）；S3 独有的是中断矩阵、EXTMEM、49 脚 GPIO、SENS 单次 ADC（periph.rs）。
- 入口帧溢出保存区：核 0 / 核 1 分别借用 ROM 的 level 5 / level 4 中断栈（app 装了自己的向量表后 ROM 不再用）。
- 崩溃检测：落进 ROM 异常向量（VECBASE 仍为 0x40000000 时）停机报 EXCCAUSE / EPC1；app 装了自己的 VECBASE 后，崩溃由固件自己的 panic 处理程序打印（Guru Meditation），CLI 照常转发。
- 中断：32 条线，级别 / 类型按 core-isa.h（外部电平、外部边沿 10/22/28/30、NMI 14、软件 7/29、定时器 6/15/16、性能计数 11）。`INTERRUPT` = 锁存位（边沿 / NMI / 软件 / 定时器）| 外部电平线。可响应条件：挂起 & INTENABLE 的最高级别 > max(PS.INTLEVEL, EXCM ? 3 : 0)。level 1 走 User/Kernel 向量（EXCCAUSE=4），level n≥2 存 EPC_n / EPS_n、置 INTLEVEL=n 与 EXCM，跳 VECBASE+0x180/0x1C0/0x200/0x240/0x280/0x2C0。
- SoC 接口：`set_irq_lines(mask)` 驱动外部线；`step()` 遇 WAITI 返回 `Exit::Waiti`，SoC 可把 `cpu.cycles` 直接推到 `next_timer_event()`（及自己外设的下一事件），下一次 step 会补检 CCOMPARE 越过；`Exit::Simcall` 可当空操作；`Bus::rer/wer` 给外部寄存器（默认读 0）。
- 主频（E-10）：SoC 按 CPU 时钟寄存器（PLL 下 CPUPERIOD_SEL）设 `Cpu::cpi3`，240 / 160 / 80 MHz 每条指令 ⅔ / 1 / 2 个 160 MHz 时基周期；XTAL 阶段按 1。
- CCOUNT 每条指令 +1（真机 CPI 标定以后做；240 MHz 下仍按时基走，见 DECISIONS E-10）；写 CCOMPAREn 清对应定时器挂起位。CCOUNT = `cycles` + 偏移：固件写 CCOUNT（IDF 换 CPU 频率时按新旧频率比例改写）只改偏移，`cycles` 是整机模拟时间，不能跳（否则复位后启动时时间会被放大数倍、两核时间错开）。
- FPU（CP0，CPENABLE 位 0 门控，否则 EXCCAUSE 32）：f64 精确值 + 一次舍入实现 4 种舍入模式，非规格数不冲零，FSR 标志累加；NaN 传播与除法 / 开方分步指令的模型见 `fpu.rs` 模块说明与 DECISIONS。
- MAC16：40 位 ACC、m0..m3、LDINC/LDDEC 与并行装载形式；区域保护 TLB 指令（8 个 512MB 区域属性）；SALT/SALTU。
- 未实现：PIE（EE.*）指令，按非法指令处理。
- 验收：`tools/xtensa-tests/*.S` 自检汇编（`build.sh` 用 xtensa-esp32s3-elf-gcc 构建），`cargo test -p tryboard-xtensa` 跑全部并统计六个窗口向量的命中次数；`window` 测试必须六种都触发。本机有乐鑫 QEMU 时同一 ELF 在 QEMU 上跑一遍逐字差分，见 `tools/xtensa-tests/README.md`。

## 经典 ESP32 SoC（C-05，`core/crates/esp32`）
- 核：与 S3 同一个 `tryboard-xtensa`，`Cpu::with_variant(Variant::Lx6Esp32)`。两颗芯片的 core-isa.h 在本核实现的选项上一致（中断线类型 / 级别、窗口、循环、MUL/DIV、FPU、MAC16、向量偏移），只差硬件版本号 / CONFIGID（SR 176 / 208）；LX6 没有 PIE（本来就没实现）。
- 存储映射（soc/esp32/include/soc/soc.h）：SRAM 520KB 一块缓冲，D 视图 0x3FFAE000..0x40000000（SRAM2 + SRAM1，328KB）在前、SRAM0（I 0x40070000，192KB）在后；SRAM1 的 I 视图 0x400A0000..0x400C0000 与 D 0x3FFE0000.. 同一块但**按字倒序**（SOC_DIRAM_INVERTED），只给不跨字的访问，取指页缓存不缓存它。ROM0 0x40000000、ROM1 只读数据 0x3FF90000（64KB）；RTC 快速内存 D 0x3FF80000 = I 0x400C0000，慢速内存 0x50000000。
- cache：DROM0 0x3F400000、IROM0 0x400D0000 起，MMU 256 项 64KB 页（DPORT_PRO_FLASH_MMU_TABLE 0x3FF10000，0x100 = 无效；项 0..63 给 DROM，64.. 给 IROM），核 1 的表（0x3FF12000）IDF 总写成一样，取指只看核 0 的。默认板 DevKitC V4（WROOM-32E，4MB flash）。
- 外设：MMIO 0x3FF00000..0x3FF80000，0x60000000 + x 是 0x3FF40000 + x 的 AHB 别名（UART / I2C FIFO 走它）。与 C3 / S3 寄存器语义相同的直接复用 tryboard-soc（UART、I2C + SSD1306 / BME280、引脚器件、GPIO 记录），偏移不同的 TIMG、SPI1、LEDC 在 `periph.rs` 里做翻译层；I2C 按 `I2cLayout::ESP32`（命令码 RSTART 0 / WRITE 1 / READ 2 / STOP 3 / END 4、16 项命令表、SCL 直接按 APB 80MHz 计 14 位）。DPORT：两张中断矩阵（69 个源）、核间中断、cache 控制。GPIO 40 脚（0–39，无 20 / 24 / 28–31）。
- LEDC：高速 / 低速两组各 8 通道；timer 的 tick_sel 0 = REF_TICK 1MHz，1 = 高速组 APB / 低速组 SLOW_CLK（APB_CLK_SEL 选 APB 或 8MHz），翻译层据此算频率。
- 启动：直接启动同 S3（ROM 各 .data* 初值、入口窗口帧、双核由 `ets_set_appcpu_boot_addr` 拉起核 1，两核 256 周期量子交替）；一代 ROM（2016-06-08）的启动横幅只有两行。eFuse 只读：芯片版本 v3.0（REV1 / REV2 位 + APB_CTRL_DATE 位 31）、出厂 MAC 02:54:42:00:00:04（本地管理地址，带 CRC8）。
- Wi-Fi：PHY 射频校准轮询与 C3 同一套（外设偏移相同、APB 基址 0x3FF40000）；MAC 是上一代 IP（0x3FF73000..0x3FF76000），与 C3 / S3 共用 `tryboard_soc::wifi::WifiMac`，寄存器排布由 `WifiLayout::ESP32.mac`（`MacRegs::ESP32`）给出：7 字接收头、RSSI 偏置 96、接收控制重装位自清、"下一个描述符"寄存器（docs/WIFI.md「经典 ESP32」）。SocBus 在 MMIO 分发里先查 MAC 范围再查射频，`impl tryboard_soc::Mem for SocBus` 让 MAC 读写描述符；中断源 WIFI_MAC 进中断矩阵。WPA2 需要的 SHA（0x3FF03000，SHA-1/256/384/512）/ AES（0x3FF01000）在 `crypto.rs`。RFPLL 校准完成位由 HLE regi2c 读回（块 0x62 寄存器 7 位 7）。
- RMT 发送（M5-11）：共用 `tryboard_soc::rmt::Rmt`，`RmtLayout::ESP32`（`classic = true`）：0x3FF56000，8 通道 × 64 字块（RAM +0x800），CHnCONF0 / CONF1 成对在 0x20 + 8n（mem_size CONF0[27:24]、div[7:0]；tx_start / mem_rd_rst / conti / idle_out 在 CONF1，脉冲位读回 0），STATUS 0x60、INT 0xA0（结束 3n、出错 3n+2、阈值 24+n，无循环计数）、TX_LIM 0xD0、APB_CONF 0xF0（回绕是全局位 1）；时钟按通道 ref_always_on 选 APB 80MHz / REF_TICK 1MHz。中断源 47，输出信号 87..94，`route_rmt` 同 S3 喂 WS2812 解码与 iotrace。接收、载波、APB FIFO 未做：访问 FIFO / 地址寄存器、置 rx_en、载波开着启动发送都记 unimpl。
- HSPI / VSPI 主机 + DMA（M5-10，`crates/soc/src/gpspi_classic.rs` `ClassicSpi`，接入 `esp32/src/spi_lcd.rs`）：0x3FF64000 / 0x3FF65000，中断源 30 / 31（SPI 完成，SLAVE.trans_done 位 4 & trans_inten 位 9）、51 / 52（DMA）。与 S3 `gpspi` 分开写而不是加 layout 枚举：差在语义——CMD.USR 是位 18 且无 UPDATE、MOSI / MISO 长度分开（0x28 / 0x2C，24 位）、地址取 ADDR 高字 + SLV_WR_STATUS、W0..W15 在 0x80、USR_MOSI/MISO_HIGHPART（位 25 / 24）改用 W8..W15、时钟源 APB 80MHz、DMA 是块内 lldesc 引擎（DMA_CONF 0x100、OUT_LINK 0x104 / IN_LINK 0x108，start 位 29，地址 = 0x3FF00000 | 低 20 位；中断 0x110..0x11C，in_suc_eof 5 / out_done 6 / out_eof 7 / out_total_eof 8；OUT_EOF_DES_ADDR 0x138、IN_SUC_EOF_DES_ADDR 0x124）。共用 `gpspi::Plan`、按时钟计时和 `Lcd::spi_transfer`（S3 `spi_lcd.rs` 也改走它）。没有 dma_tx_ena：上次传输后写过 OUT_LINK / IN_LINK start 才算 DMA；DPORT_SPI_DMA_CHAN_SEL 只存不判。W 缓冲按环读：MOSI 长度超过 64 字节（HIGHPART 时 32）从头绕回（M5GFX `writeDataRepeat` 在 ESP32 上一次发 2048 位）。屏归哪个主机看 SCLK 的走线（矩阵信号 8 = HSPICLK、63 = VSPICLK，或 IO_MUX 功能 1 的 14 / 18 脚）；CS 走矩阵 11 / 68 或 IO_MUX 15 / 5 时按 PIN.cs0_dis 选中，否则按 GPIO 低电平。`Chip::lcd_default_pins`（新，默认 S3_DEFAULT）在 esp32 上是 `LcdPins::ESP32_DEFAULT`（StickC Plus2：SCLK13 MOSI15 CS5 DC14 RST12 BL27），`--spi st7789@...` 的引脚覆盖基于它。CO5300 拒绝挂接。M5Stack Core2 的屏检测走软件 I2C 读 AXP192，CLI 要用 `--i2c-bus sda=21,scl=22:axp192@0x34`（`--i2c` 只挂硬件 I2C 不够）。
- 经典 I2S（M5-12，`crates/esp32/src/i2s.rs`）：**没有复用** `tryboard_soc::i2s`——经典 ESP32 的寄存器布局（CONF / FIFO_CONF / CONF_CHAN / CLKM 0xAC / SAMPLE_RATE 0xB0 / PDM_CONF 0xB4）和 DMA（I2S 自带 lldesc 链表，OUT_LINK / IN_LINK 0x30 / 0x34，stop / start / restart 位 28 / 29 / 30 自清，地址 20 位 | 0x3FF00000）与 C3 / S3（TX/RX_CONF + GDMA）几乎没有共同点，硬套只会让共用模型满是分支；只共用器件层（`devices/audio.rs` 的 MAX98357A / INMP441 与 `AudioBus`）。I2S0 0x3FF4F000 / I2S1 0x3FF6D000，中断源 32 / 33，SD 输出信号 163 / 189，SD 输入 155 / 181。
  - lldesc：字 0 = size[11:0] / length[23:12] / eof 位 30 / owner 位 31，字 1 = buf，字 2 = next。TX 按帧率一块一块取（取出时刻 = 第一帧播放时刻），放完报 OUT_DONE，带 eof 的报 OUT_EOF（OUT_EOF_DES = 这块），next = 0 报 OUT_TOTAL_EOF；RX 按帧率录满一块写回 length / eof、owner 交还 CPU，报 IN_DONE，累计满 RX_EOF_NUM（**按字计**，IDF 写 字节/4）报 IN_SUC_EOF（IN_EOF_DES），链表走完报 IN_DSCR_EMPTY。时钟没配 / 从模式 / APLL：1 ms 后再看（`stalls`）。
  - 帧率 = 160 MHz ÷ (N + b/a) ÷ bck_div ÷ (2 × bits_mod)；fifo_mod 0 = 16 位双声道、1 = 16 位单声道、2 = 32 位双、3 = 32 位单；tx_chan_mod 3 / 4 时 CONF_SINGLE_DATA 送另一槽，16 位时 msb_right 决定半字顺序。IDF i2s_std 单声道默认 slot_mask = LEFT（chan_mod 4），喇叭混 (L+R)/2 只剩一半幅度，所以示例固件显式写 `I2S_STD_SLOT_BOTH`。
  - PDM RX（只 I2S0，同真机）：**按 PCM 层建模**——硬件 PDM→PCM 抽取滤波器的输出（16 位补码）直接进 DMA，线上 1 位 PDM 流不模拟；采样率 = BCK ÷ 64（DSR_8S）或 ÷ 128（DSR_16S）。麦克风模型复用 INMP441（`pdm = true` 时报告名为 SPM1423，取 24 位样本的高 16 位）；PDM TX、I2S1 的 PDM 不出数据。
  - 引脚约定（`i2s::pin`，同 M5 Core2）：喇叭 BCLK 12 / LRC 0 / DIN 2，PDM 麦克风 CLK 0 / DATA 34（StickC Plus2 / Core2 SPM1423）。接线判断同 C3 / S3：DIN 脚的 FUNC_OUT_SEL = SD 输出信号、SD 输入信号的 FUNC_IN_SEL（位 7 经矩阵）= 麦克风 DATA 脚。CLI `--i2s max98357a` / `--mic <wav>` 与 C3 / S3 相同。
- ADC1 / ADC2 单次读（M5-12，`crates/esp32/src/sens.rs`，SENS 0x3FF48800 = RTC_CNTL 页 +0x800）：只接管 READ_CTRL / START_FORCE（位宽 9..12）/ ATTEN1 / ATTEN2 / SLAVE_ADDR1（meas_status 读 0）/ MEAS_START1 / READ_CTRL2 / MEAS_START2（data[15:0]、done 16、start 17 上升沿采样、en_pad[30:19]），其余 SENS 寄存器仍按通用寄存器记 unimpl。通道 → 脚：ADC1 {36,37,38,39,32,33,34,35}，ADC2 {4,0,2,15,13,12,14,27,25,26}。DATA_INV = 1（IDF 默认）时给正码，否则取反。转换用共用的 `AdcModel`（`AdcChip::Esp32`：满量程 1050 / 1350 / 1900 / 3150 mV）；eFuse BLK0 位 136..140 烧 ADC_VREF = 3（1121 mV，符号-幅值 7 mV 步），`adc_cali_create_scheme_line_fitting` 走 eFuse Vref 路径；`AdcModel` 的 calibrated_mv 按 IDF 线性拟合（scale / offset / 12 dB 高端 LUT 混合）求逆，使校准结果对准输入电压。输入：`--script t:mv38=…`（`bus.adc.pin_mv`，复位保留）。
- 未做（按未实现寄存器记 unimpl）：DAC、触摸、霍尔、蓝牙；GP-SPI 从机模式、双工同时收发 DMA 的细节、SPI 中断以外的 DMA 链错误位；I2S 从模式 / PDM TX / APLL / LCD / 相机模式；ADC 的 DIG（DMA）读法与 Two Point eFuse。
- CLI / wasm：镜像头芯片 id 0 → ESP32（`Chip::Esp32`），ROM `esp32_rev300_rom.elf`（`tools/fetch_third_party.sh`）。`tb_image_chip` 认不出时返回 `u32::MAX`（0 已被 ESP32 占用）。短路电流估算沿用 C3 的数（`tb_fault` 的 s3 标志为 0）。
- 网页：台面板 ESP32-DevKitC V4（`board3d.ts` `BOARD_E32`，54.4 × 27.9 mm、两排 19 针相距 1″、micro-USB + CP2102、没有用户灯 / RGB 灯）；两排针相距 1″ 插在 830 孔面包板上，整板沿 z 偏半格，使 J1 落在 j 排、J3 落在 b 排，a 排留给跳线。芯片显示名 / BOOT 键 / RGB 脚统一在 `web/src/chips.ts`。
- 验收：accept.json 的 esp32-hello（与 QEMU 逐行一致）、esp32-blink（GPIO2）、esp32-fade（LEDC）、esp32-i2c（SSD1306 + BME280）、esp32-wifi-init、esp32-wifi（开放热点 + HTTP）、esp32-wifi-wpa2、esp32-spi-lcd（VSPI + DMA 画 ST7789 四色带，三线半双工读 RDDID 85 85 52）、esp32-i2s-tone（440 Hz）、esp32-pdm-mic（1 kHz WAV）、esp32-adc（GPIO38 五档 1%）；`tools/oracle_qemu.sh esp32-hello`（Espressif QEMU 的 esp32 机器没有 HSPI / VSPI 模型、I2S 只是空占位、没有 SENS ADC，这几例只能比到开头的打印 / 首个 DMA 画图之前）。

## 原生 USB OTG（ESP32-S3；模型在 `crates/soc/src/usb/`，中断源号在 esp32s3 `periph::src::USB`）
- `dwc2.rs`：Synopsys DWC2 设备模式（基址 0x60080000，中断源 38）。寄存器按 DWC2 编程模型；ID / 硬件配置读回 S2/S3 实测值（GSNPSID 0x4F54400A = 4.00a，CSRST 自清；GHWCFG2 0x224DD930、GHWCFG3 0x00C804B5、GHWCFG4 0xD3F0A030）。
  - 两条数据通路：GAHBCFG.DMAEN=1 时按 DIEPDMAn / DOEPDMAn 直接读写内存（SETUP 写到 DOEPDMA0 后指针 +8、置 STUP、关 EP0 OUT）；否则走 Slave：GRXSTSP 弹出状态字、FIFO 窗口读数据，IN 数据由固件写入各端点发送 FIFO（按 32 位字，含包尾填充，取包时按 tsiz 算包长并丢弃填充）。
  - 中断：GINTSTS 的 RXFLVL / IEPINT / OEPINT / OTGINT / BOUTNAKEFF 由状态实时算出；DAINT = 各端点 (DxEPINT & DxEPMSK)，IN 端点在 DIEPEMPMSK 置位时加上 TXFE（发送 FIFO 空）。
  - 线上事务不逐位模拟：虚拟主机以"SETUP / IN / OUT 令牌"为单位调用 `setup` / `token_in` / `token_out`，得到 ACK（含数据）/ NAK / STALL。
- `host.rs`：虚拟主机。DCTL.SDIS 清零即视为 D+ 上拉接入 → 10ms 去抖 → 总线复位（USBRST）→ 10ms 后 ENUMDNE（全速）→ 恢复期 → 枚举。控制传输是一个小状态机（SETUP → 数据 IN / OUT → 状态），NAK 就下一拍重试，2 秒无进展判超时。配置后按端点间隔轮询 HID 中断 IN、CDC 批量 IN，CDC 批量 OUT 发送队列。
- 调度：设备接上总线后，SoC 每 0.25ms 唤醒一次推进主机（`SocBus::update` 里把 `usb` 从 Option 临时取出，借总线给 DMA 访问内存）；断开后不再唤醒，不影响空闲快进。
- 对外：CLI `--usb-log`、脚本 `usbcdc=文本`；wasm `tb_usb_version` / `tb_usb_json` / `tb_usb_json_ptr` / `tb_usb_cdc_send`，JSON 结构见 `web/src/usb3d.ts` 的 `UsbView`。

## USB-Serial-JTAG 控制台（M5-03；模型在 `crates/soc/src/usj.rs`，S3 接入在 `crates/esp32s3/src/lib.rs` 0x6003_8000，中断源 `periph::src::USB_SERIAL_JTAG` = 96）
- 只模拟 CDC-ACM 串口一侧：EP1 FIFO（64 字节，满即自动送出，WR_DONE 立即送出）、EP1_CONF 空闲 / 有数据位、INT_RAW/ST/ENA/CLR（SOF、SERIAL_OUT_RECV_PKT、SERIAL_IN_EMPTY）、FRAM_NUM、OUT_EP1_ST 计数、JFIFO_ST 恒为两个 FIFO 空；JTAG 端点不模拟。
- 主机默认已连接：每 1 ms 帧边界置 SOF（只有 INT_ENA 开了 SOF 才把帧边界计入 `next_event`，否则不打断空闲快进）；IDF 连接检测 / Arduino `HWCDC::isPlugged()` 都看到"已连接"。`Usj::set_connected` 预留拔插。
- 输出：主机收到的包并入同一个控制台（CLI stdout / 网页串口面板，`console_take`）。IDF 默认的"次控制台"会轮询把 UART0 内容再写一遍到 USJ（不开 USJ 中断）：`INT_ENA == 0`、紧跟 UART0 输出 2 ms 内、内容（去 CR/LF、允许尾部最多 16 字节滞后）能在最近 UART0 字节里找到的包视为镜像丢掉，保证每行只出现一次。
- 输入：`Chip::uart_push`（CLI `uart=` 脚本 / `--inputs`、wasm `tb_uart_push`）同时喂 UART0 RX 和 USJ OUT FIFO（置 OUT_RECV），固件用哪个口就从哪个口读到。
- 窄存储：HWCDC 用 `s8i` 写 EP1，子字写合并会先 `mmio_read`（会弹 RX），所以 0x6003_8000 不做合并。C3 的 USJ（0x6004_3000）尚未接入。

## GP-SPI2 / GDMA / GC9A01 圆屏（ESP32-S3；模型在 `crates/soc/src/{gpspi,gdma}.rs`、`devices/dcs.rs`；SPI3 见下）
- GP-SPI2 主机（0x60024000，中断源 21）：寄存器按 `spi_reg.h`，复位值由各字段注释的 default 求得。CMD.UPDATE 瞬间完成；写 CMD.USR 时 SoC 按 USER 里的阶段（命令 → 地址 → 哑周期 → MOSI / MISO）组织一次传输：命令值按 bit7..0、bit15..8 顺序，地址从 ADDR 最高位移出，MOSI 数据在 DMA_CONF.dma_tx_ena=1 时从 GDMA 取、否则从 W0..W15 取。字节立即交给从机；CMD.USR 读回 1 直到按 SPI 时钟算出的结束时刻，然后置 DMA_INT_RAW.trans_done（位 12）。时钟：CLK_GATE.mst_clk_sel 选 PLL 80MHz / XTAL 40MHz，CLOCK.clk_equ_sysclk 或 ÷(pre+1)(n+1)。
- GDMA（0x6003F000，5 通道，间距 0xC0，IN 组在 +0x00、OUT 组在 +0x60；中断源 IN 66..70、OUT 71..75）：PERI_SEL 复位为 0x3F（不接），SPI2 = 0。OUT_LINK 只有低 20 位，完整地址 = 0x3FC00000 | addr；start / stop / restart 自清，park 恒为 1。SPI 传输开始时沿描述符链（字 0：size[11:0]、length[23:12]、suc_eof[30]、owner[31]；字 1 缓冲区；字 2 下一个）一次取完，out_auto_wrback 时交还 owner、记 OUT_EOF_DES_ADDR；传输结束时置 OUT_DONE / OUT_EOF / OUT_TOTAL_EOF。
- 圆屏 GC9A01（`SocBus::lcd`，CLI `--spi gc9a01`、wasm `tb_lcd_attach`，C3 / S3 都有）：S3 默认接线 SCLK=12、MOSI=11、CS=10、DC=14、RST=13、背光=15（`LcdPins::S3_DEFAULT`，可用 `--spi 屏@脚` 改，见下）；C3 为 SCLK=6、MOSI=7、CS=10、DC=5、RST=4、背光=3（`tryboard_esp32c3::lcd_pin`）。SCLK / MOSI / CS 都是 SPI2 的 IO_MUX 直连脚。D/C 取传输开始时 DC 脚的电平；片选见 DECISIONS。命令：SWRESET、SLPIN/SLPOUT、DISPON/DISPOFF、INVON/INVOFF、MADCTL（MY/MX/MV 换算显存坐标，BGR 位）、COLMOD（16 / 18 位）、CASET、RASET、RAMWR、RAMWRC，其余算厂商命令只计数。显存 240×240 RGB888；渲染时按"常黑 IPS（INVON 才是原色）、BGR 子像素"换算，圆形可视区（半径 120）外透明。
- 多线（E-01）：命令 / 地址 / MOSI / MISO 各阶段线数取 CTRL.fcmd_*（位 8–10）、faddr_*（5–7）、fread_*（14–16）与 USER.fwrite_*（12–14），时钟数 = Σ ceil(位数 / 线数) + 哑周期 + 2（CS）；字节仍按顺序交给从机。MISC.cs_keep_active（位 30）= 1 时传输结束 CS 不抬起。
- 屏幕抽象（E-01，`devices/lcd.rs`）：`enum Lcd { Dcs(DcsPanel), Co5300 }` + `LcdKind`；`Chip::lcd_attach(LcdKind)`、`Chip::lcd() -> Option<&mut Lcd>`，`Machine::lcd_attach("gc9a01"|"co5300")`；`Lcd::size/version/render/ppm/color_report/name` 统一出图，SPI 路径按变体分派（DCS 屏用 D/C 脚，CO5300 用片选帧）。C3 只接受 GC9A01。
- 参数化 MIPI-DCS 屏（M5-01，`devices/dcs.rs`，原 `gc9a01.rs`）：`DcsPanel::new(PanelSpec)`，`PanelSpec` = 显存尺寸、可见区尺寸与偏移（ox/oy）、圆形、常黑、BGR 面板、横屏（frame(x,y) = window(w-1-y, x)）、RDDID 三字节、ILI9342 变体。`LcdKind` / `--spi` 名：`gc9a01`（240×240 圆，ID 00 9A 01，与旧行为逐字节一致）、`gc9107`（128×160 显存，128×128 @0,32，ID 00 91 07）、`st7735`（132×132，128×128 @2,1，ID 7C 89 F0）、`st7789`（240×320，135×240 @52,40，ID 85 85 52）、`st7789l`（同上横屏 240×135）、`ili9342` / `ili9342c`、`ili9342e`（320×240，ID E3 00 00）。ID 取自 M5GFX autodetect 的判据（只读学习，未拷代码）。ILI9342 C/E 区分：E 保存 DD/CB 参数供 D9 索引读回；C 在 EXTC 口令 `C8 FF 93 42` 后 D3 回 `00 00 93 42`。
- 读路径（M5-01）：命令字节后屏准备读流 `rd`（MSB 先出），04h（RDDID）/ 09h 先有 1 位哑位，其余 0 位；超出部分补 0；CS 抬起清流。SPI 的 MISO 阶段从流里取位，没有屏或屏未选中时为 0xFF。M5GFX 用 MISC.ck_idle_edge（位 29）翻转 + UPDATE 产生 1 个哑时钟：`GpSpi` 在 CMD 写 USR|UPDATE 时比较位 29 与锁存值，计 `idle_flips`，每两次翻转 = 1 个时钟，在下一次传输前交给屏（`DcsPanel::idle_edge`）。3 线（USER.sio）与 4 线 MISO 走同一路径，不按 SIO 区分——所以 CoreS3 的 MISO = DC = GPIO35 共用脚无害（读数据在 MOSI 线上，D/C 仍取传输开始时的电平）。
- 接线可配（M5-01）：`LcdPins { sclk, mosi, miso, cs, dc, rst, bl }`，`LcdPins::S3_DEFAULT` = 12/11/-/10/14/13/15（旧 `--spi gc9a01` 含义不变）；CLI `--spi <屏>@sclk=N,mosi=N,cs=N,dc=N[,rst=N,bl=N,miso=N]`（`-1` = 不接；别名 sck/clk/sda），`Machine::lcd_attach_spec("kind[@pins]") -> Result<(), String>`、`Chip::lcd_attach_pins(LcdKind, LcdPins)`（S3，拒绝 CO5300）、wasm `tb_lcd_attach_spec(ptr, len) -> i32`。片选：IO_MUX FSPICS0（仅脚 10）或 GPIO 矩阵 func_out 110（SPI2 CS0）/ 71（SPI3 CS0）算 SPI 驱动，否则看 GPIO 电平。背光：BL 脚为高，或 LEDC PWM 输出被路由到 BL 脚且占空比 > 0（每次 update 刷新，AtomS3 用 PWM 背光）；未给 BL 脚恒亮。
- GP-SPI3（M5-01，S3）：0x60025000，中断源 22，GDMA 外设号 1，与 SPI2 同一 `GpSpi` 模型。屏挂在哪个主机由 SCLK 脚的 func_out 决定（66 = SPI3_CLK，否则 SPI2）。CLI 报告 `[tryboard] SPI3 transfers N, MOSI N bytes`（仅 N > 0 时），LCD 行在有读时追加 `, reads N`。
- CO5300（`devices/co5300.rs`；S3 侧片选与分派在 `esp32s3/src/spi_lcd.rs`，`co5300_pin`：CS=12 CLK=38 D0–D3=4–7 RST=39，经 GPIO 矩阵）：CS 拉低后的前 4 字节是 `opcode, 0, cmd, 0`（0x02 / 0x12 / 0x32 写，0x03 / 0x0B 读），其后为参数 / 像素；帧在 SPI 控制的 CS 抬起（传输结束且 cs_keep_active=0）或 GPIO 片选拉高时结束。显存 480×480 RGB888，方屏全可见，无背光脚，亮度 0x51 在 0x53 BCTRL=1 时缩放。未实现命令 / opcode 计入 `unimpl`，CLI 列出。
- wasm：`tb_lcd_attach_kind(0 GC9A01 | 1 CO5300)`、`tb_lcd_kind() -> -1|0|1`（0 = 任意 DCS TFT）、`tb_lcd_attach_spec(ptr, len)`（M5-01）、`tb_lcd_w()` / `tb_lcd_h()`；`tb_lcd_ptr` 为 w×h×4 RGBA。
- 对外：CLI stderr `[tryboard] LCD GC9A01 非黑像素 N（显示开/关）`、`--lcd-ppm <路径>`；wasm `tb_lcd_attach() -> i32`、`tb_lcd_version() -> u32`、`tb_lcd_ptr() -> *const u8`（240×240×4 RGBA），`tb_report` 在 OLED 行之后追加 `[tryboard] LCD GC9A01 非黑像素 N` 和颜色统计行（见上）。

## I2S + 音频器件（P2-06；模型在 `crates/soc/src/i2s.rs`、`devices/audio.rs`，C3 / S3 共用）
- I2S（S3：I2S0 0x6000F000 / I2S1 0x6002D000，中断源 25 / 26，GDMA 外设号 3 / 4；C3：I2S0 0x6002D000，源 20，外设号 3）：寄存器按 `i2s_reg.h`（两颗芯片布局逐项相同），复位值由字段注释的 default 求得。TX/RX_CONF.update 瞬间完成（读回 0）；只做主模式 + TDM / 标准格式（Philips / MSB / PCM 都按"每帧若干槽"处理，线上逐位时序不模拟），PDM、从模式、外部 MCLK 不做（该方向不出数据）
- 帧率 = 源时钟（clk_sel 0 = XTAL 40 MHz，1 = PLL_D2 240 MHz（M5Unified 直接写寄存器选它），2 = PLL_F160M）÷ (N + 分数) ÷ (bck_div_num+1) ÷ ((tdm_chan_bits+1) × (tot_chan_num+1))；分数是 `i2s_ll_tx_set_mclk` 的逆运算：分母 = z(x+1)+y，分子 = yn1 ? 分母−z : z
- 数据只走 GDMA（流式，`Gdma::out_next / out_eof / in_peek / in_fill`，通道里多了"当前描述符"`cur`，start 时 = link）：
  - TX：tx_start 之后按帧率一块一块取描述符（length 字节），取出时刻 = 这块第一帧的播放时刻；放完这一块报 OUT_DONE，描述符带 suc_eof 的再报 OUT_EOF（OUT_EOF_DES_ADDR = 这块），next = 0 的报 OUT_TOTAL_EOF 并停。IDF 在 EOF 中断里把缓冲还给 `i2s_channel_write`，所以写入被播放速度卡住
  - RX：rx_start 之后每块 = min(描述符 size, RXEOF_NUM 剩余) 字节（整帧），按帧率录满的时刻写进描述符（length、owner 交还 CPU），累计满 RXEOF_NUM 置 suc_eof、报 IN_SUC_EOF（IN_SUC_EOF_DES_ADDR = 这块），每块报 IN_DONE
  - 通道没启动 / 时钟没配：1 ms 后再看（`stalls` 计数）
- 槽字：模型内部统一成 32 位"槽字"（MSB 对齐）。TX 内存样本（data_bits 位，8/16/24(3 或 4 字节)/32）左移到 32 位；tx_mono（单声道复制）两槽同值；未使能槽送 0，skip_msk 时内存里也有它的样本。RX 取槽字的高 data_bits 位；rx_mono 只存第一个使能槽；rx_msb_shift=0（MSB 格式）而器件是 Philips 时读到错一位的数据（真机也是）
- 接线判断（`SocBus::i2s_update`）：喇叭的 DIN 脚 FUNC_OUT_SEL 是该口的 SD 输出信号（S3 I2S0 25 / I2S1 30，C3 15）才收到声音；麦克风：该口 SD 输入信号的 FUNC_IN_SEL 经矩阵（S3 位 7 / C3 位 6）选的是麦克风 SD 脚才有数据，否则读 0。时钟脚不检查。接错的帧数计入 `tx_unrouted / rx_unrouted`，观察记录里报"接线"
- 引脚约定（`i2s_pin`）：S3 喇叭 BCLK 16 / LRC 17 / DIN 18，麦克风 SCK 39 / WS 40 / SD 41；C3 喇叭 0 / 1 / 2，麦克风 0 / 1 / 3（C3 只有一个 I2S，两者共用 BCK / WS）。网页 `src/i2spins.ts` 同一份
- MAX98357A：(L+R)/2 混成单声道 16 位，带模拟时刻成块排队（给网页，上限约 3 秒，满了丢最老的）+ 最近约 6 秒历史（给读数：去直流、RMS、峰值、过零主频，相邻上升过零点线性插值）。5 V 轨电流 = 静态 2.4 mA + (2.5 Vrms × √均方)² / 4 Ω / (0.85 × 5 V)（估算），由 `Activity::amp_i` 进供电网络（`Board` 第 10 个元件，5V 轨上的 Load）
- INMP441：24 位补码左对齐到槽字，L/R 接地 = 左槽（另一槽高阻读 0），1.4 mA 计入 3V3 模块电流。声源：安静 / WAV（循环，按**模拟时间**取样、线性插值，可复现）/ 实时（网页推入的样本按 I2S 帧率从队列消耗，空了给 0、计欠载）
- 对外：CLI `--i2s max98357a,inmp441`、`--mic <wav>`（自动接麦克风）、`--audio-wav <输出.wav>`；接了音频器件 1 ms 一片（功放电流与网页一致）；结束时 stderr `[tryboard] I2S 喇叭 MAX98357A（…）：收到 N 帧（Ts），采样率 R Hz，最近 1 秒 RMS x、峰值 y、主频 f Hz`、`[tryboard] I2S 麦克风 INMP441（…）：送出 N 帧，声源 …`，`--elec-report` 多一行功放峰值电流。wasm：`tb_i2s_attach(0 喇叭|1 麦克风)`、`tb_audio_take / _ptr / _len`（块：t f64 秒 | rate f32 | n u32 | n×i16，补齐 4 字节）、`tb_audio_stat(0..5)`、`tb_mic_wav(ptr,len)`、`tb_mic_push(ptr,n,rate)`（f32 小端，不要求对齐）、`tb_mic_silence()`、`tb_audio_report()`、`tb_elec_i(5)` / `tb_elec_stat(9)`（功放电流 / 峰值）
- 网页：worker 每片之后取走 PCM，随 tick 发 `pcm` 消息（tick 带 `audio` 读数）；`pcm.ts` 的 PcmVoice 用 AudioWorklet（按绝对帧号寻址的环形缓冲，读完清零）播放，模拟时刻 → 音频时刻的对齐同蜂鸣器（领先 0.12 s，偏出 [0, 0.6 s] 重新对齐），重采样首尾相接（按块取整会在块边界留 1 帧 0，是咔哒声，还会被过零测频多数）；没有 AudioWorklet 退回 AudioBufferSourceNode。与蜂鸣器共用 `BuzzerAudio` 的开关和 AudioContext，`window.__tbAudio.pcm`（输出端 AnalyserNode 测的主频 / RMS）与 `.sim`（模拟器侧读数）给测试读。麦克风（`micinput.ts`）：getUserMedia + AudioWorklet（退回 ScriptProcessor）收集 1024 样本一块，`micPush` 推给 worker；没权限 / 没设备时提示并换回 1 kHz 测试 WAV（`/audio/sine1k.wav`，由 build_web.sh 从 tools/audio 复制）。实时麦克风不进输入日志；InputLog 记 `i2s` / `mic`（WAV 文件名），重放参数 `--i2s` / `--mic tools/audio/<名>`
- 3D（board3d）：MAX98357A 模块（深蓝 PCB、7 针、绿色接线端子）+ Φ40 喇叭（纸盆随模拟器侧 RMS 起伏、冒声波）、INMP441 模块（Φ14 紫色圆板、2×3 针、声孔），都平放在桌上、杜邦线接到开发板；`Bench.setAudio(喇叭 RMS, 麦克风电平)`

## BLE（C-01；内核在 `crates/soc/src/ble/`，C3 接入在 `crates/esp32c3/src/ble.rs`，S3 接入在 `crates/esp32s3/src/ble.rs`）
- 边界：VHCI（主机 NimBLE ↔ 控制器 libbtdm 之间的 HCI 包口）。用户固件里的控制器代码一条都不跑。
- 定位（`ble/sig.rs` + 生成的 `ble/sigs.rs`）：启动时在 app 镜像的 IROM / IRAM 段里逐条指令匹配掩码签名（种类 EXACT / CALL / HI20 / LO12，压缩指令与 4 字节指令都认），每个函数要求唯一命中；pll_track 按调用点找（`btdm_controller_enable` 调用前 24 字节内的 call）。任何一个找不到 → `Ble` 处于错误态（网页 state = 2），固件照常跑，HCI 初始化会自己失败。
- 钩子：`SocBus::code_patch` 在取指时把函数入口覆盖成 `lui t0, 0x40060; jalr x0, 4×槽(t0)`；魔术区 0x40060000..+4×13 不可读写，CPU 取指落进去由 `esp32c3::ble` 按槽做 HLE（槽 0–6 见源文件，12 = 空操作）。要回调固件函数（信号量、notify_host_recv）时把 ra 改成下一个魔术地址接力，返回状态压在当前任务栈上。
- 桩任务：`btdm_controller_init` 借 osi 的 task_create 建一个任务代替控制器任务；它等信号量 → 有到期的控制器事件就调主机回调交包 → 再等。到期时间按模拟周期算（`Ble::next_due`），所以和真实时间无关、可重放。
- 虚拟控制器（`ble/mod.rs`）：命令 → Command Complete / Status；广播（ADV_IND + SCAN_RSP，手机扫描时按固件设的广播间隔出现）；连接建立后 ACL 上跑 L2CAP 的 ATT 通道，连接间隔固定 30 ms，无丢包、无 RSSI 模型。
- 虚拟手机（`ble/phone.rs`）：中心 + GATT 客户端（发现服务 / 特征 / 描述符，读、写、订阅 CCCD、收通知），`view_json()` 给网页画面，空中日志每条 `{n, t(µs), k: adv|conn|att|phone|hci, s}`，文本以「手机 →」「固件 →」开头表示方向。
- 命令（输入日志 `ble=` 后面的部分）：`scan` / `scan off` / `connect [地址]` / `disconnect` / `read <UUID 或 0x句柄>` / `write <UUID 或 0x句柄> <十六进制>` / `sub|unsub <UUID 或 0x句柄>` / `auto`（扫描→连第一台→读全部→订阅全部可通知）。CLI 在 1 ms 片边界应用输入；网页同样记进输入日志（`{kind:'ble', cmd}`）。
- wasm 导出：`tb_ble_state()`（0 无 / 1 有 / 2 没认出边界）、`tb_ble_seq()`（日志条数，变了才取）、`tb_ble_json(from)` → `{"view":…,"log":[…]}` 或 `{"error":…}`（返回长度，指针 `tb_ble_json_ptr()`）、`tb_ble_cmd(ptr,len)`（0 成功，失败原因走 `tb_error_ptr/len`）。worker 每片后按 seq 变化或 250 ms 发 `ble` 消息；网页侧 `web/src/ble.ts`（解析）、`web/src/app/blepane.tsx`（坞页签 BlePane、手机 PhonePanel，`bleFeed` 节流 ≤ 10 Hz）。
- S3（E-04）：定位用 `ble/sig_xt.rs` + 生成的 `ble/sigs_xt.rs`（`tools/ble_sigs.py gen-xt`；种类 EXACT / LONGCALL / FILL / LIT，4 字节对齐起点，方法见 DECISIONS 2026-10-20 E-04）；pll_track 同样按 `btdm_controller_enable` 调用前 24 字节内的 call 找（CALLn 或未松弛的 `l32r+callxN`）。钩子不改取指：8 个入口地址和魔术槽 0x40060000..+4×6 都放进 `Cpu::hle_addrs`（`hle_hi` 抬到最高入口 + 1），`run_core` 的 `Exit::Hle` 先查 ROM HLE 表、再交 `ble::call_at`。拦在 ENTRY 之前，窗口还是调用者的：n = PS.CALLINC，参数 a(4n+2..)，返回地址 a(4n)，结果写 a(4n+2)，PC 回到调用点之后，不跑 RETW。要回调固件函数时借调用者的 CALLn：a(4n) = n<<30 | 魔术槽、PS.CALLINC = n、PC = f，f 的 RETW 回到魔术槽且窗口不变；原返回地址按调用者 SP 存在 `BleHle::frames`（跨任务可重入）。桩任务名用 osi `_malloc_internal`（偏移 120）分配再交 task_create；task_create 的第 7 个参数 core_id 在调用者栈上，原样读，bt.c 把越界值当不绑核。`SocBus::ble` 是 `ble::Slot { hle, error }`。BT 地址 = eFuse MAC + 2 = 02:54:42:00:00:05。
- 经典 ESP32（E-09）：同一套窗口 ABI HLE（`esp32s3::ble` 泛化成 `Bus` trait + `Osi` 布局表，`esp32::ble` 只给 `OSI_ESP32` 和 SocBus 实现）。签名 `ble/sigs_lx6.rs`（`tools/ble_sigs.py gen-lx6`，`sig_xt::LX6`）。差别：osi 表版本 0x10005 在偏移 0、魔数 0xFADEBEAD 在 248，semphr_create / take / give / task_create / malloc_internal = 28 / 44 / 48 / 92 / 112；LX6 链接把密度指令放宽（`mov.n` → `or`），匹配时窄 / 宽规范化；`btdm_controller_get_mode` 与 get_sleep_mode 等同形，按 `btdm_controller_enable` 调用前 96 字节内的 call 定位；无 pll_track 钩子，Nop 槽改挂 `btdm_in_wakeup_requesting_set`（bt.c 每次 VHCI 发送前后调它，它经控制器自己的 osi 指针拿信号量，而注册被钩住所以指针为 NULL）。BT 地址 = eFuse MAC + 2 = 02:54:42:00:00:06；`boot::install_ble` 在 `enter_windowed` 前装钩，core 1 复制 `hle_addrs`。
- Bluedroid（E-05）：虚拟控制器的应答对两种主机栈一样，NimBLE 不看的位才改。LE 本地特性只报 LL Privacy（bit 6）：Bluedroid 开了 `CONTROLLER_RPA_LIST_ENABLE` 就无条件往控制器解析列表加默认项，列表大小为 0 会空指针 / 除零；解析列表只应答不解析。另有 Bluedroid 才发的 Read Local Name（0x0C14，248 字节）、Host Number Of Completed Packets（0x0C35，按规范不回事件，主机信用不建模）、C2H 流控 / Host Buffer Size / RPA 超时 / Espressif 广播报告流控 0xFD09（只回状态）。解析列表增删清（0x2027–0x2029）、地址解析使能（0x202D）、隐私模式（0x204E）留在兜底分支：NimBLE 也发，挪出来会改它的 `unknown_cmds` 报告。签名不用改：Bluedroid 固件里的 libbtdm 与 NimBLE 固件同一份。
- 虚拟电脑（E-06，`ble/desk.rs`）：手机的一种模式（`Phone.desk`），复用其 GATT 客户端。`pc=on` → 扫描并连名字以 `Claude` 开头的设备 → MTU（247）→ 发现后按 128 位 UUID 找 NUS RX `6e400002` / TX `6e400003` → 订阅 TX → `Desk::start`：依次发 `{"time":[BASE_EPOCH+模拟秒,28800]}`、`{"cmd":"owner","name":"TryBoard"}`、首条心跳；之后每 2 s `{"cmd":"status"}`，心跳在脚本相位（6 s）变化或 10 s 保活时发。一行按 (MTU-3) 拆片（`desk::fragment`）：RX 有无应答写属性就用 0x52（每连接事件最多 4 片，不占 pending），否则 0x12 一片一事件；TX 通知进 `LineBuf` 按 `\n` 重组，>4096 字节整行丢弃，ack 解析成 `pc: ack <cmd> #n ok`。空中日志新类别 `k: "pc"`（`pc …` / `fw → pc …`）。命令走同一通道：`Ble::phone_cmd("pc=…")` / `tb_ble_cmd`；CLI `--desk-pc` = 第 0 周期 `pc=on`。`Phone::json()` 多一个 `pc` 字段（on / active / sent / heartbeats / polls / acks / last_rx / last_hb）给 E-07 网页用。所有内容只由模拟时间决定，无墙钟。

## 板预设（M5-05，`crates/machine/src/boards.rs`）
- 数据表 `BOARDS: &[BoardPreset]`，每项包括：id、显示名、芯片、eFuse 封装号、Flash / PSRAM 容量、屏 spec（与 `lcd_attach_spec` 同格式，-1 = 未接）、引脚 I2C 总线和器件（`make_i2c` 的 kind@addr）、触摸 INT 脚、编码器 A/B 脚、按钮（名、脚、低有效）、需要固定电平的脚、仅作说明的输出脚（蜂鸣器、背光、电源保持……）、`verified`、备注。加板只需加一行，不写代码。
- 应用顺序（`Machine::board_preset(id)`，在 boot 之后、其它器件参数之前）：
  1. 检查芯片，不符时报错，CLI 退出码 2。
  2. 写 eFuse 封装号。
  3. 挂屏。
  4. 加 I2C 总线和器件。
  5. 设 IMU 安装方向 `imu_mount`（M5-06）：BMI270 加速度 / 陀螺和 AUX 上 BMM150 的轴映射（`imu::Mount`，传感器轴 i = 符号 × 板轴），取 M5Unified 对该板重排轴的逆，使同一 `imu=` 姿态在各板上经驱动后读数一致。AtomS3R：加速度 / 陀螺 (-y, x, z)，地磁 (-x, y, -z)。
  6. 接触摸 INT。
  7. 接编码器。
  8. 把按钮驱到松开电平，并驱固定电平。
  9. PSRAM：经典 ESP32 用 `set_psram_mb` 挂上（M5-14 建模）；S3 见下方 `psram_quad`。
  10. `battery_adc: Some((pin, 分压比))`（无 PMIC 的板，如 StickC Plus2 G38 / 2）：开机给 80% 的 OCV；脚本 `bat=` 走 `battery_set` 的 ADC 分支。
  CLI 的 `--i2c` / `--spi` / `--i2c-bus` 等在预设之后叠加。
- `verified`：
  - m5dial 已验证：`arduino-m5-probe-dial` / `arduino-m5-dial-demo` 跑通了 M5Unified 检测、触摸、RTC、编码器、BtnA 和屏幕。
  - 经典 ESP32 的 m5stickcplus2 / m5core2 / m5core2v11 / m5atomlite（M5-13）用 `arduino-m5-probe-*` 与 `arduino-m5-stickc-demo-*` 验证（检测、屏、IMU、RTC、PMIC / 电池、按钮或触摸区、麦克风、Atom 的 WS2812）。Atom Lite 与 Matrix 靠触摸脚 4 / 7（G13 / G27）区分：SENS 触摸模型（`sens.rs` TOUCH_OUT1..5 = 0x70..0x80，CTRL2 0x84 bit10 恒为完成，各脚空闲计数 `TOUCH_IDLE` = 1000）读数相等即判为 Lite。
  - m5atoms3 / m5atoms3lite / m5atoms3r 已验证（M5-06）：同一个 `m5stack_atoms3` FQBN 固件（arduino-esp32 3.3.2 没有 Lite / R 的 FQBN）运行时识别三块板，`arduino-m5-probe-atoms3*`、`arduino-m5-atoms3-imu*` 用例。
  - 其余是存根，备注写明由哪个 PLAN 项验证。CLI 会打印 "(UNVERIFIED preset)"。
  - 已验证的预设只要有一个部件挂不上就返回错误；存根只给警告。
  - m5cores3 / m5cores3se 也已验证（M5-07，`arduino-m5-probe-cores3` 一个固件两块板 + `arduino-m5-cores3-demo`）。
  - PSRAM：S3 8MB 不再警告；`psram_quad` 让 S3 的 PSRAM 走四线协议（Arduino `m5stack_cores3` 的 `psram_type=qspi`），其余仍警告。
  - `touch_int_aw9523: Some((port, bit, gpio))`：触摸 INT 接在 AW9523 输入脚上，`touch()` 改 AW9523 输入，`after_run` 开头把 AW9523 INTN 同步到 gpio（CoreS3 为 P1_2 → G21）。
  - `speaker: Some((bclk, ws, dout))`：在这几脚挂扬声器接收端（`Chip::attach_speaker_at`），CoreS3 为 34 / 33 / 13（AW88298 的增益 / 使能未建模）。
- 单测 `table_is_consistent`：id 不重复，所有器件 kind 都能创建，所有屏 spec 都能解析。
- 接口：
  - Rust：`board_preset(id) -> Result<Vec<String>, String>`（返回警告列表）、`board()`、`board_button(name, down)`、`board_list()`。
  - CLI：`--board <id>`、`--board list`；脚本动作 `btn=A,1|0`（预设按钮）、`rtc=EPOCH`（改板上 RTC）。触摸用已有的 `touch=x,y` / `release`，编码器用 `enc=±N`。
  - wasm：`tb_board_preset(p, len) -> i32`（0 成功，1 失败）。网页 UI 尚未接入。
- Grove 单元（M5-09a）：`BoardPreset.grove_a: Option<(sda, scl)>` 是 Port A 引脚；`GROVE_UNITS`（`GroveUnit { id, name, devices }`）：`env3` = sht30@0x44 + qmp6988@0x70，`env4` = sht40@0x44 + bmp280@0x76。`Machine::grove_attach(unit)` 在 `board_preset` 之后用 `i2c_bus_add(sda, scl, true)` 新建一条引脚总线挂上器件。CLI `--grove env3|env4`（在 `--env` 之前生效），wasm `tb_grove(p, len) -> i32`。`env_set` 更新所有总线上的 Bme280 / Bmp280 / Sht3x / Sht4x / Qmp6988。器件在 `devices/sht.rs`（SHT3x 单次 / 周期 / ART / 状态 / 序列号，SHT4x 单字节命令；没测完时 NACK 读头）、`devices/qmp6988.rs`（OTP 25 字节，QST 参考的整数补偿反解出原始值，强制 / 正常模式，IIR 未建模）、`Bme280::bmp280`（id 0x58，无湿度）。
- 网页 Grove（M5-09d）：`SceneSpec.grove`（`'env3' | 'env4'`，只在 M5 预设板上生效）→ `devsOf().grove` → boot / seek / verify / simrun 的 `grove` 字段；worker `bootWasm` 与 `simrun.runSim` 在 `tb_board_preset` 后、`tb_env_set` 前调 `tb_grove`（与 CLI 同序），输入日志头 `grove` → 回放 `--grove`。UI 在 `web/src/app/bench/preset.tsx` `GrovePick`（`#grovePort`）。
- M5Dial 映射（参考 M5Unified / M5GFX 读出来的，不是复制）：
  - GC9A01：SCLK 6、MOSI 5、CS 7、DC 4、RST 8、BL 9。
  - 内部 I2C（SDA 11 / SCL 12）：FT3267 0x38、BM8563 0x51。触摸 INT 14。
  - 编码器 40 / 41（A/B 顺序是推断的）。
  - BtnA G42（低有效）。电源保持 G46。
  - 蜂鸣器 G3（I2S 1-bit，尚无模型）。
- Cardputer / Cardputer-Adv（M5-08）：
  - 预设新字段：`keyboard: Option<Keyboard>`（`Hc138 { select, cols }` 或 `Tca8418`）、`mic: Option<Mic>`（`bclk / ws / data / pdm / both`；both = 两个声道同样本，M5Unified 默认读右声道）。挂载顺序在 I2C 之后。
  - 键盘：`crates/machine/src/keyboard.rs` 的 4×14 图例 `KEY_LEGEND`，`key_pos(name)`；Rust `board_key(name, down)`；脚本动作 `key=<名>,1|0`（`,` `;` 等用别名 comma / semicolon …）；wasm `tb_board_key(p, len, down) -> i32`。
  - 74HC138 矩阵：`soc/devices/keymatrix.rs` `KeyMatrix`，Chip 默认方法 `key_matrix_attach / key_matrix_set`（目前只有 S3 实现）；S3 在 `gpio_changed` 里组合求值（`Gpio::key_matrix_settle`，同 `i2c_pins_settle`），被选行把按下键所在列拉低。
  - 图例→矩阵 / TCA8418 行列映射是推断的（未对照 M5Cardputer 库），需真机核对。
  - 麦克风：Cardputer 是 SPM1423 PDM（CLK G43、DATA G46），走 `i2s.rs` 的 PDM2PCM（RX_CONF bit20 PDM_EN + bit21 PDM2PCM_EN；bit22 DSR16 → 每样本 128 个 PDM 时钟，否则 64，依 IDF i2s_pdm.c）；Adv 用 INMP441 模型顶替 ES8311（BCK 41、WS 43、DIN 46，两个声道同样本）。
  - PDM 帧率 = BCK ÷ 64 或 128（DSR16）；clk_sel 1 按 M5-07 定为 240 MHz，M5Unified 写的分频这样算出正好 16 kHz（M5Unified 自己按 120 MHz、64× 算，两处偏差互相抵消，需真机核对）。
- S3 GPIO 电平（M5-08 改）：开漏释放、外部无人驱动的焊盘，若只有 IO_MUX 下拉（FUN_PD）则读 0（之前一律读 1）。M5GFX 的 Cardputer / Adv 区分和 M5Unified 的 I2C 总线检测都靠这个。C3 / 经典 ESP32 未改。

## 分享状态 v1（F-01a；`web/src/app/sharestate.ts`，页面接入在 `web/src/app/shareopen.ts`）
- 链接：`/app?s=<base64url(deflate-raw(JSON))>#bench`。导出 `encodeState` / `decodeState`（抛 `ShareDecodeError`，`reason` = `corrupt` | `newer`）、类型 `ShareStateV1`、`captureState`、`shareLink`、`redact`、`shareKey`。
- 字段：`v`=1；`w` 作品 id（空白作品 `blank:<示例>`）；`sel` 选板地址参数（自定义作品）；`cp` 检查点；`fw` `{ex, h}` 内置示例 + `fw/<ex>/flash.bin` 的 sha256 前 10 位（同 `tools/asset_hashes.py`）；`chip`；`scene` / `ext5v` 和默认不同时才有；`mods` 改线；`harness` 装配线束（和默认不同才有）；`env`、`heat`、`loc`；`run` `{endMs, s}`，`s` 是 `tryboard run --inputs` 正文；`cut` 被剥掉的隐私项（`wifi` / `net`）；`tl` 环境脚本（F-11，可选，`ScenarioV1` `{len, tracks}`，`parseScenario` 校验，坏了按 `corrupt`），`run.s` 仍是完整的 `--inputs` 正文、脚本已编译进去，`tl` 只给编辑器复原，所以不升 `v`；链接过长丢 `run` 时保留 `tl`。
- 环境脚本（F-11；`web/src/app/scenario.ts` 纯函数 + `scenariofeed.ts` 状态 + `scenariopane.tsx` 底栏「脚本」页 / 手机抽屉）：轨道 `temp` / `light` / `dist` / `btn` / `net` 等，关键帧 10 ms 网格、同轨最小间隔 100 ms（关键帧本身不受限）、最长 600 s、不循环。`compileScenario(sc, room, {has})` 编成输入事件（env 按轨道 100 ms 抽样、dist 量化到 1 cm、按键松开 = 浮空 `z`）；`LiveSim` 开机时 `fresh: true` 整份发给 worker，worker 在切片边界 `apply` → `record`，所以输入日志是唯一事实来源、`--inputs` 重放逐字节一致；运行中改动只替换 `at > now` 的未来事件，改到播放头之前标记过期、提示重启。作品脚本存 localStorage `tryboard-scenario:<作品 key>`；打开分享链接带的 `tl` 不写回（`save: false`）。嵌入页有 `tl` 时工具栏上方显示只读进度条 `#embedScenario`。验收 `node tools/webtest/scenario.mjs`、`web/test/scenario.test.ts`。
- 往后加字段只能可选；改语义就升 `v` 并在 `migrate` 里转换。
- 打开：`readShare` 在会话启动前解码并把作品改成本地副本（`work.key = share:<fnv>`）；`restoreShare` 在开机后换固件、`session.seek` 快进到 `endMs`，然后接着跑。测试钩子：`__tbShare()` 生成链接，`__tbShareRestored` 是快进结果（stdout / report / endMs）。
- 验收：`node tools/webtest/share.mjs`。
- `.tryboard` 文件（F-01b；纯函数在 `sharestate.ts`：`packTryfile(state, bin, name)` / `unpackTryfile(bytes)`，页面接入在 `web/src/app/tryfile.ts`）：`TRYBOARD 1\n` + 一行状态 JSON + `\n` + 原始 bin。头行数字是文件格式版本，与状态 `v` 无关；高于 1 报 `newer`。状态多一个可选字段 `bin` `{name, h, size}`（h = 完整 sha256 hex），只出现在文件里；有 `bin` 时 `run` 绑定这个 bin（`CaptureInput.ownRun`）。
- 打开文件：`openFile` 校验魔数 / 版本 / 大小 / sha256，把 `encodeState(state)` 串和 bin 存进 IndexedDB `tryboard-files/files`（键 = `shareKey(s)` 的 8 位 hex，留最近 3 个），然后跳到 `?f=<键>#bench`；`main.tsx` 启动时 `takeFile(键)` 取回状态串交给 `readShare`，开机后把 bin 传给 `restoreShare(ctx, sh, own)`（先过 `fwCheck`）。不放进 `?s=`：长操作的状态超过服务器请求行上限。入口：换固件文件框（`accept=".bin,.tryboard"`，`pickFirmware` 按扩展名分流）、页面任意处拖放（`installDrop`，只接 `.tryboard`，不抢已有拖放区）、⋯「下载 .tryboard 文件」（`actions.shareFile`）。测试钩子 `__tbShareFile()` 返回 `{name, own, run, b64}`。

## 嵌入页（F-03；`web/embed.html`，代码在 `web/src/embed/`）
- 地址：`/embed?s=<同分享链接的 s>`（可加 `&lang=zh`、`&theme=dark`）。`main.ts` 只解码状态、显示标题 + 芯片 + ▶ 海报（首屏 JS + CSS gzip 约 25 KB，中日韩另预载 site + app 词典约 140 KB gzip；不含 wasm / three.js / 固件）；点 ▶ 后才动态 `import('./run')`，`createSession` + `restoreShare` 复用实验台的同一套代码（快进到 `endMs` 后接着跑）。
- 精简台面：3D 台面（板上 BOOT / RST 可按）、暂停 / 继续、重启、模拟时间、可折叠串口（`#console`）、右下角「在 TryBoard 打开」（新窗口 `/app?s=<同一个 s>`）。没有顶栏、步骤条、放件改线、时间线、装配。
- 存储：不读 `readShare`（它会写线束），工作键用 `share:<fnv>`；点 ▶ 时 `memstore.ts shieldStorage()` 把 `window.localStorage` 换成内存副本（从真实存储拷一份只读），会话里任何保存都只进内存。测试钩子 `__tbEmbedRealKeys()` 返回真实存储的键、`__tbEmbed` = `{store, session}`；`__tbShareRestored` 同完整页。
- 头：`web/public/_headers` 只给 `/embed` 和 `/embed.html` 加 `Content-Security-Policy: frame-ancestors *`（其它页面保持托管默认）。本地 vite preview / 测试服务器不读 `_headers`，这条规则要上线后才能验证。
- 嵌入代码（推荐；`allow-popups*` 是「在 TryBoard 打开」新窗口要的，只要能运行的最小集合是 `sandbox="allow-scripts allow-same-origin"`，同源那项是 worker / wasm 同源加载必需）：
```
<iframe src="https://<域名>/embed?s=…" width="640" height="420" style="border:0;max-width:100%" loading="lazy"
 allow="fullscreen; autoplay" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="TryBoard"></iframe>
```
- 验收：`node tools/webtest/embed.mjs`（宿主页 `tools/webtest/fixtures/embed-host.html` 放在另一个源）。按原速回放见下一条（F-03b）。
- 按原速回放（F-03b）：`/embed?s=…&replay=1` 或 `/app?s=…&replay=1`；嵌入海报在有运行记录时多一个「按原速回放」勾选框（`#embedPaced`，`&replay=1` 预选）。实现：`SeekJob.paced` → worker `seek` 消息带 `paced`，上电后停在 0、不跑 `seekTo`；之后 `run` 的实时循环 `loopSlice` 每个 1 ms 切片前调 `pacedStep`（与 `seekTo` 同一个 `dueList`、同样的「切片边界 ≥ at 就施加、到 untilMs 不再施加」），所以到 untilMs 的周期和状态与快进逐字节一致；到点后 `settleReplay`（与 seek 共用：录好的网络回复、真网开关、网络预设）并发 `replayed {snap}`，然后接着实时跑。回放期间 `pumpNet` 不跑（录好的 netreply 按原时刻作为事件施加，不提前取缓存也不联网）。主线程：`LiveSim.pacedEnd()` 在 `replayed` 时给快照，被上电 / 另一次 seek 打断给 null；`session` 按 tick 的模拟时间把已过的事件同步到界面（`gpio` → `bench.showPress` 按键下沉，`env` → 房间温度，`imu` → 姿态，`dist` → 障碍物），不再发给 worker。`shareopen.ts`：`restoreShare(ctx, sh, own, paced)`、`shareReplay()` 返回 `{endMs, done, skip()}`，`skip()` = 原来的快进路径；`wantsPaced(search)` 读 `replay=1`。嵌入工具栏回放中显示「回放中 t / end s」（`#embedReplay`）和「跳到结尾」（`#embedSkip`），结束 / 跳过 / 重启后消失。`__tbShareRestored` 在原速回放结束时才写，多一个 `paced: true`。
