# 覆盖矩阵

最后更新：2026-10-15（`tools/accept.sh` 全部通过）

## ESP32-C3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU RV32IMC + Zicsr | ✅ | riscv-tests rv32ui/um/uc 50/50 | M 模式；A 扩展已实现（给以后的芯片） |
| 中断矩阵 + CPU 中断控制器 | ✅ | FreeRTOS 调度、vTaskDelay 计时与 QEMU 一致；GPIO / LEDC / UART 中断 | 电平 / 边沿、优先级、阈值（2026-10-15 修正 PRI_n 偏移错位） |
| SYSTIMER | ✅ | esp_timer 测 500ms 延时误差 < 0.1% | 16MHz，比较器单次 / 周期 |
| TIMG0/1 | 🟡 | 启动期 RTC 校准 | T0 计数 / 告警 / 自动重载已写，缺独立验收；看门狗不触发复位 |
| UART0/1 | ✅ | echo：驱动收行回显 | TX 瞬间完成；RX 阈值 + 超时中断 |
| GPIO 输出 | ✅ | blink：GPIO5 翻转次数 | GPIO 矩阵外设信号路由未做 |
| GPIO 输入 / 中断 | ✅ | button：下降沿中断 + 消抖 | IO_MUX 上下拉；板载 GPIO9 上拉；边沿 / 电平中断 |
| SPI1 flash 控制器 | ✅ | 识别 GD 4MB 芯片 | 读 / 写 / 擦除命令已写，缺 NVS 验收 |
| EXTMEM / MMU | ✅ | 直接启动映射 + 运行时读写 MMU 表 | cache 操作瞬间完成 |
| eFuse | 🟡 | 芯片版本 v0.4、MAC | 只读 |
| 模拟前端（regi2c） | 🟡 | HLE，ocode 校准通过 | 不建模模拟电路本身 |
| USB-Serial-JTAG | 🟡 | 第二控制台输出被吞掉 | 网页里暂不显示 |
| LEDC | ✅ | fade：5kHz 13 位硬件渐变时序与 IDF 计算一致；servo：50Hz 脉宽 | 不逐周期出波形，按占空比给出引脚 PWM |
| ADC（APB_SARADC 单次） | ✅ | pot：0 / 1250 / 2400mV 读数误差 < 1LSB+噪声 | 衰减档线性近似、±2LSB 噪声；连续模式（DMA）未做；eFuse 校准数据未提供（adc_cali 不可用） |
| RMT / I2C / SPI2 / I2S | ☐ | — | M2（RMT、I2C 在分支开发中） |
| Wi-Fi / BLE | ☐ | — | M6 / M7 |

## 网页
| 项 | 状态 |
|---|---|
| wasm 内核 | ✅ 115KB，无 import |
| 1× 实时 / 加速 | ✅ blink、hello 在 Chrome 无头模式下 1.00× |
| 3D 工作台 | ✅ 面包板 + 开发板 + LED 随 GPIO 亮灭；BOOT / RST 可点 |
| 串口输入 | 🟡 已接线，缺验收固件 |
