# 覆盖矩阵

最后更新：2026-10-15（`tools/accept.sh` 全部通过）

## ESP32-C3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU RV32IMC + Zicsr | ✅ | riscv-tests rv32ui/um/uc 50/50 | M 模式；A 扩展已实现（给以后的芯片） |
| 中断矩阵 + CPU 中断控制器 | ✅ | FreeRTOS 调度、vTaskDelay 计时与 QEMU 一致；RMT 中断驱动 led_strip | 电平 / 边沿、优先级、阈值（2026-10-15 修正 CPU_INT_PRI_n 下标错位：PRI_0 在 0x114） |
| SYSTIMER | ✅ | esp_timer 测 500ms 延时误差 < 0.1% | 16MHz，比较器单次 / 周期 |
| TIMG0/1 | 🟡 | 启动期 RTC 校准 | T0 计数 / 告警 / 自动重载已写，缺独立验收；看门狗不触发复位 |
| UART0/1 | 🟡 | 控制台输出 | TX 瞬间完成；RX 有缓冲但缺验收固件 |
| GPIO 输出 | ✅ | blink：GPIO5 翻转次数 | GPIO 矩阵：RMT 输出信号（51/52）已路由到引脚，其它外设信号未做 |
| GPIO 输入 / 中断 | ☐ | — | 网页 BOOT 键已接 GPIO9，固件侧未验收 |
| SPI1 flash 控制器 | ✅ | 识别 GD 4MB 芯片 | 读 / 写 / 擦除命令已写，缺 NVS 验收 |
| EXTMEM / MMU | ✅ | 直接启动映射 + 运行时读写 MMU 表 | cache 操作瞬间完成 |
| eFuse | 🟡 | 芯片版本 v0.4、MAC | 只读 |
| 模拟前端（regi2c） | 🟡 | HLE，ocode 校准通过 | 不建模模拟电路本身 |
| USB-Serial-JTAG | 🟡 | 第二控制台输出被吞掉 | 网页里暂不显示 |
| RMT 发送 | ✅ | rgb：1 颗 WS2812 四色逐帧一致；strip：16 颗 × 3 帧逐颗一致（384 条目，靠阈值中断乒乓填充 + 回绕） | 时钟源 / 组分频 / 通道分频、mem_size 借块、回绕、连续（循环）模式与循环计数中断、结束 / 阈值 / 出错中断；未做载波、APB FIFO 模式 |
| RMT 接收 | ☐ | — | 寄存器可读写，没有外部输入源，不会产生接收数据 |
| WS2812 解码器 | ✅ | 同上 | 引脚连到 RMT 输出时自动挂上；高电平 >0.6µs 判 1，低电平 ≥40µs 提交一帧 |
| LEDC / I2C / SPI2 / ADC / I2S | ☐ | — | M2 |
| Wi-Fi / BLE | ☐ | — | M6 / M7 |

## 网页
| 项 | 状态 |
|---|---|
| wasm 内核 | ✅ 115KB，无 import |
| 1× 实时 / 加速 | ✅ blink、hello 在 Chrome 无头模式下 1.00× |
| 3D 工作台 | ✅ 面包板 + 开发板 + LED 随 GPIO 亮灭；板载 WS2812（GPIO8）随解码颜色发光；BOOT / RST 可点 |
| 串口输入 | 🟡 已接线，缺验收固件 |
