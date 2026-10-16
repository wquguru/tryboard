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

## 芯片无关外壳（`core/crates/machine`）
- `enum Machine { C3, S3 }`：按镜像头芯片 ID（5 / 9）选芯片，给 CLI 和 wasm 一套接口（运行、控制台、GPIO 读写、PWM、ADC 电压、WS2812、I2C 器件、OLED、SPI 圆屏、调试状态）。加新芯片只改这里。

## 浏览器
- wasm 导出见 `core/crates/wasm/src/lib.rs`（`tb_*`）。没有 import，实例化时传 `{}`。主线程先读镜像头判断芯片、下载对应 ROM，再 `tb_boot`；`tb_chip` / `tb_boot_pin` 告诉前端换哪块板、BOOT 键在哪个脚；S3 的 GPIO32 以上用 `tb_gpio_level_hi` / `tb_gpio_enable_hi`。
- 资源：`/wasm/tryboard.wasm`、`/rom/esp32c3_rev3_rom.elf`（附 Apache-2.0 LICENSE）、`/fw/<示例>/flash.bin` 与 `/fw/examples.json`。
- 渲染：three.js WebGL2 + 后期泛光（LED 发光）。WebGPU 等 three 的 WebGPU 渲染器稳定后再切。
- 页面：`index.html` 实验台（main.ts）、`home.html` 首页（home.ts）、`levels.html` 关卡（levels.ts）、`advisor.html` 选型。公共资源加载在 `assets.ts`；首页 / 关卡的实时运行用 `live.ts`（包一层 worker.ts）。
- SVG 视图（`src/views/`）：`bench`（面包板）、`product`（成品）、`assembly`（拖拽装配，装完切到成品）、`showcase`（成品示意，不跑固件）。视图只画，数据来自模拟器帧（OLED 像素、各脚 PWM 占空比、板载 WS2812）；舵机角度由 50 Hz 脉宽换算。
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
- 外设：与 C3 同族的模型直接复用 tryboard-esp32c3（UART、SYSTIMER、TIMG、SPI1、LEDC、I2C + 器件、RMT + WS2812、GP-SPI2、GDMA + GC9A01），按芯片参数化的是 RMT（`RmtLayout`：通道数、寄存器块起点、RAM 偏移、GPIO 矩阵信号号）与 GDMA（`GdmaLayout`）；S3 独有的是中断矩阵、EXTMEM、49 脚 GPIO、SENS 单次 ADC（periph.rs）。
- 入口帧溢出保存区：核 0 / 核 1 分别借用 ROM 的 level 5 / level 4 中断栈（app 装了自己的向量表后 ROM 不再用）。
- 崩溃检测：落进 ROM 异常向量（VECBASE 仍为 0x40000000 时）停机报 EXCCAUSE / EPC1；app 装了自己的 VECBASE 后，崩溃由固件自己的 panic 处理程序打印（Guru Meditation），CLI 照常转发。
- 中断：32 条线，级别 / 类型按 core-isa.h（外部电平、外部边沿 10/22/28/30、NMI 14、软件 7/29、定时器 6/15/16、性能计数 11）。`INTERRUPT` = 锁存位（边沿 / NMI / 软件 / 定时器）| 外部电平线。可响应条件：挂起 & INTENABLE 的最高级别 > max(PS.INTLEVEL, EXCM ? 3 : 0)。level 1 走 User/Kernel 向量（EXCCAUSE=4），level n≥2 存 EPC_n / EPS_n、置 INTLEVEL=n 与 EXCM，跳 VECBASE+0x180/0x1C0/0x200/0x240/0x280/0x2C0。
- SoC 接口：`set_irq_lines(mask)` 驱动外部线；`step()` 遇 WAITI 返回 `Exit::Waiti`，SoC 可把 `cpu.cycles` 直接推到 `next_timer_event()`（及自己外设的下一事件），下一次 step 会补检 CCOMPARE 越过；`Exit::Simcall` 可当空操作；`Bus::rer/wer` 给外部寄存器（默认读 0）。
- CCOUNT 每条指令 +1（真机 CPI 标定以后做）；写 CCOMPAREn 清对应定时器挂起位。
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
- 圆屏 GC9A01（`SocBus::lcd`，CLI `--spi gc9a01`、wasm `tb_lcd_attach`）：接线固定为 SCLK=12、MOSI=11、CS=10、DC=14、RST=13、背光=15（`tryboard_esp32s3::lcd_pin`，正好是 SPI2 的 IO_MUX 直连脚）。D/C 取传输开始时 GPIO14 的电平；片选见 DECISIONS。命令：SWRESET、SLPIN/SLPOUT、DISPON/DISPOFF、INVON/INVOFF、MADCTL（MY/MX/MV 换算显存坐标，BGR 位）、COLMOD（16 / 18 位）、CASET、RASET、RAMWR、RAMWRC，其余算厂商命令只计数。显存 240×240 RGB888；渲染时按"常黑 IPS（INVON 才是原色）、BGR 子像素"换算，圆形可视区（半径 120）外透明。
- 对外：CLI stderr `[tryboard] LCD GC9A01 非黑像素 N（显示开/关）`、`--lcd-ppm <路径>`；wasm `tb_lcd_attach() -> i32`、`tb_lcd_version() -> u32`、`tb_lcd_ptr() -> *const u8`（240×240×4 RGBA），`tb_report` 在 OLED 行之后追加 `[tryboard] LCD GC9A01 非黑像素 N`。
