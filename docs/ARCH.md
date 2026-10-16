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
- 密码学原语全部自己实现（`wifi/crypto.rs`：SHA-1、HMAC、PBKDF2、PRF、AES-128/192/256、Key Wrap、CCM、CCMP），按 FIPS 180 / RFC 2202 / RFC 6070 / IEEE 802.11 附录 / FIPS 197 / RFC 3394 / RFC 3610 / NIST SP 800-38A 测试向量做单元测试。

## SHA / AES 加速器（ESP32-C3 / S3，`crates/esp32c3/src/crypto_hw.rs`）
- 两颗芯片寄存器排布相同；`ShaHw::write(off, v, 链头, mem)` / `AesHw::write(off, v, (输入链头, 输出链头), mem)` 不依赖 SoC，链头由 SoC 先从自己的 GDMA（`sha_link` / `aes_links`）取。
- SHA（0x6003B000）：SHA-1 / 224 / 256，START / CONTINUE 处理 TEXT 寄存器里的一块，DMA_START / DMA_CONTINUE 从 GDMA 取 BLOCK_NUM 块；H 寄存器按"摘要字节小端装载"存（`sha_hal_read_digest` 直接 memcpy 成摘要）。BUSY 恒为 0。
- AES（0x6003A000）：128 / 256 位，单块模式（TEXT_IN → TEXT_OUT）与 DMA 模式（ECB / CBC / OFB / CTR / CFB8 / CFB128，IV 寄存器随运算更新），DMA 完成 STATE = 2、写 DMA_EXIT 回 0。
- GDMA 不在这里建模：按 OUT/IN_PERI_SEL（AES = 6、SHA = 7）找到接到本外设的通道，读 OUTLINK / INLINK 描述符地址，沿 lldesc 链读写、清 owner 位。GDMA 模型落地后改成走它的接口（见 DECISIONS）。

## 芯片无关外壳（`core/crates/machine`）
- `enum Machine { C3, S3 }`：按镜像头芯片 ID（5 / 9）选芯片，给 CLI 和 wasm 一套接口（运行、控制台、GPIO 读写、PWM、ADC 电压、WS2812、I2C 器件、OLED、SPI 圆屏、调试状态）。加新芯片只改这里。

## 供电网络（`core/crates/elec`，C3 / S3 共用）
- `mna.rs`：节点电压法 + 隐式欧拉；元件 R / C / V（理想或带内阻）/ I / Limit（带限流的源）/ Ldo / Load（恒流，低于 vknee 退成电阻）/ Motor（舵机电机：max(0,(min(v,vcmd)−emf)/r)）。分段线性元件用 Katzenelson 法解（见 DECISIONS「电气模型」），稠密 LU 部分主元。`spice.rs` 读 SPICE 子集（R/C/V/I、.op、.tran，`*tb:` 行写自定义元件），CLI `tryboard elec-net` 用它与 ngspice 对照（`tools/elec/compare.py`）
- `board.rs`：开发板网络（5V 轨、3V3、舵机红线、外接 5 V 四个节点；USB 口 0.5 A 限流、外接 5 V 2 A、SGM2212 LDO、去耦电容、芯片 / 模块 / 舵机负载）。固定 100 µs 一步、只走整步。3V3 < 门限（S3 2.44 V / C3 2.51 V）持续 0.12 ms → 欠压复位，按住到电压回升
- `servo.rs`：SG90 二阶动力学（比例控制 + 电机 + 减速箱），给电流和角度，不影响固件读数
- 接法：`Machine { hw: Hw::C3|S3, elec: Board }`。`Machine::run` 跑完一段后按这段的活动（忙的核数 = 指令数 / 周期数、Wi-Fi 收发帧、舵机脚 PWM 脉宽）推进 `elec`；触发欠压就以 `Stop::Reset(15)` 结束，调用方 `reboot(15)`；按住期间 `run` 不执行指令、只走时间。`reboot` 往串口补 ROM 头三行（`rst:0x..`），第一次上电不补
- CLI：`--power usb|ext`（默认 usb）、`--servo GPIO`（接了就 1 ms 一片）、`--elec-report`（`[tryboard] 电气 …` 各节点最低电压、峰值电流、复位次数与时刻）、脚本动作 `power=usb|ext`；`tryboard elec-net 网表 [--at 秒,…]`
- wasm：`tb_power_set(0 usb|1 ext)`、`tb_servo_attach(pin)`、`tb_elec_v(1 5V|2 3V3|3 舵机|4 外接)`、`tb_elec_i(0 USB|1 外接|2 舵机|3 3V3|4 芯片)`、`tb_elec_stat(0..8)`（最低电压、峰值电流、复位次数、是否按住）、`tb_elec_brownout_t(i)`、`tb_servo_angle()`、`tb_elec_report()`（文字同 CLI，读 `tb_report_ptr`）

## 浏览器
- wasm 导出见 `core/crates/wasm/src/lib.rs`（`tb_*`）。没有 import，实例化时传 `{}`。主线程先读镜像头判断芯片、下载对应 ROM，再 `tb_boot`；`tb_chip` / `tb_boot_pin` 告诉前端换哪块板、BOOT 键在哪个脚；S3 的 GPIO32 以上用 `tb_gpio_level_hi` / `tb_gpio_enable_hi`。
- 资源：`/wasm/tryboard.wasm`、`/rom/esp32c3_rev3_rom.elf`（附 Apache-2.0 LICENSE）、`/fw/<示例>/flash.bin` 与 `/fw/examples.json`。
- 渲染：three.js WebGL2 + 后期泛光（LED 发光）。WebGPU 等 three 的 WebGPU 渲染器稳定后再切。
- 页面：`index.html` 实验台（main.ts）、`home.html` 首页（home.ts）、`levels.html` 关卡（levels.ts）、`advisor.html` 选型。公共资源加载在 `assets.ts`；首页 / 关卡的实时运行用 `live.ts`（包一层 worker.ts）。
- SVG 视图（`src/views/`）：`bench`（面包板）、`product`（成品）、`assembly`（拖拽装配，装完切到成品）、`showcase`（成品示意，不跑固件）。视图只画，数据来自模拟器帧（OLED 像素、各脚 PWM 占空比、板载 WS2812）；舵机角度由 50 Hz 脉宽换算。
- SVG 视图补充：`templates.ts` 是装配模板（零件、装法、检查、影响、成品工厂），`assembly.ts` 只是通用引擎；`lcdproducts.ts` 是圆屏成品（spin / lens），画面来自 worker 的 `lcd` 消息（GC9A01 240×240 RGBA，变化才发、≤ 30 帧/秒）。3D 实验台里圆屏是一块圆形贴图（board3d.ts `roundLcdModule`）。
- PWM 观察：CLI 与网页在汇总行之后都输出 `[tryboard] PWM GPIOn 变化 占空比@时刻 …`（三位小数相同的相邻记录合并），关卡用它判"脉宽依次出现的台阶"（`pwm.steps`）和"稳定以后的值"（`pwm.from` 秒）。
- 第 07 关这类"多个成品可选"的关用 `variants`，CLI 和网页都展开成 `07-spin` 这样的子关（`expand` / `expandLevels`）。
- 供电（P1-02 / P1-04）：worker 的 `boot` / `seek` 带 `servo`、`power`；`power` 消息在线切换（记进输入日志 `supply` 事件，导出 `power=usb|ext`）；tick 带 `elec`（`ElecFrame`：节点电压、电流、3V3 最低、峰值、复位次数、按住、舵机角度）和 `brownouts`（新复位的模拟时刻）。实验台：供电属性面板 / 快捷卡片显示实时值并切换供电，时间线记"欠压复位"，工具条"万用表"点针读电压（`pinscope.meterVolts`），3D 舵盘用动力学角度（`Bench.setServoAngle`）。验收 worker（verify-worker.ts）认 `--servo / --power` 参数与 `power=` 脚本，接了舵机也 1 ms 一片
- 作品专属检查点（`spin-1`、`spin-2`、`lens-1`、`lens-2`）是 levels.json 顶层条目，带 `"work"` 字段；作品走哪几个检查点写在 `web/src/app/works.ts`（首页卡片的检查点数也读它）。小黄：spin-1 → spin-2 → 07-spin；透镜：lens-1 → lens-2 → 07-lens（07 的变体就是"合体"，带装配）。
- 圆屏判定：观察记录在"非黑像素"行之后追加颜色统计 `[tryboard] LCD 颜色 #rrggbb N 像素，重心 x,y`（圆内各非黑颜色，前 12 种、≥ 50 像素，`Gc9a01::color_report`，CLI 与 wasm 共用）；levels.json 的 `lcd_colors` 按颜色容差求和、可限水平重心，`serial_count` 数串口某段文字出现的次数。
- 实时运行（worker.ts）时间片固定 1ms（`tb_run(160000)`），外部输入只在时间片之间施加，并按施加那一刻的 CPU 周期记进输入日志（`inputlog.ts`）。CLI `--inputs` 同样全程 1ms 一片、在时间片开头施加 `t ≤ 当前模拟时间` 的输入，所以网页上的一串操作导出后能逐周期重放（S3 双核交替点也一致）。格式见 DECISIONS 2026-10-16「输入日志」。
- 蜂鸣器（audio.ts）：worker 对 `watchPwm` 的引脚每片采样占空比与频率（`tb_pin_pwm_freq`），变化带模拟时刻放进 tick 的 `pwmEvents`；主线程把模拟时刻映射到 AudioContext 时间轴（领先 60ms，偏离超过 0.4s 重新对齐），方波振荡器 + 增益开关。测试读 `window.__tbAudio`。
- 逻辑分析仪事件（P1-05，`crates/esp32c3/src/iotrace.rs`）：SocBus 里一个有上限的环形缓冲，按 CPU 周期盖戳记 GPIO（只记 watch 掩码里的脚，在 `gpio_changed` 里比较）、PWM（`update` 里 LEDC 修改计数或 GPIO 使能 / 矩阵变了才扫各脚 `pin_pwm`）、WS2812 帧（`route_rmt` 里解码器帧数变了）、I2C 事务（`I2c::run_commands` 按命令表产生 START / ADDR / DATA / STOP，时刻按 SCL 位推算，SocBus 写完寄存器后搬进缓冲）。CLI `--trace-io` 每片取走写文本；wasm `tb_io_take` 拷成 16 字节记录，worker 攒着随 tick 发 `io` 消息（上电 / 回退先发 reset），主线程 `app/iotrace.ts` 的 IoStore 按通道整理、解 I2C 事务，`app/analyzer.ts` 画。格式与上限见 DECISIONS「逻辑分析仪事件缓冲」
- ⌘K（P1-06，`app/cmdk.ts` + 纯函数 `app/cmdmatch.ts`）：候选 = 命令（含按输入生成的"把室温设为 N ℃""回到第 n 次运行"）+ 零件 + 引脚（listPins）+ 检查点 + 运行；执行走 store / session / 时间线现有接口
- 关卡验收：`firmware/levels.json` 是唯一来源，判定规则在 `tools/check.py` 和 `web/src/checks.ts` 各写一份、逐条对应。浏览器里由 `verify-worker.ts` 按**模拟时间**跑（不看墙钟），时间片 / 脚本施加 / PWM 采样照搬 CLI `run` 的循环；观察记录用 wasm 的 `tb_report`（与 CLI `--gpio-log --ws2812-log` 同格式）。运行指纹 = FNV-1a(串口原始字节 + `\n#report\n` + 规范化观察记录)，`tools/webtest/levels.mjs` 逐关核对网页与命令行指纹相同。

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
- HLE：rom_i2c_* 在 ROM 函数入口（ENTRY 之前）拦截，此时窗口仍是调用者的：参数在 a(4·CALLINC+2..)，返回地址在 a(4·CALLINC)（高 2 位为 CALLINC），返回值写回 a(4·CALLINC+2)，PC 直接回到调用点之后。
- 软件复位：`mmio_write` 看 RTC_CNTL_OPTIONS0 的复位位（脉冲，存回的值去掉它们）。SW_PROCPU_RST / SW_SYS_RST 记 `reset_request`，写它的那个核在下一条指令前停下，`run` 返回 `Stop::Reset(12 / 3)`；SW_APPCPU_RST（esp_restart 先复位并停住另一个核）直接把核 1 停掉。`Esp32s3::reboot` 用一条新总线重新直接启动：先放进旧的 RTC 慢 / 快速内存和 RTC_CNTL_STORE0–3/6/7，再装镜像段（.rtc.data 被重新装载，与 bootloader 在非深睡唤醒时的做法一致；RTC_NOINIT 不在镜像里所以保留）；RTC_CNTL_RESET_STATE 读回复位原因（两核同值），`esp_reset_reason()` 结合 STORE6 里的提示得到 ESP_RST_SW。外部世界（引脚外部驱动、ADC 电压、I2C 器件、GPIO 记录、WS2812 解码）搬到新机器；模拟时间继续。
- 八线 PSRAM（`psram.rs`）：不 HLE，ROM 的 `esp_rom_opiflash_exec_cmd` 照常配 SPI1 寄存器；写 CMD 的 USR 位时若 SPI_MEM_MISC 选的是 CS1（CS0_DIS=1、CS1_DIS=0）就交给 `OctalPsram`：0x4040 / 0xC0C0 读写模式寄存器（MR1 厂商 0x0D AP、MR2 density 3 = 8MB / 第 3 代 / good-die，MR3 VCC=3V；写只落 MR0/4/8），0x0000 / 0x8080 同步读写存储体（与 cache 共用 `SocBus::psram`）。dummy、DTR 采样相位、驱动强度只存不用。
- 外设：与 C3 同族的模型直接复用 tryboard-esp32c3（UART、SYSTIMER、TIMG、SPI1、LEDC、I2C + 器件、RMT + WS2812、GP-SPI2、GDMA + GC9A01、SHA / AES），Wi-Fi MAC 复用 tryboard-soc（`WifiLayout::S3`，中断源 0；WDEV_RND_REG 在 0x6003507C；SENS 温度传感器给 READY），按芯片参数化的是 RMT（`RmtLayout`：通道数、寄存器块起点、RAM 偏移、GPIO 矩阵信号号）与 GDMA（`GdmaLayout`）；S3 独有的是中断矩阵、EXTMEM、49 脚 GPIO、SENS 单次 ADC（periph.rs）。
- 入口帧溢出保存区：核 0 / 核 1 分别借用 ROM 的 level 5 / level 4 中断栈（app 装了自己的向量表后 ROM 不再用）。
- 崩溃检测：落进 ROM 异常向量（VECBASE 仍为 0x40000000 时）停机报 EXCCAUSE / EPC1；app 装了自己的 VECBASE 后，崩溃由固件自己的 panic 处理程序打印（Guru Meditation），CLI 照常转发。
- 中断：32 条线，级别 / 类型按 core-isa.h（外部电平、外部边沿 10/22/28/30、NMI 14、软件 7/29、定时器 6/15/16、性能计数 11）。`INTERRUPT` = 锁存位（边沿 / NMI / 软件 / 定时器）| 外部电平线。可响应条件：挂起 & INTENABLE 的最高级别 > max(PS.INTLEVEL, EXCM ? 3 : 0)。level 1 走 User/Kernel 向量（EXCCAUSE=4），level n≥2 存 EPC_n / EPS_n、置 INTLEVEL=n 与 EXCM，跳 VECBASE+0x180/0x1C0/0x200/0x240/0x280/0x2C0。
- SoC 接口：`set_irq_lines(mask)` 驱动外部线；`step()` 遇 WAITI 返回 `Exit::Waiti`，SoC 可把 `cpu.cycles` 直接推到 `next_timer_event()`（及自己外设的下一事件），下一次 step 会补检 CCOMPARE 越过；`Exit::Simcall` 可当空操作；`Bus::rer/wer` 给外部寄存器（默认读 0）。
- CCOUNT 每条指令 +1（真机 CPI 标定以后做）；写 CCOMPAREn 清对应定时器挂起位。CCOUNT = `cycles` + 偏移：固件写 CCOUNT（IDF 换 CPU 频率时按新旧频率比例改写）只改偏移，`cycles` 是整机模拟时间，不能跳（否则复位后启动时时间会被放大数倍、两核时间错开）。
- FPU（CP0，CPENABLE 位 0 门控，否则 EXCCAUSE 32）：f64 精确值 + 一次舍入实现 4 种舍入模式，非规格数不冲零，FSR 标志累加；NaN 传播与除法 / 开方分步指令的模型见 `fpu.rs` 模块说明与 DECISIONS。
- MAC16：40 位 ACC、m0..m3、LDINC/LDDEC 与并行装载形式；区域保护 TLB 指令（8 个 512MB 区域属性）；SALT/SALTU。
- 未实现：PIE（EE.*）指令，按非法指令处理。
- 验收：`tools/xtensa-tests/*.S` 自检汇编（`build.sh` 用 xtensa-esp32s3-elf-gcc 构建），`cargo test -p tryboard-xtensa` 跑全部并统计六个窗口向量的命中次数；`window` 测试必须六种都触发。本机有乐鑫 QEMU 时同一 ELF 在 QEMU 上跑一遍逐字差分，见 `tools/xtensa-tests/README.md`。

## 原生 USB OTG（ESP32-S3，`crates/esp32s3/src/usb/`）
- `dwc2.rs`：Synopsys DWC2 设备模式（基址 0x60080000，中断源 38）。寄存器按 DWC2 编程模型；ID / 硬件配置读回 S2/S3 实测值（GSNPSID 0x4F54400A = 4.00a，CSRST 自清；GHWCFG2 0x224DD930、GHWCFG3 0x00C804B5、GHWCFG4 0xD3F0A030）。
  - 两条数据通路：GAHBCFG.DMAEN=1 时按 DIEPDMAn / DOEPDMAn 直接读写内存（SETUP 写到 DOEPDMA0 后指针 +8、置 STUP、关 EP0 OUT）；否则走 Slave：GRXSTSP 弹出状态字、FIFO 窗口读数据，IN 数据由固件写入各端点发送 FIFO（按 32 位字，含包尾填充，取包时按 tsiz 算包长并丢弃填充）。
  - 中断：GINTSTS 的 RXFLVL / IEPINT / OEPINT / OTGINT / BOUTNAKEFF 由状态实时算出；DAINT = 各端点 (DxEPINT & DxEPMSK)，IN 端点在 DIEPEMPMSK 置位时加上 TXFE（发送 FIFO 空）。
  - 线上事务不逐位模拟：虚拟主机以"SETUP / IN / OUT 令牌"为单位调用 `setup` / `token_in` / `token_out`，得到 ACK（含数据）/ NAK / STALL。
- `host.rs`：虚拟主机。DCTL.SDIS 清零即视为 D+ 上拉接入 → 10ms 去抖 → 总线复位（USBRST）→ 10ms 后 ENUMDNE（全速）→ 恢复期 → 枚举。控制传输是一个小状态机（SETUP → 数据 IN / OUT → 状态），NAK 就下一拍重试，2 秒无进展判超时。配置后按端点间隔轮询 HID 中断 IN、CDC 批量 IN，CDC 批量 OUT 发送队列。
- 调度：设备接上总线后，SoC 每 0.25ms 唤醒一次推进主机（`SocBus::update` 里把 `usb` 从 Option 临时取出，借总线给 DMA 访问内存）；断开后不再唤醒，不影响空闲快进。
- 对外：CLI `--usb-log`、脚本 `usbcdc=文本`；wasm `tb_usb_version` / `tb_usb_json` / `tb_usb_json_ptr` / `tb_usb_cdc_send`，JSON 结构见 `web/src/usb3d.ts` 的 `UsbView`。

## GP-SPI2 / GDMA / GC9A01 圆屏（ESP32-S3；模型在 `crates/esp32c3/src/{gpspi,gdma}.rs`、`devices/gc9a01.rs`）
- GP-SPI2 主机（0x60024000，中断源 21）：寄存器按 `spi_reg.h`，复位值由各字段注释的 default 求得。CMD.UPDATE 瞬间完成；写 CMD.USR 时 SoC 按 USER 里的阶段（命令 → 地址 → 哑周期 → MOSI / MISO）组织一次传输：命令值按 bit7..0、bit15..8 顺序，地址从 ADDR 最高位移出，MOSI 数据在 DMA_CONF.dma_tx_ena=1 时从 GDMA 取、否则从 W0..W15 取。字节立即交给从机；CMD.USR 读回 1 直到按 SPI 时钟算出的结束时刻，然后置 DMA_INT_RAW.trans_done（位 12）。时钟：CLK_GATE.mst_clk_sel 选 PLL 80MHz / XTAL 40MHz，CLOCK.clk_equ_sysclk 或 ÷(pre+1)(n+1)。
- GDMA（0x6003F000，5 通道，间距 0xC0，IN 组在 +0x00、OUT 组在 +0x60；中断源 IN 66..70、OUT 71..75）：PERI_SEL 复位为 0x3F（不接），SPI2 = 0。OUT_LINK 只有低 20 位，完整地址 = 0x3FC00000 | addr；start / stop / restart 自清，park 恒为 1。SPI 传输开始时沿描述符链（字 0：size[11:0]、length[23:12]、suc_eof[30]、owner[31]；字 1 缓冲区；字 2 下一个）一次取完，out_auto_wrback 时交还 owner、记 OUT_EOF_DES_ADDR；传输结束时置 OUT_DONE / OUT_EOF / OUT_TOTAL_EOF。
- 圆屏 GC9A01（`SocBus::lcd`，CLI `--spi gc9a01`、wasm `tb_lcd_attach`，C3 / S3 都有）：S3 接线固定为 SCLK=12、MOSI=11、CS=10、DC=14、RST=13、背光=15（`tryboard_esp32s3::lcd_pin`）；C3 为 SCLK=6、MOSI=7、CS=10、DC=5、RST=4、背光=3（`tryboard_esp32c3::lcd_pin`）。SCLK / MOSI / CS 都是 SPI2 的 IO_MUX 直连脚。D/C 取传输开始时 DC 脚的电平；片选见 DECISIONS。命令：SWRESET、SLPIN/SLPOUT、DISPON/DISPOFF、INVON/INVOFF、MADCTL（MY/MX/MV 换算显存坐标，BGR 位）、COLMOD（16 / 18 位）、CASET、RASET、RAMWR、RAMWRC，其余算厂商命令只计数。显存 240×240 RGB888；渲染时按"常黑 IPS（INVON 才是原色）、BGR 子像素"换算，圆形可视区（半径 120）外透明。
- 对外：CLI stderr `[tryboard] LCD GC9A01 非黑像素 N（显示开/关）`、`--lcd-ppm <路径>`；wasm `tb_lcd_attach() -> i32`、`tb_lcd_version() -> u32`、`tb_lcd_ptr() -> *const u8`（240×240×4 RGBA），`tb_report` 在 OLED 行之后追加 `[tryboard] LCD GC9A01 非黑像素 N` 和颜色统计行（见上）。
