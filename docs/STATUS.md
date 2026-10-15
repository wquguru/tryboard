# 覆盖矩阵

最后更新：2026-10-15（`tools/accept.sh` 全部通过）

## ESP32-C3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU RV32IMC + Zicsr | ✅ | riscv-tests rv32ui/um/uc 50/50 | M 模式；A 扩展已实现（给以后的芯片） |
| 中断矩阵 + CPU 中断控制器 | ✅ | FreeRTOS 调度、vTaskDelay 计时与 QEMU 一致；I2C 中断线 7 | 电平 / 边沿、优先级、阈值。2026-10-15 修正：CPU_INT_PRI_n 下标错一位（PRI_0 在 0x114），之前 SYSTIMER 能用是碰巧 |
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
| I2C0 主机 | ✅ | oled：总线扫描只应答 0x3C、1KB 帧 400kHz 传输 23.8ms（理论 23.2ms）；bme280：END 分段、重复起始读 | 命令表 COMD0–7、TX/RX FIFO、NACK / END / 完成中断、按 SCL 配置算事务耗时；未做：从机模式、10 位地址、超时与仲裁丢失（不会发生）、时钟延展 |
| 虚拟器件 SSD1306 | ✅ | 帧缓冲点亮 1636 像素、网页截图可读 | 命令解析：寻址模式 / 窗口 / 页模式、电荷泵、开关、对比度、反色、重映射；滚动不做 |
| 虚拟器件 BME280 | ✅ | 设定 -7.25°C / 88.5% / 950.12hPa，固件按数据手册公式读回误差 0；网页滑块改温度后读数跟随 | 原始 ADC 由补偿公式二分反解；强制 / 正常模式测量时序；无噪声、无 IIR 滤波 |
| LEDC / RMT / SPI2 / ADC / I2S | ☐ | — | M2 |
| Wi-Fi / BLE | ☐ | — | M6 / M7 |

## ESP32-S3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU Xtensa LX7 | ✅ | `tools/xtensa-tests` 11/11 自检；与 QEMU 逐字差分 14215 字、0 不一致；深递归覆盖六种窗口溢出 / 下溢 | 含中断、CCOMPARE、FPU、MAC16、SALT/SALTU、TLB 族、RER/WER；PIE（EE.*）未做 |
| 启动（直接启动 + ROM） | ✅ | s3-hello（单核）与 QEMU 逐行一致；FreeRTOS 延时 499.9ms | 入口帧溢出保存区借用 ROM level 4/5 中断栈 |
| 双核 | ✅ | s3-dual：两任务各钉一核、自旋锁计数 2×20000 准确、跨核队列、esp_ipc 在核 1 执行 | `ets_set_appcpu_boot_addr` HLE 启动核 1（栈 ROM .stack_app），PRID 0xABAB；每核一张中断矩阵；两核按 256 周期量子确定性交替，都空闲时一起快进；外设时间取两核中较快者（单调） |
| 存储映射 / MMU / PSRAM | ✅ | 单元测试：flash / PSRAM 页翻译、PSRAM 可写、SRAM I/D 别名 | 8MB PSRAM 只有存储与映射，PSRAM 芯片初始化（MSPI / OPI）未模拟，CONFIG_SPIRAM 固件尚未验收 |
| 中断矩阵（核 0 / 核 1） | ✅ | 单元测试 + s3-dual（FROM_CPU 跨核中断、两核各自 SYSTIMER 节拍） | 99 个源；核 1 表在 +0x800 |
| GPIO（49 脚）/ IO_MUX | ✅ | s3-blink：GPIO5 翻转 | 外设信号经 GPIO 矩阵驱动引脚（RMT）；输出信号号 256 = 普通 GPIO |
| LEDC | ✅ | s3-pot：5kHz PWM 占空比跟随 ADC | 与 C3 同一模型（扩到 8 通道），输出信号 73..80 |
| RMT + WS2812 | ✅ | s3-rgb：GPIO48 解码 6 帧，前 4 帧颜色逐颗一致 | 与 C3 同一模型，按 `RmtLayout::S3`（4 发 4 收、RAM +0x800、信号 81..84）参数化 |
| I2C0 / I2C1 | ✅ | s3-oled：扫描只应答 0x3C，1KB 帧 400kHz 约 24.0ms，点亮 1636 像素 | 与 C3 同一模型（寄存器布局逐项一致），I2C1 在 0x60027000 |
| SAR ADC 单次（SENS） | ✅ | s3-pot：0 / 1550 / 3000mV 读数正确 | S3 单次采样走 RTC 的 SENS（0x60008800），不是 APB_SARADC；衰减档量程近似 950 / 1250 / 1750 / 3100mV；ADC2 仲裁标志、连续模式未做 |
| UART / SYSTIMER / TIMG / SPI1 flash | ✅ | 控制台、FreeRTOS 节拍、RTC 校准、flash 识别 GD 16MB | 复用 C3 模型；TIMG 的 T1 未建模 |
| EXTMEM / eFuse / 模拟前端 | 🟡 | 启动期轮询通过；芯片版本 v0.2、PSRAM_CAP=8MB | cache 操作瞬间完成；eFuse 只读；regi2c HLE |
| USB OTG / Wi-Fi / BLE | ☐ | — | USB OTG 在另一分支开发 |

## 网页
| 项 | 状态 |
|---|---|
| wasm 内核 | ✅ 约 230KB（C3 + S3 两颗芯片），无 import；按镜像头自动选芯片（`tryboard-machine`） |
| 1× 实时 / 加速 | ✅ blink、hello 在 Chrome 无头模式下 1.00× |
| 3D 工作台 | ✅ 面包板 + 开发板 + LED 随 GPIO 亮灭；板载 WS2812（C3 GPIO8 / S3 GPIO48）随解码颜色发光；BOOT / RST 可点；示例按 `scene.parts` 声明元件与接线，可指定机位 |
| 按芯片换板 | ✅ C3 板（2×15 针）/ S3 板（2×22 针、UART / USB 双口、N16R8）；元件按当前板子的引脚重新接线；网页验收 s3-blink、s3-rgb、s3-dual 1.00× 实时 |
| OLED 实时画面 | ✅ 帧缓冲变了才传，128×64 最近邻纹理 |
| 环境滑块 | ✅ 温度 / 湿度 / 气压 → `tb_env_set`，webtest 验证读数跟随 |
| 串口输入 | 🟡 已接线，缺验收固件 |
