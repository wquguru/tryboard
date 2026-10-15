# 覆盖矩阵

最后更新：2026-10-15（`tools/accept.sh` 全部通过）

## ESP32-C3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU RV32IMC + Zicsr | ✅ | riscv-tests rv32ui/um/uc 50/50 | M 模式；A 扩展已实现（给以后的芯片） |
| 中断矩阵 + CPU 中断控制器 | ✅ | FreeRTOS 调度、vTaskDelay 计时与 QEMU 一致 | 电平 / 边沿、优先级、阈值 |
| SYSTIMER | ✅ | esp_timer 测 500ms 延时误差 < 0.1% | 16MHz，比较器单次 / 周期 |
| TIMG0/1 | 🟡 | 启动期 RTC 校准 | T0 计数 / 告警 / 自动重载已写，缺独立验收；看门狗不触发复位 |
| UART0/1 | 🟡 | 控制台输出 | TX 瞬间完成；RX 有缓冲但缺验收固件 |
| GPIO 输出 | ✅ | blink：GPIO5 翻转次数 | GPIO 矩阵外设信号路由未做 |
| GPIO 输入 / 中断 | ☐ | — | 网页 BOOT 键已接 GPIO9，固件侧未验收 |
| SPI1 flash 控制器 | ✅ | 识别 GD 4MB 芯片 | 读 / 写 / 擦除命令已写，缺 NVS 验收 |
| EXTMEM / MMU | ✅ | 直接启动映射 + 运行时读写 MMU 表 | cache 操作瞬间完成 |
| eFuse | 🟡 | 芯片版本 v0.4、MAC | 只读 |
| 模拟前端（regi2c） | 🟡 | HLE，ocode 校准通过 | 不建模模拟电路本身 |
| USB-Serial-JTAG | 🟡 | 第二控制台输出被吞掉 | 网页里暂不显示 |
| LEDC / RMT / I2C / SPI2 / ADC / I2S | ☐ | — | M2 |
| Wi-Fi / BLE | ☐ | — | M6 / M7 |

## ESP32-S3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU Xtensa LX7 基础 ISA + 窗口 | 🟡 | `tools/xtensa-tests` 8/8；深递归覆盖六种窗口溢出 / 下溢 | 缺中断、FPU、MAC16、PIE；未与 QEMU 差分 |

## 网页
| 项 | 状态 |
|---|---|
| wasm 内核 | ✅ 115KB，无 import |
| 1× 实时 / 加速 | ✅ blink、hello 在 Chrome 无头模式下 1.00× |
| 3D 工作台 | ✅ 面包板 + 开发板 + LED 随 GPIO 亮灭；BOOT / RST 可点 |
| 串口输入 | 🟡 已接线，缺验收固件 |
