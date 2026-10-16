# 覆盖矩阵

最后更新：2026-10-16（P2-01 / 04 / 05 分支 wt-pcnt：`tools/accept.sh --no-qemu` 全部通过，固件 47/47（含 s3-encoder、s3-ultrasonic），网页冒烟加 s3-encoder / s3-ultrasonic，web 单测 107 个。此前：固件 40/40（含 s3-brownout-usb / -ext），ngspice 对照 10/10，关卡参考固件 8/8（含 07-spin / 07-lens），网页冒烟 15 个示例 + 关卡 / 装配 / 首页 22 项）

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
| RMT 接收 | 🟡 | 单元测试（C3 布局：通道 2/3、mem_size [25:23]、RX_END 位 2+i、多段电平 + 滤波、结束条目、CH3STATUS 写指针） | 与 S3 共用 `rmt.rs` 接收模型（`RmtLayout::C3`），输入经 GPIO 矩阵（sel[4:0]、inv[5]、经矩阵[6]）；HC-SR04 等引脚器件 C3 也能挂；缺 C3 固件验收（P2-05 的验收固件在 S3 上） |
| WS2812 解码器 | ✅ | 同上 | 引脚连到 RMT 输出时自动挂上；高电平 >0.6µs 判 1，低电平 ≥40µs 提交一帧 |
| SPI2 / GDMA | ✅ | c3-lcd：esp_lcd + esp_lcd_gc9a01 标准写法（SPI_DMA_CH_AUTO、40MHz），整帧 115200 字节拆 6 次 DMA，再每 50ms 局部刷新；CLI `--spi gc9a01` 与网页 3D 台面圆屏都有画面（四色扇区 + 白环，非黑 35409 像素） | 与 S3 共用 `gpspi.rs` / `gdma.rs`；GDMA 按 C3 排布（3 通道、通道组从 0x70 起、中断寄存器集中在 0x00 起且 IN / OUT 共用，`GdmaLayout::C3`）。C3 驱动直接写 DMA_INT_RAW 清 trans_done，模型据此支持写 RAW。圆屏接线 SCLK=6 MOSI=7 CS=10 DC=5 RST=4 背光=3（`esp32c3::lcd_pin`） |
| I2S | ☐ | — | 未做 |
| I2C0 主机 | ✅ | oled：总线扫描只应答 0x3C、1KB 帧 400kHz 传输 23.8ms（理论 23.2ms）；bme280：END 分段、重复起始读 | 命令表 COMD0–7、TX/RX FIFO、NACK / END / 完成中断、按 SCL 配置算事务耗时；未做：从机模式、10 位地址、超时与仲裁丢失（不会发生）、时钟延展 |
| 虚拟器件 SSD1306 | ✅ | 帧缓冲点亮 1636 像素、网页截图可读 | 命令解析：寻址模式 / 窗口 / 页模式、电荷泵、开关、对比度、反色、重映射；滚动不做 |
| 虚拟器件 BME280 | ✅ | 设定 -7.25°C / 88.5% / 950.12hPa，固件按数据手册公式读回误差 0；网页滑块改温度后读数跟随 | 原始 ADC 由补偿公式二分反解；强制 / 正常模式测量时序；无噪声、无 IIR 滤波 |
| LEDC / RMT / SPI2 / ADC / I2S | ☐ | — | M2 |
| Wi-Fi STA（开放网络） | ✅ | wifi-init / wifi-scan / wifi-connect / wifi-http：扫描 4 个 AP、关联、DHCP、DNS / mDNS、HTTP GET | MAC 寄存器 + DMA 描述符层；只有 STA，没有 SoftAP / 省电 / 802.11n 聚合 |
| Wi-Fi WPA2-PSK | ✅ | wifi-wpa2：四次握手完成、拿到 IP、两次 HTTP GET 成功（数据帧全程 CCMP，DHCP 广播走 GTK）；wifi-wpa2-bad：错口令时 AP 判 MIC 失败、IDF 自己报 `reason=15`（4WAY_HANDSHAKE_TIMEOUT），重连时 AP 已被 IDF 拉黑报 `reason=205`，不崩溃 | 只做 PSK + CCMP（不做 TKIP、WPA3-SAE、PMF/802.11w、GTK 轮换）；密钥表字 1 高位只解了"组密钥"位；未经真机标定 |
| SHA / AES 加速器 | ✅ | 单元测试（FIPS 180 / FIPS 197 / SP 800-38A 向量经寄存器接口）；WPA2 握手（PBKDF2 4096 轮走块模式、HMAC 走 DMA 模式、Key Unwrap 走 AES DMA） | SHA-384/512、AES-GCM 硬件 GHASH、中断模式未做；链表头改从 GDMA 模型（`channel_for_peri` / `configured_link`）取；搬数据仍用本模块的 gather / scatter（驱动先配链表、后置 start，`take_out` 只认已启动的通道），GDMA 通道的完成中断不置 |
| BLE | ☐ | — | M7 |
| BLE | ☐ | — | M7 |

## ESP32-S3
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| CPU Xtensa LX7 基础 ISA + 窗口 | 🟡 | `tools/xtensa-tests` 8/8；深递归覆盖六种窗口溢出 / 下溢 | 缺中断、FPU、MAC16、PIE；未与 QEMU 差分；缺 SALT/SALTU、TLB 族、RER/WER（S3 crate 里有临时垫片）；**MOVSP 的 Alloca 条件反了**（应为 WINDOWSTART[WB-1..WB-3] 全 0 才报，现为任一为 1 就报；垫片撤回多报，少报的情况救不回来） |
| 启动（直接启动 + ROM） | ✅ | s3-hello 单核：从 call_start_cpu0 跑到 app_main，打印芯片信息 / 16MB flash / Free heap 402804，与 QEMU 逐行一致 | CALLINC=0 进入口、入口帧 [sp-12] 填指向 ROM .stack_app 的指针；核 1 不启动（UNICORE） |
| **当前止步点** | ⚠️ | `tryboard run firmware/build/s3-hello/flash.bin` | `vTaskDelay(500ms)` 约 2µs 就返回、app_main 返回后 vTaskDelete 不切换任务 → `abort()` → 进 `esp_restart_noos+0x104` 空转。原因：核不响应中断（SYSTIMER 节拍、任务切换都依赖 level-1 中断）。SoC 侧已把外部中断线写进 INTERRUPT SR，等核实现中断裁决 |
| 存储映射 / MMU / PSRAM | ✅ | 单元测试：flash / PSRAM 页翻译、PSRAM 可写、SRAM I/D 别名 | 512 项 MMU（位 15 选 PSRAM）；PSRAM 芯片初始化见下方新行（2026-10-16 已补） |
| 中断矩阵（核 0） | 🟡 | 单元测试：电平线、边沿线上升沿、复位映射到线 16 = 不连接 | 99 个源；INTR_STATUS 可读；核 1 矩阵未做 |
| UART / SYSTIMER / TIMG / SPI1 flash / LEDC | 🟡 | s3-hello 启动期使用（控制台、RTC 校准、flash 识别 GD 16MB） | 复用 C3 模型（寄存器布局同族）；TIMG 的 T1、LEDC 的通道 6/7 未建模 |
| EXTMEM（I/D cache 分开） | ✅ | 启动期 freeze / sync / autoload 轮询通过 | cache 操作瞬间完成 |
| GPIO（49 脚）/ IO_MUX | 🟡 | — | 输出 / 输入 / 上下拉 / 中断状态已写，未有 S3 示例验收 |
| eFuse | 🟡 | 芯片版本 v0.2、MAC、PSRAM_CAP=8MB | 只读 |
| 模拟前端（regi2c） | 🟡 | HLE（窗口 ABI 返回），ocode 校准通过；BBPLL 校准完成位（I2C_MST_ANA_CONF0 bit24） | 不建模模拟电路 |
| USB OTG（DWC2，设备模式） | ✅ | s3-usb-keyboard（esp_tinyusb 默认 Buffer DMA）：虚拟主机完成枚举（描述符 / SET_ADDRESS / 字符串 / SET_CONFIGURATION / HID 报告描述符），解码出键盘输入 "Hello from TryBoard!\n"、鼠标 80 次报告画正方形回原点；s3-usb-cdc（Slave / FIFO 方式）：SET_LINE_CODING、DTR，双向收发 ECHO；网页面板与 3D 笔记本同步显示 | 控制 / 中断 / 批量端点；GRXSTSP 接收队列、各 IN 端点发送 FIFO、DIEPEMPMSK / TXFE；SNAK/EPDIS/SGONAK 等握手位瞬间生效；不模拟线上比特、数据翻转位、ISO 端点、主机模式、挂起 / 远程唤醒；USB_WRAP / PHY 选择寄存器只读回 |
| 虚拟 USB 主机 | ✅ | 同上 | 0.25ms 一拍、1ms 帧发 SOF；类驱动：HID（按报告描述符识别键盘 / 鼠标报告 ID，美式布局还原文字）、CDC-ACM；CDC-NCM 网卡、MSC、音频只识别接口类型，不驱动 |
| 双核 | ☐ | — | 后续：核 1 由 SYSTEM_CORE_1_CONTROL 放行 + ets_set_appcpu_boot_addr，需第二个 Cpu 实例与跨核中断 |
| CPU Xtensa LX7 基础 ISA + 窗口 | ✅ | `tools/xtensa-tests` 11/11 自检；与 QEMU（sim 机器 + esp32s3 核配置）逐字差分 14215 字、0 不一致；深递归覆盖六种窗口溢出 / 下溢 | 差分发现并修正 MOVSP 的 Alloca 条件方向；PIE（EE.*）未做 |
| 中断（核内） | ✅ | irq 测试与 QEMU 一致：软件中断 level 1/3、INTLEVEL / EXCM 屏蔽、CCOMPARE0/1/2、WAITI 唤醒、INTSET/INTCLEAR；单元测试：外部电平 / 边沿线、NMI | 外部线由 SoC 调 `cpu.set_irq_lines(mask)`；WAITI 时用 `next_timer_event()` 快进 |
| FPU（单精度） | ✅ | fp 测试 18 个特殊值两两组合 × 4 种舍入：加减乘、乘加 / 减、转换、比较、条件传送、装载存储、FSR 标志、__divsf3 与 sqrtf 序列，全部与 QEMU 一致 | 除法 / 开方分步指令按 QEMU 的模型（序列结果正确，分步中间值不保证同真机）；RECIP0/RSQRT0 有意偏离 QEMU（给出正确结果） |
| MAC16 | 🟡 | 乘 / 乘累加 / 乘减四种来源、40 位 ACC、LDINC/LDDEC 与 QEMU 一致 | 并行装载形式 QEMU 读到旧 m 值，未对照，按"用当前值"实现并单元测试；newlib / IDF 不生成 MAC16 |
| S3 专用杂项 | ✅ | SALT/SALTU、区域保护 TLB 指令（W/R/P/I × I/D）与 QEMU 一致 | RER/WER 走 `Bus::rer/wer`（默认读 0） |
| CPU Xtensa LX7 | ✅ | `tools/xtensa-tests` 11/11 自检；与 QEMU 逐字差分 14215 字、0 不一致；深递归覆盖六种窗口溢出 / 下溢 | 含中断、CCOMPARE、FPU、MAC16、SALT/SALTU、TLB 族、RER/WER；PIE（EE.*）未做 |
| 启动（直接启动 + ROM） | ✅ | s3-hello（单核）与 QEMU 逐行一致；FreeRTOS 延时 499.9ms | 入口帧溢出保存区借用 ROM level 4/5 中断栈 |
| 双核 | ✅ | s3-dual：两任务各钉一核、自旋锁计数 2×20000 准确、跨核队列、esp_ipc 在核 1 执行 | `ets_set_appcpu_boot_addr` HLE 启动核 1（栈 ROM .stack_app），PRID 0xABAB；每核一张中断矩阵；两核按 256 周期量子确定性交替，都空闲时一起快进；外设时间取两核中较快者（单调） |
| 存储映射 / MMU / PSRAM | ✅ | 单元测试：flash / PSRAM 页翻译、PSRAM 可写、SRAM I/D 别名、SPI1 经 CS1 读 PSRAM 模式寄存器 | 512 项 MMU（位 15 选 PSRAM） |
| 八线 PSRAM（N16R8，8MB OPI） | ✅ | s3-psram（CONFIG_SPIRAM=y、OCT、80MHz、双核）：IDF 识别 AP 8MB 第 3 代 3V，启动内存测试 8MB 通过，SPIRAM 堆 8386156 字节；分配 4MB 写伪随机模式读回 0 错（模拟时间写 79ms / 校验 85ms） | ROM 的 `esp_rom_opiflash_exec_cmd` 照常执行，SPI1 用户命令在 MISC 选 CS1 时交给 PSRAM 芯片模型（`psram.rs`：读 / 写模式寄存器 MR0/1/2/3/4/8、同步读 / 写）；之后 cache 经 MMU 直接访问存储体。不模拟 dummy / DTR 采样相位，所以时序调优 14 个候选点全读对，IDF 判"连续通过点过多"打印 `W MSPI Timing: tuning fail, best point is fallen back to index 5` 并用默认点——真机上会是 tuning success；ECC、四线 PSRAM、16MB/2MB 型号未做；访问耗时不计 cache 未命中（与真机速度不同，未经真机标定） |
| 软件复位 | ✅ | s3-restart（双核）：第 1 次核 0 调 esp_restart、第 2 次核 1 调 esp_restart，第 3 次 `BOOT COUNT 3 reason=SW`；NVS 计数跨复位；RTC_NOINIT 计数 1→2→3、RTC_DATA 每次复位回到镜像初值 7；三次启动核 1 都重新跑起来；s3-psram 初始化失败的 abort → 重启循环也走这条路 | RTC_CNTL_OPTIONS0：SW_PROCPU_RST（bit5）/ SW_SYS_RST（bit31）→ 整机重新上电（复位原因 12 / 3，RTC_CNTL_RESET_STATE 两核同值），SW_APPCPU_RST（bit4）→ 停掉核 1；保留 flash、RTC 慢 / 快速内存、RTC_CNTL_STORE0–3/6/7（复位原因提示）、引脚外部驱动、ADC 电压、I2C 器件；SRAM 清零（真机上 `__NOINIT_ATTR` 的 SRAM 变量一般能保留，这里不保留）；RTC 看门狗未建模（esp_restart 里设的 1 秒 RWDT 不会触发）；USB 设备重新枚举 |
| 中断矩阵（核 0 / 核 1） | ✅ | 单元测试 + s3-dual（FROM_CPU 跨核中断、两核各自 SYSTIMER 节拍） | 99 个源；核 1 表在 +0x800 |
| GPIO（49 脚）/ IO_MUX | ✅ | s3-blink：GPIO5 翻转；s3-button：BOOT 键 GPIO0 下降沿中断 + 消抖，GPIO5 翻转 2 次 | 外设信号经 GPIO 矩阵驱动引脚（RMT）；输出信号号 256 = 普通 GPIO |
| LEDC | ✅ | s3-pot：5kHz PWM 占空比跟随 ADC；s3-servo：GPIO4 50Hz 0.5–2.5ms | 与 C3 同一模型（扩到 8 通道），输出信号 73..80 |
| RMT + WS2812 | ✅ | s3-rgb：GPIO48 解码 6 帧，前 4 帧颜色逐颗一致 | 与 C3 同一模型，按 `RmtLayout::S3`（4 发 4 收、RAM +0x800、信号 81..84）参数化 |
| PCNT（4 单元 × 2 通道，P2-01） | ✅ | s3-encoder（IDF `pulse_cnt`，与 rotary_encoder 示例同配置：双通道互为边沿 / 电平、4 倍频、±100 上下限 + accum_count、1 µs 毛刺滤波）：顺 5 格 → 20、逆 2 格 → 12、再顺 30 格 → 132（越过上限两次由驱动在中断里累加）；单元测试（正交 4 倍频、过零 / h_lim 事件与锁存、zero_mode、暂停、滤波）；S3 SocBus 集成测试（编码器 → GPIO 矩阵 → PCNT） | 寄存器按 pcnt_reg.h；h_lim / l_lim 到达即清零（不再同时触发过零），thres0 / thres1 / zero 事件；滤波按"稳定满门限才认"惰性实现（沿整体推迟门限时长）；STEP / 清零信号（S3 没有）不做；QEMU 无 S3 PCNT 模型（只对照启动行） |
| RMT 接收（P2-05） | ✅ | s3-ultrasonic（IDF `rmt_rx`，1 MHz、25 ms 空闲、1 µs 滤波）：25 / 100 / 300 cm → Echo 1457 / 5830 / 17492 µs、超量程 → out of range；单元测试（S3 / C3 两种布局、滤波、结束条目、写指针） | rx_en 后等第一个跳变开始，每段电平写半个条目，空闲超过 idle_thres 写时长 0 的半条目补齐并置 RX_END；阈值中断 + 回绕（IDF 乒乓）、内存写满出错；载波解调、DMA 接收、所有者错误未做；QEMU 能跑驱动初始化（无回波源，打印 no echo） |
| 虚拟器件 EC11 编码器（P2-01） | ✅ | 同 s3-encoder；网页：3D 旋钮左右拖 6 格 → PCNT 24、滚轮 3 格 → 36、按住 → SW DOWN；网页导出输入日志 → CLI `--encoder 6,7,15 --inputs` 串口逐字节相同；回退指纹一致 | 每格四个沿、沿间隔 0.5 ms，在内核里按时刻排出波形（不受 1 ms 时间片影响）；触点抖动未建模；按键按下接地、松开悬空（固件开上拉）；电流 0.66 mA 进 3V3（估算） |
| 虚拟器件 HC-SR04（P2-04） | ✅ | 同 s3-ultrasonic；网页：拖 3D 障碍物 15 → 10.9 cm、固件读 10.9 cm，200 cm / 50 cm 快捷按钮，逻辑分析仪看到 Trig / Echo；网页输入日志 → CLI `--sonar 17,18 --inputs` 串口逐字节相同；拆掉 Echo 分压 → 接线检查 W2 | Trig ≥ 10 µs 下降沿后 250 µs 拉高 Echo，宽 2 × 距离 / 343 m/s（20 ℃ 固定）；2–400 cm，超量程 38 ms；测量中再触发不理；距离来自探头沿朝向的射线（3D 里最远摆 100 cm）；15 mA 进 5V 轨；未经真机标定 |
| I2C0 / I2C1 | ✅ | s3-oled：扫描只应答 0x3C，1KB 帧 400kHz 约 24.0ms，点亮 1636 像素；s3-bme280：-7.25°C / 88.5% / 950.12hPa 读回误差 0 | 与 C3 同一模型（寄存器布局逐项一致），I2C1 在 0x60027000 |
| SAR ADC 单次（SENS） | ✅ | s3-pot：0 / 1550 / 3000mV 读数正确 | S3 单次采样走 RTC 的 SENS（0x60008800），不是 APB_SARADC；衰减档量程近似 950 / 1250 / 1750 / 3100mV；ADC2 仲裁标志、连续模式未做 |
| UART / SYSTIMER / TIMG / SPI1 flash | ✅ | 控制台、FreeRTOS 节拍、RTC 校准、flash 识别 GD 16MB | 复用 C3 模型；TIMG 的 T1 未建模 |
| EXTMEM / eFuse / 模拟前端 | 🟡 | 启动期轮询通过；芯片版本 v0.2、PSRAM_CAP=8MB | cache 操作瞬间完成；eFuse 只读；regi2c HLE |
| 装配成品 weather（桌面气象站） | ✅ | 同一 I2C 挂 SSD1306 + BME280（23.5°C / 45% / 1013.25hPa 读回误差 0）、舵机 GPIO4 1675us、WS2812 GPIO48 绿 #002000、BOOT 切 ℉ 后屏幕重画（点亮 1328 像素） | 场景层验收；35°C 时 LED=red、PWM=2250us、GPIO5 蜂鸣器 2700Hz 报警：accept 用例 weather-alarm（同固件第二个用例，`fw` 字段） |
| GP-SPI2 主机 | ✅ | lens / spin：esp_lcd + esp_lcd_gc9a01 标准写法（spi_bus_initialize SPI_DMA_CH_AUTO、轮询发命令、队列发像素），40MHz，整帧 115200 字节拆 6 次 DMA | 命令 / 地址 / 哑周期 / MOSI 各阶段、W0..W15 与 DMA 两条数据通路、TRANS_DONE 中断、按 SPI 时钟计时；不模拟逐位时序与 FIFO；MISO 恒读全 1；双 / 四 / 八线模式按单线计时；从机模式未做 |
| GDMA（5 通道） | 🟡 | 同上：描述符链（每次传输 5 个描述符）、owner 回写、OUT_EOF | 单元测试覆盖链表遍历 / 回写 / 中断；RX 方向只有"填描述符 + SUC_EOF"，未经固件验收；不模拟突发、FIFO、优先级、内存到内存 |
| 虚拟器件 GC9A01 圆屏 | ✅ | lens：四种表情逐一截图核对（眼睛 / 高光 / 腮红 / 心形 / ^ ^ / 困了），开心表情非黑 3208 像素；spin：小黄脸非黑 45244 像素 | 按"常黑 IPS + BGR 子像素"建模（未经真机标定）；厂商初始化命令 42 条只计数；TE、滚动、部分显示、读显存未做 |
| 装配成品 lens（透镜小人） | ✅ | 启动 MOOD 0 normal、每 3 秒眨眼（BLINK n）、BOOT 切 MOOD 1 happy → 2 love → 3 sleepy → 0 normal；检查点 lens-1（lens-blink）、lens-2（lens-mood）、07-lens 参考固件全过 | 场景层验收 |
| 装配成品 spin（会转身的小黄） | ✅ | GPIO4 50Hz 占空比 0.042..0.108（脉宽 0.833–2.167ms）、SPIN ±60 交替、眼珠随转向重画（EYE R / EYE L）、BOOT 后 LOOK FRONT（1.5ms）且眼珠回正（青色重心 119.7）；检查点 spin-1（spin-face）、spin-2（spin-turn）、07-spin 参考固件全过 | 舵机机械响应不建模 |
| USB OTG / Wi-Fi / BLE | ☐ | — | USB OTG 在另一分支开发 |

## 电气（`core/crates/elec`，C3 / S3 共用）
| 模块 | 状态 | 验收 | 备注 |
|---|---|---|---|
| 直流 / 瞬态求解器（MNA + 隐式欧拉 + PWL Katzenelson） | ✅ | `tools/elec` 10 个网表与 ngspice-47 对照最大误差 0.039%；网页 / 命令行重放逐字节一致（webtest/elec.mjs） | 估算模型；没有 ngspice 时 accept.sh 跳过该节 |
| 开发板供电网络（USB 0.5 A 限流、外接 5 V 2 A、SGM2212 LDO、去耦、芯片 / 模块 / 舵机负载） | 🟡 | 单测 + CLI `--elec-report` | 全部参数估算，未经真机标定（DECISIONS「电气模型」）；C3-DevKitM-1 的 LDO 按 S3 同款，待核 |
| 欠压复位（原因 15，ROM 头 rst:0xf） | ✅ | s3-brownout-usb 复位、s3-brownout-ext 不复位；网页时间线「欠压复位」 | 半路反向扫动才复位；第 05 关、气象站默认 USB 下不复位；spin 来回转身 USB 下开机复位 1 次。跳过 ROM 引导，复位间隔比真机密；< 1.8 V 应为上电复位，未区分 |
| SG90 二阶动力学 | ✅ | 单测（速度、过冲、起步尖峰、堵转） | 只影响电流与 3D；参数估算 |
| 万用表（电压） | ✅ | agent-browser 量 3V3 = 求解器；PWM 读平均 | 只有电压档、黑表笔固定 GND |
| 接线错误（短路 / 对打 / LED 无电阻）走网络求解 | ☐ | — | 仍是 W1–W5 规则估算 |

## 网页
| 项 | 状态 |
|---|---|
| wasm 内核 | ✅ 约 230KB（C3 + S3 两颗芯片），无 import；按镜像头自动选芯片（`tryboard-machine`） |
| 1× 实时 / 加速 | ✅ blink、hello 在 Chrome 无头模式下 1.00× |
| 3D 工作台 | ✅ 面包板 + 开发板 + LED 随 GPIO 亮灭；板载 WS2812（GPIO8）随解码颜色发光；BOOT / RST 可点 |
| 3D 工作台 | ✅ 面包板 + 开发板 + LED 随 GPIO 亮灭；BOOT / RST 可点；示例按 `scene.parts` 声明元件与接线（LED / SSD1306 / BME280），可指定机位 |
| ESP32-S3 固件 | ✅ wasm 按镜像芯片 ID 选 C3 / S3，按芯片下载 ROM；S3 的 BOOT 键为 GPIO0（3D 板子仍是 C3 外形） |
| 虚拟电脑（USB） | ✅ 侧栏面板（设备描述符、接口、枚举过程、键盘输入、鼠标轨迹、USB 串口终端可输入）；3D 笔记本经 USB 线接到板子，屏幕实时显示 |
| 3D 工作台 | ✅ 面包板 + 开发板 + LED 随 GPIO 亮灭；板载 WS2812（C3 GPIO8 / S3 GPIO48）随解码颜色发光；BOOT / RST 可点；示例按 `scene.parts` 声明元件与接线，可指定机位 |
| 按芯片换板 | ✅ C3 板（2×15 针）/ S3 板（2×22 针、UART / USB 双口、N16R8）；元件按当前板子的引脚重新接线；网页验收 s3-blink、s3-rgb、s3-dual 1.00× 实时 |
| OLED 实时画面 | ✅ 帧缓冲变了才传，128×64 最近邻纹理 |
| 环境滑块 | ✅ 温度 / 湿度 / 气压 → `tb_env_set`，webtest 验证读数跟随 |
| 串口输入 | 🟡 已接线，缺验收固件 |
| 蜂鸣器出声（P0-14） | ✅ weather GPIO5 无源蜂鸣器：worker 每 1ms 采样 `tb_pin_pwm` / `tb_pin_pwm_freq`，按模拟时刻排进 Web Audio（方波，默认静音，点「声音」开）；agent-browser：35℃ 时 lastFreq 2700.1 Hz、分析节点 2695 Hz，降到 25℃ 停。3D 蜂鸣器模块已画（响时有声波示意）；只出一个声道（多个蜂鸣器取第一个在响的） |
| 输入日志 / 重放（P0-19） | ✅ worker 按模拟时间记下按键 / 环境 / 电位器 / 串口输入，「导出输入」给出 `tryboard run --inputs` 文本；replay.mjs：鼠标按 3D BOOT + 温度 35 → 网页串口与 CLI 重放逐字节相同（1502 字节），网页重放与 CLI 指纹相同。限制：日志从上电开始，复位即新日志；装配视图 / 元件编辑器改接线不记（会重新上电） |

> 2026-10-15 合流：S3 对齐（双核、共享外设、S3 开发板网页）与 USB OTG、Wi-Fi、软件复位、元件编辑器同时可用；S3 软件复位尚未支持（见 DECISIONS）。2026-10-16：S3 软件复位已支持（见上表"软件复位"）。

## 网页：关卡 / 装配 / 首页
| 功能 | 状态 | 验收 | 备注 |
|---|---|---|---|
| 关卡验收（浏览器） | ✅ | levels.mjs：6 关参考固件网页通过，指纹与 `tools/check.py` 逐关相同 | 第 7 关无自动验收（用户自定条件） |
| 上传自己的固件验收 | ✅ | C3 blink 过第 1 关，进度记住 | 进度在 localStorage |
| 拖拽装配 | ✅ | 鼠标真实拖拽 6/6；顺序错被拦；BME280 贴芯片 → 第 6 关温度偏差 2.5、不通过 | 几何检查为估算，未经真机标定 |
| 成品视图 | ✅ | 开机后 OLED 有画面（真实固件帧） | 首页、关卡页、实验台三处 |
| 首页实时实验桌 | ✅ | 串口 T=23.50、按 BOOT 屏幕重画、390px 宽无横向滚动 | 看不见时暂停模拟 |
| 工作台外壳 app.html（P0-01/02/15） | ✅ | agent-browser：weather 实验台跑起来、点 BME280 改温度读数 23.50 → 32.00、检查点 01–06 上传参考固件 6/6 通过且指纹与 check.py 逐个一致、切组装再切回模拟时间连续（运行 #1 不变）、390×844 无横向溢出、console / errors 无 error（Reviews/ab/P0-01.md） | 采购 / 组装 / 成品为占位；点台面选中待 board3d 实现 ScenePickApi；levels.mjs 未迁移到新页面 |
| 真实器材 3D 台面（P0-10 / P0-11） | ✅ | agent-browser：weather / spin / C3 示例截图，针脚丝印可辨；highlight / setWireFault / measure / setHeat / setTheme 各截一张；console 无 error（Reviews/ab/P0-10.md） | 外观示意；中端机帧率未实测（基线 weather 228 calls / 11 万三角形）；属性面板实时值待外壳 |
| 作品首页 home.html（P0-05） | ✅ | levels.mjs：三卡跑真实固件（气象站串口 T=23.50、OLED 有画面、按 BOOT 重画；小黄 / 透镜圆屏有画面）、5 个入口到达正确页面、检查点数与工作台一致、390px 无横向滚动；agent-browser 截图与 console / errors 无 error（Reviews/ab/P0-05.md） | 参考价为估算，待 catalog；选型助手仍是旧暗色样式 |
| 第三方授权页 licenses.html（P0-20） | ✅ | build_web.sh 生成；列 three、68 个构建期依赖、ROM（Apache-2.0 全文 + 第三方清单）、5 个固件组件、字体（Reviews/ab/P0-20.md） | 字体未自托管；无外部 3D 素材 |
| 旧页面下线（P0-21） | ✅ | levels.html#04 / #07-lens / 无 hash 重定向到 app.html 并选中检查点（levels.mjs + agent-browser） | 装配验收判定待 P0-16 |
| 工作台外壳 app.html（P0-01/02/15） | ✅ | agent-browser：weather 实验台跑起来、点 BME280 改温度读数 23.50 → 32.00、检查点 01–06 上传参考固件 6/6 通过且指纹与 check.py 逐个一致、切组装再切回模拟时间连续（运行 #1 不变）、390×844 无横向溢出、console / errors 无 error（Reviews/ab/P0-01.md） | 采购 / 组装 / 成品为占位；点台面选中待 board3d 实现 ScenePickApi；levels.mjs 已迁移到新页面（P0-21） |
| 组装 / 3D 成品（P0-16/17/18） | ✅ | agent-browser（Reviews/ab/P0-16.md、P0-17.md）：未解锁时显示 0/6 与「回实验台」；上传参考固件 6/6 后解锁；BME280 放开发板旁 → 开机复测 ✗（温度最大偏差 2.5、PWM 1.80 ms、装配有警告）；时间线回到「装 开发板」改放通风口旁 → 复测 ✓，指纹 65e9·47d4 与实验台 06 相同；成品拖动后方位角 24° → −39°；声音开 + 热源 → 34.6 ℃ 报警，`__tbAudio` playing=true、peakHz 2695；点 3D BOOT → OLED 99.3°F；console / errors 无 error | 温漂 2.5 ℃、热源 +14 ℃ / 时间常数 3 s、指针二阶缓动都是示意数值，未经真机标定；小黄 / 透镜成品仍是 SVG（P1-10）；装配视图仍是 2.5D SVG |
| 工作台外壳 app.html（P0-01/02/15） | ✅ | agent-browser：weather 实验台跑起来、点 BME280 改温度读数 23.50 → 32.00、检查点 01–06 上传参考固件 6/6 通过且指纹与 check.py 逐个一致、切组装再切回模拟时间连续（运行 #1 不变）、390×844 无横向溢出、console / errors 无 error（Reviews/ab/P0-01.md） | 组装 / 成品为占位；点台面选中待 board3d 实现 ScenePickApi；levels.mjs 未迁移到新页面 |
| 成品示意（小黄 / 透镜 / 检测器） | 🟡 | — | 只是外观示意；内核已有 GC9A01 圆屏（`tb_lcd_*`），lens / spin 固件已能跑，网页显示待接 |
| 元件库 / 采购模版 / 规则引擎（数据层） | 🟡 | `cd web && npm test`：57 个用例全过（schema、核价提醒、模版对拍 examples.json、R01–R27 各正反用例） | 53 件、27 条规则；价格为代理估计未人工核价，多处字段待核（`todoList()`），规则未经人逐条复核、未经真机标定；页面见下一行 |
| 开发板库 + 版本差异规则（P1-12） | 🟡 | `npm test` 86 个用例全过（R28–R32 与改分级的 R24 各正反用例，换板前后集成用例）；agent-browser：小黄换 XIAO S3 出现 6 条 R04、换微雪圆屏板出现 R24 阻断 + R29 并可一键去掉外接圆屏（Reviews/ab/P1-12.md） | 9 块板、32 条规则；引脚为官方资料整理的行为级数据，未经真机标定；合宙排针、XIAO C3 3V3 电流、AtomS3 红外 / USB、微雪两版排针等标待核 |
| 采购页 + 摆上实验台（P0-07 / P0-09） | ✅ | `npm test` 64 个用例（含 bom.test.ts：日志重放、时间线回退、去电源提醒 + 一键补、placement 对拍 examples.json）；agent-browser：气象站清单 12 件 / ¥97.5–230、去 5 V 电源出 2 条提醒并一键补回、BME280 去不掉、切小黄、时间线回第一步、摆上实验台场景与清单一致（OLED / BME280 / 舵机 / 蜂鸣器）、无电源时供电只显示 USB、390×844 无横向溢出、console / errors 无 error（Reviews/ab/P0-07.md、P0-09.md） | 价格是代理估计（未人工核价）；中间台面是 SVG 示意卡片不是 3D；换开发板不换固件（实验台按固件芯片摆）；从元件库加的件没有默认接线，不摆上台；欠压只显示不模拟 |
| 实验台交互（P0-03 / 04 / 11 / 12 / 13，P0-15 核实） | ✅ | `npm test` 新增 interact.test.ts（时间线折叠 / 回退目标 / 截断、运行对比、W1–W5、线 id 与 3D 一致）；`tools/webtest/interact.mjs`（进 accept.sh）：三作品默认接线无问题、鼠标点 3D GPIO4 → 50 Hz / 1.675 ms + 示波器、BME280 卡片拖温度 / 热源 +8 / 量到芯片 58.2 mm、供电线切外接 5 V、回退到运行 → 指纹与收尾一致且与命令行 `--inputs` 重放 + check.py 一致、回退后再跑丢掉后面的运行、尺子 24.4 mm、五种注入错误接线各标红；agent-browser 截图与 console / errors 无 error（Reviews/ab/P0-03/04/11/12/13.md） | 供电切换只改清单和显示（欠压 P1-02）；改接 / 拔线时 3D 线仍画在原针上（只标红）；示波器 PWM 波形按占空比合成（相位示意）、I2C 只画示意、电源电压是标称估算；热源 +8 ℃、温漂按距离线性都是估算 |
| npm 本地包 `npx tryboard check`（P1-14） | ✅ | `tools/npm_parity.sh`（进 accept.sh）：8 关参考固件 + 3 个错配用例，`npx ./tryboard-0.1.0.tgz check` 与 `tools/check.py` 整段输出（含指纹）和退出码逐字一致；`run` 串口与原生 CLI 逐字节一致（bme280）；包约 0.9 MB（Reviews/ab/P1-14.md） | 未发布到 npm；不带参考固件（无 `--ref`）；不带 `--watch / --trace` 等调试开关 |
| 暗色模式 / 手机只读（P1-15） | ✅ | agent-browser：390×844 四步 + 首页无横向溢出、编辑工具隐藏、成品 3D 预览；1440×900 暗色四步 + 首页 + 授权页；console / errors 无 error（Reviews/ab/P1-15.md） | levels.html / advisor.html / index.html 未做暗色；手机上组装步骤仍是"锁着"说明，不预览装配；部分 three.js 器件材质在暗色下未调 |

| 走查修补（首页价格、中文零件名、3D 蜂鸣器、参考成品、舵机走线） | ✅ | `npm test` 79 个用例（新增：首页价与采购页合计对拍、蜂鸣器三根线、显示名无英文）；agent-browser（Reviews/ab/polish.md）：首页三卡价格与采购页合计一致（气象站 ¥97.5–230）、实验台看到蜂鸣器模块并点中、31 ℃ 报警时声波弧出现、时间线全中文、未装配打开成品页显示参考成品与「去完成检查点 →」、默认机位中心点击 BME280 / BOOT / GPIO4 / 蜂鸣器 / 舵机都选中、console / errors 无 error；accept.sh 改为必须看到各网页脚本的汇总行（原来会把 levels.mjs 中途崩溃和 3 项失败盖住，已修） | 蜂鸣器声波是示意；参考成品用的是实验台当前固件（还没上传自己的就是参考固件）；小黄 / 透镜成品仍是 SVG |
| 逻辑分析仪（P1-05） | ✅ | 内核事件缓冲（观察的 GPIO / PWM / WS2812 帧 / I2C 事务，按周期盖戳）；`cargo test`：I2C 两批命令 + 重复起始的事件序列与时刻、环形上限、PWM 去重、文本格式；`npm test` iotrace.test.ts：字节解码 / 文本行与 Rust 逐字相同、事务解码与 BME280 / SSD1306 注释；`tools/webtest/traceio.mjs`（进 accept.sh）：weather 实时运行 5707 条事件 = 命令行 `--trace-io` 按同一输入日志重放的前 5707 条（逐字），回退到运行 #1 后重建的 3594 条也一致；accept.sh 命令行段：0x76 从 0xF7 读 8 字节、GPIO4 50 Hz；agent-browser：I2C 位级解码 + "读气压、温度、湿度原始值"、缩放、PWM 包络 / 方波 + 光标 Δ 20.000 ms、回退同步、console / errors 无 error（Reviews/ab/P1-05.md） | I2C 的 SCL / SDA 波形按事务和位时序重建（不是逐边沿模拟：时钟延展、上升时间、毛刺都看不到）；PWM 相位从占空比生效时刻起算（真机计数器相位未建模）；只记被观察的 GPIO（默认是台面上接了东西的脚 + BOOT，分析仪加通道时补上，加之前的历史没有）；网页仓库上限 40 万条、内核缓冲 65536 条 |
| ⌘K 命令框（P1-06） | ✅ | `npm test`：模糊匹配、参数识别（室温 N、第 n 次运行）、最近命令；traceio.mjs 用 `cmdk.exec('室温 35')` 触发报警；agent-browser 真键盘：⌘K「室温 35」回车 → 35 ℃ 报警、「外接 5」→ 运行 #2、「回到第 1」→ 回退且指纹一致 ✓、「量 3v3」→ 提示 P1-04 中、「gpio4」→ 针脚面板、↓ 回车切步骤、最近命令置顶、焦点在温度滑块上时 ⌘K 不弹（Reviews/ab/P1-06.md） | 选中零件只高亮不转镜头（ScenePickApi 没有聚焦接口）；万用表未实现（P1-04） |
| 外部 3D 模型管线（P1-09） | ✅ | tools/models：occt-import-js → glTF-Transform（构建期）；KiCad USB-C 92.6 KB、KiCad Φ12 蜂鸣器 34.7 KB、Adafruit 9 g 舵机 32.0 KB；`npm test` models.test.ts（✅ 来源、40 位提交、glb ≤ 1 MB 无贴图、SOURCES.md / LICENSE）；agent-browser：实验台「外部模型」开 / 关对比截图、licenses.html 模型表 + 署名 + 下载、console / errors 无 error（Reviews/ab/P1-09.md） | 默认关（程序生成兜底）；M5Stack 未用；圆屏模组、开发板、排针仍是程序生成 |
| 小黄 / 透镜 3D 成品（P1-10） | ✅ | app/lcd3d.ts：GC9A01 帧缓冲作纹理；agent-browser：小黄随 GPIO4 在 ±60° 转身、拖动方位角 22° → −79°、3D BOOT → LOOK FRONT 停在 0°；透镜拖动 20° → 104°、BOOT → MOOD happy → love；console / errors 无 error（Reviews/ab/P1-10.md） | 透镜折射是 transmission 近似（示意），放大倍数未精确对上 1.35×；圆屏弯成面罩曲面是示意；WebGL 兜底 SVG 未在关 WebGL 的浏览器实测；首页卡片 / 组装仍是 SVG |
