# 自主决定记录

人不在场时代理做的取舍。每条：日期 · 决定 · 理由 · 替代方案。人复核后标"已确认"或改掉。

## 2026-10-15 · 代号 TryBoard（试板）
- 决定：产品代号 TryBoard / 试板，"买板之前先试板"。名字里不放 ESP32 / Espressif，描述里以"支持 ESP32 系列芯片"的方式指称
- 理由：商标风险（见 LICENSING.md）；名字短、中英都通
- 替代：正式命名前随时可换，只影响文案与包名

## 2026-10-15 · 先做 ESP32-C3，再做 S3
- 决定：M0–M3 用 ESP32-C3（RISC-V RV32IMC）打通"固件 → 内核 → 浏览器 → 3D"全链路，M4 再做 S3（Xtensa LX7）
- 理由：RISC-V 规格公开、有官方 riscv-tests 当 CPU 验收，指令集远比 Xtensa（窗口寄存器、可配置选项）简单；C3 外设与 S3 大量同源（GDMA、SYSTIMER、LEDC、RMT 寄存器风格一致），后面能复用。产品主推的 S3 排在第二，不影响整体路线
- 替代：直接从 S3 开始，代价是前两个月没有可展示的东西

## 2026-10-15 · 自研内核用 Rust，浏览器绑定不用 wasm-bindgen
- 决定：内核 Rust 编写，原生可跑（测试、差分快），编译成 wasm 给浏览器；JS 接口用裸 `extern "C"` 导出 + 共享内存，零第三方 crate
- 理由：不引依赖、wasm 体积小；接口面很窄（跑 N 周期、读写 GPIO / 串口缓冲、加载固件）
- 替代：wasm-bindgen 更方便传字符串 / 对象，接口变复杂时再引入

## 2026-10-15 · 直接启动 + 真 ROM 代码 + 少量 HLE
- 决定：模拟器自己当"二级 bootloader"：解析用户的 flash 镜像（分区表 → app 分区 → esp image 段），按 cache MMU 映射好，从 app 入口开始跑，跳过 ROM bootloader 与 2nd stage bootloader。ROM 区域装入从 esp-rom-elfs（Apache-2.0）提取的真 ROM 代码，固件调用的 ROM 函数（memcpy、printf、ets_delay_us……）照常执行；只对强依赖硬件、且我们不想模拟其底层的少数 ROM 函数（如 SPI flash 读写、cache 维护）在入口地址做 HLE 拦截
- 理由：授权调研确认 esp-rom-elfs 可分发（见 LICENSING.md）；真 ROM 省掉几百个 libc / 工具函数的重写，与真机行为一致；跳过 bootloader 启动快、用户输入（flash 镜像 / app bin）自然
- 替代：纯 HLE（不带 ROM，工作量大）；或完整跑 ROM bootloader（QEMU 的做法，需模拟更多启动期硬件）——以后要做"bootloader 也能调试"时再加

## 2026-10-15 · PWM 不逐周期模拟
- 决定：LEDC 只维护"当前占空比 + 频率"，渐变按时间惰性推进；引脚上的 PWM 以（占空比, 频率）对外暴露，前端用占空比当 LED 平均亮度、舵机脉宽
- 理由：逐周期翻转 GPIO 会让 5kHz PWM 每秒产生 1 万个事件，浪费且对教学场景无意义；需要看波形的场景（示波器视图）以后可以按需从（占空比, 频率, hpoint）合成
- 替代：真实逐边沿模拟，给"逻辑分析仪"功能用
## 2026-10-15 · RMT 按半条目惰性推进，WS2812 在引脚上解码
- 决定：RMT 发送不逐 tick 模拟，而是每个半条目（一个电平段）一个事件：`update(now)` 消费所有已结束的半条目、记录电平跳变、按条目计数置阈值 / 结束中断，下一事件 = 当前半条目结束时刻。跳变经 GPIO 矩阵（FUNCn_OUT_SEL = 51/52）送到引脚，再喂给挂在该引脚上的 WS2812 解码器（按高电平宽度判 0/1、低电平 ≥40µs 提交一帧，线上 GRB 换成 RGB 存）
- 理由：WS2812 每位 1.25µs，事件粒度到电平段足够精确（阈值中断时刻与真机同量级），又不至于每个 tick 都进一次模拟循环；解码放在引脚上而不是 RMT 内部，这样以后 bit-bang、SPI 驱动的灯带也能复用同一个解码器
- 未做：载波调制、RX 采样、APB FIFO（CHnDATA）写入；分数分频（SCLK_DIV_A/B）忽略
- 替代：逐 tick 输出给逻辑分析仪视图时再加

## 2026-10-15 · 板载 RGB 灯颜色做感知亮度补偿
- 决定：3D 里 WS2812 的自发光强度按 0.25/相对亮度（1–4 倍）补偿
- 理由：按线性亮度公式，纯蓝只有纯绿的 1/10，渲染出来几乎不亮、达不到泛光阈值；真实的蓝色 LED 在眼里并不暗
- 替代：按实测光通量曲线做更细的映射

## 2026-10-15 · rgb 示例用 led_strip 组件（3.0.1，固定版本）
- 决定：示例走 ESP-IDF 组件管理器拉 `espressif/led_strip` 3.0.1，与用户在真板上的写法一致；另有只用于验收的 `strip`（16 颗）覆盖多块填充路径，不放进示例列表
- 理由：示例的价值在于"跟真机一模一样的代码"；版本钉死避免组件升级导致验收漂移
- 替代：离线构建环境下改用 IDF 自带的 rmt_encoder 示例写法
## 2026-10-15 · Xtensa 核先用自检汇编验收，QEMU 差分放到下一切片
- 决定：Xtensa 基础 ISA 的验收用自己写的自检汇编（每组指令算出结果与手算常数比对，失败返回用例号），窗口溢出 / 下溢处理程序按窗口 ABI 的标准做法自行编写；暂不做与 QEMU 的逐指令差分
- 理由：自检测试零外部依赖、cargo test 直接跑、失败能定位到用例；QEMU 差分需要 gdbstub 或 trace 解析，接中断 / FPU 时一起做收益更大
- 替代：现在就接 QEMU `-d exec` 差分；代价是测试框架复杂度先上去
- 另：窗口溢出检查按"每条指令用到的最高四元组"做，多估只会提早溢出（语义上无害），换来解码简单
## 2026-10-15 · I2C：事务立即执行、完成时刻按 SCL 时序推迟
- 决定：写 trans_start 时一次性按命令表对虚拟器件读写，但"总线忙"与完成 / END / NACK 中断推迟到按 SCL 高低电平周期、分频算出的耗时之后；器件以 `I2cDevice` trait 挂在总线上，按 7 位地址寻址，没人应答即 NACK
- 理由：驱动只靠中断推进状态机，器件内部不关心位级时序；这样快且时序对驱动可见（1KB OLED 帧 23.8ms，与真机同量级）
- 替代：逐位模拟 SDA/SCL（以后做逻辑分析仪视图时再说）；引脚路由（GPIO 矩阵把 I2C 信号接到了哪两个脚）目前不校验，网页接线按示例声明画

## 2026-10-15 · BME280 输出由补偿公式反解
- 决定：给定环境值，在 ADC 范围里二分查找原始值，使数据手册整数补偿公式算回设定值；校准常数温度 / 气压用数据手册示例值，湿度用量产器件典型值
- 理由：用户代码（任意驱动库）按标准公式读就能得到滑块设定的环境，误差只有量化误差
- 替代：加入噪声 / 自热 / IIR 滤波模型，做"传感器选型对比"时再加

## 2026-10-15 · 示例自带场景描述（examples.json 的 scene）
- 决定：每个示例声明外接元件（led / oled / bme280）、地址、引脚和可选机位；网页据此建 3D 元件与跳线，并在模拟器总线上挂对应器件。I2C 模组竖插在面包板 e 行，跳线从背后接 a 行，避免挡住屏幕。虚拟 0.96" OLED 模组的排针画在下沿（真实模组多在上沿），这样竖插时画面正立
- 理由：元件和固件配套是"买前先试"的核心；先用声明式场景，拖放编辑器（M3）在此基础上做
- 替代：场景写死在 TS 里（之前的做法）；或直接上自由接线编辑器

## 2026-10-15 · S3 外设先复用 C3 的模型（crate 依赖），不抽公共层
- 决定：tryboard-esp32s3 直接依赖 tryboard-esp32c3，复用 UART、SYSTIMER、TIMG、SPI1 flash、LEDC（寄存器布局逐项对比过：S3 只多出 SYSTIMER REAL_TARGET、TIMG T1 等寄存器）；S3 特有的中断矩阵、EXTMEM、49 脚 GPIO、regi2c HLE 写在 S3 crate 里
- 理由：并行开发期间 C3 crate 正被频繁修改，现在抽 `soc` 公共层会和其它分支大面积冲突；依赖关系单向、以后搬家只改 use 路径
- 替代：把同族外设移进 crates/soc，C3 / S3 都依赖它（等分支合并稳定后做）

## 2026-10-15 · S3 先单核启动，CALLINC=0 进入口并补入口帧保存区（单核部分已被"S3 双核"取代）
- 决定：s3-hello 用 CONFIG_FREERTOS_UNICORE=y；入口以 PS.CALLINC=0、WINDOWSTART=1 进入，先执行 ENTRY，再在 [sp-12] 填一个指向 ROM .stack_app（单核时空闲）的指针
- 理由：我们跳过了 bootloader，没有真实的调用者帧。用假的 CALL8 调用者帧会在第一次窗口溢出时把空保存区当指针（写到 0 附近，双重异常）；CALLINC=0 让 app 入口成为最老的一帧，只剩溢出处理程序要读 [sp-12] 这一处，补上即可
- 替代：完整跑 ROM + 二级 bootloader（栈帧天然正确，代价是要模拟更多启动期硬件）；双核在核实现中断后再做

## 2026-10-15 · 核缺的少数指令用 SoC 侧垫片顶上（临时，已删除：核已实现）
- 决定：SALT/SALTU、WITLB/WDTLB 等 TLB 族、RER/WER 在非法指令异常入口由 S3 SoC 代执行；核里 MOVSP 多报的 Alloca 由垫片撤回
- 理由：这些都在 tryboard-xtensa 里，本分支约定不改核（另一个分支在改中断 / FPU）；垫片集中在 `esp32s3/src/shim.rs` 一个文件，核补齐后整文件删除即可
- 替代：直接在核里实现（正确做法，合并时做；MOVSP 条件是一行修正：三个 WINDOWSTART 位"全为 0"才报 Alloca）

## 2026-10-15 · Xtensa 与 QEMU 差分：sim 机器 + 半主机输出
- 决定：自检汇编结束时经 SIMCALL 半主机调用把 result 与 dump 缓冲区写到 stdout；`cargo test -p tryboard-xtensa` 在本机有乐鑫 QEMU 时，把同一 ELF 放到 `qemu-system-xtensa -M sim -cpu esp32s3 -icount shift=0,sleep=off` 上跑一遍逐字比较
- 理由：不需要 QEMU 的 ROM / flash 启动链，裸 ELF 即可；半主机两边都好实现；-icount 让 CCOMPARE 定时器按指令数确定性触发（否则由宿主计时器异步送达）
- 已知差异的处理：sim 机器 PRID=0、ATOMCTL 复位 0x28 让 S32C1I 在旁路内存上异常——测试开头把 ATOMCTL 设成 0x2a，PRID 检查接受 0；QEMU 的 CCOUNT 按 40MHz 虚拟时间走，测试不输出原始 CCOUNT
- 替代：用 gdbstub 读寄存器（更通用但慢、需要协议客户端）

## 2026-10-15 · FPU 除法 / 开方分步指令采用 QEMU 的模型
- 决定：MKDADJ.S 直接给出 fs/fr 的正确舍入商、MKSADJ.S 给出 sqrt、ADDEXPM.S 搬运结果，DIV0/SQRT0/NEXP01/MADDN/ADDEXP/DIVN 不改目标寄存器——与乐鑫 QEMU 逐值一致（黑盒对照得出）
- 理由：这些指令真实的逐步语义没有公开到可逐位复现；编译器 / libgcc / libm 只以固定序列使用它们，该模型下序列结果是正确舍入的 IEEE 结果
- 例外：RECIP0 / RSQRT0 直接给出 1/x、1/√x（QEMU 当空操作，导致 -ffast-math 的 __recipsf2 / __rsqrtsf2 返回旧寄存器值）
- 替代：拿到 Cadence ISA 手册的分步定义后逐步实现，届时用真机结果标定

## 2026-10-15 · MOVSP 的 Alloca 条件按 ISA / QEMU 修正
- 决定：WINDOWSTART 在 WB−1..WB−3 都为 0（调用者帧已溢出到栈上）才触发 Alloca 异常；切片 1 写反了，测试也按写反的理解编写，与 QEMU 差分时发现。S3 SoC 分支也独立报告了这一点
- 中断 API：SoC 驱动外部中断线用 `Cpu::set_irq_lines(mask)`（位 = CPU 中断号，电平型随线、边沿型 / NMI 上升沿锁存）；写 INTERRUPT 特殊寄存器只等于 INTSET（只能置软件中断 7/29），不能用来注入外部中断

## 2026-10-15 · Wi-Fi 在 MAC 寄存器 + DMA 描述符层模拟
- 决定：不 HLE 驱动函数，而是模拟 MAC 硬件接口（发送队列寄存器、lldesc 描述符、接收元数据头、中断位），802.11 帧交给 Rust 写的虚拟无线世界（虚拟 AP、以后的 DHCP / TCP）
- 理由：IDF 5.5 的 Wi-Fi 数据通路函数基本都被 IDF 自己的库替换，ROM 里只剩跳转桩，按 ROM 地址拦截无效；按 app 符号拦截需要 ELF。硬件接口对 IDF / Arduino 各版本稳定，用户只要上传 .bin
- 代价：要逆向寄存器语义（记录在 docs/WIFI.md）；PHY 校准等射频细节用"就绪位"糊过去
- 替代：方案 c（需要 ELF 的符号级 HLE），实现快但对用户不友好
## 2026-10-15 · USB 按"令牌事务"模拟，Slave 与 DMA 两条通路都做
- 决定：DWC2 控制器不模拟线上比特、CRC、数据翻转位，虚拟主机以 SETUP / IN / OUT 令牌为单位交互；控制器同时支持 Slave（FIFO）与 Buffer DMA
- 理由：esp_tinyusb 默认 Buffer DMA（CONFIG_TINYUSB_MODE_DMA），TinyUSB 原版与其它栈常用 Slave，用户拿来的固件两种都有；令牌粒度足以让真实 TinyUSB 栈完整走完枚举与类协议，而逐位模拟只会拖慢速度、不增加教学价值
- 替代：抓 USB 包给"协议分析仪"视图——令牌层已经有完整信息，以后可以直接记录成 pcap

## 2026-10-15 · 虚拟主机内置在 SoC 里，类驱动只做 HID 与 CDC-ACM
- 决定：主机（"另一头的电脑 / 手机"）用 Rust 写在 `esp32s3/src/usb/host.rs`，枚举后只驱动 HID（键盘 / 鼠标）与 CDC-ACM；NCM / MSC / 音频只识别接口类型
- 理由：键盘 / 鼠标与虚拟串口是最常见的 S3 USB 玩法，也是"插手机"类视频（执言）的前置知识；NCM 需要一个最小 IP 栈（ARP / ICMP / DHCP），留给 Wi-Fi 虚拟网络做完后复用
- 替代：把主机放到浏览器 JS 里——会让 CLI 验收拿不到同样的结果，不选

## 2026-10-15 · wasm 里 C3 / S3 两台机器并存、按镜像芯片 ID 选
- 决定：`tb_boot` 先读镜像头芯片 ID（5 = C3，9 = S3），各自放在独立的 thread_local；页面按同一规则（`chipOf`）下载对应 ROM
- 理由：改动最小，不打扰 C3 现有接口；以后若做多板联动再抽象成 trait 对象
- 替代：统一的 `Machine` trait——等 S3 外设和 C3 对齐（另一分支在做）后再收拢
## 2026-10-15 · S3 双核：HLE 启动核 1，固定量子交替
- 决定：不模拟 ROM 里核 1 的复位等待代码，而是在 `ets_set_appcpu_boot_addr` 入口 HLE 拿到 call_start_cpu1 直接启动核 1；两核按 256 周期量子在同一线程里交替（确定性），都空闲时一起快进
- 理由：确定性（同一固件每次跑结果相同，验收可复现）；单线程适合 wasm；量子足够小，跨核中断 / 自旋锁的延迟在微秒级，FreeRTOS SMP 与 esp_ipc 正常
- 替代：两核真并行（多线程 + 原子内存），快但不确定、wasm 里要 SharedArrayBuffer

## 2026-10-15 · 外设复用 C3 模型并按芯片参数化，不另立公共 crate
- 决定：S3 继续依赖 tryboard-esp32c3 的外设模型；寄存器排布有差异的（RMT）加布局参数，LEDC 扩到 8 通道；另立 `tryboard-machine` 做芯片无关外壳给 CLI / wasm 用
- 理由：两颗芯片的这些外设寄存器逐项一致（I2C、LEDC、UART、SYSTIMER），搬到 tryboard-soc 只会制造合并冲突；真正需要"一套接口"的是 CLI 和网页
- 替代：把外设整体搬进 tryboard-soc，等第三颗芯片（C6）加进来时再做

## 2026-10-15 · S3 示例与 C3 共用源码
- 决定：firmware/s3-* 的 CMakeLists 直接编译 C3 示例的 main.c，用 `target_compile_definitions` 覆盖引脚（LED、I2C、ADC 通道）
- 理由：示例逻辑不分芯片，复制源码会分叉；同一份代码在两颗芯片上都过验收，本身就是"可移植"的演示
- 替代：每颗芯片一份源码

## 2026-10-15 · S3 对齐分支与 USB / 复位 / Wi-Fi 合流
- 决定：CLI 与 wasm 只经 `tryboard-machine` 的 `Machine` 访问芯片；USB OTG 走 `Machine::usb()/usb_mut()`（C3 返回 None），软件复位走 `Machine::reboot()`。C3 专用的调试参数（--watch / --dump / --wifi-log / --dump-intc）在 CLI 里按 `Machine::C3` 分支处理
- S3 软件复位暂不支持：`Machine::reboot` 对 S3 返回错误，固件会停在 esp_restart；以后在 S3 SoC 里按 RTC_CNTL 软件复位位实现
- 网页元件编辑器的引脚列表取自当前开发板排针（S3 去掉 GPIO35–37，因为 N16R8 的八线 PSRAM 占用）
- `.gitignore` 里 node_modules / firmware/build 改成不带尾斜杠，免得 worktree 里的软链接被当成文件提交

## 2026-10-15 · 子代理改为"全新代理 + 自足任务说明"，不再默认 fork
- 决定：并行开发改用全新的 general-purpose 子代理，任务说明按 docs/AGENT_BRIEF.md 写；主会话在每个里程碑结束后请人 `/compact`。规则写进 AGENTS.md §9
- 理由：复盘发现 fork 子代理继承了 33–66 万上下文，产生的缓存读取占全会话的 76%，可输出只有 10 万 token；任务说明本来就写得完整，继承来的上下文几乎没用上
- 替代：继续用 fork（省掉写任务说明的功夫，但开销约为现在的 10 倍）

## 2026-10-16 · 示例共用代码放 firmware/common（头文件），weather 串口温度固定用摄氏
- 决定：SSD1306 最小驱动 + 5x7 字库抽到 `firmware/common/ssd1306_mini.h`，BME280 校准解析 + 补偿公式抽到 `firmware/common/bme280_calc.h`（均为 static inline，只在一个 .c 里包含）；oled / bme280 / weather 共用。C3 示例的引脚改成 `#ifndef` 宏（默认值不变），s3-button / s3-bme280 / s3-servo 按 s3-oled 方式只覆盖引脚
- weather 串口每行 `T=23.50 C H=45.0 % P=1013.25 hPa LED=green PWM=1675us`，不随 ℃/℉ 切换变化（切换只打印 `UNIT F` / `UNIT C` 并改屏幕），便于验收与网页解析
- 理由：复制粘贴会分叉；头文件方式不必给每个示例加组件依赖
- 替代：做成 IDF 组件（EXTRA_COMPONENT_DIRS），要改每个工程的顶层 CMakeLists
- weather-hot（35°C）用例未加：accept.json 以 id 定位固件目录，不支持同一固件多用例；要加需在 accept.sh 里支持 `fw` 字段

## 2026-10-16 · 装配与关卡：SVG 等轴测、两份判定实现、指纹跨网页 / 命令行一致
- 装配用 SVG 等轴测（`web/src/views/assembly.ts`），不用 three.js：和设计稿一致、手机上可拖、零依赖；3D 装配等有外壳模型素材再做
- 装配检查是几何估算（内腔 70×50×32 mm、排线 8 cm、贴芯片温漂 +2.5 ℃ 都是示意数值，未经真机标定），页面标"估算"；温漂会真实地改传感器看到的温度（只在"开机看成品"后生效）
- 关卡判定写两份（Python `tools/check.py`、TS `web/src/checks.ts`），而不是在 Rust CLI 里做：CLI 不引 crate，没有 JSON / 正则；两份由 `tools/webtest/levels.mjs` 用指纹对拍
- 新增 wasm 导出 `tb_report` / `tb_report_ptr`：输出与 CLI 相同格式的 GPIO 翻转 / WS2812 帧 / OLED 点亮像素，网页与命令行解析同一种文本
- 指纹按串口原始字节算（含 `\r\n`）；`check.py` 因此按字节读子进程输出
- 关卡进度存 localStorage，只记用户上传固件的通过；参考固件通过不计
- 新页面用 Google Fonts（Noto Sans SC / JetBrains Mono，OFL），与配套文章同字体；加载失败回落到系统字体
- 首页 home.html 暂不替换 index.html（实验台），因为验收脚本、artifact 打包都以 index.html 为实验台；公开发布前再决定入口
- 替代：three.js 装配（成本高、手机拖拽难）；Rust 里手写 JSON + 判定（重复造轮子）

## 2026-10-16 · GP-SPI2 + GDMA + GC9A01 圆屏；成品 lens / spin
- SPI2 与 GDMA 模型放在 tryboard-esp32c3（`gpspi.rs`、`gdma.rs`），按"外设复用 C3 模型并按芯片参数化"：GP-SPI 寄存器 C3 / S3 同族；GDMA 的通道数 / 间距 / OUT 组偏移 / 链表高位基址做成 `GdmaLayout`，目前只定义了 `S3`。**只接进了 S3 的 SocBus**，C3 的 SPI2 / GDMA 仍是未建模寄存器（等有 C3 SPI 固件再接，需要补 C3 的 GdmaLayout）
- 执行模型照 I2C：写 CMD.USR 时 SoC 立刻沿 GDMA 描述符链（或 W0..W15）取出全部 MOSI 字节交给从机，"传输中" / TRANS_DONE 与 GDMA 的 OUT_EOF 推迟到按 SPI 时钟（PLL 80MHz 或 XTAL ÷ (pre+1)(n+1)，加 2 位 CS 建立 / 保持）算出的耗时之后。不模拟 FIFO、突发、逐位时序；MISO 读回全 1（总线上没有会应答的从机），RX 方向的 GDMA 只做了"填进描述符并置 SUC_EOF"
- D/C 取传输开始时刻 GPIO14 的电平（esp_lcd 在 pre_cb 里设好 D/C 再启动传输，与真机一致）；CS 经 IO_MUX（功能 4）或 GPIO 矩阵（信号 110）接到 SPI2 CS0 时由控制器管，否则当普通 GPIO 看。RST 只在固件把 GPIO13 驱动为低时才算复位（模组板上有上拉），背光 GPIO15 高电平亮
- 圆屏按市售 1.28" GC9A01 模组的实际表现建模：IPS 常黑（不开 INVON 颜色是反的）、子像素 BGR（MADCTL.BGR=1 才正确）。依据是 ESP-IDF `examples/peripherals/lcd/spi_lcd_touch` 对 GC9A01 的配置（`LCD_RGB_ELEMENT_ORDER_BGR` + `esp_lcd_panel_invert_color(true)`）。**未经真机标定**；好处是"忘了开反色 / 颜色顺序配错"这类买板前想知道的坑在网页里就能看到
- 厂商初始化命令（0xEF、0xEB、0x84..0x8F、0x62..0x74 等）只计数不建模；画面只依赖 SLPOUT / DISPON / INVON / MADCTL / COLMOD / CASET / RASET / RAMWR / RAMWRC
- 观察输出：CLI stderr `[tryboard] LCD GC9A01 非黑像素 N（显示开/关）`，N 数的是渲染后（含显示开关、睡眠、背光、反色）圆形可视区内的非黑像素；wasm `tb_report` 追加同格式不带括号的一行。`--lcd-ppm` 导出最后一帧（圆外为黑），`tools/ppm2png.py` 只用标准库转 PNG 供人看图
- 驱动用组件管理器拉的 `espressif/esp_lcd_gc9a01` 2.0.4（Apache-2.0，依赖 `espressif/cmake_utilities`，Apache-2.0），而不是自己发初始化序列：验收的意义就是"标准写法能跑"
- 固件用整帧缓冲（115200 字节，内部 DMA 内存）+ `on_color_trans_done` 信号量等传完再重画；spin 每 20ms 只重画眼睛那条带（88 行），避免 40MHz 下整帧 23ms 跟不上舵机节拍
- 替代：只建模 W 寄存器方式（esp_lcd 一定走 DMA，不够）；逐字节按 SPI 时钟推进（与"瞬间交付 + 推迟完成"相比慢且没有可观察差别）
