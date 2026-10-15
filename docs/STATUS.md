# 覆盖矩阵

最后更新：2026-10-15（`tools/accept.sh` 全部通过）

## ESP32-C3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU RV32IMC + Zicsr | ✅ | riscv-tests rv32ui/um/uc 50/50 | M 模式；A 扩展已实现（给以后的芯片） |
| SYSTIMER | ✅ | esp_timer 测 500ms 延时误差 < 0.1% | 16MHz，比较器单次 / 周期 |
| TIMG0/1 | 🟡 | 启动期 RTC 校准 | T0 计数 / 告警 / 自动重载已写，缺独立验收；看门狗不触发复位 |
| UART0/1 | ✅ | echo：驱动收行回显 | TX 瞬间完成；RX 阈值 + 超时中断 |
| GPIO 输入 / 中断 | ✅ | button：下降沿中断 + 消抖 | IO_MUX 上下拉；板载 GPIO9 上拉；边沿 / 电平中断 |
| 中断矩阵 + CPU 中断控制器 | ✅ | FreeRTOS 调度、vTaskDelay 计时与 QEMU 一致；GPIO / LEDC / UART / RMT 中断 | 电平 / 边沿、优先级、阈值（2026-10-15 修正 CPU_INT_PRI_n 下标错位：PRI_0 在 0x114） |
| GPIO 输出 | ✅ | blink：GPIO5 翻转次数 | GPIO 矩阵：RMT 输出信号（51/52）已路由到引脚，其它外设信号未做 |
| SPI1 flash 控制器 | ✅ | 识别 GD 4MB 芯片 | 读 / 写 / 擦除命令已写，缺 NVS 验收 |
| EXTMEM / MMU | ✅ | 直接启动映射 + 运行时读写 MMU 表 | cache 操作瞬间完成 |
| eFuse | 🟡 | 芯片版本 v0.4、MAC | 只读 |
| 模拟前端（regi2c） | 🟡 | HLE，ocode 校准通过 | 不建模模拟电路本身 |
| USB-Serial-JTAG | 🟡 | 第二控制台输出被吞掉 | 网页里暂不显示 |
| LEDC | ✅ | fade：5kHz 13 位硬件渐变时序与 IDF 计算一致；servo：50Hz 脉宽 | 不逐周期出波形，按占空比给出引脚 PWM |
| ADC（APB_SARADC 单次） | ✅ | pot：0 / 1250 / 2400mV 读数误差 < 1LSB+噪声 | 衰减档线性近似、±2LSB 噪声；连续模式（DMA）未做；eFuse 校准数据未提供（adc_cali 不可用） |
| RMT 发送 | ✅ | rgb：1 颗 WS2812 四色逐帧一致；strip：16 颗 × 3 帧逐颗一致（384 条目，靠阈值中断乒乓填充 + 回绕） | 时钟源 / 组分频 / 通道分频、mem_size 借块、回绕、连续（循环）模式与循环计数中断、结束 / 阈值 / 出错中断；未做载波、APB FIFO 模式 |
| RMT 接收 | ☐ | — | 寄存器可读写，没有外部输入源，不会产生接收数据 |
| WS2812 解码器 | ✅ | 同上 | 引脚连到 RMT 输出时自动挂上；高电平 >0.6µs 判 1，低电平 ≥40µs 提交一帧 |
| I2C / SPI2 / I2S | ☐ | — | M2（I2C 在分支开发中） |
| Wi-Fi / BLE | ☐ | — | M6 / M7 |

## ESP32-S3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU Xtensa LX7 基础 ISA + 窗口 | 🟡 | `tools/xtensa-tests` 8/8；深递归覆盖六种窗口溢出 / 下溢 | 缺中断、FPU、MAC16、PIE；未与 QEMU 差分；缺 SALT/SALTU、TLB 族、RER/WER（S3 crate 里有临时垫片）；**MOVSP 的 Alloca 条件反了**（应为 WINDOWSTART[WB-1..WB-3] 全 0 才报，现为任一为 1 就报；垫片撤回多报，少报的情况救不回来） |
| 启动（直接启动 + ROM） | ✅ | s3-hello 单核：从 call_start_cpu0 跑到 app_main，打印芯片信息 / 16MB flash / Free heap 402804，与 QEMU 逐行一致 | CALLINC=0 进入口、入口帧 [sp-12] 填指向 ROM .stack_app 的指针；核 1 不启动（UNICORE） |
| **当前止步点** | ⚠️ | `tryboard run firmware/build/s3-hello/flash.bin` | `vTaskDelay(500ms)` 约 2µs 就返回、app_main 返回后 vTaskDelete 不切换任务 → `abort()` → 进 `esp_restart_noos+0x104` 空转。原因：核不响应中断（SYSTIMER 节拍、任务切换都依赖 level-1 中断）。SoC 侧已把外部中断线写进 INTERRUPT SR，等核实现中断裁决 |
| 存储映射 / MMU / PSRAM | ✅ | 单元测试：flash / PSRAM 页翻译、PSRAM 可写、SRAM I/D 别名 | 512 项 MMU（位 15 选 PSRAM）；8MB PSRAM 只有存储与映射，PSRAM 芯片初始化流程（MSPI / OPI 命令）未模拟，CONFIG_SPIRAM 固件尚未验收 |
| 中断矩阵（核 0） | 🟡 | 单元测试：电平线、边沿线上升沿、复位映射到线 16 = 不连接 | 99 个源；INTR_STATUS 可读；核 1 矩阵未做 |
| UART / SYSTIMER / TIMG / SPI1 flash / LEDC | 🟡 | s3-hello 启动期使用（控制台、RTC 校准、flash 识别 GD 16MB） | 复用 C3 模型（寄存器布局同族）；TIMG 的 T1、LEDC 的通道 6/7 未建模 |
| EXTMEM（I/D cache 分开） | ✅ | 启动期 freeze / sync / autoload 轮询通过 | cache 操作瞬间完成 |
| GPIO（49 脚）/ IO_MUX | 🟡 | — | 输出 / 输入 / 上下拉 / 中断状态已写，未有 S3 示例验收 |
| eFuse | 🟡 | 芯片版本 v0.2、MAC、PSRAM_CAP=8MB | 只读 |
| 模拟前端（regi2c） | 🟡 | HLE（窗口 ABI 返回），ocode 校准通过；BBPLL 校准完成位（I2C_MST_ANA_CONF0 bit24） | 不建模模拟电路 |
| 双核 | ☐ | — | 后续：核 1 由 SYSTEM_CORE_1_CONTROL 放行 + ets_set_appcpu_boot_addr，需第二个 Cpu 实例与跨核中断 |

## 网页
| 项 | 状态 |
|---|---|
| wasm 内核 | ✅ 115KB，无 import |
| 1× 实时 / 加速 | ✅ blink、hello 在 Chrome 无头模式下 1.00× |
| 3D 工作台 | ✅ 面包板 + 开发板 + LED 随 GPIO 亮灭；板载 WS2812（GPIO8）随解码颜色发光；BOOT / RST 可点 |
| 串口输入 | 🟡 已接线，缺验收固件 |
