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

## 浏览器
- wasm 导出见 `core/crates/wasm/src/lib.rs`（`tb_*`）。没有 import，实例化时传 `{}`。
- 资源：`/wasm/tryboard.wasm`、`/rom/esp32c3_rev3_rom.elf`（附 Apache-2.0 LICENSE）、`/fw/<示例>/flash.bin` 与 `/fw/examples.json`。
- 渲染：three.js WebGL2 + 后期泛光（LED 发光）。WebGPU 等 three 的 WebGPU 渲染器稳定后再切。

## Xtensa LX7 核（ESP32-S3，`core/crates/xtensa`）
- 配置取自 ESP-IDF `components/xtensa/esp32s3/include/xtensa/config/core-isa.h`：64 个物理 AR、窗口 ABI、16 位密度指令、零开销循环、MUL16/MUL32/MULUH/MULSH/DIV32、NSA/MIN/MAX/SEXT/CLAMPS、布尔寄存器、S32C1I、硬件非对齐访存、VECBASE 复位 0x40000000。
- 取指按首字节 op0 判长度（8..=13 为 2 字节，否则 3 字节）；`Bus::fetch` 默认逐字节读，SoC 可重写成快路径。
- 窗口：`a(i)` = 物理 `ar[(WINDOWBASE*4 + i) & 63]`。每条指令执行前按它用到的最高四元组做溢出检查（`max_quad`，宁可多估），撞到 WINDOWSTART 中别的活帧就把最老的那帧溢出：EPC1 = 本指令、PS.OWB = 原 WB、WB 转到被溢出帧，按到下一帧的距离选 OF4/OF8/OF12 向量；RETW 发现调用者帧已不在寄存器里则走 UF 向量。PS.WOE=0 或 EXCM=1 时不检查（处理程序本身不会递归溢出）。
- 向量偏移（相对 VECBASE）：OF4 0x000、UF4 0x040、OF8 0x080、UF8 0x0C0、OF12 0x100、UF12 0x140、Kernel 0x300、User 0x340、Double 0x3C0。
- 循环：顺序执行到 LEND 且 LCOUNT≠0、EXCM=0 时回到 LBEG；循环体末尾是已跳转的分支时以分支为准。
- 中断：32 条线，级别 / 类型按 core-isa.h（外部电平、外部边沿 10/22/28/30、NMI 14、软件 7/29、定时器 6/15/16、性能计数 11）。`INTERRUPT` = 锁存位（边沿 / NMI / 软件 / 定时器）| 外部电平线。可响应条件：挂起 & INTENABLE 的最高级别 > max(PS.INTLEVEL, EXCM ? 3 : 0)。level 1 走 User/Kernel 向量（EXCCAUSE=4），level n≥2 存 EPC_n / EPS_n、置 INTLEVEL=n 与 EXCM，跳 VECBASE+0x180/0x1C0/0x200/0x240/0x280/0x2C0。
- SoC 接口：`set_irq_lines(mask)` 驱动外部线；`step()` 遇 WAITI 返回 `Exit::Waiti`，SoC 可把 `cpu.cycles` 直接推到 `next_timer_event()`（及自己外设的下一事件），下一次 step 会补检 CCOMPARE 越过；`Exit::Simcall` 可当空操作；`Bus::rer/wer` 给外部寄存器（默认读 0）。
- CCOUNT 每条指令 +1（真机 CPI 标定以后做）；写 CCOMPAREn 清对应定时器挂起位。
- FPU（CP0，CPENABLE 位 0 门控，否则 EXCCAUSE 32）：f64 精确值 + 一次舍入实现 4 种舍入模式，非规格数不冲零，FSR 标志累加；NaN 传播与除法 / 开方分步指令的模型见 `fpu.rs` 模块说明与 DECISIONS。
- MAC16：40 位 ACC、m0..m3、LDINC/LDDEC 与并行装载形式；区域保护 TLB 指令（8 个 512MB 区域属性）；SALT/SALTU。
- 未实现：PIE（EE.*）指令，按非法指令处理。
- 验收：`tools/xtensa-tests/*.S` 自检汇编（`build.sh` 用 xtensa-esp32s3-elf-gcc 构建），`cargo test -p tryboard-xtensa` 跑全部并统计六个窗口向量的命中次数；`window` 测试必须六种都触发。本机有乐鑫 QEMU 时同一 ELF 在 QEMU 上跑一遍逐字差分，见 `tools/xtensa-tests/README.md`。
