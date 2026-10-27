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
- S3 软件复位暂不支持：`Machine::reboot` 对 S3 返回错误，固件会停在 esp_restart；以后在 S3 SoC 里按 RTC_CNTL 软件复位位实现（2026-10-16 已实现，见下文"S3 软件复位与八线 PSRAM"）
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

## 2026-10-16 · S3 软件复位与八线 PSRAM
- 软件复位按寄存器语义实现（RTC_CNTL_OPTIONS0 复位位），不 HLE `esp_restart`：panic 后重启、ROM 里的 software_reset_cpu 都走同一条路。核 0 / 系统复位 = 整机用新总线重新直接启动；只复位核 1 = 停掉核 1（真机上它回 ROM 等启动地址并被 stall，效果相同）
- 复位后保留 RTC 慢 / 快速内存、RTC_CNTL_STORE0–3/6/7；SRAM 清零而不是保留——ROM 的 .bss 等我们跳过的初始化依赖零值，保留旧 SRAM 风险更大。代价：真机上 `__NOINIT_ATTR`（SRAM）变量通常跨软件复位保留，这里不保留，记在 STATUS
- Xtensa CCOUNT 改成"模拟时间 + 偏移"：IDF 的 esp_clk_init 按新旧 CPU 频率比例改写 CCOUNT，旧实现直接改了整机时间；首次上电时 cycles 很小看不出来，复位后启动时时间被放大约 4 倍、核 1 要空追上亿周期（s3-restart 3 秒用了 57 秒墙钟）。替代：在 CPU 里模拟可变频率（要动所有时间换算，留到 CPI / 频率标定时做）
- PSRAM 走寄存器级：ROM `esp_rom_opiflash_exec_cmd` 照常执行，SPI1 用户命令按 MISC 片选分给 flash 或 PSRAM 芯片模型。替代是 HLE 这个 ROM 函数（13 个参数、一半在栈上，且绕不开 IDF 时序调优里同样的寄存器路径），没选
- 时序调优不模拟采样窗口：所有候选点都能读对，IDF 因"连续通过点 ≥ 6"打印一条 tuning fail 警告并回落到默认点（index 5）。要消掉警告得按 IDF 的候选表硬编一个通过窗口，与芯片行为无关，不做
- 验收固件 s3-restart 没有共用 firmware/nvs 的源码：要测核 1 发起的复位和 RTC_NOINIT / RTC_DATA，期望输出也不同（nvs 的中文输出是 C3 用例的期望），共用要在 nvs/main.c 里加大段条件编译
- s3-psram 选 80MHz（Arduino "OPI PSRAM" 默认档、多数 N16R8 教程用法），会走时序调优；40MHz 不调优
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

## 2026-10-16 · WPA2：四次握手留给固件，数据帧 CCMP 在 MAC 硬件模型里做
- 决定：虚拟 AP（`wifi/wpa.rs`）当认证方跑完整四次握手；固件侧的 PBKDF2 / PRF / MIC / Key Unwrap 由 IDF 的 wpa_supplicant 自己算（经硬件 SHA / AES 加速器模型）；数据帧的 CCMP 加解密放在 MAC 模型（`wifi/mod.rs::hw_ccmp`），用驱动写进硬件密钥表的 PTK / GTK。"空中"的帧是真正的 CCMP 密文，AP 用自己推出来的 TK 解
- 理由：真机就是这样分工的——ESP32-C3 的 802.11 加解密由 MAC 硬件做（驱动发出的受保护帧里只有 CCMP 头和 MIC 空位，`ccmp_decap` 只剥头尾、不解密），握手则全在软件里。照这个分工，固件推导错了密钥就真的连不上，模拟器不会替它"补对"；密钥表读的是驱动实际写入的值，不是从 AP 那边抄
- 替代：(a) 让空中帧保持明文、MAC 模型忽略受保护位——实现最省，但验证不了固件的密钥安装；(b) MAC 模型直接用 AP 推出来的 TK——口令错时握手早就失败，看似等价，但会掩盖驱动装错密钥槽这类问题
- 密钥表格式靠反汇编 `hal_crypto_set_key_entry` / `hal_crypto_get_key_entry` 得到，字 1 高位只用到位 30（组密钥）；实测 IDF 把 GTK 装在槽 0、PTK 装在槽 4，对端 MAC 都是 BSSID

## 2026-10-16 · SHA / AES 加速器建模，DMA 模式暂时直接读 GDMA 寄存器
- 决定：新增 `crypto_hw.rs` 模拟 SHA（块 + DMA）与 AES（块 + DMA，6 种分组模式）。DMA 模式不经 GDMA 模型，而是按 GDMA 的 OUT/IN_PERI_SEL 找到接到 SHA(7) / AES(6) 的通道，直接读 OUTLINK / INLINK 描述符地址、沿 lldesc 链搬数据并清 owner 位
- 理由：IDF 默认 MBEDTLS_HARDWARE_SHA / AES，WPA2 绕不开；不建模时寄存器读回 0，`sha_hal_read_digest` 见全零摘要直接 abort。C3 上 mbedTLS 的 SHA / AES 只走 DMA 模式（fast_psk 走块模式）。GDMA 通道模型另有代理在做，这里只读不写 GDMA 寄存器，避免冲突
- 替代：在验收固件的 sdkconfig 里关掉硬件加速——用户拿来的默认配置固件照样会崩，不选。GDMA 模型合入后，`gdma_link` 改成调用它的接口（通道状态、EOF 中断由它负责）

## 2026-10-16 · 错口令用例：断开两次即判通过，原因码以 IDF 实际行为为准
- 决定：wifi-wpa2-bad 期望第一次断开 `reason=15`（WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT），第二次断开后打印 TRYBOARD_OK；不检查第二次的原因码
- 理由：实测 IDF 5.5 收到第 4 个消息 1（AP 已重传 3 次）后自己去认证并报 15，早于虚拟 AP 的超时；随后它把这个 BSSID 拉黑，重连扫描时跳过它，报 205（CONNECTION_FAIL）。这两步都是 IDF 自己的策略，不是模拟器造的
- 替代：只断开一次就结束——覆盖不到"失败后重连不崩溃"


## 2026-10-16 · 任务书试做后的修订；装配模板化；第 07 关接入真实固件
- 依据 docs/BRIEF_TRIALS.md（只看任务书写固件，6 关 5 关一次过）：01/02/04/05/06 任务书补上极性、初始电平、消抖上限、负温度格式、"不要先等待"、"舵机始终按摄氏度"等；03 关像素阈值 300 → 150（验的是 I2C + 帧缓冲，不是字数）；05 关加 `pwm.steps`（0.5/1.0/1.5/2.0/2.5 ms 依次出现），时间窗 2.6 → 3 s；06 关 PWM 只看 1 s 以后（`pwm.from`，上电初始化阶段允许别的脉宽，真舵机此时也不会动）
- PWM 结果文字改成"占空比 + 约 x.xx ms"，不再把三位小数的占空比换算成看似精确的三位毫秒（试做里 1.675 被显示成 1.680，误导 AI 去改对的值）
- check.py 在模拟器没跑起来（缺 ROM、panic）时首行报"模拟器没跑起来"，不再表现为"GPIO 翻转 0 次"
- 第 06 关的"装配无警告"命令行不判，check.py 明确打印一行说明
- 装配引擎与模板分开（templates.ts）；spin / lens 两套模板的"装法影响"只改成品画面（舵盘偏角、透镜放大），标估算，不改模拟器
- 替代：06 关保留 min = max 并在任务书里强调——仍会挂掉大量"先初始化 PWM"的正常写法，放弃

## 2026-10-16 · 工作台外壳 app.html：一页四步、hash 路由、一个 store
- 决定：新页面 `web/app.html?work=<weather|spin|lens|blank>#<shop|bench|assemble|product>`。作品放查询串（换作品 = 换固件和台面，整页重载可以接受），步骤放 hash（切步骤不重载）。实时模拟（LiveSim）和 3D 台面（createBench）在 `src/app/session.ts` 里整页只建一份，步骤切换只换面板内容，所以模拟时间连续。步骤用 `registerStep(id, { mount(el, ctx), unmount() })` 注册，后续任务覆盖占位即可
- store：`src/app/store.ts` 自写（不引依赖），一个对象、浅合并 `set`、`subscribe(fn, keys?)` 按字段过滤通知。selection 是 `{ kind, id }`，构建树和台面拾取（ScenePickApi.onPick）写同一个字段，属性面板只读它。实时字段（读数、模拟时间）只更新面板里带 `data-live` 的节点，不重建面板，免得拖滑块时被打断
- 与 3D 的耦合只经 `scene-api.ts`：外壳把 bench 当 `Partial<ScenePickApi>`，方法存在才调；board3d 未实现时点不到台面但不报错
- 检查点进度：只有自己上传的固件通过才计数（与关卡页一致），存 `localStorage['tryboard-app-checks:<work>']`。第 06 关的"装配无警告"在实验台上显示为"·（在组装步骤判定）"，不计入通过与否——与命令行 check.py 一致，组装接进来（P0-16）后再补判
- LiveSim 加了 `onTick` / `onBoot` / `setEnv`：外壳要拿引脚电平驱动 3D、要计"运行 #n"、要改湿度气压；旧页面不受影响
- 替代：每步一个独立 HTML（切步骤必然重载模拟，违背 P0-01）；引入状态库（违反"不加依赖"）
## 2026-10-16 · 输入日志（P0-19）与蜂鸣器出声（P0-14）
- 输入日志在 worker 里盖时间戳，用**模拟时间**（施加时的 CPU 周期 ÷ 160MHz），不用墙钟：墙钟 / 模拟时间比随机器快慢变化，墙钟日志重放不出同样的结果
- 导出格式就是 CLI 的定时脚本，一行一条 `秒:动作`（秒向下取整到微秒，6 位小数），`#` 开头为注释（头两行写固件名和建议的重放命令，含 `--seconds` 到导出时刻）。动作：`gpioN=0|1|z`、`mvN=毫伏`、`env=温度,湿度,气压Pa`（新增）、`uart=文本`、`usbcdc=文本`（`\n` 表示换行）。上电时挂的器件不进脚本，由 `--i2c` / `--spi` 给（InputLog JSON 里有 i2c / lcd 字段，`cliArgs` 拼出命令行）
- CLI：`--script` 接受 `;` 或换行分隔、`#` 注释；新增 `--inputs <文件>`（与 `--script` 合并，按时间稳定排序，同一时刻按书写顺序生效）。有 `--inputs` 时全程 1ms 一片——与网页 worker 相同，这是逐周期复现的前提。`tools/check.py --inputs` 接受上述文本或 InputLog JSON
- 网页 worker 的时间片从"按落后多少切、最多 5ms"改成固定 1ms：多一点循环开销，S3 weather 实测仍 1.00× 实时
- 每份日志从一次上电开始，复位 / 换固件 / 改接线（会重新上电）就是新日志。装配视图里"传感器贴芯片"的温度偏移已经算进 env 的温度里，日志记的是传感器读到的值
- 蜂鸣器：只看 LEDC 输出的占空比和频率（不逐周期出波形，见 LEDC 的约定），20Hz–20kHz 且占空比 > 0 才出声，舵机的 50Hz 不算。方波 + 小音量（0.04）。默认静音，浏览器要求用户手势才能起 AudioContext。替代：用 AudioWorklet 按模拟时间逐样本合成——能还原占空比对音色的影响，但要把 PWM 变化精确到样本，暂不需要
- 测试钩子：`window.__tbAudio`（muted / lastFreq / playing / sounding / peakHz）、`__tbInputLog()`、`__tbReplay(log, 秒, pwm脚)`、`__tbButtonPos('BOOT')`（3D 按键的屏幕坐标，给测试用真实鼠标按）
## 2026-10-16 · 元件库 / 采购模版 / 规则引擎：TS 纯数据 + 纯函数，node --test 直接跑 .ts
- 决定：元件库、模版、规则都放 `web/src/catalog/`（`parts.ts` 53 件、`templates.ts` 四个模版、`rules.ts` R01–R27、`schema.ts` 校验与核价提醒），是 TS 常量和纯函数，不是 RESEARCH_PROCURE 草稿里的 `parts.json` / `rules.json`。规则元数据（id、级别、来源、可信度）在 `RULES` 表里，实现按 id 查 `IMPL`
- 数据约定：查不到来源的数值写 `null`，字段名必须写进该件的 `todo`；没有意义的字段（线材没有供电电压）写进 `na`；估算电流 `currentMa.est = true` 且 source 写"估算：依据"；`sources` 为空的件不许给供电范围，除非列入 todo。价格全部 `verified: false`、来源写"代理按淘宝常见在售区间估计"，`checkedAt` 为 YYYY-MM（只记年月时按当月 1 日算，宁可早提醒）。这些约定由 `validateCatalog()` 强制，测试与 accept.sh 跑它
- 外链只用淘宝 / 立创商城搜索页，schema 拒绝商品页和带推广参数的链接（docs/LICENSING.md）
- C3 ADC2：改正 `advisor/data.ts` 的说法——C3 的 ADC2 因勘误已不被 ESP-IDF 支持（与 Wi-Fi 无关）；S3 才是 ADC2 与 Wi-Fi 共用（R11 / R12 分开处理）
- 测试：Node 24 自带 `node --test` 直接跑 `web/test/*.test.ts`（类型擦除，无需 flag），不加任何 npm 依赖；catalog 内部用带 `.ts` 扩展名的 import（Node ESM 不补扩展名），`tsconfig.json` 开 `allowImportingTsExtensions` + `noEmit`（vite 照常打包）。现有页面代码仍用无扩展名 import，不受影响。测试文件不进 tsc（没有 @types/node）
- `toScene` 的输出顺序按接线里第一次出现的先后，与 `firmware/examples.json` 的 scene 逐项 deepEqual；模版接线与 examples.json 的 `pins` 对拍
- `level-bss138` 归为 passive：它的 5 V 侧 HV 脚本来就不接 GPIO，归 module 会让 R17 在没接线时误报
- 替代：(a) JSON + 单独校验脚本——要么丢掉类型，要么 TS 再写一遍类型，且 JSON 里不能写注释交代来源；(b) vitest——要加 npm 依赖，Node 24 自带的够用
## 2026-10-16 · 真实器材 3D 台面（P0-10 / P0-11）
- 决定：bloom 用 UnrealBloomPass 单遍 + 亮度阈值 1.8 只挑发光体（RGB ×7、LED 透镜 ×6 的 HDR emissive），不另渲染一遍"发光层"；没有发光体（LED 全灭、RGB 为 0）时整遍跳过
- 理由：不做色调映射（白底要与设计稿一致），白底与受光白色器件的线性亮度在 1.0–1.4，阈值 1.05 时全屏泛白（截图实测）；选择性 bloom 的双遍渲染要多一倍 draw call
- 替代：layers 选择性 bloom（多一遍场景渲染）；开色调映射（背景色会偏）
- 决定：面包板孔、排针、针尖、焊点等大量重复件用 InstancedMesh；针脚拾取也用一个 InstancedMesh 隐形碰撞盒，instanceId → 针脚 id
- 理由：830 孔 + 两块排针逐个 Mesh 要上千 draw call；实例化后 weather 场景 228 calls（含后处理）、11 万三角形
- 替代：合并成一个静态几何体（拾取要另算哪根针）
- 决定：开发板引脚顺序按乐鑫用户指南重排：C3 DevKitM-1 原来整排反了；C3、S3 两块板 J1 / J3 左右放反了，一并改正
- 理由：针脚位置决定连线和丝印，学生拿真板对照时必须一致（前一个代理对着指南核过；本轮只核对了丝印与 listPins 一致，未再逐针对照指南）
- 决定：示例没给机位时按开发板 + 元件包围盒取景（不再用为 C3 写死的机位）；跳线拱高从面包板面量起；导线在插头内补竖直控制点；点到插头且后面 15 mm 内有针脚时算点中针脚
- 理由：均来自截图验收（Reviews/ab/P0-10.md）：S3 + 舵机被裁、线穿插头、线从插头侧面鼓出、点 GPIO4 总点到线
- 决定：`window.__bench` 只在 URL 带 `?debug=1` 时挂出（含 `_debug.pos` 等内部句柄），给验收脚本用

## 2026-10-16 · 作品首页、第三方授权页、旧页面下线（P0-05 / P0-20 / P0-21）
- 首页：替换旧 home.html，白底极简（复用 app/app.css 的变量和 .btn/.kv/.sec，页面版式在 src/page.css）。首屏三张作品卡，卡片先放成品示意图，点「看真实固件跑」换成 views/ 的成品视图（真实固件，同一时间只跑一份 worker，滚出视口暂停）。旧的米色 / 墨绿底用 CSS 盖掉 SVG fill 属性统一成台面浅灰，不改视图代码（关卡页 / 实验台还在用）。"做这个" → `app.html?work=<id>#shop`；"我有自己的想法" → advisor.html（样式后续统一）；"已经有固件了" → `app.html?work=blank#bench`。旧首页的装配区、7 关路线、示例墙去掉（装配进组装步骤，关卡成了检查点，示例在空白实验台下拉里）
- 参考价暂用 catalog 合入前的估算（¥89–144 / ¥95–150 / ¥70–110），标"估算"，HTML 里留 TODO 指向 catalog。检查点数写死在卡片上，levels.mjs 对拍工作台的"检查点 0/N"保证一致（不 import session.ts，免得首页打包 three.js）
- 授权页：tools/gen_licenses.mjs 在 build_web.sh 里生成 web/licenses.html（不进仓库；vite 入口在文件存在时才加，单独 npm run build 也能过）。来源：package.json 运行时依赖 + LICENSE 全文、package-lock 构建期依赖（标"不随网站分发"）、Cargo.lock 第三方 crate（当前无）、esp-rom-elfs LICENSE / README 版权行 / ROM 第三方清单、web/public/fw 实际发布的固件的 managed_components（许可证从 LICENSE 正文识别，版权取 SPDX-FileCopyrightText）、字体、SOURCES.md（现在没有，写明程序生成）。发现乐鑫修改版 MIT 组件就失败退出（规则 5）
- 旧页面：levels.html 改为跳转页（#01–#06 → weather，#07 / #07-spin → spin，#07-lens → lens，带 `&cp=`），app 只加了最小的 `cp` 参数（初始 selection 选中该检查点，不属于该作品就忽略）。levels.ts / levels.css 暂不删（并行分支可能在改，免得合并冲突；P0-16 接手装配验收后删）。index.html 保留为空白实验台，页头加"新工作台 →"，去掉"关卡"
- 测试：levels.mjs 的关卡页用例迁到 app.html（每个检查点参考固件指纹与 check.py 对拍、上传自己的固件、进度记住）；拖拽装配迁到 index.html 的装配视图（同一个 views/assembly）。原来"BME280 贴芯片 → 第 06 关验收不过"改成"开机后固件读数 T=26.00（偏 2.5 ℃）"，"舵盘装偏 → 07-spin 验收不过"改成"成品提示偏 14.4°"：工作台实验台不判装配（与命令行一致），判定由 P0-16 组装步骤补回
- 替代：保留旧关卡页另起名字（两套检查点 UI 并存，违背 P0-21）；授权页放 public/ 内联样式（要复制一份 CSS）

## 2026-10-16 · 组装与 3D 成品接进外壳（P0-16 / P0-17 / P0-18）
- 组装沿用 `views/assembly.ts` 的 SVG 等轴测引擎和 `templates.ts` 三套模版，不另写 3D 装配：装法影响规则只有一份。外壳化的做法是"包一层"：SVG 裁掉自带的右侧小面板（viewBox 704×560），改由外壳属性面板显示；颜色用 CSS 属性选择器覆盖成白底主题，引擎代码只加了炸开（层间距 30 → 46）、`message()`、`isoPoint()` 几个接口
- 时间线回退 = 清空后重放前 i 步（`asm.reset()` + `place()`），不存快照，和 P0-03 的"确定性重算"一致。新操作截断回退点之后的步骤。装配时间线（含复测结果）存 `localStorage['tryboard-app-asm:<work>']`，刷新后按存的顺序重放；存的顺序与模版不符就作废
- 开机复测跑的是带装配的那个检查点（weather 06、spin 07-spin、lens 07-lens），固件优先用你在实验台验收这一关时上传的那份（本页内存，刷新后回落到台面上的固件），env 温度 = 关卡室温 + 装法温漂。结果 = 关卡判定全过 且 装配无警告；命令行 check.py 仍不判装配（几何估算）
- 解锁：组装要求实验台检查点（只算自己的固件）全过；成品要求装完（不要求复测通过——装偏了也该能看到后果）
- 外壳改动：`Shell.onVerdict`（结论按钮的动作由步骤自己设）；main.ts 的实验台时间线 / 结论只在采购、实验台显示，组装、成品各管自己的时间线；Session 增加 `audio`（BuzzerAudio 整页一份，接 LiveSim.onPwm）、`frame.lcd`、`fwBuf`、`setSensorOffset`、`onConsole`。组装、成品时实验台 3D 台面 `visibility:hidden`（仍在后台跑，不销毁，不改 board3d.ts）
- 成品 3D（`app/product3d.ts`）独立于 board3d：WebGLRenderer + EffectComposer（UnrealBloom 阈值 1.25，只有导光柱的自发光超过阈值）+ RoomEnvironment；没走 WebGPU，因为 three 的 EffectComposer / UnrealBloomPass 只支持 WebGL，与 board3d 现状一致。OLED 用 DataTexture、MeshBasicMaterial（toneMapped=false），不参与 bloom，免得字糊
- 指针：二阶弹簧阻尼（k=90、ζ=0.8）追固件 PWM 换算的角度，再限速 600°/s（SG90 约 0.1 s/60°）。示意，不是舵机模型
- 热源改的是 env（气象站周围的温度）：目标 = 室温 + 14 ℃ × 贴近程度（离通风口 2.7–9.7 cm 线性），一阶滞后 τ=3 s 逼近。示意数值，未经真机标定；离开成品步骤时撤掉热源、温漂，回到室温
- 事件时间线从串口整行解析 `ALARM ON/OFF`、`UNIT F/C`（weather 固件格式），加上上电、按键、热源、声音开关；只追加不回退
- 小黄 / 透镜先挂 `lcdproducts.ts` 的 SVG 成品（标"外观示意（2D）"），3D 化留给 P1-10
- 测试钩子：`window.__tbProduct`（buttonPos / azimuth / needle / heat / unit / alarm）
- 替代：(a) 成品复用 board3d 的场景——那边另有代理在改，且台面和成品的相机、光照、交互都不同；(b) 每次进成品重启模拟加温漂——违背"不重启模拟"，温漂改由 `LiveSim.setOffset` 在线生效
## 2026-10-16 · 采购页（P0-07）与"买完摆上实验台"（P0-09）
- 决定：清单只存**操作日志**（套用模版 / 加 / 去 / 换板 / 一键修），清单由日志重放得到（`web/src/app/bom.ts`，纯函数，`web/test/bom.test.ts`）。时间线每格是一步，点回去 = 重放到那一步；从中间再改就丢掉后面的分支（和撤销 / 重做一致）。日志存 `localStorage['tryboard-app-shop:<work>']`，读回时校验，引用了不存在的件就回到模版默认
- 舵机电源（5 V 2 A 电源 + DC 母座）从模版**必选改为建议件（默认勾选）**：R27 / R20 本来就会对"舵机没有外接 5 V"给阻断 + 一键补，放成必选反而看不到后果；去掉后实验台照"只有 USB"摆，给欠压演示留口子。`catalog.test.ts` 的"气象站带出正确清单"仍然成立（默认勾选）
- 规则检查放在右栏最上面、零件详情在下：结论先说后果。结论按钮"n 条提醒"（含阻断时标红），"摆上实验台"不因阻断置灰——实验台本来就是看后果的地方
- 必选件的勾选框不禁用：点了不变并弹提示说为什么（"必选件不能去掉：BME280（温度 / 湿度 / 气压）"），比灰掉更好懂；开发板一行只能换不能去
- 中间台面用 HTML + 内联 SVG 示意卡片（不改 board3d.ts，3D 画布在采购步骤隐藏但不销毁，模拟继续跑）
- 摆上实验台：`toScene(picks, 模版接线)` → `Session.applyScene`。只有 I2C 器件或圆屏变了才带着当前固件重新上电（LiveSim 加 `configure`）；场景存 `localStorage['tryboard-app-placed:<work>']`，刷新后仍按清单摆。清单的模版和当前作品不同（比如在气象站页切到小黄）就把日志和场景写到那个作品名下、整页换到 `app.html?work=<模版>#bench`——固件跟着作品走
- 换开发板不换固件，实验台仍按固件的芯片摆板；没有默认接线的件（从元件库加的）不摆，提示里列出
- 替代：(a) 每步存清单快照——简单但违背"回退靠确定性重算"；(b) 采购页用 3D 平铺——要改 board3d.ts，与另一个代理冲突

## 2026-10-16 · 实验台时间线回退（P0-03）、快捷卡片、针脚、接线检查、运行历史（P0-04 / 11 / 12 / 13）
- 回退不存模拟快照，靠确定性重算。时间线每一步记 `{操作, 第几次运行, 模拟时刻}`（`web/src/app/history.ts` 纯函数 + `benchhist.ts` 控制器）。编辑状态（场景、供电、环境、热源、改接线、验收结果）= 把前 i 步折叠起来；模拟器状态 = 用那次运行的固件、器件和**输入日志**重新上电，按原来的模拟时刻施加输入，快进到目标时刻停住（暂停）
- "回到第 i 步" = 第 i 步做完、第 i+1 步还没发生的那一刻：同一次运行里下一步的时刻，否则是这次运行收尾的时刻。所以"运行 #n"这一步如果后面同一次运行里没有别的操作，回去就是整次运行，指纹必须与收尾时一致（agent-browser 与 interact.mjs 对拍；命令行 `--inputs` 重放同一日志、check.py 指纹也一致）
- 步骤的模拟时刻由 worker 盖（新增 `mark` 消息）：主线程先发 mark 再发输入，worker 按顺序处理，所以一步的时刻 ≤ 它带来的第一条输入；拖滑块一次手势只记一步（第一下记、松手结束）
- worker 新增 `snapshot`（上电以来的输入日志 + 串口全文 + `tb_report`，不打断运行）和 `seek`（上电 → 1ms 一片快进，事件在原来的时间片边界施加 → 停住）；实时输入与回退重放走同一个 `apply()`。LiveSim 在每次重新上电前先 snapshot 收尾（`onRunEnd`），运行记录的指纹由它算
- 回退后再做新操作 = 新分支：后面的步骤和运行丢掉；停在回退点的那次运行截到回退时刻（用回退的快照当它的记录）。改环境 / 热源会从回退点接着跑；供电、改接线、验收只改显示状态，仍停在回退点；也可以点「从这里继续」或「重新上电」
- 第一次上电前的步骤（放零件、连线）算第 1 次运行的 0 ms；"摆上实验台"若换了 I2C 器件会重新上电，这一步记在旧运行里（回到它看到的是旧运行收尾时的模拟状态 + 新场景），没再细分
- 不进时间线：BOOT 按键、成品 / 组装步骤里改的环境（都在输入日志里，回退会照样重放）
- 替代：(a) 每步存 wasm 内存快照——S3 内存几 MB，每步一份太大，且违背"确定性重算"；(b) 每次回退都从第 1 次运行开始重放全部历史——运行之间本来就重新上电，没必要
- 快捷卡片：点 BME280（温度滑块 / 把手放上去 = env +8 ℃ 并 `setHeat('bme280')` / 量到芯片 = `measure(bme280, board)` 加温漂估算）、舵机供电线或 5V 针（USB ↔ 外接 5 V，只改清单和供电显示）、BOOT（按下 / 松开）。卡片用 `project()` 定位，每帧跟着目标走，转到看不见就关；选了别的东西也关
- 针脚实时值来自 worker 每个 tick 已有的电平 / 使能 / PWM 占空比与频率，没有新增采样；示波器按记录下来的占空比、频率合成方波（相位示意），普通 GPIO 画 tick 采样的电平，I2C 线只画示意，电源脚电压按标称写"估算"（电路求解是 P1-01）
- 接线检查新写 W1–W5（`wirecheck.ts`）而不是直接调 `catalog/rules.ts`：采购规则吃的是元件库 id + 模版接线，实验台吃的是场景推出来的线（id 与 3D 一致）；W2 / W5 的来源、可信度沿用 R17 / R15。index.html 的元件编辑器只能改场景，造不出 5 V 接 GPIO / 没电阻 / 缺地，所以用 `?debug=1` 的 `__tbApp.injectWiring()` 造用例；改接 / 拔线不改 3D 画法（不动 board3d.ts），只标红 + 说明
- 外壳公共接口变化：`Session` 加 `heat / setHeat / setPower / wireMods / setWireMods / restoreScene / onTick / onBoot / onRunEnd / bootCount / snapshot / mark / seek / continueRun`，`frame` 加 `pwmFreq / gpio / enable / gpioHi / enableHi`；`AppState` 加 `editRev / runNo / hist`；`StepCtx.hist`；`Card.place / onHide`；接线与零件信息从 bench.ts 挪到 `app/wiring.ts`；`saveBom` 导出。board3d.ts 未改

## 2026-10-16 · 电气模型（P1-01 直流求解器、P1-02 欠压复位、P1-03 舵机动力学、P1-04 万用表）
- 决定：新 crate `core/crates/elec`（无依赖）。`mna.rs` 通用求解器：节点电压法 + 隐式欧拉（电容伴随模型），非线性元件全部写成分段线性（USB 限流源、LDO、恒流负载、舵机电机），用 **Katzenelson 法**求解：在当前段线性化 → 稠密 LU（部分主元）→ 解若落在同一组段里即精确解，否则沿"当前点 → 线性解"走到第一个段边界（二分）换段再解。不用导数、不调步长，结果只取决于输入
- 理由：节点只有 4 个，稠密 LU 足够；先试了"普通 PWL 牛顿 + 残差线搜索"，在 LDO 稳压段（100 S 斜率的窄谷）和浮空节点上来回跳、发散（从 0 V 起算时 3V3 跑到 1e11 V），Katzenelson 每轮只跨一个边界，不会被浮空节点的超大线性解带跑
- 替代：(a) 光滑化（softplus 代替 max）+ 牛顿——要调光滑系数，误差与 ngspice 的 min/max 对不上；(b) 引 nalgebra / 现成 SPICE——违反"不加 crate"，也不需要
- 对照：`tools/elec/*.cir` 10 个网表（分压、电桥、两源并联、电流源 T 网、RC 充电、两级 RC、USB 板静态、USB + 舵机堵转、LDO 压差、欠压瞬态）。自定义元件在网表里写两遍：`*tb:` 注释行给我们读、等价 B 源给 ngspice 读；`.op` 加 `.nodeset`（ngspice 对 min/max 的 B 源从 0 V 起不收敛）。`tools/elec/compare.py` 比全部节点电压（瞬态比终止时刻的 1/4、1/2、1），本机 ngspice-47（brew）实测最大误差 0.039%（RC 充电 5 ms 处，隐式欧拉 vs ngspice 梯形法）
- 推进：板子模型 `board.rs` 固定 100 µs 一步，只走整步（余数留到下次），由 `Machine::run` 每次跑完一段后用这段的芯片活动推进。网页 worker 与 CLI 都是 1 ms 一片（CLI 接了 `--servo` 时也强制 1 ms 一片，同 `--inputs`），所以两边逐位相同（tools/webtest/elec.mjs：带 15 次欠压复位、中途切外接 5 V 的一次运行，命令行 `--inputs` 重放串口 21292 字节逐字节相同）
- 板子网络：节点 5V 轨 / 3V3 / 舵机红线 / 外接 5 V。参数与来源（未注明的都是**估算**，未经真机标定）：
  - USB 口：5.0 V，内阻 0.5 Ω（口内 0.1 + 1 m 线两根 28AWG 约 0.43 + 插头），限流 0.5 A（USB 2.0 规范值；真机口多数能给更多），超过限流后按 20 Ω 斜率掉压（限流开关恒流区的 PWL 近似）
  - 外接 5 V 2 A：5.0 V，内阻 0.15 Ω（适配器 + DC 母座 + 面包板电源轨），限流 2 A；舵机经杜邦线 0.15 Ω 接到它，地共用
  - 板载 LDO：SGM2212-3.3（ESP32-S3-DevKitC-1，乐鑫论坛工程师答复；C3-DevKitM-1 按同款，待核原理图）。数据手册：800 mA、压差 420 mV @ 800 mA → 调整管全开等效 0.525 Ω；限流值手册没给，取 1.2 A；输出电阻 0.01 Ω、静态 0.1 mA
  - 去耦：5V 轨 10 µF、3V3 轨 22 µF（开发板输入 / 输出电容 + 模组内电容）
  - 芯片电流（3V3）：S3 空闲 20 mA + 每个忙的核 12 mA，Wi-Fi 打开 +75 mA、发射 340 mA；C3 14 / 10 / 65 / 335 mA；复位按住 5 mA。量级取自 S3 / C3 数据手册功耗表（modem-sleep 数十 mA、802.11b 21 dBm 发射约 340 / 335 mA），"忙"= 执行指令数 / 周期数（WAITI / WFI 时为 0）；Wi-Fi 发射按每帧 0.6 ms 计（只有 C3 有 Wi-Fi 模型）
  - 板上其它 3V3：电源灯 2 mA + CP2102N 8 mA + 板载 WS2812 静态 1 mA；模块取 catalog 的 `currentMa.typ`（BME280 3.6 µA 数据手册值、SSD1306 10 mA 估算、GC9A01 25 mA 估算），CLI `--i2c` / `--spi` 挂上就加
  - 欠压：门限 S3 2.44 V、C3 2.51 V（IDF 5.5 `Kconfig.power` 默认档 ESP_BROWNOUT_DET_LVL_SEL_7，乐鑫标注"估计值"）。IDF 5.5 默认 `ESP_BROWNOUT_USE_INTR=n` → `brownout_hal_config` 开硬件复位（`rst_ena=1`、`rst_wait=0x3ff`），所以复位原因是 RTCWDT_BROWN_OUT_RESET（15）、ROM 打印 `rst:0xf (BROWNOUT_RST)`、`esp_reset_reason()` = ESP_RST_BROWNOUT（9），不经过 "Brownout detector was triggered" 的中断路径。去抖：0x3ff 个周期，计数时钟没在公开资料里查到，按约 8.75 MHz 估 0.12 ms。复位后芯片按住到 3V3 回到门限 + 0.05 V 才放开（这期间不执行指令、时间照走、引脚高阻、PWM 停）
- 舵机（`servo.rs`，SG90，全部估算）：比例控制器（误差 ≥ 10° 满电压，死区 0.9° ≈ 规格书 10 µs）+ 有刷电机 + 减速箱，折算到输出轴。R = 4.8 V / 0.7 A（catalog 堵转电流估算）= 6.86 Ω；k 由规格书 0.1 s/60° @ 4.8 V 与空载电流 0.15 A（catalog typ）反推 0.360 V·s/rad；η = 0.7 使堵转扭矩与规格书 1.8 kgf·cm 一致；J 按"起步约 25 ms 到全速"反推；机械限位 −8° / 188°；静态 6 mA；上电时角度按 90°。从电源取的电流 = 静态 + max(0, sign(vm)·i)（H 桥：回馈电流记 0）。单测：5 V 下 180° 约 0.3 s、过冲 0.2–6°、起步尖峰 ≈ 堵转电流、5° 小动作峰值 < 0.45 A、外力卡住时 = 堵转电流。舵机只影响电流和 3D 观感（`setServoAngle`），固件读到的东西一个不变
- 复现结论（P1-02，`board.rs` 场景单测 + CLI）：USB 0.5 A 限流下，舵机**从静止起步**（哪怕 0→180° 跳变、第 05 关的 0/45/90/135/180°、气象站开机 90→105.75°）起步电流约 0.6–0.7 A 超过限流，5V 轨只掉到约 3.05–3.6 V，LDO 进压差但 3V3 仍在 3.0–3.3 V，**不复位**（第 05 关参考固件 `check.py --servo 4 --power usb` 实测 5V 最低 3.462 V、3V3 最低 3.299 V、0 次复位）。只有**没到位就反向**（反接制动，电流 ≈ (V + 反电动势)/R，约 1.2 A）才把 5V 轨拉垮、3V3 掉到 1.5–2.1 V → 欠压复位。所以验收固件 `s3-brownout` 用 0↔180° 每 150 ms 换向；外接 5 V 时同一固件不复位（外接峰值 1.25 A，5V 轨 4.97 V）。气象站默认场景（23.5 ℃、舵机小幅）USB 下不复位，与"按物理估算"一致，如实记录
- 决定：CLI 默认 `--power usb`，但**不接舵机就没有舵机负载**（`--servo GPIO` 显式接），所以现有用例结果一字不变；关卡（levels.json）没有加 `--servo`，指纹不变（第 05 关带 `--servo 4` 跑出的指纹也相同，因为不复位）。理由：默认 ext 会让"只靠 USB"的坑在命令行里看不到；默认自动把 50 Hz 的脚当舵机又太魔法
- 决定：复位后补打 ROM 头三行（`ESP-ROM:esp32s3-20210327` / `Build:Mar 27 2021` / `rst:0x.. (名字),boot:0x8 (SPI_FAST_FLASH_BOOT)`，C3 用 20210207 / boot:0xc），所有复位（软件复位 0x3 / 0xc、欠压 0xf）都打，第一次上电不打（现有用例的串口不变）。网页 wasm 原来自己插的"[试板] 软件复位，重新上电"去掉，改由 `Machine::reboot` 统一写，网页与命令行串口逐字节相同
- 决定：`Machine` 从 enum 改成 `struct { hw: Hw, elec: Board }`（`Hw::C3 / Hw::S3`）：供电网络是外部世界，跨复位保留。顺带修了 C3 `reboot` 丢外接 I2C 器件 / WS2812 解码 / GPIO 记录的问题（与 S3 一致）
- 网页：worker tick 带 `elec`（5V / 3V3 / 舵机 / 外接节点电压、各路电流、3V3 最低、峰值电流、复位次数、是否按住、舵机角度、供电）和 `brownouts`（新出现的复位时刻）；供电快捷卡片 / 属性面板的 USB ↔ 外接 5 V 真正在线切换（worker `power` 消息 → 输入日志 `supply` 事件 → 脚本 `power=usb|ext`，回退时按原时刻重放）；时间线把欠压复位记成一步（0.5 s 内连着的合并、记次数）；万用表点针读电压（电源脚 = 节点电压；信号脚按逻辑电平 × 当时的 3V3；PWM 脚读平均值）。InputLog 加 `servo` / `power`（上电时的），`cliArgs` 拼出 `--servo N --power X`
- 不做 / 遗留：USB 口二极管、地线压降、LDO 动态响应、电机电感（τ ≈ 0.15 ms，比步长还短）、芯片在 1.8–2.4 V 之间的异常行为（flash 读错等）、低于约 1.8 V 应是上电复位而不是欠压复位；复位后我们跳过 ROM / 二级引导（真机约 0.3 s），所以 USB 下复位间隔只有约 11 ms，比真机密；去抖时钟、USB 限流斜率、舵机全部参数都要真机标定（P1 的"买零件做真机标定"）
## 2026-10-16 · 本地 npm 包 `tryboard`（P1-14）与暗色 / 手机只读（P1-15）
- 打包：`packages/tryboard/`（private，不发布）。`tools/build_npm.sh` 用 web/node_modules 里已有的 esbuild（vite 自带，不新增依赖）把 `src/cli.ts` 连同网页的 `checks.ts`（判定 + 指纹）、`simrun.ts`（运行循环）、`inputlog.ts` 打成一个 `dist/cli.mjs`，再 `npm pack`。判定只有网页一份，CLI 不另写
- 运行循环从 `verify-worker.ts` 抽到 `web/src/simrun.ts`（纯函数，无 DOM / Worker），网页验收与 npm 包共用；`imageChip` 也挪进去，assets.ts 转调
- 对拍时发现两处与原生 CLI 的分歧并修正：(1) wasm `tb_run` 在软件复位时往控制台插一行"[试板] 软件复位，重新上电"，原生只写 stderr——simrun 把它从串口输出里去掉（网页实时串口照旧显示）；(2) 原生崩溃重启最多 50 次就停，wasm 无上限——simrun 第 51 次复位就停。两处都让网页验收与 check.py 指纹在"固件崩溃重启"时也一致。另外 check.py 的 `from` 秒数改按 JS 写法（1.0 → 1），原生 CLI 重新上电失败时打印原因
- ROM：构建时从 `third_party/esp-rom-elfs` 拷两颗芯片的 ELF（esp32c3_rev3、esp32s3_rev0）进包，附 `LICENSE-esp-rom-elfs.txt`（Apache-2.0 全文）、`NOTICE.txt`（来源 release、README 版权行、ROM 第三方清单）；包目录的产物（dist / wasm / rom / levels.json / tgz）全部 .gitignore，仓库只有脚本（LICENSING 规则 1）
- `--ref` 不进 npm 包（不带参考固件）；`check` 支持 `--level` / `--all` / `--inputs`（脚本文本或 InputLog JSON），`run` 支持 `--seconds --i2c --env --spi --inputs --script --pwm-log`，串口到 stdout、观察记录与指纹到 stderr
- 网页命令提示改为 `npx tryboard check app.bin --level NN`，下面注明"本地包，尚未发布"并保留 `tools/check.py` 给仓库开发者
- 暗色：DESIGN §2 变量在 `:root[data-theme=dark]` 反转，另加 `--surface / --stage-bg / --on-accent` 等原来写死的颜色变量。`<head>` 内联一行脚本在首帧前按 localStorage `tb-theme` 或系统设置定 data-theme（不闪白）；`web/src/theme.ts` 负责切换按钮与系统切换跟随；3D 台面调 `setTheme`，成品场景换背景 / 桌面色。暗色下主按钮文字用深色（亮蓝底白字对比度不够）；零件缩略图垫浅底
- 手机只读：沿用已有的 ≤ 760px 堆叠断点（覆盖 ≤ 600px 的要求）；新增：组装 / 成品步骤隐藏空台面不占位、清单勾选不可改、时间线不再用 scrollIntoView（会把整页拽到底部）；成品锁着时手机上按默认装法预览 3D 成品（手机上没法上传固件，否则永远看不到成品），属性面板写明"手机只读预览"
- 替代：(a) CLI 直接 `node --experimental-strip-types` 跑网页 TS——要求 Node 23+ 且 import 要写扩展名；(b) 暗色用 `prefers-color-scheme` 媒体查询 + 选择器两套变量——要写两遍，改用首帧前内联脚本只写一遍
## 2026-10-16 · 走查修补：成品先看参考、蜂鸣器 3D、首页价格、舵机走线
- 成品页不再整页锁住：没装完（或检查点没全过、组装还锁着）时显示**参考成品**——参考装配 = 每个零件都装上、有装法选择的取正确的那种（`referenceAssembly(T)`，温漂 0），跑的是实验台上现在的那份固件（模拟不重启）。顶部琥珀色横条"参考成品 · 你还没装配"+ 原因（检查点 n/6 或组装 n/6），右栏首节同样说明，构建树装法分组叫"参考装法"，结论按钮"参考成品 · 还没装配"；下一步按钮在检查点没全过时是「去完成检查点 →」（选中第一个没过的检查点），全过后是「去组装 →」。真正装完以后照旧用自己的装法（温漂、复测结果）
  - 理由：先看到成品长什么样才有动力去做检查点；参考装法本身就是正确答案，不泄露验收（验收看的是自己的固件）
  - 替代：(a) 保持锁住只放截图——看不到真实固件驱动的成品；(b) 用参考固件跑成品——会和实验台的模拟分叉成两份，违背"整页一份模拟"
- 3D 无源蜂鸣器模块：蓝色 PCB 15 × 22、Φ12 × 8.5 黑色蜂鸣器、TO-92 三极管、VCC I/O GND 丝印、直排针朝上，平放在面包板前面的桌上（靠 I/O 针），三根杜邦线（母头插排针）接 3V3 / GPIOn / GND；占空比在 0..1 之间（有方波）时振膜轻微起伏、冒两道蓝色声波弧（示意）。`wiresOf` 加蜂鸣器三根线（id 与 3D 一致）
- 舵机挪到信号针与 5V 针中间的正前方，跳线拱高降到面包板面 + 13–19 mm 并往前弓：原来从面包板右前方拱过开发板，默认机位下挡住 BOOT 键和 BME280。C3 舵机示例去掉写死的机位，改按包围盒取景
- 零件"中心"（`project()` / 尺子 / 卡片定位）取看得见的本体包围盒，不算拾取盒、金针和接触阴影；竖插模组的针脚拾取盒从 0..5.5 mm 降到 0..4 mm：原来点 BME280 中心选中的是它的 GND 针
- 首页卡片的"要买"和参考价从元件库算（`templatePicks` 默认勾选 + `bomTotal`，与采购页合计同一口径，bom.test.ts 对拍），去掉写死数字；零件显示名统一用 `wiring.ts` 的 `PART_LABEL`（舵机、蜂鸣器、圆屏……）
- 验收脚本：accept.sh 判 levels / replay / interact 时改为必须看到汇总行（`[x] PASS（…`）。原来只看最后一行有没有 PASS，levels.mjs 在 07-spin 点构建树时偶发 "Node is detached" 崩掉，最后一行恰好是"检查点 06 PASS"，于是把崩溃和后面 3 项失败都盖住了。levels.mjs 点检查点改为节点被重画时重找再点；"做这个 → 检查点数一致"一项改为落地采购页后切到实验台再看结论按钮（采购页的结论按钮早已改成清单提醒，这项一直是失败的）
## 2026-10-16 · 逻辑分析仪事件缓冲（P1-05）与 ⌘K 命令框（P1-06）
- 决定：内核里加一个有上限的事件环形缓冲（`core/crates/esp32c3/src/iotrace.rs`，C3 / S3 的 SocBus 各一份，软件复位时搬到新总线）。每条 16 字节小端：`t u64（CPU 周期）| kind u8 | a u8 | b u16 | v u32`。kind：1 GPIO（a 引脚，b 电平）、2 PWM（a 引脚，b 占空比 × 65535，v 频率毫赫，0 = 不再输出）、3 WS2812 帧（a 引脚，b 灯珠数，v 第一颗 0xRRGGBB）、10 I2C 起始（b 位 2 = 重复起始，v = 一个 SCL 位的周期数）、11 地址（a 7 位地址，b 位 0 读 / 位 1 NACK）、12 数据字节（同上，位 0 = 方向）、13 停止；b 位 15 = I2C1
- 上限：内核 65536 条（1 MB），满了丢最老的并计数（`tb_io_dropped`）；网页 worker 每批时间片（≤ 20 ms）取走一次，正常用不满。网页主线程仓库 40 万条，满了丢最老的一半、按剩下的重建通道（分析仪把丢掉的那段画灰）
- 只有 GPIO 受"观察"掩码限制（`tb_io_watch` / `--trace-pins`）：固件逐位翻转的脚每秒可达百万次变化，全记会塞满缓冲；PWM、WS2812、I2C 变化本来就少，总是记。网页默认观察台面上接了东西的脚 + BOOT，掩码在上电前发给 worker，所以从第 0 个周期起就按它记
- I2C 事件来自主机模型的事务层（执行命令表时），时刻 = 事务开始 + 已过的 SCL 位数 × 每位周期（与完成中断同一套算法），不逐 SCL 边沿；所以 I2C 事件会比记录它的那一刻"晚"（预先盖戳），对拍按记录先后比前 N 条。PWM 在 SocBus::update 里按"LEDC 修改计数 / GPIO 使能与矩阵改过"重新扫各引脚，没变不记
- 所有字段都是整数（占空比 1/65535、频率毫赫），文本格式（`IoEvent::line` / `iotrace.ts eventLine`）两边逐字相同，没有浮点格式化差异。CLI `--trace-io` 强制 1 ms 一片（与网页 worker 相同），网页事件 = CLI 重放的前 N 条（traceio.mjs）
- 性能（CLI，模拟 60 s 墙钟，三次）：weather 主干 0.90 s / 本分支只记不导出 0.88 s / 导出全部 0.91 s；fade（LEDC 硬件渐变，约 5000 条 PWM 事件 / 秒）0.07–0.12 s / 0.09 s / 0.17 s——只记不导出看不出差别，导出成文本约 0.3 µs / 条；网页 weather 实时倍速分析仪开 / 关都是 1.00×
- 分析仪画法：canvas 2D，只画可视窗口（各通道二分查找起点）；I2C 的 SCL / SDA 按事务和位时序重建（位宽 ≥ 1.2 px 画位级波形 + 每字节泡泡 + 整句，缩小时事务画成活动块，挨得近的并成"n 个事务 · 0x76 ×1 · 0x3C ×2"）；PWM 一个周期 ≥ 3 px 画方波（相位从占空比生效时刻起算，示意），否则画包络 + 平均电平虚线 + "50 Hz · 1.675 ms"；占空比 0 / 100% 画直线。寄存器注释只做 BME280（0x76/0x77）和 SSD1306（0x3C/0x3D）
- ⌘K：顶部输入框 + 下拉；全局 ⌘K / Ctrl+K 在焦点处于别的输入框（input / textarea / select / contenteditable）时不拦截。命令里改状态的走现有通道（`hist.op` + `session.setEnv / setPower / reboot`、`hist.seek`），所以时间线照常记步、回退照常可用。量 3V3 先选中 3V3 针并提示"万用表在 P1-04 中"。最近命令存 `localStorage['tryboard-cmdk-recent']`（6 条）
- 公共接口：wasm 新增 `tb_io_watch / tb_io_take / tb_io_ptr / tb_io_dropped`；Machine 新增 `io_watch / io_cap / io_take / io_dropped`，导出 `IoEvent`；CLI 新增 `--trace-io` / `--trace-pins`；worker 新增 `ioWatch` 入、`io` 出消息；LiveSim 加 `onIo` / `watchIo`；Session 加 `io / onIo / ioPins / watchIo`；外壳去掉 ⌘K 占位（shell.ts），由 `cmdk.ts` 接；`__tbApp.analyzer`、`__tbApp.cmdk` 测试钩子
- 替代：(a) worker 每个时间片采样引脚（现有 PinTrace 做法）——1 ms 分辨率看不到 I2C 字节和 PWM 边沿；(b) 逐 SCL 边沿模拟 I2C——要改 I2C 模型的执行方式，且对驱动没有可见差别；(c) 事件用 JSON 传——每条几十字节，400 kHz I2C 一秒上万条
## 2026-10-16 · 小黄 / 透镜小人拆检查点（P1-11）
- 原则"每过一个检查点作品就多一样东西"。小黄：spin-1 画脸（圆屏 + 静态脸）→ spin-2 转身（+ 舵机 ±60° 往复）→ 07-spin 合体（+ 眼珠跟随、BOOT 回头、装配）。透镜：lens-1 眼睛 + 眨眼 → lens-2 按键换表情（normal ↔ happy）→ 07-lens 合体（四种表情循环、装配）。合体直接用第 07 关的变体，不另起 `spin-3`：毕业作品与作品最后一关是同一份条件，参考固件也是同一份（spin / lens）
- 新检查点放 levels.json 顶层、带 `"work"` 字段，id 用 `spin-1` 这种（check.py `--level spin-1`），不嵌进 variants：CLI / 网页的展开逻辑、build_web.sh 复制参考固件都不用改。旧关卡页已重定向到工作台，顶层多几条不影响
- 只看串口和"非黑像素"判不出"画的是不是脸、眼睛在哪"，所以观察记录加颜色统计（前 12 种颜色的像素数 + 重心），新判定 `lcd_colors`（颜色 ±24、像素数上下限、水平重心范围）和 `serial_count`。重心判"眼睛对称 / 回正"，上下限判"开心弯眼比睁眼少"，心形眼颜色判"切到了 love"。只看最后一帧，所以每个检查点的输入脚本都让结束时刻落在确定的画面上（按键后、眨眼间隙）。代价：所有带圆屏的关卡指纹变了（CLI 与网页同算，对拍不受影响）
- 07-spin 加 EYE R / EYE L 串口约定判眼珠跟随（只有最后一帧，看不出运动过程）；07-lens 改成 6 次按键转一圈回到 normal 再到 love，`serial_count` 判 MOOD 0 normal / MOOD 2 love 各 ≥ 2 次
- 任务书按 BRIEF_TRIALS 的经验写：坐标、尺寸、颜色值、反色 + BGR、"上电不要先等待"、开 PWM 时就是起点脉宽、消抖上限、按键最短间隔都写进去。自测：只按任务书另写了一份逐像素函数渲染的固件（不用 round_lcd.h），6 关里 4 关第一次过；07-spin 第一次挂在自测代码自己的眼珠逻辑错误；lens-1 第一次挂在"逐像素整屏重画一帧约 150 ms，一次眨眼拖到 1.2 s，4.5 s 内没出 BLINK 1"——把窗口放宽到 5.5 s，并在任务书里写明"整屏重画别超过 100 ms"，第二次过（记录在 Reviews/ab/P1-11.md，自测工程未提交）
- 替代：(a) 用 `--lcd-ppm` 对整帧做模板比对——太严，自己写的画法略有不同就挂；(b) 在固件串口里报颜色 / 坐标——判的是固件自述，不是屏上真画了什么

## 2026-10-16 · C3 接 SPI2 / GDMA 圆屏（P1-13）
- C3 复用 S3 的 `gpspi.rs` / `gdma.rs`，差异参数化：`GdmaLayout` 加通道组起点、组内 LINK / PERI_SEL / EOF 描述符 / FIFO 状态偏移、复位值，以及"中断寄存器按方向放在组内（S3）还是集中在 0x00 起、IN / OUT 共用（C3）"；C3 共用寄存器的位与按方向存的位之间用一张映射表换算
- C3 圆屏接线：SCLK=6、MOSI=7、CS=10 用 SPI2 的 IO_MUX 直连脚；DC=5、RST=4、背光=3 选 DevKitM-1 排针上空闲、又不是 strapping 的脚（2、8、9 是 strapping，8 还接着板载 RGB）。`firmware/common/round_lcd.h` 按 `CONFIG_IDF_TARGET_ESP32C3` 选引脚，也允许 include 前 `#define` 覆盖；board3d 的圆屏连线按芯片取 `LCD_WIRING`
- C3 的 `spi_ll_clear_int_stat` 是直接写 `dma_int_raw.trans_done = 0`（S3 写 INT_CLR），不支持写 RAW 时 trans_done 一直是 1，第二次传输前断言 `spi_ll_get_running_cmd(hw) == 0` 失败。模型改成写 RAW 即覆盖（S3 不写 RAW，不受影响）
- crypto_hw 的 AES / SHA DMA：链表头改从 GDMA 模型取（`channel_for_peri` + `configured_link`），不再自己按寄存器地址读 `regs`。搬数据没改用 `Gdma::take_out / put_in`：IDF 的加速器驱动先配链表再置 start、再启动加速器，时序上 start 不一定先于触发，`take_out` 只认已启动的通道；要完全改用得给 GDMA 加"按配置的链表取数据"的入口，留作以后

## 2026-10-16 · 开发板库与版本差异规则（P1-12）
- 开发板从 6 块到 9 块：新增 M5Stack AtomS3、微雪 ESP32-S3-LCD-1.28（无触摸）、微雪 ESP32-S3-Touch-LCD-1.28；合宙 ESP32-S3 核心板、XIAO ESP32S3 / C3 补齐引脚、板载外设、strapping、USB、PSRAM 与来源。每块板数据记来源 URL（`board.urls`），查不到或资料互相矛盾的字段标待核（清单见 Reviews/ab/P1-12.md）
- schema 加 `urls`、`builtin`（板载外设及占用的脚）、`lcd`（板载屏接线）字段；`onboard.share` 表示可与外接件共用的总线（I2C 这类），屏 / IMU / 触摸的线是独占的
- 规则 R28–R32：排针上的 strapping 脚、板上已有又外接一份、要 PSRAM 但板子没有、GPIO 不够、板载屏引脚和固件不符；R24 改为屏 / IMU / 触摸独占线被外接件占用时判阻断。每条有正反用例（web/test/rules.test.ts）
- 换到板上已经带了的件（如微雪圆屏板 + 外接圆屏），模版的必选件降为建议件，由 R29 提示去掉，而不是硬塞两块屏
- 替代：板子特有的坑写成每块板一条专用规则——条数随板子线性增长；现在按"板载外设占线 / strapping / 资源不够"几类通用规则读板子数据

## 2026-10-16 · 外部模型管线（P1-09）与小黄 / 透镜 3D 成品（P1-10）
- 决定：STEP → glb 转换用 **occt-import-js 0.0.23**（OpenCascade 的 wasm 版，**LGPL-2.1**）+ **glTF-Transform 4.5.1**（MIT）+ **meshoptimizer 1.3.0**（MIT），全部是 `tools/models/package.json` 的构建期依赖（node_modules 在 tools/models 下、不进 git），**不进网站**，网页运行期没有新依赖（GLTFLoader 是 three 自带，按需拆成单独的 45 kB 块，只有开了外部模型才加载）
  - 理由：本机没有 FreeCAD / cadquery；occt-import-js 装完 tools/models 共 38 MB，node 里直接跑，能读出 B-rep 面颜色。LGPL 只约束这个库本身，我们不分发它
  - 替代：FreeCAD 命令行（> 1 GB）、cadquery / OCP（pip 包 > 500 MB）、Blender（本机有，但 4.x 不再自带 STEP / VRML 导入）、KiCad 的 WRL（顶点多、单位是 0.1 inch）
- 决定：素材放 `assets/models/<名字>/`：`<名字>.glb`（进 git，脚本强制 ≤ 1 MB）、`SOURCES.md`（由 convert.mjs 按 models.json 生成：原始文件 URL、仓库 @ 40 位提交、作者、许可证、是否修改、改动清单、署名）、`LICENSE` / `LICENSE.md`（从同一提交下载的原文）；原始 STEP 在 `src/`（.gitignore）。`web/vite.config.ts` 的 tb-models 插件在开发时直接读、构建时把 glb + SOURCES.md + LICENSE 发布到 `models/<名字>/`，CC BY-SA 模型因此连同许可与来源都可下载。LICENSING_REVIEW 原建议的 `web/public/models/kicad/` 改成这个目录，是为了让原始文件、生成脚本和产物待在一起
- 决定：fetch.mjs 只认 LICENSING ✅ 的三个仓库（KiCad 官方 3D 库、Adafruit CAD Parts、M5Stack M5_Hardware）、必须钉 40 位提交；KiCad 模型所在库目录里如果有单独的 LICENSE 文件就失败退出（LICENSING_REVIEW 第一节的剩余风险）
- 首批 3 个模型：KiCad `USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal`（CC BY-SA 4.0，开发板 USB-C 口）、KiCad `Buzzer_12x9.5RM7.6`（CC BY-SA 4.0，蜂鸣器模块上的蜂鸣器本体）、Adafruit `1143 Micro Servo`（MIT，与 SG90 同外形的 9 g 舵机，实验台和小黄转台）。改动：三角化、Z 朝上转 Y 朝上（单位 mm）、减面到约 50% 顶点、同材质合并、量化（KHR_mesh_quantization）；KiCad 的金属灰（#A5A392）统一成网站的不锈钢色 #CDD1D6（实验台低环境光下原色发暗发绿）；Adafruit 舵机原文件没有颜色，按 SG90 涂蓝 / 白。三个原文件都没有 logo、商标图形或贴图（脚本仍会清掉任何贴图）。三个都算"已修改"，CC BY-SA 的两个在 SOURCES.md 写明以 CC BY-SA 4.0 提供
  - 没做 M5Stack：M5_Hardware 的结构件都是整机外壳，当前作品用不上；Adafruit 6178 圆屏是 EYESPI + microSD 的板子，和实验台用的带排针 GC9A01 模组不同，没用
- 决定：程序生成始终是默认兜底。外部模型开关 = URL `?models=ext|proc`（只管这一次）> `localStorage['tb-ext-models']`（实验台工具条「外部模型」按钮）；board3d 每个替换位（ExtSlot）登记"程序生成件 + 摆位函数"，开了就懒加载 glb、藏起程序生成件，关了换回来，加载失败保持程序生成。舵盘仍是程序生成的（Adafruit 模型没有舵盘），只按花键顶抬高。测试钩子 `window.__tbExt.shown()` 列出此刻场景里实际显示的外部模型
- 授权页：gen_licenses.mjs 第 6 节改为模型表（名称、许可证、作者、是否修改、glb / SOURCES / LICENSE 下载链接）+ 每个模型的署名原文 + 转换工具说明 + 每种许可全文一次
- 决定（P1-10）：小黄 / 透镜成品改成 three.js（`app/lcd3d.ts`，和气象站一样独立于 board3d，同一个 LiveSim、同一套 BOOT / 声音 / 拖动 / 复位视角）；`lcdproducts.ts` 的 SVG 留作 WebGL 不可用时的兜底（`webglOk()`），首页卡片和组装视图仍用 SVG
  - 小黄的形象：黄色胶囊身体（Ø40 mm，身高约 115 mm，比装配模版写的 110 mm 估算略高）、头顶一缕向前卷一圈半的发丝（越往发梢越细）、**正面一块圆角方形的深色面罩**（只在正面，不绕到脑后，没有护目镜和带子）里嵌 GC9A01 圆屏、棕色工具腰带（侧面搭扣、两个工具袋、一把起子、一把扳手）。刻意不做：护目镜、头带、背带裤、手臂手套——避免像小黄人。圆屏网格按面罩半径弯成曲面（真屏是平的，外壳罩着；示意）
  - 转台：SG90 立在 Ø60 mm 底座里，转轴对准中心，托盘 + 小黄随 GPIO4 的 PWM 转（二阶弹簧阻尼 + 600°/s 限速，与气象站指针同一套示意参数），装偏的舵盘（assembly effects.hornOffset）让"正面"本身歪着。开了外部模型时 SG90 换成 Adafruit 1143
  - 透镜：Ø40 mm 平凸透镜（中心厚 9 mm），`MeshPhysicalMaterial` transmission 1 / ior 1.5 / roughness 0；放大感靠 `thickness`（three 的屏幕空间折射近似，偏移量 ∝ thickness），按装法的放大倍数设 `(k − 1) × 3`（高档 1.35× → 1.05，低档 1.08× → 0.24），三根细柱长度 = 离屏高度。标"透镜折射为示意，不是光学仿真"。底座背面 USB-C 口开了外部模型时用 KiCad 模型
  - 色调映射：lcd3d 用 NeutralToneMapping（ACES 把小黄的黄压得发绿发灰，截图实测）；气象站不变
  - 串口事件：`MOOD n name` → 时间线"换表情：开心"、`LOOK FRONT / AROUND` → "转回正面，停住 / 继续左右转身"；右栏加 转台角度、状态、表情、透镜档位。测试钩子 `window.__tbProduct`（buttonPos / azimuth / turn / ext / mood / look）
  - 替代：在 board3d 里拼成品（另有代理在改 board3d，相机和交互都不同）；透镜用真实光线追踪 / 自写折射着色器（工作量大，transmission 已经够"看出放大"）

## 2026-10-16 · 合并 main（P1-05 / P1-11–15）进电气分支（P1-01–04）
- `Machine` 已是 `{hw, elec}`：main 的 `io_*`、C3 `lcd()` / `spi_stats()` 改成按 `self.hw` 匹配；C3 接圆屏也把 GC9A01 电流记进供电网络（与 S3 一致）。C3 `reboot` 同时保留外接 I2C / WS2812 / GPIO 记录（电气分支）、`iotrace.carry()` 与 `lcd.take()`（main）
- CLI：`--trace-io` / `--trace-pins` 与 `--power` / `--servo` / `--elec-report` 并存；接了舵机或带 `--trace-io` 都 1 ms 一片；欠压复位与软件复位分开提示，重新上电失败打印原因
- 复位计数：电气分支已去掉 wasm 往串口插的"[试板] 软件复位，重新上电"（改为 `Machine::reboot` 补打 ROM 头 `rst:0x..`，CLI 与网页逐字节相同），main 的 simrun 靠这行数复位、做"最多 50 次"。改为 wasm 新增 `tb_reset_limit(n)` / `tb_reset_count()`：simrun 设 50，第 51 次复位 `tb_run` 返回 3、停在复位前不再上电（与 CLI `resets > 50 → break` 同一周期、同一串口）；网页实时页不设上限，行为不变。替代：在 simrun 里数 `rst:0x` 行——固件自己也可能打印这串，不可靠
- simrun（网页验收 + npm 包共用）加 `servo` / `power` 与脚本动作 `power=`；npm 包 `check` / `run` 加 `--servo` / `--power`（与 check.py 一样叠加在关卡参数上；InputLog 里的 servo 字段两边都不读，只转事件）
- 行为：关卡都不带 `--servo`，所以 CLI、网页验收、npm 包三方指纹与合并前 main 相同（npm_parity 全一致）；只有实验台实时运行按台面接线接舵机、走供电网络。worker `boot` 同时带 `servo` / `power` 与逻辑分析仪 `ioWatch`，tick 同时带 `elec` / `brownouts`，`io` 消息照旧
- accept.sh：levels / replay / elec / interact / traceio 一律要求最后一行是汇总行 `[x] PASS（`，否则记"脚本没跑完"
- ⌘K "量 3V3" 的提示改为指向工具条万用表（P1-04 已有）

## 2026-10-16 · 3D 装配（P1-07）与参数化外壳 + STL / 3MF 导出（P1-08）
- 依赖（LICENSING.md ✅ 列表里的两项，网页侧第一次引入第三方运行时库，均懒加载，不进首包）：
  - `manifold-3d` **3.2.1**（Apache-2.0，2025-08-06 发布）：外壳布尔运算。`manifold.wasm` 476 KB + JS 43 KB（dist 里另有一份 77 KB 的 manifold.js 原样副本：emscripten 的 node 分支用 `new URL(…, import.meta.url)` 指它，vite 照样发出，浏览器从不请求），只在组装步骤建 3D 视图、采购页点"导出"时下载。没选最新 3.5.x：3.3.0 起 npm 包把 CLI 的依赖（gltf-transform、sharp 原生库、esbuild-wasm 等十几个）写进了 `dependencies`，`npm install` 会拉几十 MB；3.2.1 零依赖，API 相同。包里没有 NOTICE 文件，licenses.html 由 gen_licenses.mjs 自动列出（附 LICENSE 全文）
  - `three-mesh-bvh` **0.9.15**（MIT，2026-09-09 发布，peer three ≥ 0.159）：外壳网格建 BVH，拖动落点、尺子取点的射线走 `acceleratedRaycast`（只挂在外壳网格上，不改全局 `Mesh.prototype.raycast`）。进 asm3d 懒加载块
  - vite 打包没问题（`new URL('manifold.wasm', import.meta.url)` 之外再显式 `?url` 导入、`locateFile` 指过去），没用上"自己写简单 CSG"的退路
- 包体积：首包 app 块 169 → 193 KB（+24 KB：外壳布局 / 导出器 / 采购页外壳详情），共享块（three 等）652 → 682 KB（+30 KB：3D 装配用到的 three 类被打进共享块）；懒加载：asm3d 63 KB、Manifold 43 KB + wasm 476 KB、STLLoader 3 KB、3MFLoader 19 KB（自带 fflate）。wasm 内核首包未变
- 外壳布局是纯函数（`web/src/app/enclosure.ts`，node --test 直接跑，Manifold 模块实例作参数传入），按作品模版 + 清单里零件的尺寸（元件库 `sizeMm`，没有的用常见规格并标"估算"）算槽位、开孔、定位柱与警告；参数 = 高度 / 壁厚 / 圆角（圆壳没有圆角），存 `localStorage['tryboard-app-case:<work>']`，进 store 的 `caseParams`
  - 气象站：50 × 70 方壳（与成品 3D 一致），后壳 + 前面板（顶盖带 2 mm 止口）。开发板贴左墙（USB 口朝下、背面开孔），舵机挂在前面板下、开发板右侧（轴孔对准舵机轴），OLED 在舵机耳朵下方（窗 22 × 11.5 mm），BME280 两个位置：A 右墙通风槽旁的立柱上（底面另开 3 个通气孔）、B 趴在模组屏蔽罩上。默认高 32 mm、壁厚 2：内腔 28 mm ≥ 舵机 31 − 轴伸出 4 = 27 mm（与模版"内腔用了 27 / 32 mm"一致）；低于 31 mm 出"太矮"警告并给最低高度
  - 小黄：Ø60 底座（舵机仓开在顶板）+ 身体（圆柱 + 压扁的球顶，开圆屏窗 Ø34、舵盘座与中心排线孔）；开发板竖放在身体里，顶端躲不开球顶就警告
  - 透镜小人：Ø50 底座（圆屏台阶离顶 4 mm）+ 屏幕外框（底沿压屏、两档卡扣差 8 mm）。默认清单的 DevKitC-1（63 × 26，尺寸待核）平放进不了 Ø46 内腔，默认就会出警告：加高到 ≥ 73 mm 改竖放，或换 XIAO S3。这是真实的选型风险，保留警告，不为了"默认无警告"改数据
  - 只算零件与外壳的包围关系，不做零件之间的干涉检测；壁厚、间隙、止口、立柱都是示意尺寸，未经打印验证
- 导出：二进制 STL（两个零件放在同一个文件里）、3MF（自己打的 zip，只存储不压缩，CRC32 + 本地头 + 中央目录；`[Content_Types].xml` + `_rels/.rels` + `3D/3dmodel.model`，单位 mm，两个 object）。导出前按打印朝向摆：底壳外底面贴床，顶盖翻过来贴床放旁边（小黄身体是球顶，正着放）。下载前在页面里用 three.js 自带的 STLLoader / 3MFLoader 读回一遍，三角形数对不上就标红。`npm test`（enclosure.test.ts）在 node 里跑真 Manifold：每条边恰好两个三角形（封闭流形）、STLLoader 读回三角形数 / 包围盒、3MF 解压后顶点 / 三角形数；3MFLoader 要 DOMParser，放到网页测试（asm3d.mjs）里读回
- 3D 装配：`web/src/app/asm3d.ts`，与成品一样铺满台面区域。外壳网格来自参数化外壳（与导出的同一份），零件是按尺寸搭的简单体（盒子 / 圆柱 / 球冠）。没装的零件按缩放后宽度在外壳后上方排一排（最大边缩到 26 mm）；拖动时在外壳顶上方 8 mm 的水平面上走，离下一件的槽位中心 16 mm 内就吸过去（BME280 两个槽位都发亮，吸到哪个算哪个），松手在外壳范围内但没吸到：有位置差别的取最近槽位，否则照常装（顺序错照样被拦）。舵盘中位 / 透镜档位这类"同一位置、不同装法"仍是放下后弹选择按钮（3D 里浮在槽位上，右栏也有）
  - 规则只有一份：状态与 place / reset 抽到 `views/asmcore.ts`，SVG 视图（`views/assembly.ts`）和 3D 视图都用它；装法影响、检查、温漂仍在 templates.ts。store 的 `assembly` 结构不变，成品步骤、开机复测照旧
  - 工具：炸开（每层往上拉 16 mm，缓动）、剖面（clippingPlanes 裁掉靠近相机的半边，切口用"只画背面、涂橙色"的办法当截面）、尺子（BME280 到芯片的直线距离 + 在外壳表面点两点量距离，BVH 射线）、复位视角
  - 外壳参数或清单变了，回到组装时丢掉旧视图重建，再按时间线重放（和回退同一套确定性重算）
  - 兜底：没有 WebGL2、Manifold 加载失败、或 URL 带 `?asm=svg` 时用原来的 SVG 视图（尺子仍只有气象站）
- 测试：`tools/webtest/asm3d.mjs`（进 accept.sh）用真实鼠标（puppeteer mouse down / move / up）拖到槽位，零件飞回托盘时等它停稳再按；检查点进度用 localStorage 预置（与"自己的固件通过"同一份存储，验收本身在 levels.mjs 测）。levels.mjs 里的装配用例测的是旧实验台 index.html 的 SVG 视图，不受影响，没改
- 替代：(a) three-bvh-csg 做布尔——实时预览快，但不保证流形，导出给切片软件可能破面；(b) JSCAD——体积大、API 偏脚本；(c) 3MF 用 fflate 压缩——three 自带的 fflate 只在 examples 里，引进来等于多一个依赖，而 3 个文件存储不压缩只多几十 KB；(d) 用物理引擎做吸附——只要"离槽位多近"，距离判断就够
## 2026-10-16 · S3 Wi-Fi（P2-08）：MAC 模型移到 tryboard-soc
- 决定：Wi-Fi 整个模块（MAC 行为模型、虚拟世界、局域网 / TCP、WPA2、密码学原语）从 `tryboard-esp32c3` 移到 `tryboard-soc`（此前是空 crate），`tryboard_esp32c3::wifi` 保留为再导出。MAC 不再写成 `impl SocBus`，而是独立的 `WifiMac`，内存经 `tryboard_soc::Mem`；GDMA 的 `DmaMem` 改为它的别名（多了 `wr8`）
  - 理由：S3 与 C3 的 Wi-Fi MAC 是同一代硬件（寄存器、描述符、接收元数据头、中断源都相同，S3 固件实跑验证），只需一份模型；放进 soc 让 S3 不必为 Wi-Fi 再借 C3 的 SocBus 内部
  - 替代：留在 esp32c3 里按布局参数化（像 RMT / GDMA 那样）——改动更小，但 MAC 与 C3 SocBus 的字段（regs、now、mem_read）耦合，S3 用不了；新建 tryboard-wifi crate——soc 本来就是"公共件"的位置，没必要多一个
- 决定：`WifiLayout` 目前只区分射频轮询表（`rf_polls`）；C3 / S3 两份表内容相同。S3 特有的两处放在 S3 SoC 侧而不是 Wi-Fi 模型里：WDEV_RND_REG（0x6003507C，虽然落在 MAC 地址范围）与 SENS 温度传感器 READY（libphy 校准时读温度）——它们是芯片外设，不是 MAC
- 决定：SHA / AES 加速器（`crypto_hw.rs`）改成不依赖 SoC：寄存器写前 SoC 从自己的 GDMA 取链头，再把加速器临时取出、借总线 DMA。S3 直接复用（地址与 GDMA 外设号相同）。替代：S3 另写一份——重复
- 决定：MAC 的密钥表（0x60033814 有效位图、0x60034400 起 32 槽）写入时在 `WifiMac` 里另存副本，同时照旧存进通用寄存器表（读回、unimpl 计数不变）。理由：模型不再能直接看 SocBus.regs
- 决定：S3 Wi-Fi 帧计数进供电网络（`Machine::wifi_frames` 以前对 S3 恒为 0），发射电流用已有的 S3 参数 340 mA（数据手册 802.11b 1 Mbps 21 dBm）
- 决定：S3 验收固件 `firmware/s3-wifi-{init,scan,connect,http,wpa2}` 直接编 C3 版的 main.c（CMake SRCS 指过去），sdkconfig 只有目标与 16MB flash，默认双核；accept 用例与 C3 版期望文本逐条相同。没做 s3-wifi-wpa2-bad（与 C3 共享同一 AP 逻辑，错口令路径已由 C3 用例覆盖）
- CLI：`--wifi-log` 改为机器级（C3 / S3 都能打空中日志）；新增 `--unimpl N` 列前 N 个未建模寄存器（默认 12）
## 2026-10-16 · P2-07 LVGL 基准与 S3 内核提速
- 组件：`lvgl/lvgl` 9.2.2 + `espressif/esp_lvgl_port` 2.6.0（esp_lvgl_port 2.x 支持 LVGL 8 / 9，选 v9 稳定版）。许可证核对后写进 LICENSING（MIT / Apache-2.0，非乐鑫修改版 MIT）。替代：LVGL 8.4（API 旧、新项目少用）；自己写 LVGL 移植层（esp_lvgl_port 是乐鑫推荐的标准写法，用户固件大多就是这样）
- 基准界面故意选"整屏都在动"的压力场景（绕圈弧线让每帧失效区几乎覆盖整屏），帧数用 `LV_EVENT_RENDER_READY` 计、按 esp_timer 的模拟时间每秒打印；CPU 保持 IDF 默认 160MHz（模拟器 CPU 时钟固定 160MHz）。替代：局部刷新的界面（帧率和速度都会好看很多，但掩盖最坏情况）
- 真机参考量级：240×240×16 位一帧 921600 位，SPI 40MHz 纯传输 23ms → 上限约 43 FPS；LVGL 渲染与 DMA 发送重叠时整屏刷新常见 20–30 FPS（LVGL 官方 ESP32 文章的传输 / 渲染时间算法）。模拟得 33–34 FPS，同量级；模拟 CPI=1 偏快
- 提速只做"结果逐字节不变"的改动（验收用例 stdout / stderr / 屏幕 ppm 与关卡指纹前后对拍）：CCOMPARE 下次触发时刻缓存（tick_timers 从每条指令三次取模比较变成一次比较）、窗口溢出检查先看 WOE/EXCM 和"上方 3 个四元组是否空"再算 max_quad、取指 64KB 页缓存、SRAM 读写内联、`Cpu::run_batch` 批量执行。主要收益来自前三项；数据读页缓存（flash 常量）实测 <1%，没留
- 未做：预解码 / 指令块缓存（宿主每条模拟指令仍约 190 条指令，大头是逐条解释的固定开销；要再快 2× 需要块缓存或 JIT，工作量大、风险高，留给以后）。改 CPI 模型会改变所有时序与指纹，不在本项做
- 结论：LVGL 能跑、动画与帧率在模拟时间里正确；整屏满负荷动画在网页上只有约 0.2–0.4× 实时（未达 0.5× 目标），在 STATUS 标"速度不够实时"；局部刷新 / 静态界面不受影响

## 2026-10-16 · PCNT、RMT 接收、编码器与 HC-SR04（P2-01 / P2-04 / P2-05）
- 决定：带精确时刻波形的外接器件（编码器、HC-SR04）放进 SoC（`devices/pins.rs` 的 `PinDevices`），由 `poll(now)` 给出"何时把哪个脚驱动成什么"，SoC 按时刻施加、并把下一次时刻并进 `next_event`。理由：Echo 宽度要精确到 µs、正交相位间隔 0.5 ms，只在 1 ms 时间片之间施加做不到；放进 SoC 后 CLI / 网页 / 回退重放走同一套时刻，逐周期一致（实测网页导出日志 → CLI 串口逐字节相同）。替代：在 Machine 层把一次转动拆成多次 `gpio_drive` 并缩短时间片——片长会随交互变化，S3 双核交替点跟着变，重放不一致
- 外部输入的粒度是"动作"：`enc=+N`（转 N 格，器件自己排出 4N 个沿）、`encsw=1|0`、`dist=厘米`。网页拖旋钮一次手势可能发多条 `enc`，都进输入日志；`dist` 施加前取整到 0.01 cm（导出两位小数，重放才一致），网页侧又按 0.1 cm 取整、拖动中每 60 ms 最多报一次，免得日志被拖动刷屏
- 编码器：每格一个完整正交周期（EC11 20 格 / 圈常见款），沿间隔 0.5 ms；不模拟触点抖动（机械抖动没有可靠参数，模拟出来也只是随机数；PCNT 的毛刺滤波照样建模，固件开了滤波也不会出错）。按键松开为悬空（KY-040 的 SW 多数没焊上拉），固件要开内部上拉。替代：抖动做成可选参数，等真机标定
- HC-SR04：Trig 下降沿后 250 µs（8 个 40 kHz 脉冲 200 µs + 余量，规格书没给，取常见实测量级）拉高 Echo，宽 = 2 × 距离 / 343 m/s；声速固定 20 ℃，不随环境温度变（固件也按 343 算，结果正好；以后可以从 env 温度算 331.3 + 0.606 T，让"温度影响测距"可演示）。超量程 38 ms；回波没结束时的再触发忽略。距离由网页射线（从发射头沿探头朝向打到障碍物）或滑块给，3D 里障碍物最远摆 100 cm，更远只改读数
- 5 V 风险：HC-SR04 Echo 是 5 V 推挽输出。台面默认画 1 kΩ / 2 kΩ 分压（示例场景 `divider` 缺省为真），接线检查 W2 认分压；属性面板可"拆掉分压电阻"（改接线 `noDivider`），W2 报"5 V 进 GPIO"并把线标红，来源复用采购规则 R17。模拟器里电平只按逻辑值走，不模拟 GPIO 被 5 V 损坏
- PCNT：h_lim / l_lim 到达即清零并只报限位事件（不同时报过零）；STATUS 锁存位每次有事件就整体替换。依据 TRM 与 IDF `pulse_cnt` ISR 的读法（先读事件位判断加 high_limit 还是 low_limit），真机上"到限时是否同时置过零"未核实，标"未经真机标定"
- RMT 接收：rx_en 后从第一个跳变开始记（之前的空闲电平不记）；空闲结束时把当前电平写成时长 0 的半条目补齐最后一个条目、写指针算上它——与 IDF 的 NEC 示例"num_symbols 含结束符号"一致，HC-SR04 一次回波正好一个符号 {宽度, 1, 0, 0}。高电平本身超过 idle_thres（超量程 38 ms > 25 ms）时那段时长丢失、符号是 {0,1,…}，固件按"超量程"处理
- QEMU 对照：乐鑫 QEMU 的 esp32s3 机器有 RMT 寄存器但没有外部输入源、没有 PCNT 模型；两个固件在 QEMU 里都能跑到 ready 行（与我们逐字相同），编码器读不到转动、超声波打印 no echo。所以 P2-01 / P2-05 的对照只到"驱动初始化路径一致"，行为验收靠 accept 用例与单元测试
- 网页：两个实验台入口 `app.html?work=knob`、`?work=sonar`（`WORKS` 里没有检查点；作品化在 P2-09）。index.html 的示例 s3-encoder / s3-ultrasonic 同样能拖。测试工具 agent-browser 的 `mouse wheel` 落在 (0,0)，滚轮用页面里派发 WheelEvent 验证（鼠标拖动与按住用真实鼠标）
## 2026-10-16 · IMU（P2-03）与触摸屏（P2-02）
- 姿态用欧拉角 + 欧拉角速率进内核（不是四元数）：脚本可读（`imu=30,-20,0`），网页把三种来源（滑块、拖台面、转成品盒子）的四元数统一换成 ZYX 欧拉角再发。姿态在两次输入之间不按速率外推：每次变化都记进输入日志、按模拟时刻施加，重放逐周期一致；代价是拖动时加速度计看到的是 ~30 Hz 的阶梯（拖动事件频率），陀螺看到的是那一段的平均速率。替代：内核里按速率积分姿态——脚本 `imu=…,速率` 会让姿态自己漂走，验收不好写
- 速率由网页按墙钟算（`PoseRate`），停 150 ms 补一次速率 0：确定性靠"记进日志的就是施加的"，而不是靠速率本身可复现。施加前取到 0.01°（脚本精度），网页读到的与 CLI 重放读到的逐位相同（sense.mjs 对拍）
- 噪声：加速度 ±3 mg、陀螺 ±0.05 °/s 均匀分布，按样本序号哈希（确定性）；量级是估算，未经真机标定。零偏、温漂、振动、DLPF 的相位滞后都没做
- QMI8658：CTRL1.BE 在 I2C 下不改字节序——微雪示例与 SensorLib 设 0x60 仍按小端拼数，按它们的实际表现建模，标"未经真机标定"。ADDR_AI=0 时不自增照样复现（真机常见坑）。REVISION_ID 取 0x7C、复位完成标志 0x4D=0x80，按数据手册与 SensorLib 的读法
- CST816S INT 建成电平（按着拉低、抬起回高），不是真机的扫描周期低脉冲：内核没有"器件按时间驱动引脚"的机制，按电平时下降沿中断和"低电平期间轮询"两种常见写法都能用；s3-touch 用下降沿唤醒 + 按着轮询。没做自动睡眠（真机无触摸几秒后 I2C 不应答）——写进元件库 note 和成品"只能上真机"
- 触摸 INT 引脚不进 I2C 器件描述（`--i2c cst816s@0x15`），单独 `--touch-int GPIO` / InputLog.touchInt：I2C 规格串保持 `型号@地址`，旧日志、check.py、npm 包的解析不用改
- 3D：有 IMU 时转整块台面（"端着面包板"），绕 IMU 模块转、不抬高（试过按包围盒抬到桌面以上：30° 时整块台面跑出视野）。拖 IMU 模块 = 轨迹球（横拖绕相机竖轴、纵拖绕相机横轴，0.5°/像素），点一下不动 = 选中。触摸圆屏是 gc9a01 + cst816s 两个场景零件（采购清单里是一件 `gc9a01-touch`，`toScene` 拆成两件），圆屏画成 12 针；点屏幕优先于选中 / 转视角
- 新作品位 `imu`（倾角仪）、`touch`（触摸圆屏）：只有实验台 + （imu）成品页，没有检查点、采购 / 组装模版——作品化（体感小人等）留给 P2-09。倾角仪成品不要求组装，实验台"看成品 →"直接可点
- 固件：s3-imu / s3-qmi8658 共用一份源码（`IMU_QMI8658` 宏，同 s3-bme280 的做法），只用 IDF 的 i2c_master；s3-touch 用 round_lcd.h（esp_lcd_gc9a01 组件，与 lens 同版本）+ 自己读 CST816S 寄存器，没引 esp_lcd_touch_cst816s 组件（少一个第三方依赖）
- 替代：四元数直接进内核（脚本难写难读）；IMU 只转模块不转台面（模块插在面包板上自己转不符合实物）；FT6236 一起做（时间留给 CST816S 的手势和 3D 交互，FT6236 以后按同一套接口加）
## 2026-10-16 · I2S + GDMA 收发、MAX98357A / INMP441（P2-06）
- 决定：I2S 模型放在 `tryboard-esp32c3`（`i2s.rs`），C3 / S3 共用（`i2s_reg.h` 两颗芯片布局逐项相同，只有 TX_CONF1、DATE 的复位值不同）。只做 IDF `i2s_std` / `i2s_tdm` 用到的主模式 + GDMA；PDM、从模式、外部 MCLK 不做，配到这些时该方向不出数据（不静默假装成功）。依据：TRM 的寄存器描述 + IDF `hal/i2s_ll.h`、`hal/i2s_hal.c`、`esp_driver_i2s/i2s_common.c` 的写法（Apache-2.0），没看 GPL 的 QEMU I2S
- 决定：流式时序按"块"而不是按位：TX 每个描述符一块，**取数据时刻 = 这块第一帧的播放时刻**，放完（按帧率算出的时刻）报 OUT_EOF；RX 每块录满再写进描述符。理由：IDF 的 EOF 回调就是按块把缓冲还给 `i2s_channel_write / read`，块级时序足以让写入 / 读出被采样率卡住；逐位模拟 BCK 要每秒 1.4 M 个事件，没有收益。代价：真机 FIFO（64 字）带来的提前量（约 0.7 ms @ 44.1 kHz）不模拟。替代：每帧一个事件（44 k 事件/秒，CPU 开销可见，结果一样）
- 决定：模型内部用 32 位"槽字"（MSB 对齐）作为 I2S 与器件之间的接口：TX 按 data_bits 左移，RX 取高 data_bits 位；这样 16 / 24 / 32 位、Philips / MSB 的差别（rx_msb_shift）都在 I2S 一侧处理，器件只管"线上一个槽从高位移出的 32 位"。INMP441 给 24 位补码左对齐（低 8 位 0）、另一槽读 0
- 决定：喇叭 / 麦克风是否"接上"按 GPIO 矩阵判断数据线（DIN 脚的 FUNC_OUT_SEL = 该口 SD 输出；SD 输入信号的 FUNC_IN_SEL 选的是麦克风 SD 脚），时钟脚不检查。引脚按芯片固定（S3 16/17/18 + 39/40/41，避开圆屏 10–15、I2C 8/9、舵机 / LED 4/5、WS2812 48、USB 19/20、PSRAM 33–37；C3 0/1/2 + 0/1/3，共用 BCK / WS），与圆屏 `lcd_pin` 同一套做法。替代：器件自动跟着 I2S 信号走（接哪都响）——教不了"接错线没声音"
- 决定：测试声音自己合成（`tools/audio/gen_wav.py`：1 kHz 正弦、200→2000 Hz 扫频，48 kHz 16 位，幅度 0.5），WAV 进仓库（共 288 KB，见 `tools/audio/SOURCES.md`），网页从 `/audio/` 取。麦克风按**模拟时间**取样，同一 WAV 每次运行读数一样，进验收（s3-i2s-mic：1000 Hz ±1、RMS 0.3536 ±0.002）。浏览器麦克风只玩：不进输入日志、不进验收
- 决定：网页放音用 AudioWorklet + 按绝对帧号寻址的环形缓冲（主线程按模拟时刻算出"第几帧开始播"，重采样到 AudioContext 采样率，首尾相接），对齐策略照抄蜂鸣器（领先 0.12 s，偏出就重新对齐）；与蜂鸣器共用一个开关和 AudioContext。没有 AudioWorklet 时退回 AudioBufferSourceNode 定时播放。踩过的坑：按块四舍五入输出长度会在块边界留 1 帧 0，过零测频多数一次，网页测得 452→464 Hz 漂移；改成每块覆盖 [ceil(f0), ceil(f0+时长)) 后输出端测得 440.0 Hz。替代：MediaStream / `<audio>` 播 WAV 片段（延迟大、不能按模拟时间对齐）
- 决定：功放电流进供电网络：Board 第 10 个元件（5V 轨上的 Load），电流 = 2.4 mA + 输出功率 / (85% × 5 V)，输出有效值按"0 dBFS ≈ 2.5 Vrms（9 dB 档、5 V 不削顶）"估算——数据手册只给增益不给满量程电压，这个数标"估算"。功放没接时该元件电流为 0，原有网络与读数不变；`--elec-report` 只在接了功放时多一行
- 决定：CLI 接了音频器件就 1 ms 一片（功放电流按每片放出的声音算，与网页实时运行一致；网页验收 worker / npm 包的 simrun 没接音频器件参数，关卡也不用）；`tb_report` 不加音频行（保持关卡指纹不变），音频读数单独走 `tb_audio_report` / `tb_audio_stat`
- 喇叭固件用 I2S0、麦克风固件用 I2S1（真实项目常这样分，两条路径各有一个固件验收）
- 未做：C3 固件验收（只有单元测试）、作品库里还没有带喇叭的作品（成品页的声音开关按 `hasSound` 显示，验证时在透镜作品的台面上加了喇叭、跑 s3-i2s-tone）、成品 3D 里不画喇叭
## 2026-10-16 · 暗色漏项（分析仪 / ⌘K / levels / advisor / index）
- 决定：逻辑分析仪 canvas 的不透明色照旧从 CSS 变量读（`--fg / --line / --accent / --ok / --bad`…），半透明叠层（无数据段、未发生段、标签垫底、包络、气泡底）按 `currentTheme()` 选 `PAL.light / PAL.dark` 两套，数值取自 app.css 两套变量；`onTheme` 时置 dirty 重画。气泡"读到的数据"判定由比较写死的 `#14ae5c` 改为比较当前 `--ok`。`.analyzer / .ana-b / .cmdk-list` 的 `#fff`、`#b9e0ff` 换成 `--surface / --accent-line`，`.prod-preview` 的浅橙底换成 `--ch-bg / --warn-line`
- levels.html、advisor.html、index.html 都加首帧前内联脚本；advisor 与空白实验台从写死的暗色（橙强调、Inter）改成 DESIGN §2 亮色默认 + `:root[data-theme='dark']` 暗色（与 app.css 同值），字体 Noto Sans SC / JetBrains Mono，头部加 `themeToggle()`；index 的 3D 台面调 `bench.setTheme` 并跟 `onTheme`。advisor 模板卡去掉 emoji（DESIGN §2）
- 理由：这几处在暗色下是白块或浅底浅字；canvas 不认 `color-mix()`，半透明色只能另备一套
- 替代：(a) canvas 叠层用 `globalAlpha` + 变量色——要改每处绘制顺序，碰到分析仪逻辑；(b) 保留 advisor / index 的旧暗色只加亮色——两套视觉不统一
- 未改：views.css 里成品 / 装配 SVG 示意图的自带配色（绿底、橙标签）是插画本身的颜色，两种主题下都可读；USB 虚拟鼠标画布保持深色（它画的是一块屏幕）
## 2026-10-16 · 拍照 / 录 10 秒（P2-10）
- 决定：不用 three-gpu-pathtracer（不在 web 依赖里，按规则不新装），拍照 = 当前视角重渲一帧：输出 = 画布 CSS 尺寸 × 2（长边上限 4096），渲染再按输出放大一倍超采样（长边上限 4096 / maxTextureSize），含 bloom 等后期（EffectComposer 跟着改像素比），背景临时换成 DESIGN §2 台面渐变（亮 / 暗两套）、关掉雾，`drawImage` 缩到输出尺寸后角落写"TryBoard 试板 · 作品名 · 外观示意，非乐鑫官方模型"，PNG 用 Blob + a[download] 下载。渲染完在同一个任务里立刻拷走，不必开 preserveDrawingBuffer
- 决定：录像 = `canvas.captureStream(30)` + MediaRecorder（优先 `video/webm;codecs=vp9,opus`，8 Mbps），10 秒自动停，可提前点停；声音开着时把蜂鸣器那条 Web Audio 链（分析器节点）再接一个 MediaStreamDestination，音频轨混进去；声音关着就是只有视频轨。下载名 `tryboard-<作品>-<时间>.webm`
- 公共接口：`ProductScene / Lcd3D / Bench / Keypad3D` 都多了 `capture(): Capturable`（渲染器、场景、render、setPixelRatio），`BuzzerAudio.recordStream()`；`globalThis.__tbCapture` 记最近一次拍照 / 录像的文件名、字节数、尺寸，给测试核对
- 验收：`tools/webtest/media.mjs`（进 accept.sh）在 Chrome 里点按钮、读下载目录：PNG 的 IHDR 宽高 = 画布 × 2、webm 的 EBML 头与视频轨 PixelWidth / PixelHeight = 画布像素、声音开时有 A_OPUS 轨、时长 9.5–11 s
- 替代：(a) three-gpu-pathtracer——真路径追踪更好看，但新依赖 + 首帧要收敛几十秒；(b) `renderer.domElement.toBlob` 直接存当前帧——只有屏幕分辨率、背景跟着页面；(c) 录屏用 ffmpeg.wasm 转 mp4——包太大

## 2026-10-16 · 线长影响 I2C、天线遮挡（P2-11）：确定性模型，标"估算，必须上真机"
- 决定：不引入随机。I2C：`tryboard-elec::i2cbus` 一份公式（网页 `app/harness.ts` 同一组常数，单测对拍）：总线电容 C = 线长 × 1 pF/cm + 器件数 × 10 pF + 10 pF（开发板 + 面包板），上拉 = 每个模块 10 kΩ 并联（没有模块时内部 45 kΩ），上升时间 t_r = 0.8473·R·C（UM10204 §7.1，30% → 70%）。上限按**固件实际配置的 SCL 频率**（I2C 控制器的分频寄存器算出来）：≤ 100 kHz 1000 ns、≤ 400 kHz 300 ns、更快 120 ns。t_r 在上限内照常；超出、不到两倍：读回的字节里"前一位是 0、这一位是 1"的位读成 0（`b & ((b >> 1) | 0x80)`，写入不受影响）；超两倍：地址字节没人应答（NACK）
  - 理由：读错用"慢上升吃掉 0→1 的位"这一条确定性规则，BME280 校准数据、原始值都会被同一规则改写，读数离谱但每次一样，指纹可复现；气象站 2 个模块在 400 kHz 下 41 cm 起读错、112 cm 起不应答；扫描时 IDF 用 100 kHz，所以 150 cm 时扫描还能看到 0x3C / 0x76、正式读才 NACK——和真机"能扫到但读不了"的现象一致
  - 常数全是估算（线电容 0.5–1.5 pF/cm 取 1、模块上拉以常见 10 kΩ 计），未经真机标定；只作用于 I2C0（作品都在 I2C0 上）
- 决定：天线：虚拟世界（`soc::wifi::world`）里所有 AP 的 RSSI 减去遮挡 dB（链路对称，AP 也听不清芯片）：< -92 dBm 扫描收不到；< -82 dBm 认证 / 关联 / 数据帧 AP 不回、也不 ACK（IDF 报 `reason=2` 认证超时）。网页按"金属件贴着 45 dB、锂电池 30 dB，乘 (1 − 距离 / 20 mm)，20 mm 外不算"估算遮挡（整数 dB），TryBoard-WiFi 开阔处 -42 dBm
- 决定：线束是机器的外部世界（`Machine::harness`），跨软件复位保留；CLI `--i2c-wire <cm>`、`--antenna-loss <dB>`，脚本动作 `i2cwire=cm`（负数 = 理想总线）、`antenna=dB`；网页输入日志新增 `i2cwire / antenna` 两种事件（上电时的值记在第 0 个周期），回退 / 导出 / check.py `--inputs` 都能重放；结论文字（命令行 stderr 与 wasm `tb_harness_report` 同一段）不进指纹。没设线长时与以前完全一样（所有旧用例、指纹不变）
- 网页：实验台每个 I2C 模块的线长默认 10 cm（不交给模拟器 = 理想总线），选中 SDA / SCL 线可拉长，接线检查新增 W6（超出警告、超两倍阻断，可信度"必须上真机"），改动进时间线并在线换模拟器的总线负载；组装：I2C 排线总长（默认 16 cm）+ 天线旁放了什么（没有 / 锂电池 / 金属件）+ 距离，存 `localStorage['tryboard-app-harness:<work>']`，不进装配时间线；线束超标算"装配有警告"，开机复测带着线束跑（读数跑偏、RSSI 连不上判不过）；成品页按装好的线束跑并显示估算与模拟器结论
- accept：weather-i2c-long（60 cm：读数不是 23.50、stderr 上升 381 ns）、weather-i2c-nack（150 cm：NACK、参考固件 ESP_ERROR_CHECK abort）、wifi-scan-antenna（30 dB）、wifi-connect-antenna（45 dB）。accept.sh 新增 `crash_expected`：用例本来就要验"故障让固件崩"时不算失败（没崩反而算失败）
- 替代：(a) 按概率丢字节——不可复现，指纹失效；(b) 逐位模拟 SDA/SCL 的 RC 波形——要把 I2C 模型改成逐位推进，代价大，而结论（超没超规范）一样；(c) 天线用路径损耗模型算距离——这里只关心"装壳后旁边有没有金属"，线性近似足够，且明确标估算

## 2026-10-16 · 作品 USB 小键盘（P2-12）
- 决定：新作品 `usbkey`（work 定义驱动）：首页卡片改由 `app/works.ts` 的 `card` 字段生成（home.html 只留空容器），加作品不用改页面；成品步骤的作品列表同样来自作品定义
- 硬件：S3 DevKitC-1（原生 USB）+ 4 个 6×6 轻触按键（K1–K4 = GPIO4–7，另一端接地，内部上拉）+ 外壳键帽。实验台新增 PartSpec `key`（面包板上跨凹槽的开关 + 印字键帽，3D 里按住 = 引脚接地，`Bench.onKey`），采购模版的 `button ×4` 按接线（每根 A 脚接 GPIO）展开成 4 个 key
- 固件：`firmware/usbkey`（在 s3-usb-keyboard 上改：只报键盘，产品名 TryBoard Macro Pad，不自动打字）：K1–K3 发 a / b / c，K4 宏键打 "Hello TryBoard\n"；10 ms 采样两次一致消抖。三个检查点共用这一份参考固件（每关条件都是它的子集）：usbkey-1 枚举（虚拟主机"已配置"）、usbkey-2 1.2 / 1.5 / 1.8 s 按 K1–K3 打出 "abc"、usbkey-3 按 K1 + K4 打出 "aHello TryBoard\n" + 装配
- 判定：关卡新增 `usb: { state?, typed? }`，对象是虚拟主机看到的结论：观察记录（指纹的一部分）在关卡带 `--usb-log` 时追加两行 `[tryboard] USB 主机：<状态>` 与 `[tryboard] USB 键盘输入: "<Rust Debug 转义>"`（CLI 与 wasm `tb_usb_report` 同一个 `tryboard_machine::usb_report_lines`），check.py / checks.ts / npm 包按同一规则解析（JSON 解析引号串），顺序排在 LCD 之后、PWM 之前。理由：只看串口的话固件可以自己打印"已发送"，判不出电脑到底收没收到
- 组装：参数化外壳 44×80×22 mm（底壳 + 定位板，一排 4 个 14 mm 键孔，键距 19.05 mm），开发板两种装法：USB / OTG 口朝背面开孔（对）、转 180°（USB 口顶着前墙，成品里线插不进、电脑看不到设备）；成品：three.js 小键盘 + usb3d 的笔记本，屏幕上是虚拟主机还原出的字；没有 WebGL 时用平面视图（views/keypad.ts，首页卡片也用它）
- usb3d：只有键盘、没有鼠标的设备不画鼠标区，文本编辑器占满、字放大
- 替代：(a) 用 BOOT 键当唯一按键——省掉新元件，但"按键若干"做不出来；(b) 每关一份参考固件——和小黄一样，但这三关条件正好层层包含，一份就够，少编两份 TinyUSB 固件（每份 ~290 KB）

## 2026-10-16 · wt-media 合并 main（P2-10/11/12 × P2-01..08）
- 决定：录 10 秒的声音轨同时接蜂鸣器与 I2S 喇叭（`PcmVoice.tap`），成品页声音开关改用 main 的 `hasSound`；I2C 排线（`i2cBuses`）把 MPU6050 / QMI8658 也算进 I2C0 总线上的器件。
- 未做：倾角仪成品（tilt3d）没有 `capture()`，成品页对它不显示拍照 / 录像（它还不是完整作品，P2-09 作品化时补）。
- 理由：两边功能全部保留；新器件在 main 上是 I2C0 外设，线长估算应计入它们的负载。

## 2026-10-16 · traceio「回退到运行 #1」间歇失败的根因（测试判据，不是确定性）
- 现象：同一份固件、同样输入，连跑偶尔 FAIL（回到 1.632 s / 3716 条），多数 PASS（1.5x s / 3594 条）。失败那次事件逐条仍是命令行前缀（报告里没有"第 N 条不同"），挂的是附加判据"末条时刻 ≤ 回退点 + 20000 周期"
- 根因：回退点 = ⌘K 改室温那一刻，由墙钟决定（落在 1.5–1.65 s 之间）。I2C 事件在事务层按位时序预先盖戳（见 P1-05），weather 每 0.52 s 写一次 SSD1306（1.6302 s 起约 10 ms，命令表一批最多 32 B FIFO ≈ 116k 周期）。回退点落进这个写屏窗口时，最后一批事件的时刻越过回退点最多一批 FIFO（失败那次 +92k 周期），超过 20000 周期余量。网页与命令行在这一点上是一致的（实时运行那次也同样提前记下了这批），确定性没有被破坏；之前能过是因为回退点多数落在两次写屏之间的空闲段
- 修法（只改测试判据，没有放宽逐条对拍）：①逐条是命令行前缀；②没漏：命令行下一条事件的时刻 ≥ 停住的周期（用快照的 simSeconds，而不是 untilMs）；③越过停住点的只能是 I2C 事件、且不超过 1 ms。另加一项确定性用例：直接回退到运行 #1 里最后一次 0x3C 写屏事务开始后 60000 周期，每次都覆盖"回退点在 I2C 事务中间"的情形（旧判据在这一项上必挂）
- 替代：(a) 把余量放大到 1 ms——能过，但不再检查"越过的是什么"，也不检查有没有漏；(b) 让 I2C 事件按周期推进时才放出（不预先盖戳）——要在事务层排队按周期释放，改动内核、对实时显示没有好处，而且网页 / 命令行两边已经一致
## 2026-10-16 · 新作品：旋钮台灯、超声波尺子、体感小人（P2-09）
- 决定：三个作品 `lamp` / `ruler` / `tilt`，每条线 3 个检查点：零件单独跑通 → 加第二样东西 → 合体（带装配）。检查点放 levels.json 顶层、带 `work`（同 spin-1 做法），合体关 `assembly: "<作品>"`；标题不用全角冒号（check.py 输出 `第 x 关 标题：通过`，levels.mjs 按第一个冒号切，"合体：旋钮台灯" 会被切错），写成"合体 · 旋钮台灯"
- 参考固件只用 IDF 自带驱动：WS2812 用 RMT TX + `rmt_new_bytes_encoder`（不引 led_strip），编码器 PCNT，测距 RMT RX，蜂鸣器 LEDC，OLED 用 firmware/common 的 ssd1306_mini.h，IMU 直接读寄存器。圆屏沿用 spin / lens 的 espressif/esp_lcd_gc9a01（Apache-2.0，已在授权清单里）——这不是 IDF 自带组件，但关卡任务书本来就让用户用它，保持一致。每个作品三关共用一份源码，`STAGE` 宏区分（同 s3-qmi8658 共用 s3-imu 的做法）
- 新判定（两份实现同步，网页 / 命令行 / npm 包指纹一致）：
  - `ws2812.last {count, lit, rgb, tol}`：最后一帧逐颗看（灯数、亮几颗、亮的颜色每通道 ±tol）。台灯亮度公式写死在任务书里（通道 × L×16 / 255 整数除法），容差 2 吸收别的取整写法
  - `pwm.beeps [{from, to, min, max}]`：时间窗里占空比从 0 变成 > 0 的次数，直接判"越近越急"（60 cm 时 0.3–1.5 s 响 2–5 声，15 cm 时 1.8–2.5 s 响 4–9 声，150 cm 不响），不信固件自报的节奏
  - `lcd_colors.cy`：竖直重心，配合 cx 判小豆停在左下边上
- 小人是原创形象"小豆"（黄色圆身体 + 深色眼罩 + 青色眼睛，沿用小黄的屏幕脸风格），不像任何商业 IP。滑动规则写进任务书：v = (v + 倾角 × 0.03) × 0.9，碰边沿半径拉回并去掉朝外速度（贴边滑）；判定只看最后一帧落在左下一片区域，不要求逐像素一致
- 装法影响：台灯"灯条贴着灯罩内壁"→ 罩上一排亮点（只改成品画面）；尺子"探头缩在孔后 6 mm"→ 读数截到 3 cm（`SONAR_BLOCK_CM`，估算）；体感小人"六轴转 180° 装反"→ 俯仰、横滚反号。后两项**进模拟器**：开机复测把关卡输入脚本按装法改写（`effectScript`：dist= 截到 3、imu= 俯仰横滚取反），所以复测是判定项真的挂掉（读不到 15 cm、节奏不对 / 小豆停在右上），不只是"装配有警告"；成品里用户拖的距离 / 姿态同样经装法再送进模拟器，离开成品时还原
- 网页：外接 WS2812 灯条（PartSpec `ws2812`，8 灯小板平放在桌上）：worker 每个时间片扫一遍板载灯以外的引脚，帧数变了才发；台面不做色调映射，灯珠亮时底色压暗、自发光用归一化色相（否则白底 + 强自发光被裁成发白的粉色）。成品 `app/works3d.ts`（与 product3d 同一套舞台：WebGL + RoomEnvironment + bloom，cm 单位）：台灯旋钮拖 / 滚 = 转、点 = 按；尺子桌上卷尺 + 可拖动木挡板；体感小人拖圆盘倾斜。都支持 P2-10 的拍照 / 录像。首页卡片走 P2-12 的作品定义（works.ts `card`），新作品的演示数据 / 实时器件配置在 home.ts `EXTRA`
- 采购：台灯带 5 V 2 A 电源 + DC 母座（默认勾选；去掉后 R20：8 颗满白 480 mA + 板子超过 USB 500 mA）和 74AHCT125（R18）；尺子 Echo 走分压（去掉分压 → R17）；元件库加三件外壳，件数上限 60 → 70（catalog.test.ts）；hc-sr04 / encoder 标为"模拟器验证过"
- 未做 / 替代：(a) 组装用平面 SVG（P0-16 引擎），没写参数化 3D 外壳布局（enclosure.ts 只认 weather / spin / lens）——`HAS_3D` 之外的模版走平面；(b)「会说话的小黄」（MAX98357A + 自合成提示音，可选）没做，留到下一批；(c) 考虑过台灯用板载 RGB 当灯——不像台灯，也看不出 8 颗灯的亮度变化，放弃

## 2026-10-17 · 首页改版：只留流程 + 主张、作品、页脚
- 决定：人看了三版设计稿（流程条横排 / 居中大字 + 四列画廊 / 左右分屏 + 两列横卡）后选了左右分屏。首页只剩三段：首屏主张和竖向四步流程、作品两列横卡、一行页脚（DESIGN §5）
- 砍掉：卡片简介、"要买"清单、检查点数、示意图状态行（只在跑固件时出现，显示串口最后一行）、"我有自己的想法 / 已有固件"两张入口卡（导航和首屏按钮已有）、命令行验收介绍、参考价说明小字。参考价保留"估算"标注（DESIGN §6）
- 替代：保留入口卡放在作品下面——人明确要求砍多余说明，入口已在导航里，不重复

## 2026-10-17 · 2D 界面改用 React + Tailwind + shadcn 风格组件（先试点选型助手）
- 决定：网页 2D 外壳（导航、面板、表单、表格、对话框、命令框）逐页迁到 React 19 + Tailwind v4 + shadcn 风格组件（底层 Radix）；构建仍是 Vite，**不用 Next.js**（站点纯静态、没有后端，SSR / 服务端组件 / API 路由都用不上，反而让 wasm、Worker 打包更难控）。3D 场景（three.js）、Worker、wasm 绑定、高频刷新的 canvas 面板（逻辑分析仪、时间线波形、示波器）保持命令式，由 React 组件挂载，不进 React 渲染。
- 先试点选型助手（advisor.html：纯 2D 表单 + 表格、与模拟器无关）；通过标准：功能与旧页一致（同样的模板 / 需求 / 推荐结果）、亮暗色与手机宽度 agent-browser 走查无 error、`levels.mjs` 首页入口回归通过、首包增量可接受。通过后再迁首页、检查点页、实验台外壳。
- 依赖（精确版本，均发布于 2026-09-15 之前；许可证见 LICENSING.md）：
  - 运行时：react 19.3.0、react-dom 19.3.0（MIT，gzip 约 60 KB）、radix-ui 1.6.7（MIT，按组件 tree-shake）、class-variance-authority 0.7.1（Apache-2.0，<1 KB）、clsx 2.1.1（MIT，<1 KB）、tailwind-merge 3.7.0（MIT，约 7 KB）
  - 构建：tailwindcss 4.3.3、@tailwindcss/vite 4.3.3、@vitejs/plugin-react 4.7.0（Vite 6 能用的最后一个大版本）、@types/react 19.3.0、@types/react-dom 19.3.0（MIT，不随网站分发）
  - 不引 lucide 等图标库：DESIGN 用 ✓ ✗ ! 文字符号表达状态
- 主题：Tailwind 的 `@theme` 直接映射 DESIGN §2 的 CSS 变量，`dark:` 变体绑 `[data-theme=dark]`（与 theme.ts 同一个开关），不另起一套色板。Tailwind preflight 只在迁过的页面加载，旧页面样式不受影响。
- 理由：现有 2D 界面靠 `innerHTML` 拼串（94 处）+ 手动重画，状态和 DOM 容易不同步、每处都得记得转义；对话框 / 菜单 / 命令框的焦点与键盘要自己写。React 声明式渲染 + JSX 默认转义 + Radix 的可访问性原语直接解决这几类问题。
- 替代：(a) 保持原生 DOM、只抽小组件函数——便宜，但解决不了状态同步；(b) Next.js——见上，收益几乎为零；(c) Preact——更小，但 Radix / shadcn 生态要 compat 层，出问题难查。

## 2026-10-17 · 首页、关卡页迁 React；授权页改用 Tailwind 编译的样式
- 决定：`home.html` → `src/home/{main,App}.tsx`。页头和页脚抽成 `ui/site.tsx`（SiteHeader / SiteFooter），后面的页面共用。作品卡的示意图和真实固件运行仍然命令式（`src/home/cards.ts`），由 `useEffect` 挂载，清理函数里销毁 LiveSim 和 IntersectionObserver。串口状态行直接写 DOM ref，不进 state。"同一时间只跑一张卡"由 App 的一个 `live` state 管。`levels.html` 本来就是跳转页（P0-21），跳转在 `<head>` 里做（首帧前）。主会话合并时决定：跳转页保持纯 html、不 React 化，因为它只显示一行字，React 化只会让每个旧链接多下载约 68KB。
- 授权页（`tools/gen_licenses.mjs` 生成的静态 HTML，不 React 化）：不再引 app.css / page.css，改引 `src/licenses/licenses.css`。它是 `@import ui/tailwind.css` 再加 `@source` 生成脚本，页头和页脚直接写与 site.tsx 同一串 Tailwind 类，正文表格用 `.lic` 下的几条 `@apply` 规则。
  - 理由：颜色、字体、亮暗主题和 React 页面同一个来源，不再维护第二份。
  - 代价：CSS 里带上 tailwind.css 扫到的所有工具类，约 28.6 KB，gzip 6.45 KB。比原来的 app.css + page.css（gzip 8.13 KB）还小。
  - 替代：手写一份小静态 CSS 体积更小，但颜色变量要再抄一份，主题改了就会漂。
- 删除：`src/home.ts`、`src/levels.ts`（已无入口）、`src/levels.css`、`src/site.css`、`src/page.css`（只被这几页引用）。`.wk-prev` 里改写 showcase SVG 的规则搬到 `src/home/home.css`。app.css 和 views.css 没动，只是不再被这几页引用。
- 加了 token：`ui/tailwind.css` 末尾加 `--stage-bg`（台面渐变，亮暗两套，与 app.css 同值）。
- 颜色有意变化（AA，按 DESIGN §2）：
  - 次要文字：#8c8c8c → `muted` #6f6f6f；
  - 白字主按钮：#0d99ff → `accent-strong`；
  - 步骤序号、串口状态行、链接：改用 `accent-ink`；
  - 授权页段落里的链接常显下划线（axe link-in-text-block）。
  - 其余与旧页像素对比在 1.5% 以内，暗色基本为 0。
- **没做：暖灰橙色板（site.css）的 `[data-palette='site']` 映射。**
  - 原因：site.css 只被 levels.ts 引用，而 levels.ts 自 P0-21 起已经没有入口，是死代码。现在的首页用的是 app.css 的白底蓝色（DESIGN §2 A 版），任务又要求"视觉必须与改前一致"，两条冲突。我按视觉一致处理，色板直接删掉，不映射。
  - 要恢复：从 git 历史里取 site.css 的取值，在 tailwind.css 里加作用域主题，页面根加属性。**待人决定**是否要暖色版首页。

## 2026-10-17 · 实验台（index.html）外壳迁到 React
- 决定：工具栏、示例选择、串口 / USB / 这个示例 / 面包板元件面板改成 React（`web/src/lab/`）；3D 台面、worker、串口流、模拟时间、装配视图仍是命令式（`lab/lab.ts`，原 main.ts 原样搬过来），由 React ref 挂载、`useEffect` 清理。删掉 `src/style.css`、`src/main.ts`、`src/usbpanel.ts`；`src/editor.ts` 只留数据部分（引脚表、描述、冲突检查）
- 保留 `views/views.css`：app.html、home.html 和 app/ 下的代码也用 views/*，换成 Tailwind 要同时动别的页面，不在本次范围
- 滑块非受控 + `onInput`：验收脚本（sense / replay 等）用"改 value + 派发 input 事件"，React 受控输入的值追踪会把这种事件吞掉；3D 拖旋钮 / 装配视图调温度也直接改滑块 DOM
- 入口不包 StrictMode：开发模式下的双挂载会建两个 worker 和两个 WebGL 上下文；清理函数照样写全（`lab.dispose()`）
- 窄屏（≤ 900px）修了旧页的重叠：旧页 body 固定 100% 高、main 设了 min-height:0，内容超出一屏时页脚和侧栏叠在 3D 舞台上；现在窄屏下根容器高度随内容
- 替代：(a) 把 main.ts 整个拆成 hooks——改动面大、与验收对拍的时序风险高，收益只是代码风格；(b) 串口区也用 React 渲染——高频流进 state 会卡，违反 ARCH「每秒十次以上不进 React」

## 2026-10-17 · 实验台 app.html 外壳与四步面板迁到 React + Tailwind
- 决定：外壳（左栏头 / 步骤导航、构建树、属性面板、命令框、右上检查点 / 下一步 / 主题、工具条、时间线外框、提示）和四步面板（采购、实验台、组装、成品）改成 React 组件 + Tailwind 类；three.js 台面、组装 / 成品 3D、session / worker / verify-worker、逻辑分析仪、示波器 canvas、串口流保持命令式，经 `Host`（ref 挂已有节点）或 `useEffect` 挂上去。Shell 接口不变形：`shell.tree / props / layer` 是 `Panel { render(node), el }`，每次 render 整块重挂（key 自增），步骤代码只换成 JSX，不改"选中变了整块重画、实时值按 data-live 直接改文字"的分工
- 保真做法：测试会"设 value + 派发不冒泡的 input/change"，React 的 onChange 收不到 → 输入框统一用 `ui/native.tsx` 的 NInput / NSelect（原生监听）；每帧更新的字段（Live / Txt）只在挂载时写一次初始值，之后由原有代码改 textContent，不经 React 状态；`render` 用 flushSync 提交，`store.set` 之后下一个任务前 DOM 已更新（测试会紧接着点新节点）
- 对拍：298 个状态（weather / spin / imu / touch / usbkey / ruler / blank × 四步 × 逐个选中树条目 / 零件，另含四个作品装完后的组装 / 成品）导出各容器文字和 id / data-* 签名，与旧版逐条一致（Reviews/ab/react/app.md）
- 可访问性顺手修（axe 0 违规）：每个树分组一棵 `role=tree`（summary 是原生开关，不能做 tree 的子节点）；步骤画面是 `<main>`、作品名是 `<h1>`；串口 `role=log`（aria-live=off，免得读屏逐行念）可键盘滚动；选中条目的灰字改成强调色（对比度）；app.css 里 `--muted` 不再覆盖成 #8c8c8c，统一用 tailwind.css 的 #6f6f6f
- 样式文件：实验台还用得上的规则搬到新文件 `src/app/lab.css`（约 250 行：Tailwind 里没有的变量、命令式节点——分析仪、SVG / 3D 装配、3D 成品——和采购 / 组装 / 成品专用类），app.html 不再引 `app/app.css`。app.css 原样保留，因为 home.html / licenses.html 还 link 着它且大量依赖（.brand、变量、按钮基础样式；删规则会让首页手机宽度横向溢出）；那两处 link 去掉后 app.css 可整体删除。lab.css 不在 @layer 里、会盖过同名工具类，所以不写通用元素选择器
- 替代：(a) 只迁外壳、步骤仍用 innerHTML 填进 React 留的空 div——两套渲染混在同一容器里，测试点击时机难保证；(b) 用 React 状态驱动实时读数——60 Hz 重渲整块属性面板，违背"高频数据不经 React"

## 2026-10-17 · U-02 新版选型助手、U-06 手机站点页
- 决定：选型助手按 Advisor.dc.html 重做界面，engine.ts / data.ts 的推荐逻辑不动，只加数据：配件、模板各加 `short`（卡片副标题 / 手机底部按钮用），模板加可选 `work`（对应完整作品），`examples` 同时列 C3 和 S3 的示例 id（去掉不存在的 `strip`）。BOM 在勾"电池供电"而配件里没有锂电池时补上锂电池（之前续航算了电池、清单里却没有）
- 「在试板里跑一遍」：实验台 index.html 只认 `?example=`（另一个代理在改实验台，这次不碰），所以交接只带示例 id：运行时读 `fw/examples.json`，从模板的示例里挑芯片与推荐芯片相同的那个；推荐芯片没有可跑示例时按钮置灰并写明原因，另给同类项目在别的芯片上能跑的示例；有完整作品的再给 `app.html?work=<id>#shop`。把整套 BOM / 引脚带进实验台要等实验台支持读参数，记在这里
- 设计稿上的"越小越好 / 新手友好"两个 chip 不是引擎里的能力，不加（加了也无从过滤）；预算用引擎已有的 `need.budget`（不限 / 60 / 120 / 200）。三个关键数：芯片、整套价、续航（估算）；不需电池时第三格换成"仿真：完整 / 部分 / 还不能"，不编数字
- 可信度表：配件和芯片用引擎的 simCoverage / chip.simulated，引脚和续航是估算；勾电池时加"锂电池充电 必须上真机"，要无线时加"天线、无线距离 必须上真机"
- 手机（< 768px）：模板单列先显示 4 个 + "还有 N 个"；结果的接线 / 要注意 / 零件清单 / 可信度折叠成一行（桌面直接展开）；备选横向滑动；底部吸附主按钮，结果进入视野前是"看推荐 · <模板> + N 个要求"，进入后是"在试板里跑一遍"（IntersectionObserver）
- 站点页头：手机上导航收进汉堡菜单（Radix Dialog 全屏抽屉，含手机能力说明、三段主题 跟随系统 / 浅 / 深、授权与致谢）；theme.ts 加 `themePref / setThemePref`（跟随系统 = 删掉 tb-theme）。SiteHeader 只加了可选 `subtitle`，原有 props 不变。页脚"第三方授权"改叫"授权与致谢"
- 授权页（gen_licenses.mjs 静态页）：同一套页头 + 抽屉，用 20 行内联脚本管开关 / Esc / 焦点 / 三段主题；表格每格带 data-label，手机上每行显示成一张卡，不再横向滚表格
- 首页手机：作品卡单列紧凑行（84px 缩略图 + 标题 + 两行简介 + 芯片 / 检查点 / 价格），"我有固件了"换成"帮我选板子"，四步说明在手机上隐藏
- levels.html 是跳到 app.html 的跳转页（levels.mjs 依赖），本身没有卡片，手机上直接跳转，不另做单列卡片
- 替代：(a) 把 BOM 编进 URL 交给实验台——要改 src/lab，本批不允许；(b) 手机结果全部展开——一屏放不下，与设计稿不符
## 2026-10-17 · 实验台 v2（U-03 / U-04）
- 只做有后端的功能，没有的灰显并写明原因，不造假数据：
  - 「代码」页签灰显：作品只有编译好的固件，没有源码数据。
  - 台面「放零件」工具灰显：零件清单归采购步骤管；左栏零件库只链到采购（#shop）。
  - 「分享」只复制作品链接：没有服务端，也没有把连线 / 环境编进链接的格式，分享改动不做。（2026-10-20 被 F-01a 取代：改动编进 `?s=`，见文末）
- 改接线（W 键 / 接线表）只改台面上的线和接线检查（`WireMods.retarget` + `pick.rewire`），不给模拟器重新上电，改动不跨刷新保存。
  - 理由：重新上电会打断时间线和指纹对拍；接线检查已经能说清「接错会怎样」。
  - 替代：改接后整机复位重跑——更真实，但要改 worker 协议，留给以后。
- 接错线（检查出问题）弹卡片：撤销 / 改接到别的针 / 我知道，保留；撤销重做走同一条 `hist.op` 时间线，⌘Z / ⇧⌘Z 可用。
- 逻辑分析仪从右栏挪进底部坞（与串口、时间线并列页签），坞可拖高、可收起。
- 「仅示意」声明和操作提示挪到台面左上角，避开右侧浮层。
- 检查点锁只是提示（标题写「N 个检查点全部通过后解锁」），不拦操作——与原有四步行为一致。
- 运行速度只按墙钟换算显示，不改模拟器步长（改了会影响指纹）。
- 零件可信度徽标（仿真验证 / 行为模拟 / 估算）按 docs/STATUS.md 现有结论映射，写死在 `benchv2.tsx` 的 `PART_CONF`；STATUS 变了要同步改。
- 运行态新增 `nofw`（没有固件）：空白作品原来一直显示「加载中」，会让人以为在等。
- 新增回归 `tools/webtest/wiremode.mjs`：引脚圈跟相机投影每帧定位，agent-browser 悬停 / 点击它之后会话会失效（元素找不到、超时），页面本身没问题（puppeteer 正常），所以改接线和接错线卡片用 puppeteer 真实鼠标测；其余功能仍用 agent-browser 人眼检查。
- 只在 `?debug=1` 下挂 `__tbApp.faults` / `injectWiring`，给回归脚本读接线检查结果。

## 2026-10-17 · U-05 手机：实验台与四步
- 断点统一到 Tailwind `md`（< 768px 为手机）：app 里原来的 `max-[760px]:` 全部换成 `max-md:`，lab.css 的 760 / 761 换成 767 / 768，只留一套。
  - 替代：保留 760——和站点页（U-06 用 md）差 8px，两套规则会在 760–767 之间打架。
- 外壳在 JS 里按 `usePhone()`（matchMedia）分两套 class，而不是一套 class 里堆 `max-md:`：桌面那套就是原来的字符串去掉旧的 max-* 部分，保证 ≥ 768 不退化。
- `--dock-h` 改由 CSS 从 `--dock-desk`（syncDockVar 写在 body 上）推出：手机上同一个变量换成「工具条 + 串口窥视条」的高度，桌面拖动坞高照旧。
- 手机实验台：台面铺满；串口、检查点、问题、运行记录收进底部抽屉（peek / 半屏 / 全屏，可上拉下拉、可点）；属性是半屏底部抽屉（选中零件时自动打开）；零件库、接线表、构建树是全屏页（同一个左栏换成 fixed inset-0）；底部五个工具 选择 / 连线 / 加零件 / 测量 / 更多。
- 改接线在手机上：横幅里直接列出可改的线（chip）选起点，免得在 3D 里点细线；按住台面时取 40px 内最近的引脚圈，用 DOM 画一个 ×2.5 的放大镜（引脚名 + 占用 / 用途），松手接上。
  - 替代：截 WebGL 画面做放大镜——要 preserveDrawingBuffer 或每帧读像素，性能和实现成本都高；DOM 放大镜已经能说清手指下是哪个引脚。
- 手机上把实验台改成可操作（原来是「只读」提示），因为抽屉、放大镜已经解决了窄屏点不准的问题。
- 采购 / 组装 / 成品在手机上：台面区域用 `invisible`（visibility）而不是 `hidden`——3D 画布要保持非零尺寸，否则 WebGL 报警告、组装 3D 拿不到尺寸；各块按 order 排成单列卡，底部吸附主按钮（`#mNext`）。采购的「淘宝 / 立创」搜索链接留在选中零件的详情卡里（每个零件一组），不另做一排。
- 台面快捷卡（card.tsx）在手机上 portal 到 body、变成底部抽屉：采购的「换开发板…」原来挂在隐形的台面里，看不到也点不到。
- `#simtime`、`#cmdk`、`#console`、`#toolbar` 在手机各步骤都保留在 DOM 里（隐藏也行）：main.tsx、cmdk.ts、采购选板卡都直接按 id 取这些元素，缺了会让启动中断。
- 顶栏四步条做成 50px（按钮 44 + 下边距），手机 `--top-h` 99px。
- 成品步骤的「按键网格」用属性卡里已有的按键（按 BOOT / 热源 / 声音 / 拍照 / 录像），3D 放最上面但不是全屏——全屏 3D 会盖住读数和按键，单列卡更好用。
- 新增回归 `tools/webtest/mobile.mjs`（接进 accept.sh 网页段）：组装解锁用 localStorage 预置检查点，和 asm3d.mjs 一样；"自己的固件通过才算"仍由 levels.mjs 测。

## 2026-10-17 · P2-13 验收缺口 / P2-18 FT6236
- c3-ultrasonic 与 s3-ultrasonic 共用一份 main.c（CMake 引用 `../../s3-ultrasonic/main/main.c`，`target_compile_definitions` 改引脚），与 ruler-dist 同做法；C3 上 Trig=GPIO4、Echo=GPIO5：避开 strapping（2 / 8 / 9）、USB（18 / 19）、flash（12–17）和 I2S 约定脚（0 / 1 / 2）。
  - 替代：复制一份源码——两份会慢慢走样，判定也得维护两套。
- c3-i2s-tone 是 s3-i2s-tone 的拷贝（只改引脚 0 / 1 / 2 和 OK 行）：S3 版把引脚写在文件中间，抽宏要改 S3 固件，和别的代理冲突的面更大；判定（440 Hz、RMS）两边相同。
- gptimer 验收固件 C3 / S3 共用一份源码（s3-gptimer 引用 c3-gptimer/main/main.c）：IDF gptimer API 两颗芯片一致；判定用 accept 的 `numeric` 带容差（计数 / 经过时间 ±400 µs，50 周期 ±5 µs，首次 / 单次告警 ±10 µs），不写死模拟器当前的精确值。
- 修 TIMG 自动重载：原来"结算时"才把计数改回 load，结算发生在下一次读寄存器 / 下一个时间片，重载相位随结算时刻漂（50 个 10 ms 周期误差可到几十 µs），而且固件在中断里读计数能读到 ≥ 告警值。现在按真机"计数到告警值那一拍重载、接着往上数"：重载后计数 = load + (当前 − alarm)；告警装上时如果已经过点（真机立刻触发），记 `t0_alarm_late`，这种情况重载后从 load 起数、不补超出部分。写任何 TIMG 寄存器前先 `update(now)` 结算已到点的告警，避免锁存 / 改配置跨过重载。已有 74 个 accept 用例新旧二进制 stdout 逐字节相同。
  - 替代：按告警周期取模算当前计数（无状态）——要处理告警值被改写、暂停 / 继续、单次 / 自动重载混用，复杂度高，收益只在极长时间无寄存器访问时才有。
- `parse_touch`（脚本 `touch=x,y`）截断上限从 239 改成 4095（12 位）：FT6236 常配 320×480 屏，239 会把坐标截坏；CST816S 在自己的 `press` 里仍截到 239，原有用例不变。
- FT6236 模型：寄存器 / 事件位按 FocalTech《FT6x36 Datasheet》与应用笔记（只读数据手册，不看 GPL 驱动代码）。只模拟一个触点（第二触点恒"无事件"、ID 0xF）；GEST_ID 恒 0（多数模组固件不报手势，主机自己判）；G_MODE 出厂值取 0（轮询模式：按着期间 INT 一直低），INT 按电平建模，触发模式下真机的低脉冲不模拟——"下降沿中断"和"低电平期间轮询"两种写法都能工作；事件位：按下后第一次读 0x03 报"按下"(0)，之后"接触"(2)，抬起报"抬起"(1)、TD_STATUS=0。休眠（PWR_MODE=3 后不应答）、多点、权重 / 面积变化未做。功耗按 4 mA 估算。出厂 G_MODE / TH_GROUP 实际值随模组固件，待真机核对。
  - 替代：复用 CST816S 结构加分支——两颗芯片寄存器排布完全不同，分开更清楚。
- s3-ft6236 用裸 `i2c_master` 驱动（不用 esp_lcd_touch_ft5x06 组件）：不新增组件依赖，也能直接验证寄存器层；不挂器件时打印 "no ACK" 并停住而不是 abort，给出"接线 / 地址"提示（s3-ft6236-absent 反例）。
- 网页串口输入回归放进 `webtest.mjs` 的 echo 分支（示例页 `#uartIn`），而不是新脚本：一个示例一个分支，跟 s3-usb-cdc 的终端输入同一写法；accept.sh 网页冒烟列表加 `echo:串口回显`。

## 2026-10-17 手机成品全屏 3D（P2-17）
- 决定：手机成品页（< 768px）3D 占满顶栏以下到底部面板之上（`#mProduct`，flex 列），底部面板 = 一行串口 + 4 列按键格 + 预览时的主按钮；推翻 U-05 时「全屏 3D 会盖住读数和按键」的单列卡做法——按键格和串口固定在 3D 下面，不叠在画面上，所以不盖。
- 按键只放作品真有的交互：weather 按 BOOT / 热源，spin / lens 按 BOOT，lamp 旋钮 −1 / +1 / 按旋钮，ruler 挡板近 / 远 10 cm，tilt 右边放低 / 左前放低 / 放平，imu 放平，usbkey K1–K4（与 3D 键帽同一组引脚和键帽字）；再加声音（有蜂鸣器才有）、拍照 / 录像 / 复位视角（有 3D 才有）、详情（打开原属性卡抽屉）、再跑一次。桌面工具条不变。
- 串口条点开就是实验台那个串口抽屉（半屏）：shell 在抽屉打开时给 Dock 传 step="bench" 复用 PhoneDock，不改 dock.tsx；收起回 peek 时 Dock 不渲染，回到全屏。
- 双指缩放用 OrbitControls 默认（enableZoom，canvas touch-action none），不另写手势。
- 代价：手机成品页不再显示零件 / 装法树（左栏隐藏），换作品走顶栏 ▾。
- 替代：3D 上叠浮动按键（设计稿另一案）——遮挡 3D 且难保证 44px 不重叠；保留单列卡——不满足 DESIGN_V2 §5。

## 2026-10-17 字体自托管（P2-19）
- 决定：Noto Sans SC、JetBrains Mono 改为自托管 WOFF2，删掉全部 fonts.googleapis / gstatic 外链，各页 `<link rel="stylesheet" href="/fonts/fonts.css">`（@font-face，font-display: swap，family 名沿用原名，页面字体栈不改）。
- 来源：github.com/google/fonts 固定提交 47d54ca1ebb14fd864695f1d39dc734f39017c33 的 ofl/notosanssc、ofl/jetbrainsmono 可变字重 TTF 与 OFL.txt（OFL-1.1，LICENSING ✅），`tools/fonts/fetch.sh` 下载到 third_party/fonts 并做 sha256 校验。
- 子集：`tools/fonts/subset.py` 扫描 web/src、各 html（含生成的授权页）、示例 / 关卡 / 验收清单里实际用到的字，并上 GB2312 一级字（3755 个常用字，由 Python 自带 gb2312 编解码器推出，不另下字表）和 ASCII / 中文标点，共约 3970 个码位；等宽字留整套 cmap（只含西文）。体积：原件 Noto Sans SC 可变 TTF ≈ 17 MB → tb-sans-sc.woff2 ≈ 1.05 MB；JetBrains Mono ≈ 190 KB → tb-mono.woff2 66 KB。产物 web/public/fonts/ 被 git 忽略，build_web.sh 每次构建生成（字集没变就跳过，戳记放 third_party/fonts）。
- 工具：fonttools 4.60.1 + brotli 1.1.0（MIT），装在 tools/fonts/.venv（brew 的 python3.12 建，git 忽略），不碰系统 python；build_web.sh 缺 venv 时自动建。
- OFL：子集是"修改版"，文件名不用原名（Noto 的保留名是 "Source"，两个都改成 tb-*），OFL.txt 原样放在字体同目录并在授权页附全文与来源提交链接。
- 失败兜底：没网 / 没 venv 时 subset.py 写一份只有注释的 fonts.css，页面退回系统字体，构建不失败。
- 替代：Google Fonts 外链（外部请求、国内不稳定）；unicode-range 分片（首屏更小，但要维护分片表，后续再说）；系统字体（各平台字形不一，和设计稿差距大）。
## 2026-10-17 · P2-14 接线错误走网络求解
- elec 加一个元件 `Diode`（PWL 两段：截止 / 导通 vf + rd），网表用 `*tb: DIODE 阳极 阴极 vf rd`，ngspice 侧用等价的 B 源。红色 LED 1.8 V / 10 Ω，引脚钳位二极管 0.6 V / 10 Ω（估算）。
  - 理由：MNA 已经是 Katzenelson 折线迭代，加一段折线不改求解器；与 LDO、限流源同一套写法。
  - 替代：指数二极管（Shockley）+ 牛顿迭代——更准，但要改求解器、和 ngspice 的对照也要换模型参数。注意：tools/elec 2% 对照验的是「同一个折线模型」解得对不对，不是二极管物理。
- GPIO 输出内阻由 ESP32-C3 数据手册 v2.4 表 5-4 推：最强档 I_OH 40 mA @ VOH ≥ 0.8 VDD、I_OL 28 mA @ VOL 0.495 V → 16.5 / 17.7 Ω；IDF 默认驱动档 GPIO_DRIVE_CAP_2 约一半强度，取 33 Ω（推高）/ 35.36 Ω（拉低）。S3 同量级，共用。
- W1 按最坏情况：电位器滑片转到头（接触 1 Ω）、编码器触点闭合（1 Ω，推高靠 10 kΩ 上拉）、HC-SR04 Echo 5 V 推挽约 50 Ω（有分压时 667 Ω）、其它 CMOS 输出同 GPIO 内阻；每种组合都解一遍取电流最大的，卡片上写出是哪一种。
- W2「5 V 进 GPIO」：5 V 经模块 10 kΩ 上拉（I2C）或推挽输出内阻进引脚钳位二极管灌进 3V3 轨；后果门限：VIH 上限 VDD + 0.3 V（表 5-4）、注入 > 1 mA 视为有害——乐鑫没给注入电流上限，1 mA 是经验值，标「估算」。
- 新增 W7「电源短路」：实验台原来没法把电源轨接地（改接只改零件那根线的开发板端）。`WireMods.jumpers` 加「开发板针到开发板针」的跳线（零件名 `jumper`），3D 用 `pick.bridge` 画一根红线；目前只有 `?debug=1` 的 `injectWiring('short3v3' | 'short5v')` 能造，没做手动连跳线的工具。W4 / W5 / W6 规则本身没动。
  - 替代：把零件的 VCC 改接到 GND——那是「零件反接」，不是电源短路，电流也不同。
- 求解在主线程：`faultsolve.ts` 用 `loadWasm()`（同一个 tryboard.wasm，已缓存）单独实例化一份，只调无状态的 `tb_fault` / `tb_fault_out`，结果按（芯片、规则、线、参数）缓存。
  - 理由：模拟器 worker 没启动（没固件、换固件中）也能算；同一二进制同一参数，结果与命令行 `tryboard elec-net` 解同一网表一致（webtest/elec.mjs 对拍，差 ≤ 0.05 mA，即网页显示精度）。
  - 替代：走 worker 消息——要改协议，且接线检查是纯函数、不该依赖机器状态；在 TS 里重写折线求解——两份实现会漂。
- `tryboard-wasm` 依赖 `tryboard-elec`（仓库内 crate，不是第三方），wasm 增大约 7 KB（645 KB，仍 ≤ 2 MB）。
- 实验台网表跟芯片走：S3 板芯片 + 板上负载 43 mA、C3 35 mA，所以短路另有 16 / 17 两份 S3 网表给网页对拍（实验台上的作品多是 S3）。
- `?debug=1&wiring=<种类>`：打开就造一种错接并弹出接错线卡片（agent-browser 不能跑页面脚本时的人眼验收入口），与 `__tbApp.injectWiring` 同一入口；`__tbApp.faults()` 多给 `mA` / `est`，`__tbApp.showWrongWire(线 id)` 打开卡片。
## 2026-10-17 · P2-15 代码页签 / P2-16 台面直接放零件
- 源码打包：`tools/gen_fw_src.py` 在 `tools/build_web.sh` 里随 `web/public/fw/<名>/flash.bin` 一起生成 `src.json`（main/*.c *.h、被 include 的 firmware/common 头、CMakeLists.txt、sdkconfig.defaults），代码页签打开时才 fetch，不进首包。
  - 替代：vite 插件 / import.meta.glob——会把源码打进 JS 包或要另配插件；与 fw 目录同一个生成脚本最简单。
- C 高亮用自写的小 tokenizer（`web/src/app/ctoken.ts`：注释 / 字符串 / 预处理 / 关键字 / 类型 / 数字 / 函数调用），不引 highlight.js / prism：只读显示用不着完整语法，零依赖。
- 上传的 .bin、没有 src.json 的示例：代码页签显示原因（flash 镜像里没有源码），不猜、不反汇编。
- 台面放零件是「先放、再逐根接线、接完才进场景」：拖到台面（或点「放」）只开横幅和引脚圈，每一步只亮该类引脚（GPIO / GND / 3V3·5V），全部接完才 `applyScene` 加进场景；中途 Esc 取消场景不变。
  - 理由：场景里的零件必须有确定的引脚才能进模拟器，半接的零件没法模拟也没法做接线检查；不摆「没接线的摆设」。
  - 替代：先在 3D 里摆一个未接线的件——要给场景加"未接线"状态，接线检查 / 指纹都要跟着改，收益小。
- 只开放台面已有引脚器件模型的 14 件（LED、按键、蜂鸣器模块、SG90/MG90S、电位器、BME280、SSD1306、MPU6050、QMI8658、编码器、HC-SR04、WS2812 灯条 / 灯棒），其余在元件库里灰掉并写原因（无模拟模型 / 引脚由固件固定在 SPI2·I2S / 只有三针蜂鸣器模块模型）。表在 `web/src/app/place.ts`。
- I2C 器件按地址挂在模拟器总线上，模拟器本身不按 SDA/SCL 引脚判断能否扫到；接错 I2C 引脚只由接线检查报。STATUS 里写明。
- 电源针接了不是本来的那一路（如 BME280 VCC 接 5V）：场景照常加，并把这根线记成 `WireMods.retarget`，由接线检查报 W2——和改接线模式同一套，不另造规则。
- 放置记成一条 hist `scene` 操作，带 label「放 X（针→GPIO…）」：`applyScene(scene, power, label)` 新增可选 label，session 记 `sceneLabel`；时间线显示它而不是「按清单摆上 N 件」。
- 顺手修：`applyScene` 换零件后没刷新蜂鸣器引脚（`audio.setPins`），台面上新放的蜂鸣器不响。
- 同类模块（除 LED / 按键）一次只能放一个、I2C 地址冲突直接拦：场景模型按类型单例。
- 手机上的元件库暂不支持放零件（仍链到采购）：手机放置要配合放大镜逐根选针，留作后续。

## 2026-10-17 · P2-07（续）LVGL 网页实时倍率 ≥ 0.5×
- 决定：Xtensa 解释器加**预解码缓存**（`core/crates/xtensa/src/fast.rs`）：32K 项直接映射，按 pc 低位索引，命中条件是 pc 与本次取到的原始指令字节都相同。解码结果只依赖 (pc, 字节)，所以自修改代码、IRAM 重载、MMU 改映射都会因字节不同而自然重解码，不需要任何作废逻辑——这是选它而不是"基本块缓存 + 写监视作废"的主要理由：正确性只靠一个比较，不会因漏作废而出错。每条指令仍真实取指（取指页缓存），所以总线行为不变
- 约 100 个常用操作解码成扁平 `Op` 枚举直接执行；其余（实测约 4%，主要是窗口异常处理里的 L32E/S32E 和特殊寄存器读写）回落到原 `exec`，不重写一遍。ENTRY 的窗口溢出检查依赖运行时 PS.CALLINC，max_quad 标成"动态"现算
- 热循环：`cycles` / `instret` 在 `run_batch` 里放局部变量、退出（或回落到通用 exec、定时器慢路径）前写回；"有没有可能要进中断"缓存成布尔，在改中断线、定时器触发、写 INTENABLE 时刷新，每条指令只看布尔；`load` / `store` 强制内联、越界异常放冷函数。`attention()` 仍每条指令调用（mmio 读依赖它更新的 now），以保证逐周期一致
- 网页 worker：落后于墙钟时用 MessageChannel 立即让出、接着跑；追上时才 `setTimeout(loop, 4)`。浏览器对嵌套 setTimeout 有 ≥ 4 ms 钳制，原来每片之间白等。`loopGen` 计数防止复位 / 换固件后两个循环并跑。单这一项网页 0.35× → 0.42×
- 结果（负载 < 4）：宿主指令 / 模拟指令 189 → 155；s3-lvgl 原生 0.645 → 0.78×、wasm Node 0.43 → 0.51×、网页 0.34 → 0.52×。确定性用基线二进制对拍：81 个 accept 用例 stdout、24 个关卡指纹、LCD ppm、`--trace-io` 全部逐字节相同
- wasm `+simd128` 做了 A/B：Node 仍 0.50×（解释器是分支密集的标量代码，用不上 SIMD），体积 657 KB vs 662 KB；还会把 Safari 门槛抬到 16.4+。不采用
- 试过没留：缓存缩到 8K 项（未命中变多更慢）；窗口检查先判 max_quad==0（更慢）；attention 改成每 64 周期一次（会改变 mmio 读到的时刻，违反确定性）
- 替代：基本块缓存 / 跳转链（再快约 1.5–2×，但要处理块内中断、LOOP、窗口异常的精确边界和作废，风险高）；wasm JIT（生成 wasm 模块，工作量和安全面都大）。余量不大，若以后 0.5× 不稳再考虑块缓存

## 2026-10-17 实验台说明卡在桌面布局封顶 40vh
- 决定：实验台右栏「这个示例」卡在宽 > 900px 时 `max-h-[40vh]`、超出自己滚动（web/src/lab/App.tsx）。
- 理由：右栏是 `1fr / auto` 网格，说明卡高约 350px 不封顶；视口高 < 约 650px（小笔记本、浏览器缩放、agent-browser 默认 1280×577）时串口监视器被挤到 5px，标题叠在说明上。封顶后 577 / 720 / 900 高下串口 171 / 257 / 378px。
- 替代：串口设最小高度（会让右栏整体溢出、底部编辑栏被推出屏幕）；说明卡默认折叠（多一次点击，大屏上反而难用）。

## 2026-10-17 · 统一实验台：index.html 退役（U-07–U-10，推翻 P0-21 中「index.html 保留」一条）
- 决定：示例改在工作台里开（`app.html?work=blank&example=<id>#bench`），`index.html` 变成跳转页；旧实验台 src/lab 的独有功能迁进工作台后删除。
  - 理由：两套实验台布局、用词、串口位置、能选的芯片都不同，首页「空白实验台」和选型助手 / 示例链接各进一边（设计评估见 DESIGN_V2 §6）。工作台的会话本来就按 `work.example` 从 examples.json 取台面和芯片（session.ts），C3 开发板也已支持，合并的主要成本是迁功能和回归脚本。
  - 替代：两套都留、只统一页头（根因不变，功能继续分叉）；把旧实验台改成工作台皮（等于再维护一套）。
- 芯片按固件头自动识别（`imageChip`，assets.ts）已有：换固件时上传的 .bin 不用手选芯片，设计稿里那句不是新功能。
- 回归脚本改指向工作台，选择器尽量由工作台提供同名 id（`#console` `#ratio` `#simtime` `#uartIn` `#usbTyped` `#usbCdcIn` `#usbCdcOut` `.env input`），断言不改。
- 空白作品的「下一步」是「想装壳？挑个作品 →」（去 home.html#works），不是设计稿里的「存为作品」：现在没有保存作品的功能，按钮不能指向不存在的东西。
- 去掉台面工具条和固件卡里的「再跑一次」：和运行组里的「重启」（`#runRestart`）是同一件事。interact.mjs 改点 `#runRestart`，断言不变。
- 锁住的组装页调 `setBare(true)`：左栏、属性栏、运行组都收起，只留一张检查点卡；解锁后 `setBare(false)`。成品步锁住时同样只给一个「回实验台 · 还差 N 个检查点」。
- 空白作品标题从「空白实验台」改为「空白」：面包屑首段已经是「实验台」，再叫「实验台 / 空白实验台」重复了。levels.mjs 对 `#workName` 的判断随之改为 `/^空白$/`。
- 「换固件」菜单里的「最近用过」：示例记 id，上传的文件只记文件名和时间（浏览器不让重读文件内容），点文件名会重新打开选文件框。最多 3 条，存在 localStorage `tryboard-recent-fw`。
- 手机上的换固件抽屉用 `createPortal` 挂到 body：手机顶栏自己是一层层叠上下文（z-20），抽屉留在里面会被串口抽屉和底栏（z-24–27）盖住。agent-browser 截图发现了这个问题，mobile.mjs 新增了「没被盖住」的断言。
- 「固件读到」的正则改为 `\s+`：bme280 示例的输出用两个空格分隔（`T=23.50 C  H=…`），原来只认单空格，读数一直卡在「等固件打印…」。
- 打包 artifact（pack_artifact.py）改用 app.html 作页面；body 上的 class 和 data-step 用一小段脚本补回去，因为打包时只取 body 内容，属性会丢。
- 组装页里的 SVG 电源键「开机看成品 →」（views/assembly.ts，和装配视图共用）不改名：它的意思是给装好的成品上电，不是步骤条上的「下一步」，所以不算用词表里要统一的「进组装」。
- 窄桌面（769–1100px）顶栏的「换固件 ▾」会收起，⋯ 菜单里补一项「换固件」（宽屏隐藏），避免这个宽度下除了空台面卡就没有入口。

## 2026-10-18 · 新主张、文案、去 .html 后缀、授权页改「一页声明 + 完整文件」（U-11–U-13）
- 主张：首页主标题改为「试板：完全免费的线上 AI 智能硬件实验台」，副标题「高仿真 3D 动画，可直接运行真实固件」（人指定）。同一思路改了其余口语化或绕的文案，逐条见 DESIGN_V2 §7（设计稿：artifact「试板 · 授权页与文案优化」的「文案对照」板）。
- 超声波尺子简介：人给的「蜂鸣器跟着一起强弱变化」与固件不符——firmware/ruler 的蜂鸣器是 LEDC 开 / 关、按距离改间隔，音量不变。按事实写成「蜂鸣器随距离快慢变化」，汇报里说明。
- 「选型助手」改名「选板」（导航、标题、页面名），地址 `/select`。
- 去后缀只做第一步：页面文件仍是 `xxx.html`，站内链接一律写成不带后缀的 `./app?work=…#bench`、`./select`、`./licenses`、`./`（首页）。
  - 理由：Vite 6 的开发和预览服务器本来就会把 `/app` 映射到 `app.html`（htmlFallbackMiddleware），主流静态托管（Cloudflare Pages、Netlify、Vercel cleanUrls）也默认这样做，不用写插件、不改路由。
  - 第二步（`/works/weather/shop`、`/lab/bme280` 这种路径化地址）暂缓：要把 `base: './'` 改成绝对路径（会破坏 pack_artifact 打包和子路径部署），还要把作品步骤从 hash 路由搬到 path 路由，牵动所有 `location.hash =` 和十几个回归脚本。等定了托管平台（上线前要问人）再做。站内链接集中在 `web/src/ui/links.ts`，届时改一个文件即可。
  - 首页：`index.html` 改为首页（原 home.html 的内容），`/` 就是首页；`index.html?example=X` 仍跳到工作台示例（旧链接兼容）。`home.html`、`advisor.html`、`levels.html` 留作跳转页（保留 query 和 hash）。
  - 回归脚本自带的静态服务器同样加「无后缀 → .html」回退，新增一条「旧地址都能跳到新地址」的测试（levels.mjs）。
- 授权页用设计稿 C 版（人选定）：页面只有「试板本身 / 第三方组件概述 / 特别感谢 / 完整清单（两个下载）/ 商标」。原来逐包贴全文的内容移到同时生成的 `THIRD_PARTY_NOTICES.txt`（每个组件的版权行 + 每种许可证全文一次 + 修改过的素材说明），另出 `tryboard.spdx.json`（SPDX 2.3，含不随网站分发的构建工具，标注出来）。LICENSING.md 规则 8 相应改写：署名义务由页面 + NOTICES 文件共同满足。
  - 组件数、文件大小、生成日期都由脚本算，不写死。
  - 设计稿 C 里的「发现遗漏？告诉我们」不做：没有对外联系渠道，开渠道属于要问人的事。
  - 替代：A 版按许可证归并（人没选）；B 版可搜索清单（组件少时功能过剩）。
  - 实现补记：NOTICES 文件头加 UTF-8 BOM（静态托管给 .txt 常不带 charset，浏览器直接打开会把中文认错）；SPDX 里写不成标识的 ROM 内含组件（Newlib、miniz、TJpgDec）填 NOASSERTION 并在 comment 里写原文；「特别感谢」六张卡的许可证从收集到的数据取，卡对应的组件不在清单里就不列并告警。
  - 首页主标题按词组分块（试板：/ 完全免费的线上 / AI 智能硬件实验台）只在块之间换行，避免中文按字断行把「线上」拆开。

## 2026-10-18 主流程走查修复（Reviews/ab/flow.md）
- 检查点 / 复测 / 回放的 Worker 加看门狗（verify.ts `runJob`）：20 s 没有任何进度消息、Worker 抛错或消息反序列化失败，都按「没跑完」结束，`verifying` 复位，卡片显示「✗ 没跑完」和「重试」，不记成未通过。
  - 阈值 20 s：最慢的检查点（07 系列）在慢机上进度间隔约 1–2 s，留了十倍余量；`globalThis.__tbVerifyStall` 可改（只给测试用）。模拟本身的步进和时序不动，指纹与 check.py 不变。
  - 替代：按模拟时长估总超时（不同固件差别大，容易误杀）。
- 「换固件 → 上传」在实验台上同时验收检查点：优先当前选中的检查点，否则第一个还没用自己固件通过的；有检查在跑就只换固件。toast 等新运行真的起来（onBoot，3 s 兜底）再弹，菜单先关再开文件框。参考固件一项写明「不算检查点」。
- 采购步骤接入顶栏撤销 / 重做（`actions.shopUndo`，走采购自己的 `{ops, cur}` 历史），实验台的仍走 benchhist。
- 采购的 ✓ 改为看本机是否存过摆台结果（`tryboard-app-placed:<作品>`），刷新后不丢；手机步骤条读同一个 `bc.done`。
- 5V 适配器：清单里有走 EXT5V 的执行器（舵机）、又没有别的 EXT5V 电源时，采购页把它归入「必选」、不能去掉，和 R27 同一口径。模板数据不改（`setPower` 切回 USB 时仍会去掉适配器，R27 会照常阻断，这是有意的实验）。未做「换一个」：目前只有一种 EXT5V 电源。
- PWM 检查结果改写成「脉宽 x ms（占空比 y）」，区间两端相同只写一个值；没过时追加「；要 a ms」（频率不对再加「、f Hz」）。check.py 同步改，文字与网页 / npm 包逐字一致。
- 组装开机复测没过时，实验台检查点卡和手机横幅改为「检查点 n/n 通过 · 开机复测 ✗」（黄色），按钮「回组装 →」；`bc.retest` 新字段。
- 构建树底部「加零件」底栏加上边线和上内边距，列表在线上方截止、能滚到底。
- 首页作品卡：跑起来后的串口状态行在桌面上压在预览底边（绝对定位），卡片不再变高、邻卡不跳；手机单列仍排在最下面。
- 首页流程「采购」副标题改为「列清单、看参考价，先不用真买」：与「买板之前先试板」不再矛盾，步骤顺序不动（采购是列清单，不是下单）。
- 验收命令旁注明 tryboard 命令行包尚未发布到 npm（发布要问人），命令保留。
- 顶栏运行状态在非实验台步骤写「实验台运行中 / 已暂停 …」，和灰掉的运行按钮对上。
- 暂缓：成品步骤底部工具条和右栏重复的 BOOT / 热源 / 声音 / 拍照 / 录像。右栏那组是手机布局和回归脚本（media.mjs）也在用的入口，删哪一组要连同设计稿一起定，先不动。
- 串口视图跟随到底（`stick`）改成每帧最多滚一次（rAF 合并）：以前每收到一段输出就同步读 `scrollHeight`，强制整页重排。固件崩溃循环（如 bme280 固件没接传感器，每次 panic 都打栈转储，4 s 约 4000 行）时，主线程 4 s 里有 3.9 s 耗在这里，页面卡死，editor.mjs 等不到引脚圈而超时。试过给串口视图加 `contain: strict` 和逐行 `content-visibility`，实测每帧布局只从 19 ms 降到 15 ms，没有留下。
  - editor.mjs 的超时还和机器负载有关：负载约 10 时（另有一个 agent-browser 会话在后台跑模拟器）原样失败，负载降下来后原样通过。测试脚本没改。

## 2026-10-18 选板 v3 与闭环（DESIGN_V2 §8，PLAN U-14–U-19）
- 可信度改用「一个墨色、四档填充」（`ui/conf.tsx` ConfIcon），结果状态独占颜色。理由：10-18 起检查点有四种状态色，「估算」的黄挨着检查点会被读成没过。替代：蓝色深浅（蓝已是主按钮 / 链接色，会被当成能点）。
- 成品页重复按钮按 ProdCtl 方案 B（人在画布上看过推荐）：右栏 BOOT / 热源 / 声音，底栏拍照 / 录像，手机抽屉不变。media.mjs 只改选择器、不减断言。替代：A 只留右栏、C 只留底栏（理由见稿）。
- 本批不做：UtilC、LoopC、ProdA–C、ShareC、SelectA / B 整页布局。动态 OG（ShareB 按结果出图）要服务端，部署前要问人，标 ✗。静态 OG 图构建时用 puppeteer（已是开发依赖）渲染，不进 git。
- 深睡唤醒检查：内核没有建模深睡，生成的检查点里它固定是「必须上真机」，列在卡底、不参与判定。

### 接口约定（三个子代理共用，改动要先改这里）
**1. 地址参数**（选板 ↔ 采购 ↔ 分享，`web/src/advisor/state.ts` 一处编解码，两边都 import）
```
/select?t=<模板>&add=<零件,…>&rm=<零件,…>&bat=0|1&net=0|1&sim=0|1&budget=0|60|120|200&req=<需求,…>&board=<选板板子 id>
/app?work=custom&t=…&add=…&rm=…&bat=…&net=…&sim=…&budget=…&req=…&board=…&have=<零件,…>#shop
```
- 零件、需求、模板、板子都用选板（`advisor/data.ts`）里的 id；缺省值不写进地址；`/select?t=weather` 这种旧链接照常可开。
- `have`（我已有）只出现在进采购的链接里：分享链接不带（别人家里没有）。本机存 `localStorage['tryboard-have']`（零件 id 数组）。
- `work=custom` 的作品状态存 `tryboard-app-*:custom`，地址参数变了（换了选板结果）就按新结果重建，旧摆台不复用。

**2. 选板零件 → 采购目录（`web/src/catalog/parts.ts`）对照**（`advisor/catalogmap.ts`）
| 选板 | 目录 | 选板 | 目录 |
|---|---|---|---|
| bme280 | bme280 | oled | ssd1306 |
| ws2812 | ws2812-strip | servo | sg90（加 psu-5v2a，走 EXT5V，同 R27） |
| button | button | pot | pot |
| led | led-kit | battery | lipo-1000（加 tp4056） |
| amp | max98357a + speaker-3w | mic | inmp441 |
| tft | st7789 | relay / pir / camera | 无模型：只进清单，不上实验台，标「必须上真机」 |
- 总会加：面包板 breadboard-400、杜邦线 dupont-ff（「我已有」常勾）。
- 板子：xiao-c3 → xiao-c3；c3-devkitm → c3-devkitm1；c3-supermini → xiao-c3（同芯片代替，说明里写）；s3-devkitc-n16r8 → s3-devkitc1-v11；xiao-s3-sense → xiao-s3；c6 / esp32 / p4 → xiao-c3（「用 C3 代替运行」）。
- 引脚：用选板 `planPins` 的结果，转成 `Wire { part, pin, net }`；XIAO C3 上 I2C 是 D4 = GPIO6 / D5 = GPIO7（与 firmware/bme280 默认一致）。

**3. 生成检查点**（`web/src/app/genlevels.ts`，输入：板子 + 已摆的目录零件及其引脚；输出：`Level[]`，id `custom-<n>`，`work: 'custom'`）
| 条件 | 检查点 | 判定字段 | 可信度 |
|---|---|---|---|
| 总有 | 开机不崩溃，串口有输出 | 新字段 `boots: true`（`seconds` 内无 panic / abort 且串口至少 1 行输出） | 仿真验证 |
| 每个 I2C 器件 | I2C 0x76 有回应（BME280） | 新字段 `i2c_ack: [{ addr: 0x76, min: 1 }]`，参数 `--i2c-log` | 行为模拟 |
| ssd1306 | OLED 收到画面 | `oled_min_pixels: 50` | 仿真验证 |
| ws2812-strip | 灯带收到数据 | `ws2812: { pin, min_frames: 1 }` | 仿真验证 |
| sg90 | 舵机信号 | `pwm: { pin, freq: 50, min: 0.075, max: 0.075, tol: 0.05 }`（脉宽 0.5–2.5 ms 都算过） | 行为模拟 |
| 电池 + 深睡需求 | 深睡后能再唤醒 | 不判定，`manual: true` | 必须上真机 |
- 所有检查点的 `args` 带上板上器件（`--i2c ssd1306@0x3c,bme280@0x76`、`--env 23.5,45,101325`），网页由 `bootOptions` 翻译；`seconds` 取 3。
- 新报告行（只有带 `--i2c-log` 时输出，否则不进报告，旧关卡指纹不变）：`[tryboard] I2C 0x76 应答 <n> 次`，按地址升序，每个有过事务的 7 位地址一行（应答 = 地址字节收到 ACK）。CLI（`core/crates/cli`）与 wasm 报告（`core/crates/wasm/src/lib.rs` 报告函数）同一实现、同一文字。
- 判定文字：`I2C 0x76 应答 <n> 次（要 ≥ <min>）`。`boots`：`开机 <s> s 内串口输出 <n> 行`。tools/check.py、packages/tryboard、web/src/checks.ts 三处逐字一致。
- check.py 读生成 Level：`tools/check.py <bin> --level-json <文件>`（从网页「导出检查点」下载的 JSON，数组或单个 Level）。
- 演示固件 `firmware/c3-thermo`（XIAO C3，BME280 + SSD1306，GPIO6/7）：每秒读一次，串口一行 `T=.. C  H=.. %  P=.. hPa`，OLED 显示读数；加 accept.json 用例。

### U-18 / U-19（成品页与 OG）
2026-10-18
- **成品页去重按 ProdCtl 方案 B**：右栏只留「操作板子」（BOOT / 热源 / 声音，及台灯旋钮、尺子挡板、体感倾斜这类作品专属动作）；桌面底部工具条只留「记录」（拍照 / 录 10 秒），视角（旋转 / 复位视角）和「重启」也留在工具条——它们不是重复项，稿里也在底部。只改 product.tsx 的 `syncToolbar`，别的步骤自己设工具条组，不受影响。手机：底部工具条仍一套（操作 → 记录，`phoneGroups` 不变），详情抽屉里右栏那组操作键 `max-md:hidden`，避免抽屉里再出一套。替代：两边都留（就是要去掉的重复）、操作也放工具条（方案 A，右栏读数和操作分家）。
- **「不能模拟的项」标题用 `Conf c="必须上真机"`**，不再是纯文字；product.tsx 里已没有按颜色区分可信度的徽章（剩下的 `Res kind="na"` 是结果状态，不是可信度）。
- **真买卡挂在成品右栏末尾**，只在装完（非参考成品）时出现；数据：remaining = 采购步存的清单（`loadBom` + `replay`）减去「我已有」（`tryboard-have` 经 `PART_MAP` 换成目录 id，含 `with` 附件；找不到映射的按原 id 比）；fingerprint = 检查点全过时最后一个检查点的指纹，否则 null；manual = product.tsx 已有的 `CANNOT[作品]`（不另起一份清单）；checked 存 `tryboard-manual:<作品>`；下载 flash.bin 只在用户自己的固件（fwName 不带 `/`）时给。buycard.tsx 按任务要求没动，目前骨架返回 null——实现时要照顾右栏 312 px 窄单列 / 手机详情抽屉。
- **全站静态 OG**：每个 HTML 入口（含 gen_licenses 生成的 licenses.html）加 og:type / og:site_name / og:title / og:description / og:image / og:image:width·height / twitter:card=summary_large_image。跳转页（home / advisor / levels）用首页的标题和描述。图由 `tools/webtest/og.html`（仿 ShareA，文案按 §7.1 新主张而不是稿里的旧标语；logo 与 ui/logo.tsx 同几何的反白版；系统字体栈、零外网请求）经 `tools/webtest/og.mjs`（复用已有 puppeteer-core，不加依赖）渲染成 `web/dist/og.png`，脚本断言 1200×630、每个入口标签齐全且 og:image 指向的文件存在；挂在 `tools/build_web.sh` 的 vite build 之后，失败即构建失败。og.png 是构建产物，不进 git。
- **og:image 暂用相对地址 `./og.png`**：上线定域名后改绝对地址（上线前要问人）。不少抓取方只认绝对地址，所以现在分享卡片未必出图。
- **选板结果的动态 OG 不做**（每个结果一张图要服务端），PLAN 里由主会话标 ✗。
### U-17（custom 作品与生成检查点）
2026-10-18
- **演示固件算进度**：「先跑演示固件看看」跑的 c3-thermo 结果按「自己的固件」记进度（own=true），全过后弹真买卡。理由：c3-thermo 正是按选板引脚表（XIAO C3，GPIO6/7）写的，真机上烧的也是它；不算的话，只想看效果的人永远拿不到真买卡。替代方案是只当参考固件、不计进度；没采用，因为那样闭环断在最后一步。只有 C3 + （BME280 或 SSD1306）+ I2C 全在 GPIO6/7 时才给演示固件。
- **手动项不进 work.checkpoints**：`manual: true` 的 Level 只列在检查点卡底部「上真机才知道（不判、不计入）」，并进真买卡第 3 栏。进度分母只数要判的条目。
- **一次拖入全判**：所有生成的检查点 args / seconds 都相同，同一份固件指纹也相同，所以拖入固件后逐条跑全部要判的检查点（verifyAll），而不是只判当前选中的那条。
- **只在本页刚通过时自动弹真买卡**：刷新后恢复进度、重放时间线都不弹，因为在手机上它会盖住整个台面。之后靠检查点卡的「看真买卡 →」、顶栏的「下一步：做成真的 →」或手机横幅打开。
- **改了采购清单就重载**：采购步改了零件，重新生成的检查点和之前不同时，`location.hash='bench'` 后整页重载，让 session 拿到新的 levels。理由：session 的 levels 在创建时就定了；整页重载比热替换简单，也不会留下旧检查点的进度。
- **实验台用 DevKitM-1 外形**：C3 只有 DevKitM-1 这一块 3D 板，XIAO C3 在台面上用它的外形，引脚号照 XIAO 的引脚表（GPIO6/7）。采购清单与真买卡仍写 Seeed XIAO ESP32C3。
- **真买卡接口**：BuyCardProps 加了三个可选字段 `title?`、`extra?`（只进清单的无模型零件，算进件数和参考价）、`onClose?`；原有字段不变。进度存 `tryboard-buy-manual:<wkey>`。
- **对拍 fixture**：`tools/webtest/fixtures/custom-thermo.json` 是 genLevels 对 `?t=weather&bat=1`（xiao-c3 + bme280 + ssd1306 + 电池）的输出。genlevels.ts 改了要同步重生成；`tools/webtest/custom.mjs` 会先比对网页生成的结果和它是否逐字相同。重生成：`UPDATE_FIXTURE=1 node tools/webtest/custom.mjs`。fixture 依赖选板数据（weather 模板的零件和 planPins），选板代理合并后如果这些变了，要重生成。
- **任务书占位**：`web/src/advisor/brief.ts` 只是最小占位（签名 `briefMarkdown(s: SelectState): string`）。选板代理的实现合并时以那边为准。
### U-15（选板）
2026-10-18，选板页 v3（`web/src/advisor/App.tsx` 重写，DESIGN_V2 §8.2）。
- **数据**：`data.ts` 加零件 `buzzer`（无源蜂鸣器模块），`PART_MAP.buzzer = { partId: 'buzzer-module' }`（catalogmap 新增一项，既有项不动）；`Template.suggest?` 列每个项目的「建议」零件（虚线框，默认不选）。
- **引擎**：`Need.sim?`：「要在试板里先跑通？」答是时，能模拟的芯片 +40 分（只影响排序，不过滤）。预算是硬过滤，放在 `derive.ts`（引擎不改），0 块时给「去掉 X → N 块」和放宽预算两种出路。
- **`derive.ts`**（纯函数，页面和任务书共用）：`resolve(s)` 一次算出模板、需求、方案、三块对比；`sanitize` 丢掉地址里未知的零件 / 能力 id（旧链接、手改地址不崩）；`changeText` 写「刚才」一行（换板 / 多占或空出的引脚 / 参考价差 / 续航变化，数字全来自引擎）。
- **我已有**：id 规则：板子 = 选板板子 id，`always` = 面包板和杜邦线，`usb-c-cable`，零件 = 选板零件 id，`battery`。存 `localStorage['tryboard-have']`，切换不进撤销栈；只进「按这套开始做」的链接（`encode(s,true)`），分享链接不带。
- **进采购链接**：总是显式带 `board=`，实验台不必再跑一遍推荐。
- **`brief.ts`**：`briefMarkdown(s)`（签名按协调约定）+ `checkpointsOf(r)`。检查点名逐字：`开机不崩溃，串口有输出`、`I2C 0x76 有回应（BME280）`、`I2C 0x3c 有回应（SSD1306）`（地址小写十六进制两位，括号里是芯片名不是零件名）、`OLED 收到画面`、`灯带收到数据`、`舵机信号`、`深睡后能再唤醒`（manual）。genlevels 要与此一致。任务书不写命令行，末行固定「想离线跑的，从仓库本地装 packages/tryboard」。
- **术语**：每次渲染只有第一次出现的术语可点（桌面 Popover、手机底部抽屉、Esc 关）。
- **测试钩子**：`globalThis.__tbSelect = { state, have, brief, go, share }`，只给 `tools/webtest/selectv3.mjs` 读，不是公开接口。
- 删掉 `CONF_VARIANT`，可信度全部用 `ui/conf.tsx` 的 ConfIcon / ConfBar（U-14 的选板部分）。
- 替代方案：把预算放进引擎打分——否掉，「¥60 以内」是用户说的硬线，超了就该不出现，不该只是排后面。

### U-20（结果文案）
2026-10-19，按 DESIGN_V2 §9 重写结果文案。
- **两层**：`CheckResult.text` 不动（与 tools/check.py 逐字一致，levels / custom 测试拿它和命令行对拍），新增 `say`（人话一行）和 `tag`（器件 / 引脚小字）。界面第一层显示 `say`，`text` 收进「原始数据」折叠，测试仍能在 DOM 里读到。
- **器件名**从关卡推断：PWM 50 Hz → 舵机，带 `beeps` 或 100 Hz–20 kHz → 蜂鸣器，`gpio_toggles` → LED，`i2c_ack` 按地址查常见芯片（0x76/0x77 BME280、0x3c/0x3d SSD1306、0x68 MPU6050），查不到写「I2C 器件」。
- **命令行不改**：check.py / npm 包仍输出「通过 / 未通过」和「指纹」——开发者读、脚本解析，改了要连带改 accept 解析；只改界面。
- **状态判定加 `data-verdict`**（ok / bad / stall）：测试按属性判，不再靠「✓ 通过」文字（「没通过」里含「通过」，正则要排除）。
- 替代：在界面层解析 `text` 生成人话——否掉，正则反解析脆，evaluate 手里本来就有数。

### U-21（结果卡 v2 精修）
2026-10-19，按 DESIGN_V2 §9.5 实现画布 PT6Qqq… 的六块。
- **与画布的两处偏差**：①「开机复测」仍在工具栏（`data-tool="asm-retest"`，手机上整行主按钮），没挪进底栏——测试和桌面工具栏都靠这个入口，而且「下一步：成品」本来就不以复测为门槛。② 还没复测时底栏仍是「下一步：成品」（画布写「开机复测」）：mobile.mjs 和用户都可以不复测直接去成品；只有复测没通过时底栏才换成「重装<零件>」。
- **补救动作找「罪魁」**：按装配顺序取第一件选了不 ok 位置的零件，「重装」= `seek` 到放这件之前那一条时间线；找不到（全 ok 但复测没过）时退回「再复测」。
- **分组只在界面层**：`CheckResult` 加可选 `dev`（器件名），`text` / `say` / `tag` 不动；分组键 = `dev + tag`。原始数据里仍一条一条列 `text`（levels.mjs 读 「✗串口出现 …」）。
- **复制给 AI 修**：任务书 + 没过的 `text` 原文，不另造格式，AI 拿到的和命令行看到的一致。
- **暗色 `--on-accent`**：已是深色 #08141f，只把主按钮里写死的 `text-white` 换成 `text-on-accent`。
- 替代：分组放进 `checks.ts` 产出结构化组——否掉，检查点、复测、命令行共用 `CheckResult`，组只是展示问题。
- **走查后补的规则**（Reviews/ab/U-21.md）：复测有补救动作时，面板「开机复测」和工具栏「开机复测」降为普通按钮（一屏一个蓝色主按钮），「当前」框不显示（它的「点下一步：成品」和主按钮矛盾）；「有 N 个器件变了」不数「装配」组；只有一条失败且与标题同句时不画逐条；真买卡用 `createPortal` 挂到 body、`fixed` 全屏遮罩（只盖舞台时两侧栏不暗，像还能点）。


## 2026-10-19 内置固件走完全程（U-22）
- 起因：新人走查（Reviews/ux/report.md）里，没有 ESP-IDF / Arduino 工具链的人卡在实验台：组装 / 成品要求「自己上传的固件」通过全部检查点。这挡住了「买板之前先试板」的核心人群。
- 决定：检查点通过分两档。`CheckOutcome.own=false` 的通过（内置参考固件、选板作品的演示固件）记「◐ 参考跑通」，`own=true` 记「✓ 我的固件」。**解锁组装 / 成品只看通过，不看是谁的固件**；「我的固件 n/N」单独计数，作为荣誉标记。改的是 2026-10-15 那条「参考固件通过不计」。
- 存储：`tryboard-app-checks:<work>` 每条加 `own`；**没有这个字段的旧记录当成 own=true**，老用户的进度不会降级。参考固件的通过只在这一条还没有记录，或者原记录也是参考时才写，不会覆盖自己的通过（沿用原来的 keep 规则）。
- 一键「用内置固件走完全程」：按检查点顺序逐个取 `fw/<ref>/flash.bin` 验收（每个检查点的参考固件不同，没有一份能过全部），最后台面上留着最后一个检查点的固件。
- 选板作品的演示固件（c3-thermo 等）原来记 own=true，改成参考，与其他作品一致。
- 下载：参考固件 `fw/<ref>/flash.bin` 本来就发布了；构建期 `tools/gen_fw_zip.py` 另出 `fw/<ref>/src.zip`。zip 内保持 firmware/ 下的相对布局（`<id>/…`、`common/…`、跨工程引用的源文件），原有的相对 include 和 SRCS 不用改就能 `idf.py build`。附 README（IDF 版本、set-target、验收命令）。只打包仓库自己写的固件；gc9a01 这类组件由 idf_component.yml 让组件管理器下载，不随包分发。
- 气象站检查点 01 / 02 要求 GPIO5 接 LED，台面上 GPIO5 却只有蜂鸣器模块：在气象站模板里加一颗 LED（经 220 Ω）并在 GPIO5 上，和蜂鸣器共用这只脚。真机上电流约 6 mA + 模块基极电流，GPIO 撑得住；成品报警时 LED 跟着亮，算多一个提示。任务书写明「GPIO5 上同时接着蜂鸣器模块，翻转时会咔哒响，正常」。
- 替代：(a) 保持锁住，只给截图——新人看不到组装 / 成品；(b) 参考固件也算 ✓——分不出谁自己做到了，「交给 AI 写」的练习就没意义了；(c) 把气象站蜂鸣器挪到别的脚——要改参考固件，运行编号全变，代价更大。
- 源码包实际做法：文件清单复用 `gen_fw_src.idf_paths`（从 collect_idf 拆出，src.json 逐字节不变），再补工程顶层 CMakeLists.txt 和 main/idf_component.yml；目标芯片与 build_fw.sh 同规则（sdkconfig.defaults 的 CONFIG_IDF_TARGET，缺省 esp32c3）。覆盖 levels.json 全部 ref（含 07 的 spin / lens 分支，README 里写 `--level 07-spin`）+ 演示固件 c3-thermo（README 改给 `--level-json`）。zip 日期戳固定为 1980-01-01，同源码同字节。验收命令写 `build/<id>.bin`（app 镜像，内核按 0xE9 头直接当 app 加载）；s3-blink、spin-face、c3-thermo 解压后实编通过，前两份的 app.bin 用 check.py 过了 01 / spin-1。


## 2026-10-19 竞品调研后做 C-01–C-05（人已确认）
- 起因：对照乐鑫 esp-emulator v0.49（docs/RESEARCH_ESP_EMULATOR.md）。人确认按设计画布 https://claude.ai/artifact/7uo4Q73fYgyusK27EZytZp 实现 PLAN C-01–C-05。
- BLE（M7）从 P3 提到 C-01：路线 a′（按 libbtdm 预编译库字节签名在 .bin 里找 VHCI 边界）先探，不成再走 c（上传 ELF 按符号拦截）。经典蓝牙 / A2DP 仍留 P3。
- 界面统一规则：新面板进现有底部坞，像 USB 标签一样按需出现（「蓝牙」「网络」），「任务」常驻；手机端放进现有底部抽屉，不另开区域。
- C-03 真实网络默认关；打开后的运行不记运行编号（指纹），回复进输入日志，重放按记录算。
- C-05 复用现有固件校验（fwcheck.tsx），只把芯片 id 0 认作可运行。
- C-06（esp-emu 作第二对照源）不做：它只发二进制、授权未定（其 issue #10），要人先定 LICENSING。
- 替代：一次只做 BLE——否掉，SoftAP / 真实网络 / 任务时间线 / 经典 ESP32 彼此独立，可并行。


## 2026-10-19 FreeRTOS 任务时间线怎么抓（C-04）
- 决定：不靠符号、不打补丁，在 CPU 核里认"栈指针 ← 某 TCB 第 0 字"这一条指令（RISC-V `lw sp,0(rs1)`；Xtensa `l32i/l32i.n a1,aN,0`）。FreeRTOS 换任务最后一定这样装新栈，所以只有 .bin 也能用；被装的地址用 TCB 自指签名（状态 / 事件链表项的 pvOwner 指回自己）加可打印任务名确认，再从链表状态推被切出任务是 ready / wait / blocked / gone。
- 时间戳取 SP 装载那一刻（上下文恢复前几十条指令，相对 1 ms 片可忽略）；中断里的时间算在被打断的任务上（不区分 ISR）。
- 退路：TCB 布局不是 IDF v5.5 默认（开 MPU、`configUSE_LIST_DATA_INTEGRITY_CHECK_BYTES`、改 configMAX_TASK_NAME_LEN 之前的字段）→ 签名对不上，不出事件，界面显示「还没看到任务切换：…不是 ESP-IDF v5.x 的」，不瞎猜；名字不可打印 → 忽略这次装载；缓冲满 → 计 dropped、界面提示，不覆盖。
- CLI 开 `--trace-tasks` 时强制 1 ms 时间片（与网页 worker 同），这样网页和命令行的切换周期逐个相同，能对拍。
- 微秒字符串用整数算、半数进位（Rust `{:.3}` 与 JS `toFixed` 在 .5 上舍入规则不同，s3-lvgl 对拍时第 430 段差 0.001 µs 暴露）。
- 恢复 PC → 函数名：CLI 自动读同目录 app.elf；网页默认没有 ELF（不上传就只给地址），可选上传 app.elf 在浏览器本地解析 .symtab，不发出去。
- 替代：(a) 按 ELF 符号拦 `vTaskSwitchContext` / 读 pxCurrentTCB——要 ELF，违背"只靠 .bin"；(b) 用 IDF 的 SystemView / apptrace——要改固件配置；(c) 周期性采样 pxCurrentTCB——要知道它的地址，且会漏短切片。

## 2026-10-19 C-01 BLE：路线 a′（按签名找 VHCI 边界）在 C3 跑通
- 决定：只靠用户的 flash.bin。在 app 镜像的代码段里按掩码签名找 libbtdm 的 8 个函数（`btdm_osi_funcs_register`、`btdm_controller_init / enable / get_mode`、`API_vhci_host_check_send_available / send_packet / register_callback`、`sdk_config_extend_set_pll_track`），取指时把入口覆盖成跳 HLE 魔术地址 0x40060000 + 4×槽（13 个槽，flash 内容不改，复位后重新找）。控制器不跑真代码：借固件自己的 osi 函数表建一个"桩任务"，按模拟时间把事件交给主机（NimBLE）。
- 签名：`tools/ble_sigs.py` 从 IDF 5.1–5.5.1 各版本 libbtdm_app*.a 的目标文件算，重定位字段清零；链接器松弛（auipc+jalr→jal / c.jal、lui+访存→gp 相对）按"指令序列"匹配而不是逐字节。仓库只存掩码后指令值（`soc/src/ble/sigs.rs`），不存库二进制、不存反汇编；授权是否算派生作品**需人复核**（LICENSING 已加一行）。
- pll_track 没有可靠的独有序列：改按调用点定位——`btdm_controller_enable` 调用之前 24 字节内的那次调用（BACK = 24），钩成空操作（槽 12）。
- 虚拟控制器只实现 NimBLE 外设启动和连接要用到的 HCI：Reset / 读版本 / 读地址 / 缓冲区 / 设事件掩码 / 广播参数 / 数据 / 使能 / 连接参数更新等；`0x202d / 0x2029 / 0x2027 / 0x204e`（地址解析、隐私相关）只回成功；Read Remote Version（0x041d）先回 Command Status 再给事件 0x0C，否则 NimBLE 卡在连接建立。
- 虚拟手机（中心 + GATT 客户端）也在 Rust 里（`soc/src/ble/phone.rs`），无第三方 crate；所有动作按模拟时间排队，可确定性重放：输入日志新增 `ble=<命令>`（scan / scan off / connect [地址] / disconnect / read / write / sub / unsub / auto），网页操作手机就记一条，`tryboard run --inputs` 逐字节重放；CLI `--ble-phone` = 第 0 个周期 `ble=auto`。
- 网页：固件用了 BLE 才出现「蓝牙」坞页签（空中日志，按模拟时间）和构建树「无线 → 虚拟手机」（属性面板 / 手机抽屉里的手机）；没认出边界时坞里显示「BLE 需要再拖一个 app.elf」卡。新示例 `c3-ble-hr` 进示例库（tags 标 ◐ 行为模拟）。
- 没做：路线 c（上传 ELF 按符号拦截）只做了提示卡，没接到内核——当前 IDF 5.5.1 的 .bin 都能认出，先不做；S3（Xtensa 版 libbtdm，签名要另算）留后；中心模式、经典蓝牙、Mesh 不做。
- 替代：按 ROM 地址拦（路线 a）——否掉，libbtdm 重新定义了 ROM 731 个 `r_*` 里的 677 个并经函数表调度，ROM 副本基本是死代码（见 RESEARCH_ESP_EMULATOR.md）；只做路线 c（要求用户传 ELF）——否掉，多一步上传，大多数人只有 .bin。

## 2026-10-19 经典 ESP32（C-05）
- **核复用、不复制**：`tryboard-xtensa` 加 `Variant`（Lx7Esp32s3 / Lx6Esp32）。对照两颗芯片的 core-isa.h，本核实现到的选项全部相同，只差 HW_VERSION / CONFIGID；不分两份代码。替代：拷一份 LX6 核——否掉，两份同步改不过来。
- **SoC 新建 `core/crates/esp32`**：外设凡是寄存器语义和 C3 / S3 一样、只是基址 / 偏移不同的（TIMG、SPI1、LEDC），在 `periph.rs` 做地址翻译层后复用原模型；I2C 命令码、命令表长度、SCL 时钟不同，加 `I2cLayout` 参数（C3 / S3 输出逐字节不变）。
- **LEDC tick_sel**：经典 ESP32 的 LEDC timer 用 tick_sel 选源：0 都是 REF_TICK 1MHz，1 时高速组 = APB、低速组 = SLOW_CLK（APB_CLK_SEL 选 APB 80MHz 或 8MHz），不是 C3 的全局选源；翻译层按它算频率，esp32-fade 5kHz 对上。
- **PHY 轮询**：ESP32 射频校准轮询的寄存器偏移与 C3 相同，只是 APB 基址 0x3FF40000；有两处语义相反或独有（FM SAR 位 26..24 回 0、PLL 换频位 8 启动 / 位 31 完成），写进 `WifiLayout::ESP32` 的 rf_polls。
- **Wi-Fi 标 ◐**：`esp_wifi_init` / `start` 能过（esp32-wifi-init），但 ESP32 的 MAC 是上一代 IP（0x3FF73000 一带，收发描述符格式与 C3 / S3 不同），这批不做收发；esp32-wifi（连 AP + HTTP）停在 reason=201，**不进 accept**、在 PLAN / STATUS 标 ✗ 原因。替代：照 GPL 的 QEMU esp32 模型抄——不允许；逆向上一代 MAC 工作量与 C3 那次相当，留待以后。（后续：同日补上，见下一节「经典 ESP32 Wi-Fi 收发」。）
- **RMT ✗**：ESP32 的 RMT 寄存器布局（8 通道 conf0/conf1 交错、RAM 64 字 × 8、没有 sys_conf）与 C3 / S3 不兼容，这批不做；选型里依赖 RMT（WS2812）的零件对 ESP32 标「必须上真机」。
- **选型标注**：advisor 的 esp32 芯片从 simulated 'none' 改为 'partial'；ESP32 只认 GPIO / PWM / I2C 三类需求为可仿真（`engine.ts` SIM_KINDS），其余零件「必须上真机」；需要蓝牙 / 经典蓝牙、DAC / 触摸时另列「必须上真机」行（霍尔随 DAC / 触摸一行）。选板 esp32-devkitc 直接映射到新板 esp32-devkitc-v4，不再用 C3 代跑。
- **1″ 排针的简化**：DevKitC 两排针相距 25.4 mm，830 孔面包板中缝两边 a–e / f–j 排距不是这个数。做法：整板 z 偏半格，J1 落 j 排、J3 落 b 排（`BoardSpec.rowSpan`），J1 外侧没有空孔时跳线端点就落在针脚自己那个孔上（`boardHole`）。真机上 DevKitC 插 830 孔板也只剩一侧一排孔，这和实物一致。
- **`tb_image_chip` 认不出返回 u32::MAX**：0 现在是 ESP32 的芯片 id，不能再当"认不出"。网页 `imageChip` 认不出仍按 C3。
- **短路 / 过流估算沿用 C3 的数**：ESP32 的 GPIO 驱动能力（40mA 档）与 C3 同量级，`tb_fault` 不另开参数；结论本来就标「估算」。
- **LCD / I2S 接线占位**：`LCD_WIRING.esp32` 用 VSPI 常用脚（SCLK 18、MOSI 23、CS 5、DC 16、RST 17、背光 4），`i2spins.ts` 给 26/25/22（喇叭）、32/25/33（麦克风）。ESP32 上这两类外设没模型，只为界面不崩。
- **多做的 esp32-fade**：LEDC 是 M2 验收项之一，顺手进 accept。
- **eFuse MAC**：出厂 MAC 用本地管理地址 02:54:42:00:00:04（不冒用乐鑫 OUI，末字节与 C3 / S3 模拟板区分）并按 esp_efuse_table 算好 CRC8，IDF 校验能过；芯片版本 v3.0 由 eFuse REV1 / REV2 位加 APB_CTRL_DATE 位 31 组成。
- **串口「跟随最新」误关**（走查发现）：串口刷屏时 scroll 事件异步到达，此时新行已把高度撑高，旧逻辑判成「用户往上翻」关掉跟随；ESP32 启动日志的节奏正好触发。改为记下自动滚到的位置，滚动位置不低于它就不算用户翻页（`dock.tsx`）。
- **板子没有 RGB 灯**：`RGB_GPIO.esp32 = null`、board3d `rgbPin: -1`、worker `LED_PIN = -1`；blink 示例在 GPIO2 外接 LED（同一份 blink 源码，`LED_GPIO=2`）。

## 2026-10-19 国际化（U-07，人已拍板）
- **人定的范围**：网页支持英 / 中 / 日 / 韩，跟随浏览器语言、回退英文，可手动切换并记住；代码注释、CLI 输出一律英文，连续注释 ≤ 2 行（特殊情况除外：许可证头、寄存器 / 报文布局表、ASCII 图）；README 英文为主，另有 zh-CN / ja / ko 副本；AGENTS.md 改英文；`docs/` 暂留中文；**固件 printf 串口输出保留中文**（验收期望文本跟着不动）。
- **机制**：不引第三方 i18n 库，自写 `web/src/i18n`（约 80 行）。gettext 风格——英文原文就是键，`t('At least {n}', { n })`；zh / ja / ko 词典按区域分文件（site / lab / views / data / checks），各区域由对应代码的负责人维护，避免并行修改冲突。缺词回退英文。替代：i18next（要新依赖、要登记授权）；按语义键（`home.hero.title`）——要给每句起名，并行翻译时更易撞名。
- **加载**：词典用顶层 await 按语言懒加载（英文不加载词典），所以模块顶层的 `t()` 常量也拿到正确语言；切换语言即存 localStorage + 重载页面，不做运行时热切换（字符串在模块加载时就定了，热切换要把所有常量改成函数，收益不大）。`?lang=` 只管这一次打开，测试用它固定语言。
- **Node / Worker 一律英文**：CLI 包与网页共用 `checks.ts`，结论行 `CheckResult.text` 要和命令行逐字一致，所以原始数据层只出英文；人话层（`say.ts` 等主线程代码）才翻译。
- **数据文件**（levels / examples / accept / 零件目录）：展示字段改成英文原文，其他语言进 `i18n/<语言>/data.ts`；要和固件串口输出比对的字段保持原样。
- **字体**：自托管的 Noto Sans SC 子集覆盖中文与常用假名；韩文与子集外的日文字退回系统字体（字体栈加 Hiragino Sans / Yu Gothic / Apple SD Gothic Neo / Malgun Gothic），不新增字体文件。
- **提交信息**：从这一批起改用英文。
- **内核观测行改英文**：`[tryboard]` 观测行（I2C 应答、USB 主机状态、LCD 颜色、I2S、排线 / 天线估算、真实网络请求、虚拟手机、任务时间线标签 tasks / core N / wait、网络页签的去向 / 状态 / 原因）一律英文；check.py、checks.ts、accept.json、网页解析只认英文，原来中英两认的分支删掉。网络页签由 `netpane.tsx` 的 `coreText()` 把英文记号翻成界面语言。
- **指纹一次性全部变化**：结论行变英文，所有检查点指纹（运行编号）随之改变；与界面语言无关，CLI = npm 包 = wasm 三方仍一致。STATUS 里的指纹按新值更新，旧的运行编号作废（不做兼容映射：指纹定义就是结论文本的哈希）。
- **作品打勾记录键改英文**：产品页 / 关卡的打勾项以英文原文为键，原先存在 localStorage 里的中文键勾选会丢一次。替代：迁移表——条目少、只影响本机试用记录，不值得。
- **覆盖测试**：`web/test/i18n.test.ts` 扫描 `web/src` 里所有字面量 `t()` 键，缺 zh 词条即失败（三种语言键集合相同另有一条测试）。网络相关词条单独放 `net.ts` 区域。

## 2026-10-19 固件自建热点 + 虚拟手机配网（C-02）
- **网段**：固件热点按 IDF 默认占 192.168.4.0/24（芯片 192.168.4.1，手机 .2），原虚拟路由器也在 192.168.4.1。拿起手机时路由器挪到 192.168.5.1、分给芯片 192.168.5.100；只在芯片还没从路由器拿过地址时挪（`!net.leased`），没拿手机时世界与以前逐字节相同。替代：让路由器一直用 .5 网段——否掉，现有 wifi-* 用例和关卡指纹全会变。
- **手机行为**：按安卓的联网探测写（DNS connectivitycheck.gstatic.com → GET /generate_204，非 204 判「需要登录」）。iPhone（captive.apple.com/hotspot-detect.html）和各家系统弹不弹、何时弹登录页差别很大，界面标「必须上真机」。手机只在用户点「打开」时才 GET 登录页（真手机是自动弹，但在网页里自动弹会让输入日志里少一步，重放与界面对不上）。
- **网页每一步都是显式事件**：拿起手机 `on`、点热点 `join,…`、打开 `open`、提交 `post,,<urlencoded>`。CLI 的 `--ap-phone` / `--ap-post`（自动打开 / 自动提交）只给命令行用，网页不用，免得重放时多出网页没做过的动作。表单正文用 `encodeURIComponent`，`;` / 换行不会把脚本行切断。
- **没有「重启板子」按钮**：网页的重新上电会重新下发 flash 镜像，NVS 回到原样，演示不了"重启后还记得"。改为提示「配好网的固件会自己重启一次，看串口」：c3-softap-prov 保存后自己 `esp_restart()`，`Machine::reboot` 保留 flash 与手机，串口里能看到从 NVS 读出 MyHome 直接连上。替代：重新上电时保留 NVS 分区——要动所有示例的上电语义，另议。
- **「网络」页签出现条件**：固件发过 Wi-Fi 帧，或拿起过虚拟手机（固件自己重启后帧计数清零，页签不能一闪而没）。电脑上手机三步并排、坞不够高时拉高到约 520px（个人偏好，存 localStorage，与拖动坞高同一条）；手机上一次一步，步骤数字可回看。
- **请求记录**：`tcp.rs` 只记芯片当客户端时发出的 DNS / HTTP 与被拦的连接（方法、去向 虚拟 / 真实 / 未放行、地址、状态、耗时），只给界面看，不改送给芯片的任何字节；手机发的请求在手机自己的日志里。


## 2026-10-19 真实网络开关（C-03）
- **只放行 HTTP（端口 80），不做 HTTPS**：芯片里的 mbedTLS 握手要和真服务器逐字节走完，浏览器 fetch 只能给明文回复，接不上；在内核里冒充服务器做 TLS 又等于中间人。所以真实网络开着时，发往 443 / 8443 的 SYN 直接回 RST，网络页签那一行写「真实网络只放行 HTTP，HTTPS 未放行」；其他端口（MQTT 1883 等）同样拦下、说明「真实网络只放行 HTTP」。关着时与以前逐字节相同（不加说明）。替代：用浏览器 WebSocket 隧道转 TCP——要一台中转服务器，违背「不部署」，以后再议。
- **路由按 Host 头**：芯片 DNS 仍由虚拟 DNS 应答，TCP 仍连虚拟网关；收齐请求（带正文的等 Content-Length 收齐）后看 `Host:`，不是 `tryboard.local`、也不是直接写的网关地址的，开着开关就进发件箱交给网页 `fetch`。请求头只带 Content-Type（其他头会触发预检，多半也是浏览器不许设的），`credentials: 'omit'`。
- **CORS 诊断**：fetch 失败时，GET 用 `mode: 'no-cors'` 再试一次：能拿到不透明回复 = 对方在线、只是没给跨域头 → 原因 `cors`；再失败 → `net`。POST 不重试（会让对方再收一遍），记 `blocked`。10 秒超时 `timeout`；https 页面发 http 被混合内容拦下 → `mixed`（只有本机 http 预览才真的能连外网，弹层里写明）。失败时芯片收到 502，正文 `TRYBOARD_REALNET_ERROR <原因>`。
- **回复进输入日志**：脚本动作 `netreply=编号,状态,毫秒,内容类型|原因,base64 正文`（状态 0 = 没拿到回复；内容类型去掉参数和逗号分号；正文上限 64KB）。回给芯片的字节只由这几项决定（毫秒只给人看），所以网页实时、检查点验收、命令行 `--inputs` 重放逐字节相同；命令行从不联网，只在 stderr 报「真实网络请求 #n」。开关本身也是事件 `realnet=1|0`。
- **回退 / 重放**：worker 从日志里取出所有 netreply 做回复缓存，回退时先重放到目标时刻，再把已发出、日志里有回复的请求按记录回答，不再联网；日志里没有的才（开关开着时）真的去取。迟到的 fetch 结果按启动代号丢掉。
- **检查点**：开着开关验收会真的联网，结论标「依赖外网」、不记运行编号（`fp:""`、`net:true`），换回虚拟网络再跑才有运行编号。开关不持久化（每次打开页面都是关的），避免用户忘了开着。
- 替代：自动把回复存成「夹具」随作品发布——涉及第三方内容再分发，先不做；只给用户自己导出。

## 2026-10-19 经典 ESP32 Wi-Fi 收发（C-05 补完）
- **共用 MAC 模型、寄存器参数化**：反汇编 esp32 版 libpp 后发现上一代 MAC 与 C3 / S3 的 HAL 函数同名、lldesc 描述符、发送结果码、硬件密钥表格式都相同，只是寄存器偏移逐个不同、接收元数据头 7 字。做法：把 `WifiMac` 里写死的地址收进 `MacRegs`（`WifiLayout.mac`），`MacRegs::C3` 数值与原常量逐个相同（C3 / S3 Wi-Fi 用例输出不变），ESP32 另给一套。替代：给 ESP32 单写一个 MAC——否掉，空中帧、AP、加密、DHCP 都在同一个模型里，两份会分叉。
- **几处上一代独有的语义**照实跑现象定：接收控制 0x3FF73084 位 0 重装后自清（不清驱动无限轮询、刷 `wifi:reload`）；0x3FF7308C 读回"下一个要填的描述符"，链空时 = 描述符高位 0x3FF00000；接收头 RSSI 驱动会再减 wDevCtrl+46（实测 96），模型写入 rssi + 96 后打印 −42 与 C3 一致；RFPLL 校准完成位（regi2c 块 0x62 寄存器 7 位 7）由 HLE 读回置 1。
- **ESP32 自带 SHA / AES 模型**：WPA2 在 esp32 端口走硬件 SHA（PBKDF2 / PRF）和 AES，读回全 0 会让四次握手 abort。寄存器按 IDF `hwcrypto_reg.h` / `sha_ll.h` / `aes_ll.h`；SHA-1 / 256 复用已有压缩函数，SHA-384 / 512 新写（常量来自 FIPS 180-4），各有 FIPS 向量单测。只做寄存器模式，DMA 模式没做（IDF 的 Wi-Fi 路径没用到）。
- **依据与授权**：只看 IDF v5.5.1 预编译库（Apache-2.0）反汇编、IDF 头文件和实跑 `--watch`；没有读、没有参考 espressif/qemu 的任何代码（它的 esp32 机器也没有 Wi-Fi MAC）。因此没有 QEMU Wi-Fi 对照，判定标准是与 C3 wifi-http 相同的应用层串口输出；STATUS 标「未经真机标定」。
- **验收**：accept.json 加 esp32-wifi、esp32-wifi-wpa2（新固件目录 `firmware/esp32-wifi-wpa2`，与 wifi-wpa2 共用 `wifi-http/main/main.c`）；网页示例 esp32-wifi 进 `firmware/examples.json` 和 accept.sh 网页冒烟。esp32-wifi-init 保留（只验 PHY 起来）。
- **选型**：Wi-Fi 不是零件种类，`SIM_KINDS.esp32` 不变；只更新芯片 / 板子说明文字（Wi-Fi 联网可模拟）。天线、无线距离仍是「必须上真机」。

## 2026-10-19 学习深度 D 批（D-01–D-08）共用约定
派子代理前先定死，免得三个 worktree 改同一处解析器时各起各的名字。
- **输入日志动作**（CLI `--inputs` 脚本与网页 `inputlog.ts` 同名，各加一个分支）：
  - `seed=<u32>`：本次运行的随机种子，缺省 7。网络与 ADC 各从种子派生独立的随机流（`seed ^ 0x4E45_5400` 给网络、`seed ^ 0x4144_4300` 给 ADC），切换 ADC 理想 / 真实不会挪动网络故障的时刻。
  - `net=normal|weak|flaky|offline`：网络状况预设（D-01）。
  - `netfault=reboot|dns|silent[,<秒>]`：安排一次故障；秒数缺省 8（reboot 断 8 s，dns / silent 持续时长）。在动作所在时刻开始。
  - `adc=real|ideal`：ADC 模型（D-02），缺省 real。
- **CLI 参数**：`--seed N`、`--net <预设>`、`--net-fault <kind>@<起始秒>[,<持续秒>]`（可重复）、`--adc ideal|real`、`--vcd <文件>`、`--vcd-pins <列表>`、`--vcd-window <起>..<止>`（秒，D-04）。时序敏感识别（D-03）不用开关，运行结束时 stderr 打一行 `[tryboard] timing-sensitive: GPIO5 busy-wait esp_rom_delay_us ×N, ...`（英文，网页原始数据逐字相同）。
- **故障一律在 Rust 里按模拟周期执行**（`soc/src/wifi`），网页只发动作，不在 JS 里丢包或计时，否则网页与命令行指纹分叉。路由器重启 = AP 停发信标、不应答 8 s，断线事件（reason 200 BEACON_TIMEOUT）由 Wi-Fi 库自己报，不伪造事件；DNS 失败 = 虚拟 DNS 回 SERVFAIL；服务器不回应 = 丢掉发往虚拟服务器的 SYN / 数据。
- **检查点用固定时刻的故障**：「不稳定」预设的随机断线（40–90 s）在 30 s 内可能不发生，验收与检查点只用 `netfault=` 定时故障，结果才确定。
- **accept.json / levels.json 由主会话合并时统一加**，子代理只在报告里给出用例，免得三个分支冲突。
- **ADC 默认改「真实」会改变已有读数**：pot / s3-pot 等用例和指纹只在新数更接近真机时更新期望值，不放宽容差；变化逐条列进 STATUS。
- **参考来源**：eFuse ADC 校准与曲线拟合系数照 ESP-IDF v5.5.1 `components/esp_adc/*/curve_fitting_coefficients.c` 与 `components/efuse/*/esp_efuse_rtc_calib.c`（Apache-2.0，LICENSING ✅），模型传递函数取 IDF 曲线的反函数，使校准后误差落在 1% 内；精细采样 / VCD、按收据计时只借 mikroverk/esp32sim（MIT）的思路，不复制代码（依据 RESEARCH_ESP32SIM.md）。

## 2026-10-19 TIMG 主看门狗（MWDT）
- **模型放在共用的 `Timg`**（C3 / S3 / 经典 ESP32 翻译层都用它）：使能位 31、wdtconfig1 预分频 [31:16]、4 级保持时间 wdtconfig2–5、动作 STG0–3（关 / 中断 / 复位 CPU / 复位系统）。每级从 0 计时，超时后执行动作并进入下一级，第 3 级后回到第 0 级；喂狗（0x60）与使能上升沿从第 0 级重新计时。配置和喂狗都要先写钥匙 0x50D83AA1。事件驱动：`update()` 返回下一级到点的周期，不按周期计数。不模拟分频计数器相位（喂狗时刻对齐），C3 的 conf_update_en 当作写入即生效。
- **芯片差别做成字段**：C3 的 bit 21 是 use_xtal（IDF 默认 XTAL / 20000 = 500 µs），中断位 1；S3 / ESP32 的 bit 21 是电平中断使能、只计 APB（APB / 40000 = 500 µs），中断位 2（位 1 是 T1）。复位原因按 soc/reset_reasons.h：系统复位 TG0 / TG1 = 7 / 8，CPU 复位 = 0x0B / 0x11；经 `reset_request` 走已有的重新上电路径。S3 / ESP32 的运行循环原来只在 RTC_CNTL 写之后看复位请求，现在定时事件结算后也看。
- **flashboot 不建模**：芯片从 flash 启动时硬件自动开 MWDT0 / RWDT，由二级引导 `bootloader_init.c` 关掉；我们直接启动跳过二级引导，等效于"已被关掉"的状态，所以 bit 14 只存不用。RTC 看门狗（RWDT）同理未建模。
- **依据**：ESP-IDF v5.5.1 `hal/*/mwdt_ll.h`、`soc/*/register/soc/timer_group_reg.h`、`esp_system/task_wdt/task_wdt_impl_timergroup.c`、`hal/wdt_hal_iram.c`（Apache-2.0）。没有看 espressif/qemu。
- **验收**：c3-wdt / s3-wdt 5 s 打印任务看门狗；IDF 在空闲钩子里喂狗、IWDT 在节拍里喂狗，已有 101 个 accept 用例 stdout / stderr 与改前逐字节相同（排除墙钟和未建模寄存器同次数排序）。

## 2026-10-19 网络故障注入（D-01）
- **全在内核按模拟周期执行**：`soc/src/wifi/netcond.rs` 存预设、故障表、随机流（种子 `seed ^ 0x4E455400`，缺省种子 7）和统计；`world` 每步 `advance_cond` 推进，定时器进同一事件队列。缺省（normal、无故障）不碰随机流、不加行，已有用例输出与指纹逐字节不变。
- **路由器重启**：AP 停发信标且不应答，同时忘掉站点。IDF 怎么报断开由它自己决定：短断（8 s）时它先发数据帧，AP 回 deauth reason 7（CLASS3_FRAME_FROM_NONASSOC_STA），所以串口是 `reason=7`；断得久（如 `reboot@10,20`）先信标超时 `reason=200`，重连扫不到再 `201`。PLAN 原写「reason=200」，按实跑现象改为两种都接受，不伪造事件。
- **DNS 失败** = 虚拟 DNS 回 SERVFAIL；**服务器不回应** = 丢掉发往虚拟服务器的 SYN 和数据。lwip 有 DNS 缓存，固件 c3-wifi-resilient 每次请求前清缓存，否则故障期内仍命中缓存、看不到失败。
- **信号弱 / 不稳定**：丢包只丢芯片发出的帧（考的是固件 / lwip 的重传与超时；下行也丢要给虚拟服务器加重传，暂不做）；延迟按包抽样但保持先后顺序，避免 TCP 乱序重传把结果变得难懂。断网 = AP 从扫描结果里消失。
- **网络页签行**：注入事件写成 dest「Injected」、method NET / FAULT / Wi-Fi 的行，状态用英文记号（Applied / Injected / Recovered / Disconnected / Reconnected / No reply），网页按记号翻译；`tb_net_json` 多 `cond` 摘要，命令行结束时 stderr 打 `[tryboard] network …` 一行（不进指纹）。
- **网页**：预设存在主线程（换固件 / 重新上电保留，像真实网络开关），上电时非 normal 记 `net=` 于时刻 0；回退时若当前预设与日志里最后一条不同则补记。故障按钮发 `netfault=kind`，在当前时刻开始。所有动作走输入日志，CLI `--inputs` 重放一致。
- **文案**：normal 预设显示用 key「Stable」（「Normal」在 steps.ts 已译成「平常」，语义不同）。
- 替代：在 JS 里丢包 / 计时——网页与命令行会分叉，否决；用真实时间触发随机断线——不可重放，否决。

## 2026-10-19 DHT11、时序敏感识别、精细采样（D-03 / D-04）
- **开漏电平**：引脚开漏输出 1 = 放手，线电平由外部器件决定（器件在驱动就取它的值，没有就是上拉的 1）；输出 0 一律拉低。C3 / S3 / 经典 ESP32 的 `level()` 同样改，非开漏脚行为不变，所以已有指纹不动。
- **DHT11 按数据手册打拍、键在模拟周期上**：时序见 STATUS。两次读间隔 1 s 的下限不强制——真机太快会读到旧值或不答，这里照答；只把「起始脉冲太短」计数报出来。读数取 `--env` / 滑块的温湿度（湿度取整、温度一位小数）。网页与 simrun 先挂 DHT11 再设环境，否则第一帧拿到默认 25 °C / 50 %。
- **时序敏感识别（D-03）是启发式**：HLE 透传计 `ets_delay_us` / `esp_rom_delay_us`，总线上读周期计数器（跳过 ROM 内的 PC）两次间隔 < 200 周期算自旋，GPIO 事件两次 < 100 µs 算软件打拍，忙等 / 自旋落在某脚活动 1 ms 内才算到该脚。只有出现打拍的脚才报，所以 blink 等普通固件不出这一行（accept.sh 指纹不变）。wasm `tb_timing_report` 给 JSON `{"line","items":[{"pin","kind":"delay|spin|toggle|poll","n"}]}`，没有就 `{}`。目前只接了 C3，S3 / 经典 ESP32 留作后续。
- **VCD（D-04）**：时间单位 1 ps（一周期 6250 ps，整数无舍入），时间轴是运行的绝对时间，方便和 `--trace-io` 对照；网页与 CLI 共用内核同一个 `text()`，所以逐字节相同。网页「下一个沿触发」= 内核 `vcd_arm`：从指定时刻起第一个被选脚的沿定窗口起点，CLI 用网页显示的起止时刻（`--vcd-window`）可复现同一份文件。缓冲满了不覆盖，只计丢弃数并显示。
- **分析仪布局**：精细采样打开时若底部面板太矮（< 400 px 或 60% 屏高），自动加高一次（只增不减），否则忙等提示会把波形行挤没。手机端分析仪仍按 U-05 隐藏，精细采样的手机布局归 D-07。
- 参考：只看 DHT11 / Aosong 数据手册与 ESP-IDF 头文件；没有读、没有参考任何 GPL 代码。

## 2026-10-19 真实 ADC（D-02）
- **调查 (a) S3 ADC2 与 Wi-Fi 冲突是硬件仲裁**：IDF v5.5.1 里 S3 的 `adc2_wifi_acquire` 是空函数（只有经典 ESP32 走软件锁）；Wi-Fi 占着时 SAR 仲裁器把 SENS 读数的标志位 [15:14] 置非 0，`adc_oneshot_ll_raw_check_valid` 判无效，`adc_oneshot_read` 返回 ESP_ERR_TIMEOUT。模型照此：S3 上 ADC2 通道 < 10 且 Wi-Fi MAC 已开（`WifiMac::is_on()` = esp_wifi_start 交出了接收描述符）时，读数返回 `3 << 14`。C3 上通道位 [16:13] > 9 视为无效（模型写 0xF）；但 C3 的 ADC2 单次读需要 `CONFIG_ADC_ONESHOT_FORCE_USE_ADC2_ON_C3`（勘误：ADC2 在 C3 上不可靠），所以不出 C3 固件用例，网页把 C3 GPIO5 标成「ESP-IDF 不支持」。
- **调查 (b) 曲线拟合需要的 eFuse**：C3 —— BLK2 `BLK_VERSION_MAJOR = 1`（位 128）、OCODE（位 140）、4 档初始码（位 148/158/168/178）、4 档校准电压码（符号-幅值，位 188/198/208/218，参考 400/550/750/1370 mV）。S3 —— BLK_VERSION_MAJOR = 1、ADC1/ADC2 初始码与校准电压码按差分链存（ADC1 4 档、ADC2 的第 3 档字段落在 BLK1 位 186），参考 850 mV。写入值取「典型芯片」：C3 digi 2018/1991/2006/2027，S3 ADC1 a0 3650 … a3 1000，`soc/src/adc.rs::burn_efuse` 在默认 eFuse 上烧这些位。
- **副作用**：BLK_VERSION_MAJOR = 1 后 IDF 从 eFuse 取 OCODE、不再打印 "calibration efuse version does not match"，启动日志少一行、时间戳整体前移约 1 ms，所以所有关卡 / 用例指纹都变了（仓库里不存指纹，check.py --ref --all 全过）。
- **传递函数**：真实 = 两头弯曲（< 0.1 V 压低、> 2.9 V 饱和）→ IDF 校准公式（线性系数 + 曲线拟合误差项，系数照 IDF `curve_fitting_coefficients.c`，Apache-2.0）的反函数 → 高斯噪声 σ = 2 LSB（splitmix32，种子 `seed ^ 0x41444300`，缺省 seed 7）→ 取整钳位。码 0 以下反函数线性外推，噪声不会把死区抬起来。效果：C3 / S3 在 0.5–2.5 V 校准后读回与输入误差 ≤ 1 mV。理想 = 旧线性律（量程按数据手册 C3 750/1050/1300/2500、S3 950/1250/1750/3100 mV），无噪声。
- **理想模式下固件的校准结果是歪的**：eFuse 曲线仍在，固件 adc_cali 会把线性码换算成另一电压（C3 1250 mV 理想码 2048 → 校准报 1380 mV）。这是故意的：理想模式给「读数 = 公式」的教学视角，不是更准的芯片；面板上「真实（默认）」才是要信的数。
- **重放**：切换走输入日志 `adc=ideal|real`（D 批共用约定），CLI `--adc`、`--seed`，wasm `tb_adc_mode` / `tb_seed`；ADC 随机流只在每次转换时推进，与网络流独立。`tools/webtest/adc.mjs`：网页切换后导出输入日志，CLI `--inputs` 串口逐字节相同、指纹相同。
- **改动的期望值**（更接近真机，未放宽容差）：pot `ADC raw=2046` → `1847`（1250 mV 在典型 C3 上的码，校准回 1250 mV），pwm max 0.96 → 0.88（2400 mV 读 3604）；s3-pot `2046` → `1852`（1550 mV），pwm max 0.968 → 0.922（3000 mV 读 3778）。s3-i2s-mic RMS 误差 0.0003 → 0.0008、gptimer 误差小幅变化，均因启动时序前移、仍在原容差内。
- **网页**：器件面板（例子卡片和选中电位器时都有）放理想 / 真实切换、最近读数 ± 抖动、48 次读数条、「估算」标签、接线选脚 ADC1 / ADC2 标注（S3 GPIO1–10 / 11–20，C3 GPIO0–4 / 5）。读数来自 wasm 每次转换记下的环形缓冲（`tb_adc_fetch`），不是解析串口。
- 替代：按 IDF 的线性系数正向加一条随机曲线 —— 校准后误差不可控，验收「< 1%」无法稳定；照搬 espressif/qemu 的 ADC —— GPL，且它没有 eFuse 曲线。

## 2026-10-19 手机布局（D-07）
- **网络状况**：D-01 已按 Phone.dc.html 做了手机变体（底部抽屉「网络」页，预设 2×2、故障按钮单列 ≥ 44px），本批只补 mobile.mjs 断言。
- **逻辑分析仪上手机**：原先 < 768px 直接隐藏。改为底部抽屉加「波形」页：打开时把分析仪这个命令式节点移进抽屉（`.in-sheet`，静态定位、按钮 ≥ 44px、表头换行），关页时移回 body 并关闭，桌面布局不变。触屏没有 Shift，轻点依次放光标 A / B。
- 替代：手机上另做一个精简波形视图 —— 两套绘制代码要同步，精细采样 / VCD 导出得重做；全屏弹层 —— 挡住 3D 台面和串口，看不到固件反应。
- 抽屉标签用「波形」（设计稿用词），桌面仍叫「逻辑分析仪」。

## 2026-10-19 首帧着色器预编译（R-15）
- **做法**：`web/src/shaderwarm.ts` 一个共用助手，7 个 3D 视图都用它：场景建好 / 换场景后 `renderer.compile()` 场景（有 composer 时对着它的线性渲染目标编，变体才一致）、后处理 pass 材质（放到临时四边形上，OutputPass 先用空绘制跑一次定 defines）、阴影深度替身（按 three 内部 MeshDepthMaterial 的程序键去重，side 翻转、fog 置空）；`warming()` 轮询 `isReady()`，未就绪就跳过这一帧绘制，并至少等一个 rAF。
- **不用 `compileAsync`**：材质在等待期间被 dispose 时它会抛错（切换示例时常见）；自己轮询更可控。
- **留下的问题**：Chrome 程序二进制缓存命中时 `isReady()` 早报完成，GPU 进程仍有约 500 ms 积压，首个同步 GL 调用阻塞。试过 fence sync（信号更早，更糟）、逐帧触碰程序（同一积压只是挪位置）、随机源码 canary 程序（无稳定收益），都已撤回。手机长任务主要是建场景 CPU 时间，另立 R-16。
- 替代：OffscreenCanvas + worker 渲染 —— 要改全部 7 个视图的事件与资源流，代价远大于收益；降低材质种类 —— 影响画面，违背「画面一致」。

## 2026-10-19 内核分层搬移的两处偏离（R-05）
- **sigin 一起进 soc**：原计划把 `sigin`（GPIO 输入信号路由）当 C3 专有留下，但 rmt / pcnt 依赖它，只能一起搬；行为不变（金标准 112/112 一致）。
- **machine 里仍有 `tryboard_esp32c3::`**：剩下的是 `Hw::C3` 构造 C3 SoC 本体用的（`Esp32c3`、`MMIO_LOW/HIGH`、`Stop`），不是共用件；归零放到 R-06（machine 只调 `trait Chip`，按芯片 match 只剩构造处）。不用别名绕过 grep。
- esp32c3 的 `pub use tryboard_soc::{…}` 转发保留到 R-06 结束，再按引用情况删除。

## 2026-10-19 芯片 trait（R-06）
- **`Hw` 枚举直接删掉**：machine 持 `Box<dyn tryboard_soc::chip::Chip>`；按批次分派（`run` 一次跑一批），指令循环仍在芯片 crate 里单态化，实测速度在噪声内。trait 不带泛型方法（保持对象安全），I2C 器件的 `device::<T>()` 由调用方在返回的 `&mut I2c` 上做。
- **只有部分芯片有的功能用缺省实现**：PCNT、ADC 模型、圆屏、I2S 器件、BLE、USB、时序报告缺省 None / false；CLI 的 `--watch` / `--dump` / `--dump-intc` 原来写在 `Hw::C3` 分支里，改成 trait 的 `set_watch` / `watch_hits` / `dump` / `intc_report`（目前只有 C3 实现，其他芯片照旧不输出）。
- **搬移**：`usb/`（DWC2 + 虚拟主机）从 esp32s3 进 soc（中断源号留在 esp32s3 `periph::src::USB = 38`），`image_chip_id` 从 esp32s3::boot 进 soc::boot，Xtensa 停机状态描述 `halt_state` 从 machine 进 tryboard-xtensa，ROM 复位横幅进各芯片的 `rom_banner`；故障 / HLE 文字原样搬到各芯片 `chip.rs`（金标准 112/112 逐字节一致）。cli / wasm 因此不再依赖 tryboard-esp32s3。
- **machine 保留 `enum Chip` 元数据表**（id、名字、ROM 文件、BOOT / RGB 引脚、引脚数）：CLI 在开机前就要用引脚数和 ROM 文件名，放进 trait 就得先构造芯片。
- **esp32c3 转发**：R-05 留下的 `pub use tryboard_soc::{…}` 改为 `pub(crate) use`，没人用的 pcnt / sigin / vcd 转发删除；R-05 记的「machine 里仍有 `tryboard_esp32c3::`」偏离至此只剩构造处。
- 替代：保留 `enum Hw` 并在每个方法里 match —— 加一款芯片要改几十处；泛型 `Machine<C: Chip>` —— wasm / CLI 都得跟着泛型化或再包一层枚举，收益只是省掉每批一次间接调用。

## 2026-10-19 按需加载面板与步骤（R-12）
- **验收口径**：R-01 只记了首屏字节（572 KB），没有记 app 主包大小，所以以本次改动前的构建为基线（`app-*.js` 262 340 B gzip，app.html 静态闭包 566 626 B）。拆完后 `app-*.js` 降到约 114.4 KB（−56%），但其中一大半是 rollup 把仍被首屏静态引用的共享模块（topbar / mobile / cmdk / wirecheck / bom / rulemeta …）分到了新文件里，不是少下载；真正少下的是静态闭包 566.6 → 476.2 KB（−16%）。PLAN 按闭包口径记 ◐，两个数都写上，不改目标。
- **剩下的首屏重量不在 R-12 范围**：three.module 150 KB、语言包 `lang-*` 66 KB、audio.ts（约 13 KB，蜂鸣器在实验台开机就要用，改懒加载会动 session 里的发声时序）。下一步可做：audio 懒加载 + 同步门面、按语言拆词典。
- **不用 React.lazy / Suspense**：React 18 在显示过 fallback 后会把真实内容至少压 300 ms 才提交（FALLBACK_THROTTLE），本地实测各面板首次打开都卡在 ≈ 305 ms，超过 300 ms 验收线；改为 `panes.tsx` 里自己的 `useState + import()` 加载器，已加载的模块直接同步渲染。代码页原来的 `lazy()` 一并换掉。
- **步骤用占位 StepImpl**：`steps/lazy.tsx` 先同步注册一个只显示「正在加载这一步…」的步骤，chunk 到了再 `registerStep` 真实现（当前步骤会重新挂载），失败显示可重试的错误卡片。
- **分析仪改为按需创建**：数据本来就在 `session.io`，分析仪只是视图；`anaload.ts` 首次打开或空闲预取时才 import 并创建，`__tbApp.analyzer` 在创建后再赋值（vcd.mjs 本就等它）；⌘K 只读 `body.ana-open` 判断开关，不为显示一个标签去加载。
- **为切断首屏依赖而搬出的小模块**（纯搬移，行为不变）：`bomstore` / `caseparams` / `asmstate` / `blefeed` / `usbfeed`（原在 shop / casemesh / assemble / blepane / usbpane 里，被首屏引用），`catalog/fix.ts`（applyFix）与 `catalog/rulemeta.ts`（规则元数据 + netVolt），rules.ts 原样转发这些导出，测试与 CLI 不用改。
- **空闲预取**：固件首次开机 2 s 后用 `requestIdleCallback`（Safari 退回 1.5 s 定时）一项一项取：分析仪 → 选购 / 组装 / 成品 → 各面板 → 选板简报。起初开机即预取，perf.mjs 桌面 c3-lcd 三次里两次 readyMs ≈ 1 s（基线 0.53 s）；加 2 s 宽限后预取落在 ready 之后，5 次中位 539 ms（基线 526 ms），剩下偶发的约 480 ms 长任务就是 R-15 记的「回访卡顿」（改动前的构建在 weather + analyzer 一行每次都有），不是预取。perf.mjs 的 5 秒帧采样窗口里会多出几次短任务。
- **AI 简报（选板作品）按需 import**：复制前先 `await import`；空闲预取已覆盖，极端情况下浏览器若因丢失用户手势拒绝写剪贴板，会提示手动复制（原有提示）。
- 替代：只用 Vite `manualChunks` 合并 —— 不减少首屏下载；把步骤文件挪进 `steps/lazy/` 目录 —— lint_size 白名单按路径记，会被当成新违规。
- **第二轮（2026-10-19，闭包 493.2 → 454.6 KB）**：先用 source map 把首屏闭包按源文件拆开再动手。结论：
  - 「语言包 `lang-*` 66 KB」是误读：那个 chunk 是 react-dom（rollup 拿 `ui/lang.tsx` 给共享 chunk 命名），zh / ja / ko 词典早就是 `import()` 并在首次渲染前 await，不闪英文，所以方向 1 不用做。
  - 去掉的（都是首屏渲染用不上、会话起来后才读的）：`firmware/levels.json`（≈ 13 KB，`session.ts` 模块加载时就 `import()`，createSession 里 await）；`asmstate` → `views/templates`（全部组装模板，main 在会话建好后 await；`CHIP_HEAT_OFFSET` 拆到 `views/chipheat.ts` 给实验台尺子用）；⌘K 的搜索逻辑 `cmdk.tsx`（框和列表视图拆到 `cmdkview.tsx` 照常首屏渲染，`createCmdk` 与会话并行取，`__tbApp.cmdk` 赋值时机不变）；`custom.ts` + 选板数据 / 引擎（只在 work=custom 时 top-level await）；自定义作品的购买卡 `buycard`（首次打开时取，空闲预取也会带上）。
  - 「并行取」不是少下载，是让这些字节不挡首次渲染；首页 index.html 闭包因 chunk 切分多 0.9 KB（160.1 → 161.0）。
  - 没做到 ≤ 396 KB 的卡点：剩下的 454.6 里 three 149 + react-dom / react 71 + CSS 18 + tailwind-merge 9，实验台 / 3D 舞台（bench3d、board3d、后期 Bloom / Outline）本身约 150 KB 都是首屏画面要用的；零件目录 `catalog/parts`（17 KB）在建 store 时 `loadBom → validHistory` 就同步要用，`wirecheck` / `place` 也要。再降需要把实验台 3D 整体改成会话前动态加载（等于把 three 移出闭包，与「three 保留在首屏」矛盾）或把零件目录拆成首屏索引 + 详情，改动面大，留给后续。
  - 不做：用手写合并替换 `tailwind-merge`（类名冲突语义会变）；音频门面（audio.ts 实际只有约 1.3 KB，第一轮 13 KB 的估计是 source map 把 levels.json 记到了它头上）。

## 2026-10-20 E：AMOLED AI 网关仪表盘（PLAN 节 E）
- 决定：以 Waveshare ESP32-S3-Touch-AMOLED-2.16 为目标板，补 CO5300 QSPI 屏、CST9220 / AXP2101 / PCF85063 三个 I2C 模型、S3 BLE、Bluedroid HCI、虚拟电脑；协议采用公开的 Claude Desktop Buddy BLE 协议（NUS `6e400001-…`，RX 写 / TX 通知，每行一个 JSON，心跳含 total / running / waiting / tokens / tokens_today / entries），示例固件自写。
- QSPI 不按四根线仿真：乐鑫 `esp_lcd_co5300`（Apache-2.0，源码头已核）每笔传输为 32 位命令 `opcode<<24 | cmd<<8`（0x02 写命令、0x32 写像素、0x03 读），GP-SPI 模型本来就按顺序交出 cmd / addr / data 字节，屏模型从字节流解析；只把四线 / 双线阶段的位时间按线数折算。
- 原作者 Magpie 推送协议未公开（yetone/magpie 仓库无 BLE / ESP32 代码），不猜。第三方固件 vthinkxie/claude-desktop-buddy-esp32（支持此板）GitHub 许可证 NOASSERTION：不进仓库、不上网站、也不在本机跑，等人决定。
- 用户真实桌面程序连不到网页里的虚拟板（浏览器 Web Bluetooth 只能当中心连真设备，不能当外设），所以「电脑端」由浏览器里的虚拟电脑扮演；接本机 Magpie 走现有 realnet 本地代理思路，作可选项。
- LE 安全连接配对（E-08）后置：Buddy 协议把加密列为推荐而非必需。
- 替代：走 Wi-Fi 直接拉 Magpie HTTP（127.0.0.1:3425）——用户判断原作是 BLE 推送，且 realnet 只放 80 端口、需 CORS，否掉作主路径。

### 2026-10-20 R-21：网页 ROM 删除 .xt.prop / .xt.lit
- 决定：`tools/strip_rom.py`（纯 python）在 build_web.sh 拷贝 ROM 时删掉这两个非加载段并压紧文件，重写 e_shoff / 节头表；NOTICE.txt 与授权页按 Apache-2.0 §4(b) 写明修改。third_party 原件不动。
- 理由：模拟器只读 PT_LOAD 与 .symtab（rv32/src/elf.rs），这两段是 Xtensa 工具链属性表，S3 共 330 KB、ESP32 共 260 KB。
- 保留：.symtab / .strtab / .comment / .xtensa.info（合计很小或被读）。备选：用 xtensa objcopy —— build_web.sh 不应依赖 IDF 环境，放弃。
## 2026-10-20 E-02：AMOLED 板 I2C 器件模型
- CST9220（`devices/cst9220.rs`）：报点布局、0xAB 标记与应答、0xD101 / 0xD109 命令 / 正常模式、0xD1FC 校验码、0xD1F8 分辨率、0xD204 芯片类型（小端 32 位，高 16 位 0x9220）按 lewisxhe/SensorLib `TouchDrvCST92xx`（MIT）核对；乐鑫 esp_lcd_touch_cst9220（Apache-2.0）与 ESPHome cst9220（GPL，只读未抄）没有逐行读。自定的地方：命令模式下不出报点、正常模式下信息字读 0；应答后报点作废直到下一次扫描（按着时视为每次读都是新扫描）；抬起时出一帧 0 点报点再停；压力字节固定 0x08（驱动把高 4 位置位当盖屏按键）。
- AXP2101（`devices/axp2101.rs`）：寄存器与位按 XPowersLib（MIT）`XPowersAXP2101.hpp` / `XPowersParams.hpp` 核对（0x49 bit3 短按、bit2 长按、bit1 / bit0 下降 / 上升沿、bit7 / bit6 VBUS 插 / 拔；0x4A bit3 / bit4 开始 / 充满；0x01 bit6:5 电流方向、bit2:0 充电状态；电压 H6L8 mV）。中断状态只在对应使能位为 1 时锁存（数据手册未确认，XPowersLib 读取时也按使能过滤）；电量静态、不随充电变化；ADC 不看 0x30 通道使能；电池电压按自拟的锂电开路电压折线（估算）。未列入已知表的寄存器照常存取并计数，CLI 结尾打印一行（只有挂了 AXP2101 才打印，不影响其它用例的金样）。
- PCF85063（`devices/pcf85063.rs`）：按 NXP 数据手册；时间以 UTC 保存，默认起点 1792123200（与虚拟网络 /api/time 一致）；写时间寄存器的事务结束时以写入值和当前周期重新起算（等效分频器复位）；读事务开始时锁存。日期换算用公开的 days-from-civil 算法手写（不加 crate）。
- ES8311 / ES7210 合一个 `devices/codec.rs` 应答空壳：ID 值取乐鑫公开驱动读到的值（ES8311 0xFD/0xFE = 0x83/0x11，ES7210 0x3D/0x3E = 0x72/0x10），未逐字对数据手册。
- 对外名字（E-03 网页用）：`--i2c cst9220@0x5a,axp2101@0x34,pcf85063@0x51,es8311@0x18,es7210@0x40`、`--battery PCT[,usb]`、`--rtc EPOCH`；输入日志 / 脚本动作 `bat=pct[,usb]`、`pwrkey=short|long`；wasm `tb_i2c_attach(6..11)`、`tb_battery(pct, usb)`、`tb_pwrkey(long)`、`tb_rtc_set(epoch)`。`tb_touch` 仍把坐标夹到 0..239，E-03 要改成按屏尺寸。
- 替代：五颗器件做一个「板级 I2C 包」——否，按器件分文件与现有约定一致，也方便别的板复用。

## 2026-10-20 字体按需切片与字体栈（R-17）
- 决定：subset.py 把 Noto Sans SC 子集切成多片 unicode-range（同 family 多个 @font-face）：Latin（U+2E80 以下所有扫描字，含通用标点、箭头、℃）、CJK 标点、假名、页面用到的汉字按扫描字频每 400 字一片、其余 GB2312 一级字按码位每 400 字一片；共 14 片，浏览器只取页面实际渲染到的片。可变字重轴用 fontTools instancer 收窄到 400–700（CSS 里只用到 400 / 500 / 600 / 700），GSUB 只留横排用的特性（去掉 vert / hwid / pwid 等，假名片 128 → 42 KB）。源字体里没有的码位（韩文、emoji 等）不再计入子集码位数（浏览器本来就按 cmap 逐字回退，字形没有变化）；`tnum` 保留（CSS 里有 tabular-nums）。
- 字体栈：新增别名 family 'TB Sans' = 同一个 Latin 片文件（同 URL，只下一次）。全站栈改为 `'TB Sans', <系统 CJK>, 'Noto Sans SC', sans-serif`：默认 / en / zh 系统 CJK 为 PingFang SC、Hiragino Sans GB、Microsoft YaHei；ja 为 Hiragino Sans、Yu Gothic、Noto Sans JP，ko 为 Apple SD Gothic Neo、Malgun Gothic、Noto Sans KR，两者再接 PingFang SC / YaHei（页面上的简体字如「试板」）后才是 Noto。lab.css 的 `--sans` 改为引用 `--tb-sans`（原来没有 ja / ko 分支）；canvas 用 scene-api.ts 的 `PAGE_SANS`，拍照前 `document.fonts.load` 角标文字。
- 取舍：西文四种语言一致用 Noto（与设计稿一致），汉字 / 假名在 macOS / Windows 上用系统字体，和 P2-19 时「全站 Noto 字形」相比 zh 页面汉字从 Noto 变成苹方 / 雅黑，字形略不同但同属无衬线黑体；换来 en 页面字体 1317 → 84 KB、有系统 CJK 字体的 zh / ja / ko 用户也不下 CJK 片。没有这些系统字体的平台（Linux、部分 Android）退到 Noto 分片，只取用到的片。
- 代价：fonts.css 从 0.5 KB 变成 30 KB（gzip 11 KB），因为按字频分片的码位不连续、unicode-range 很长；按码位连续分片 CSS 只有约 1 KB，但 zh 页面用字散在所有片里，退回 Noto 时要下几乎全部 1.2 MB，所以选字频。
- 不变：P2-19 的自托管与来源、OFL（文件名 tb-sans-sc-*.woff2，不用保留名）；等宽字体 tb-mono.woff2 原样（66 KB，保留全部 OpenType 特性，en 首页也会下，是剩下 84 KB 的大头）。
- 替代：zh 栈 Noto 在前（视觉与原来一致，但 zh 用户每页要下 3–4 片约 370 KB）；`local()` 引用系统 Noto Sans CJK（可变字重下 local 只能对应单一字重，放弃）；en 栈只用系统字体（不下任何字体，但西文在各平台不一致）。

## 2026-10-19 DHT11 进选型数据（D-05 收尾）
- **选型数据这条路，不加示例关卡**：PLAN 原话「待 DHT11 进选型数据后补」，而且选型 → 自定义作品（work=custom）是用户自己挑器件时自然走到的路；c3-dht11 早就在示例库里（examples.json），再加关卡只多一份手写判定。做法：顾问 `PARTS.dht11`（gpio，¥3–8，simulated 'partial' = 行为模拟）、目录 `catalog/parts.ts` 新增 `dht11`（VCC / DATA / GND，sim verified → 模型 dht11）、`PART_MAP`、`SCENE_TYPE` / `toScene`、`place.ts`（也能在商店单独摆上台）、`custom.ts wiresFor`、`genLevels` 加「DHT11 读数」检查点（args 带 `--dht11 <pin>`）。
- **检查点判定**：生成的检查点只跑 3 s，c3-dht11 的「校验通过 100/100」要 105 s 才出现，所以用 `numeric` 读第一次读数行（`温度 23.5 湿度 45`，±1）。numeric 行默认行为模拟，D-03 时序结论行命中后被 `withConf` 标「需真机确认」；`levelConf` 对带 `--dht11` 的 numeric 检查点、`checkpointsOf` 对 DHT11 都给「必须上真机」档。
- **引脚**：c3-dht11 固件写死 GPIO5。顾问引擎 `needs` 加可选 `prefer`（空闲且不是 strapping 才先取），DHT11 填 `[5]`；XIAO C3 / C3 DevKitM / SuperMini 单独选 DHT11 或与温湿度计模板合用都落在 GPIO5，其他器件分配不变（custom-thermo fixture 未变）。
- **演示固件**：C3 + DHT11 在 GPIO5 且没有 I2C 器件 → `c3-dht11`；有 BME280 / OLED（I2C 在 6/7）时仍是 `c3-thermo`（覆盖的检查点更多，DHT11 检查点要用户自己的固件）。
- 替代：examples.json / levels.json 加 c3-dht11 关卡 —— 用户从示例库进来的是空白作品，看不到选型 → 实验台这条主线；给 c3-dht11 加按引脚切换 —— 要改固件和验收用例，范围超出 D-05。
- **parts.ts 体量（R-14）**：新增条目让文件从 1504 涨到 1521 行，守卫只许缩。改成 `Draft.sizeMm` 可选、`P()` 默认 `null`，删掉 41 处 `sizeMm: null,`（1481 行，跌破 1500，allow list 用 `--update` 去掉这一项）；导出的 Part 字段值不变。替代：把 DHT11 拆到单独文件 —— 要导出 `P` / `pin` 等辅助函数，只为绕守卫。
- wiremode.mjs「⇧⌘Z 重做」偶发失败：撤销后时间线还在 replay（`hist.busy`）时按重做会被忽略；本分支连跑 3 次前 2 次失败、第 3 次通过，HEAD 基线 2 次都通过，最终 accept.sh 里也通过；weather 作品不含 DHT11，判断为时序偶发但未完全排除，未改测试，留给主会话复核。
## 2026-10-20 E-03：网页 AMOLED 一体板
- 一体板用场景字段 `SceneSpec.board`（'ws-amoled216'）标识，不当成「零件」：板载器件表 `web/src/bench3d/boarddevs.ts`（与 accept.json 的 s3-amoled-i2c 参数同序），会话里 `devsOf(scene)` 把板载器件与台面零件合并后再交给 worker / 重放。备选：把屏和各芯片当零件塞进 parts——会出现在零件列表里、能被删、能被改接，与「焊死在板上」不符。
- LCD 分辨率参数化：lcd 消息带 `w / h`，3D 纹理按尺寸 `lcdTexture(w, h)` 重建，触摸 UV 按 `lcdW / lcdH` 映射；旧的 240×240 消费者（作品页、lcd3d）只收长度相符的帧。输入日志头 `spi:'co5300'` → CLI `--spi co5300`，`battery` → `--battery`。
- 电量滑块只在松手（change）时记一条 `bat=` 输入，拖动过程只改读数：避免一次拖动写几十条输入、也让 CLI 重放与网页一一对应。USB 插拔同样走 `bat=pct,usb`。
- PWR 键：面板给「短按 / 长按」两个按钮；3D 上按住 ≥ 1 s 松手算长按（AXP2101 默认长按阈值 1 s 量级，未按寄存器配置细分）。
- 3D 板外形按 44 × 50 × 1.6 mm、屏有效区 38.8 mm 估计（官方未给机械图），USB-C 放在板底下沿、板子垫在 USB 壳上；目录条目 `sim.level` 标 estimated，todo 记尺寸、存储、排针、IMU / TF 卡未核实。
- 音频编解码器 ES8311 / ES7210 只答 ID 读，面板与示例说明里写明「不出声」。

## 2026-10-20 E-01：屏幕抽象与 CO5300 QSPI
- 决定：屏幕用 `enum Lcd { Gc9a01, Co5300 }`（`soc/devices/lcd.rs`）而不是 trait 对象。两种屏接线差异（D/C 脚 vs 片选帧）只在 SoC 的 SPI 路径分派，出图接口（尺寸、版本、RGBA、ppm、颜色统计）在 enum 上统一；只有两种型号，enum 免装箱、免 downcast，加第三种时再考虑 trait。
- `esp_lcd_panel_io_spi` 的 32 位命令是单独一笔单线 MOSI 传输（带 SPI_TRANS_CS_KEEP_ACTIVE），参数 / 像素是后续若干笔（像素才走 QIO）。所以 CO5300 按「CS 拉低到抬起」解析帧：SPI 控制的 CS 以 MISC.cs_keep_active（位 30）判断传输后是否抬起，GPIO 片选看引脚拉高。头 4 字节不区分来自 COMMAND/ADDR 阶段还是 MOSI 数据，按线上字节顺序解析。
- 多线计时：各阶段 ceil(位数 / 线数) 个时钟；单线时与原公式逐位相同，golden 112/112 不变。实测（s3-co5300，40 MHz）：四线整帧总线时间 30.1 ms，强制单线 97.1 ms；纯像素数据 23.0 / 92.2 ms 正好 1/4。
- AMOLED 无背光脚：显示只看 SLPOUT + DISPON；亮度 0x51 只在 0x53 BCTRL 置位时缩放（默认初始化发 0x53 0x20、0x51 0xFF），避免不发 0x51 的初始化变全黑。
- 依赖 esp_lcd_co5300 锁 2.0.3（注册表标 Apache-2.0）；2.1.0 / 2.2.0 注册表标「Custom」，license.txt 虽相同仍不用。
- CO5300 3V3 电流按 40 mA 估算（典型亮界面，随画面变化，未标定）。

## 2026-10-20 E-04 S3 BLE：Xtensa 版 libbtdm 掩码签名 + 窗口 ABI 的 VHCI HLE
- 决定：S3 沿用 C3 的路线 a′，只靠 .bin 认出 libbtdm 的 8 个边界函数。`tools/ble_sigs.py gen-xt` 从 `third_party/btlib/*/esp32s3/libbtdm_app*.a`（IDF 5.1–5.5.1，Apache-2.0，见 LICENSING）生成 `core/crates/soc/src/ble/sigs_xt.rs`（8 个函数、488 个单元），匹配器 `ble/sig_xt.rs`，接入 `esp32s3/src/ble.rs`。仓库里只有掩码后的指令值、掩码和长度，没有库的原始字节，也没有反汇编。
- 掩码：库里指令上的重定位只有两种。
  - `R_XTENSA_SLOT0_OP`：PC 相对字段，按指令清零。L32R 留 at（0xff）；CALLn / J 留 op0 + n（0x3f）；BZ（BRI12）0xfff；BI0 / BI1 / LOOP / B（RRI8）0xffff；BEQZ.N / BNEZ.N 0x0fcf。遇到别的被重定位的指令（含 ENTRY）生成器直接报错，不猜。
  - `R_XTENSA_ASM_EXPAND`：`-mlongcalls` 的 `l32r aR, lit; callxN aR`。链接器可能松弛成 `callN` 并删掉 3 字节，所以记成一个 LONGCALL 单元（值 = n<<4 | R），两种形态都认。
- 文本段字面量池：`-mtext-section-literals` 把字面量池放在同一个 section 里、函数前面。签名从符号地址开始取，只取函数体。L32R 的立即数链接后会变，所以屏蔽掉。
- FILL：`.xt.prop` 里 flag 8（unreachable）的条目标出跳转后的对齐填充。松弛后，二进制里这里是 0–3 个零字节。记成 FILL 单元，匹配时 n = 0..3 回溯；size 为 0 的条目也算，因为链接后可能补字节。
- LIT：被重定位的 L32R 指向的字面量如果是无重定位的常量，就追加一个 LIT 单元，要求链接后那个字等于原值（地址按 `((pc+3)&~3) + (imm16|~0xffff)<<2` 算）。原因：5.1–5.3 的 `btdm_osi_funcs_register` 和 `r_h4tl_eif_register` 指令形状完全相同，只差 osi 版本常量。
- 搜索：函数入口 4 字节对齐（Xtensa ENTRY 函数要求），只在 4 对齐处试。短函数的处理同 C3：`register_callback` 只在 send_packet 附近 ±64KB 找，`get_mode` 只在 init 附近找。pll_track 单靠签名有 11 个同形函数，所以照 C3 按 `btdm_controller_enable` 调用前 24 字节内的 call 找；Xtensa 指令按字节对齐，逐字节扫，认 CALLn 和未松弛的 `l32r+callxN`。
- HLE（与 C3 用 code_patch 改取指不同）：
  - 入口地址直接放进 `Cpu::hle_addrs`，在 ENTRY 执行前拦截，窗口还是调用者的。
  - 读写都按 CALLINC 偏移 4n：参数 a(4n+2..)，返回地址 a(4n)，结果写 a(4n+2)。PC = (ra & 0x3fffffff) | 高 2 位，不跑 RETW，窗口不变，和已有 `hle.rs` 的 ROM HLE 同一套规则。
  - 要回调固件函数（malloc_internal、task_create、信号量、notify_host_*）时，借调用者的 CALLn：设 a(4n) = n<<30 | 魔术槽、PS.CALLINC = n、PC = f。f 自己跑 ENTRY / RETW 回到魔术槽，窗口仍是调用者的。原返回地址按调用者 SP 存进表，所以不同任务交错调用也不会乱。
  - 不在会返回的帧里临时降 SP：窗口溢出写的位置和下溢读的位置会对不上。只有永不返回的桩任务入口把收包缓冲放在 SP 下方，和 C3 一样。
  - 桩任务名不能放栈上（会被溢出区覆盖），改成用 osi `_malloc_internal`（偏移 120）分配 8 字节。
  - task_create 的第 7 个参数 core_id 走调用者栈。我们不写调用者的帧，原样读；bt.c 把 ≥ 核数的值当 tskNO_AFFINITY，取到 0 或 1 也都能跑。
- 公共接口变化：`tryboard_soc::ble` 新增 `pub mod sig_xt`、`pub mod sigs_xt`，`sig::{Unit, Seg, Hooks}` 复用。原有函数签名一个没改；`ble_sigs.py` 的 RV `gen` 输出与改动前逐字节相同。esp32s3 `SocBus` 新增 `ble: ble::Slot`；Chip 的 `ble()` / `ble_mut()` / `ble_error()` 在 S3 上实现，CLI `--ble-phone` / `--inputs ble=` / wasm `tb_ble_*` 不用改就能用。
- 覆盖：签名覆盖 5.1-5.2、5.3、5.4、5.5.0、5.5.1 的 S3 库（`libbtdm_app.a` 与 `libbtdm_app_flash.a`），只用本机 5.5.1 编的 s3-ble-hr 实测；`check-xt` 对照 app.elf 确认 8 个函数各自唯一命中且地址正确。
- 防误认：`esp32s3::ble::tests::sigs_hit_only_ble_firmware` 遍历 firmware/build 下所有 S3 镜像（51 个），只有 s3-ble-hr 被认出；其余镜像去掉 BLE_INIT 门槛单跑 5 个长签名，也零命中。
- 替代方案：
  - 改取指打补丁（C3 做法）：Xtensa 的 3 字节指令和 L32R 字面量池让 8 字节跳板难放，否掉。
  - 在 ENTRY 之后拦截：要自己模拟 RETW 和窗口下溢，否掉。
  - 解析 app.elf（路线 c）：要求用户上传 ELF，留作后备。
## 2026-10-20 E-06 虚拟电脑（Claude Desktop Buddy BLE 中心）
- 决定：虚拟电脑做成虚拟手机的一种模式（`Phone.desk: Desk`），协议状态单独放 `soc/src/ble/desk.rs`（行缓冲、拆片、心跳生成、ack 解析），GATT 客户端（扫描 / 连接 / MTU / 发现 / 订阅）沿用 phone.rs。`desk.on == false` 时手机所有路径不变，c3-ble-hr / c3-ble-led 输出逐字节不变（golden 校验）。替代：另写一个独立中心——要复制一套 GATT 客户端，否掉。
- 命令复用手机通道：输入日志 `pc=on|off|json,<base64>|hb,<base64>`，`Ble::phone_cmd` 认 `pc=` 前缀；wasm 不加导出（`tb_ble_cmd("pc=on")` 即可），`gen_wasm_ts.py` 不用跑。CLI `--desk-pc` = 第 0 周期 `pc=on`。
- 写方式按特征属性选：RX 有 write-without-response 就用 0x52、每连接事件最多 4 片（`WRITES_PER_EVENT`，假设值，真手机 / 电脑的每事件包数因栈而异）；否则 Write Request 一片一事件。拆片长度 = 协商 MTU − 3（phone 原有的 MTU 交换已够用，没再改）。
- 确定性：时间 = `BASE_EPOCH`（2026-10-20 10:42:00 UTC+8）+ 模拟秒；tokens / running / waiting / entries 只由会话开始后的模拟时间决定（相位 6 s：running 0/1 交替、每 3 相位 waiting=1、entries 8 条滚动，默认心跳约 290–315 字节 > 244，必然分 2 片，用来验收重组）。owner 名固定 `TryBoard`。没有任何墙钟。
- `pc=hb,<base64>` 设心跳模板，`{tokens}` `{tokens_today}` `{running}` `{time}` 按模拟时间替换；设了模板就不再按相位变化发，只在设置时与 10 s 保活时发。`pc=json` 原样排队发一次（可以超过 4KB，用来测设备丢弃；正常电脑不会发）。
- 接口留口（未做）：录制回放与本机 Magpie 数据源都落到「往 `Desk` 推行」——网页 / 本地代理把真实心跳转成 `pc=hb,` 或 `pc=json,` 输入日志行即可，重放仍逐字节一致；要更细可在 `Desk` 加 `source` 枚举（Script / Recorded / Live），Live 只在网页侧，CLI 永远读输入日志。
- 已知小瑕疵：输入在 1 ms 片边界应用，BLE 的连接事件是惰性推进的，所以 `pc=json` 记在 9.000 s 而发出那行标 8.998 s（与 `ble=write` 同样的现有行为，确定性不受影响；改成先推进再应用会让 c3-ble-led 的 golden 变，暂不动）。
- 固件 c3-ble-nus：NimBLE，广播名 Claude-TB（NUS 128 位 UUID 放扫描响应，31 字节放不下），RX 可写 / 无应答写，行缓冲 4096 字节，JSON 用 IDF 自带 cJSON（json 组件）；status ack 带 bat / sys / stats / fw，故意 > 244 字节以验收电脑侧重组；owner / 未知命令回 ack（未知命令 ok:false）；time 调 `settimeofday`。
- 授权：协议按公开文档 anthropics/claude-desktop-buddy REFERENCE.md 自写，没有用任何第三方实现代码。

## 2026-10-20 二进制预压缩旁文件（R-18）
- **格式 gzip -9（`gzip -9 -n -k -f`）**：build_web.sh 给 `wasm/tryboard.wasm`、`rom/*.elf`、`fw/*/flash.bin` 生成 `.gz` 旁文件，`-n` 不写时间戳，重复构建逐字节相同（R-19 内容哈希要用）。不用 brotli：浏览器 `DecompressionStream` 不支持；不用 deflate-raw：没有现成命令行工具，gzip 头只多 18 字节。
- **固件截尾**：拷到 `web/public/fw` 时去掉尾部 0xFF，长度按 4 KB 向上取整。三款 SoC 开机都把 flash 补 0xFF 到 max(头部声明容量, 4 MB)（c3 `boot.rs:168`、s3 `boot.rs:249`、esp32 `boot.rs:200`），内置固件都 ≤ 4 MB，所以模拟结果逐字节不变（levels / replay 指纹一致）；JS 侧不补齐。唯一可见变化：实验台「大小」显示截后大小（arduino-blink 4096 KB → 356 KB），与 b64 打包模式（pack_artifact.py 早就 rstrip 0xFF）一致。
- **fetchBuf 回退顺序**：b64 打包页 → `.b64.txt`（不碰 `.gz`，pack_artifact.py 删掉 `.gz`）；否则 `.bin` / `.elf` / `.wasm` 且有 `DecompressionStream` 时先取 `url + '.gz'`：非 2xx 或 Content-Type 含 html（SPA 兜底页）→ 回退原文件；字节以 1f 8b 开头 → 解压，解压出错 → 回退；不是 gzip 魔数 → 当成托管已按 `Content-Encoding: gzip` 解过（vite preview 就这样）直接用。音频等别的类型不试 `.gz`，避免 404 噪声。
- 替代：只靠托管压缩 —— 不少静态托管不压 `.bin` / `.elf`（R-18 要求不依赖托管配置）；把原长度写进 manifest 在 JS 侧补齐 —— 多一次请求，且 Rust 本来就补齐。
## 2026-10-20 E-07a 示例固件「AI 网关仪表盘」（s3-ai-dash）
- 决定：一个固件串起 E-01 / E-02 / E-04 / E-06：CO5300 QSPI（照 s3-co5300 初始化）+ LVGL 9.2.2 / esp_lvgl_port 2.6.0（照 s3-lvgl，40 行 × 2 DMA 缓冲在内部 RAM，不用 PSRAM / 整帧缓冲）+ I2C 三颗（照 s3-amoled-i2c）+ NimBLE NUS（照 c3-ble-nus，广播名 Claude-Dash）。**没有新依赖**：组件版本与已核的 s3-co5300 / s3-lvgl 相同（esp_lcd_co5300 锁 2.0.3）。字体只开 LVGL 自带 Montserrat 14 / 20 / 28 / 48（MIT），英文界面，不带中文字库。
- 触摸不用 esp_lcd_touch_cst9220 组件（不在 LICENSING 清单，也省一次许可证核对）：自写 LVGL 指针 read_cb，按下状态取 INT 脚电平（低 = 按下），坐标读 0xD000 报点并回 0xAB；翻页由 read_cb 在松手时按位移判定（|dx| ≥ 60 且大于 |dy|），不用 LVGL 手势 / tileview——后者依赖每次读的速度阈值且翻页动画要重画十几帧整屏，脚本触摸下结果对时间点敏感。
- 页面用 4 个容器显隐切换；CO5300 窗口要求偶数起点 / 偶数宽高，加 `LV_EVENT_INVALIDATE_AREA` rounder（真机同样需要，模型不强制）。
- RTC：收到 `time` 消息时 `settimeofday` 并把**本地时间**（epoch + tz）写进 PCF85063（板子官方示例的做法）；顶栏和第 4 页每秒读 RTC，OS 位置 1 时显示 `--:--`。电量每秒读 AXP2101 0xA4 / 0x00，status ack 带真实电量（虚拟电脑日志 `battery 50%` 可核）。
- 验收用屏幕区域：accept.json 新键 `lcd_regions: [{name, x, y, w, h, color?, tol?=8, min_pixels?, max_pixels?}]`，accept.sh 自动加 `--lcd-ppm Reviews/lcd/<id>.ppm`，统计矩形内颜色（每通道 ±tol）或非黑像素。数值用几何量绑定（LOAD 条 running/total、上下文条 tokens/200000、电量条 pct），所以像素数精确等于期望值即「数值对」；不做 OCR。没有改 CLI（`run` 不变长）：每个用例只看结束时一帧，翻页用单独用例结束在目标页来验。
- 核心改动只有一处测试：`esp32s3::ble` 的 `sigs_hit_only_ble_firmware` 把 s3-ai-dash 列为 BLE 固件（它确实链接 NimBLE，签名认出是对的）；模型行为未改，已有用例输出不变。
- 替代：ArduinoJson / 第三方 Buddy 固件（vthinkxie/claude-desktop-buddy-esp32，许可证 NOASSERTION）——不用，协议按公开文档自写，JSON 用 IDF 自带 cJSON。
- 未做：网页示例库 / 蓝牙坞（E-07b）；配对加密（E-08）；时区只按 time 消息里的偏移，不存 NVS。
## 2026-10-20 E-07b 网页：虚拟电脑面板与 s3-ai-dash 示例
- **决定**：虚拟电脑命令走现有 `sim.ble()` 通道（wasm `tb_ble_cmd` 已认 `pc=`），但输入日志序列化成裸 `pc=...`（不加 `ble=` 前缀），与 CLI `board_action` 一致；simrun 重放同时接受 `ble=` 与 `pc=`。core / CLI 未改。
- **决定**：examples.json 新键 `"pc": true` → `Session.deskPc`；onBoot 时 `sim.ble('pc=on')` 作为一条被记录的输入（重启后仍开，导出重放可复现）；loadFirmware 换固件时清零；面板开关同步该标志。
- **决定**：心跳编辑表单发 `pc=hb,<base64>`，数字是字面值，entries 里保留 `{time}` 占位（由 core 模板填时间）；之后按 core 规则每 10 s 重发。「JSON 行」发 `pc=json`，只发一次。
- **决定**：布局：桌面在「蓝牙」坞右侧 340 px 侧栏；移动端（< md）用「空中日志 / 虚拟电脑」两页签切换，虚拟电脑开着时默认显示它。虚拟手机面板与 `ble=` 行为不变。
- **原因**：不改内核即可网页 / CLI 对齐；示例开箱即见数据。
- **备选**：给 PC 单开 wasm 导出（多改 core，否决）；把心跳模板做成自由 JSON 编辑框（易写错 total 键，保留为「JSON 行」高级入口）。
- **备注**：brief 指定 5191 端口被别的进程占用，走查改用 5197；已知：虚拟电脑占用共享中心时构建树「虚拟手机」行显示「已连接」。

## 2026-10-20 E-05 Bluedroid 主机栈
- 决定：只补虚拟控制器（`soc/src/ble/mod.rs` `Ble::command`），VHCI 定位与 HLE 不动——Bluedroid 固件链接的 libbtdm_app 与 NimBLE 固件是同一份，c3 / s3 签名都直接认出（`sigs_hit_only_ble_firmware` 的名字前缀加上 `c3-bluedroid-` / `s3-bluedroid-`）。
- 先跑 c3-bluedroid-nus 看 `unknown_cmds` 与崩溃，逐条按蓝牙核心规范 v5.3 Vol 4 Part E 补：
  - 0x2003 LE Read Local Supported Features（§7.8.3）：由全 0 改成只置 bit 6 LL Privacy。原因：Bluedroid 默认 `CONTROLLER_RPA_LIST_ENABLE`，`BTM_SecRegister` → `btm_ble_add_default_entry_to_resolving_list` 无条件入队解析列表待办，而队列只在 `supports_ble_privacy()` 且 Read Resolving List Size（0x202A，已有，回 8）> 0 时分配；不报 privacy 就写空指针（实测 Store access fault 后无限重启），队列下标还对列表大小取模。真 libbtdm 支持 LL Privacy，所以和硬件一致。其余位（DLE、2M、扩展广播）仍报 0，主机不走那些路径。NimBLE（IDF 5.5.1）只存不读这个字，golden 证明它的输出逐字节不变。
  - 0x0C14 Read Local Name（§7.3.12）：status + 248 字节名字（"TryBoard" 补 0）。原来兜底只回 status，返回参数长度不符合规范。
  - 0x0C35 Host Number Of Completed Packets（§7.3.40）：按规范正常情况不产生事件，不再回 Command Complete（Bluedroid 发它时带 NOACK 标志，不等应答）。主机侧 ACL 信用不建模：主机处理很快，控制器从不扣着包。
  - 0x0C31 Set Controller To Host Flow Control（§7.3.38）、0x0C33 Host Buffer Size（§7.3.39）、0x202E Set RPA Timeout（§7.8.45）、0xFD09 Espressif 厂商命令「广播报告流控」（Bluedroid `HCI_VENDOR_BLE_SET_ADV_FLOW_CONTROL`）：只回 status 0，显式分支，不再算未知。
  - 0x2027 / 0x2028 / 0x2029（解析列表增删清，§7.8.38–40）、0x202D（地址解析使能，§7.8.44）、0x204E（隐私模式，§7.8.77）：只回状态本来就对，但 NimBLE 也发，挪成显式分支会让 c3-ble-* / s3-ble-* 的 `HCI commands answered with plain success` 行变掉，所以留在兜底。解析列表只应答，不做 RPA 解析，所有对端地址当身份地址。
- 连接建立后 Bluedroid 没有再发未知命令，Number Of Completed Packets 节奏沿用 NimBLE 那套就够（golden 里 Bluedroid 只剩 0x2029×1 0x2027×1 走兜底）。
- 固件 c3-bluedroid-nus / s3-bluedroid-nus（同一份 main.c，S3 用 `../../c3-bluedroid-nus/main/main.c`）：属性表 API（`esp_ble_gatts_create_attr_tab`），广播名 Claude-BD（名字放广播、NUS 128 位 UUID 放扫描响应，原始数据 API），本地 MTU 247，RX 可写 / 无应答写，TX 通知按 MTU-3 拆片；协议行为同 c3-ble-nus 但简化（status ack 约 264 字节，故意 > 244 让 Bluedroid 连发 2 条通知；订阅后约 100 ms 发一条问候，给不写 RX 的虚拟手机一条通知）。sdkconfig 同时开 `CONFIG_BT_BLE_42_FEATURES_SUPPORTED` 与 `_50_`，与 Arduino-ESP32 预编译库一致（IDF 默认只开 5.0，传统广播 API 链接不上）。
- 验收：accept.json 新增 c3-bluedroid-nus / s3-bluedroid-nus（`--desk-pc`，固件收 time / owner / 心跳、回 ack，电脑重组 2 片 status ack）与 c3-bluedroid-phone / s3-bluedroid-phone（`--ble-phone`，扫到、连上、发现 NUS、订阅 TX、3 s 内 1 条通知）；c3-ble-hr / c3-ble-led / c3-ble-nus / s3-ble-hr / s3-ble-led golden 逐字节一致。
- 替代方案：sdkconfig 关掉 RPA 列表（`CONFIG_BT_BLE_RPA_SUPPORTED` 一类）——只对我们自己的固件有效，用户 / Arduino 固件照样崩，否掉；按主机栈分别应答——要猜主机是谁，否掉。
- 未做：Arduino 未安装，没用 Arduino 编译产物实测；配对加密（E-08）、经典蓝牙不在范围。

## 2026-10-20 词典按页面分组、HTML 预加载（R-20）
- **按「谁用」分组，不按区域文件**：首页 / 选板用到的词条散在全部 7 个区域文件里（首页 719 条分布在 data / lab / views / checks / steps / net / site），按文件整体分组省不下来。改为三组：`site`（首页可达 + 模拟 worker 可达，所有页面都装）、`select`（选板可达且首页不可达）、`app`（其余，原区域文件 data / checks / views / lab / steps / net 合并成 `app.ts`）。页面在 `<html data-i18n="...">` 里声明要装的组；没写就装全部（安全默认）。
- **「可达」靠脚本算，测试兜底**：`tools/i18n_reach.mjs` 用 TypeScript 解析器从页面入口走静态 + 动态 import（不进 worker），收集字符串字面量、JSX 文本和被 import 的 JSON 值，与词典键求交。`web/test/i18n-groups.test.ts` 要求每页可达的键都在它声明的组里、组之间不重叠、三种语言每组键相同。漏了用 `tools/i18n_regroup.mjs` 自动上移（只上移不下移，保留分节注释）。看不到的情况：键只在运行时数据里（fetch 的 JSON、拼出来的键）——首页 / 选板目前没有这类（已 grep 两页可达模块里的 fetch，只有 wasm / ROM / 固件 / 真联网）。
- **保留 top-level await，只换等什么**：没有改成「入口先 await 词典再动态 import 页面」，那样多一跳；`i18n/index.ts` 并行 `import()` 本页的几个组再合并，模块顶层的 `t()` 照常可用。worker 固定只装 `site`（worker 可达的 7 条都在 site）。
- **去瀑布用构建期内联脚本**：Vite 插件 `dictPreload`（`web/vite.config.ts`）在构建产物 HTML 的 `<head>` 最前面插一段内联脚本，按 `?lang=` > `tb-lang` > 浏览器语言（与 `detectLocale()` 同序）选语言，给本页各组插 `<link rel="modulepreload">`。语言选择逻辑因此有两份（内联 JS 与 TS），改一处要同步改另一处。dev 没有 bundle，不插。词典 chunk 统一命名 `assets/i18n-<语言>-<组>-<hash>.js`（主构建和 worker 构建都是），perf.mjs 据此单列 `dict` 字节。
- **跨文件重复键去重**：原合并顺序下同一键在多个区域文件里每种语言有 165 条重复（只有 zh 1 条译文不同），按原合并顺序保留胜出的那一条，其余删掉；合并后的整本词典与改前逐条相同（三语言各 3704 条）；新规则：只有 app 组内部的区域文件之间允许重复。
- **`hasT()` 语义变为「本页装的组里有没有」**：数据文件用它挑翻译字段，首页 / 选板可达的数据键都在 site / select，结果不变。
- **不做**：按键生成每页专属词典文件（最省字节，但词典变成生成物、人工改翻译要回到源头再生成，太绕）；把 site 再拆成「首页」与「共享」（site 现 zh gzip 25 KB，再拆收益小于多一个请求）。

## 2026-10-20 大资源内容哈希与缓存头（R-19）
- **`?v=<sha256 前 10 位>` 而不是改文件名**（wasm / ROM / 固件 / src.json / src.zip / examples.json / 音频 / fonts.css）：文件名不变，`.gz`、`.b64.txt` 旁文件、CLI（`tryboard run web/public/fw/x/flash.bin`）、npm 包、下载文件名、所有 webtest 静态服务器（都只看 pathname）都不用动；`.gz` 与原文件同一 hash（`gzip -n` 由原文件确定）。代价：CDN 缓存键必须含查询串（Netlify / Cloudflare Pages 默认含；CloudFront 要配）。woff2 例外，**改文件名**（`tb-sans-sc-latin.<hash>.woff2`）：fonts.css 本来就间接引用，任务要求也是文件名带 hash；subset.py 的跳过判断改成 stamp 里记 key + 实际文件名，并固定 `head.modified` 让重建逐字节相同（实测删 stamp 重建，14 片 + 等宽文件名一致）。
- **清单内联进 HTML**（vite `transformIndexHtml`，`order: 'post'`，在 Vite 把 `/fonts/fonts.css` 改成 `./fonts/fonts.css` 之后再加 `?v=`）：不多一次串行请求；HTML 本来就 no-cache；只改 wasm 时 JS 块名不变（实测翻一字节：155 个 URL 只变 wasm 一个，`dist/assets` 文件名全同）。替代：生成 `assets.gen.ts` 打进 JS —— 每次固件变都会让入口块 hash 变、二访要重下 JS，且生成文件进 git 会天天脏；运行时取 manifest.json —— 多一次串行请求。
- **`assetUrl` 单独放 `web/src/assetver.ts`**（不碰 document 以外的 DOM，模块顶层不执行查询）：`examples.ts` 被 node 测试间接引用，不能依赖 `assets.ts` 顶层的 `document.querySelector`。没有清单（vite dev 未跑 build_web、node 测试、npm CLI）→ 原样 URL；b64 打包页不加（文件名必须与打包时一致）。
- **`_headers` 不用 `/*` 兜底**：Cloudflare Pages 文档写明同一路径匹配到的多条 Cache-Control 用逗号拼接（Netlify 未核实，按同样处理）（`no-cache, public, max-age=…, immutable` 含义冲突），所以只列哈希目录（immutable）和页面路径（no-cache），其余吃托管默认（`max-age=0, must-revalidate`）。不用 `/*.html` 这类中间通配，两家语法支持不一致。
- **测试**：`web/test/assethash.test.ts`（npm test）在临时目录里造文件跑 asset_hashes.py，翻 wasm 一字节只变一个 key；perf.mjs `--revisit` 按 dist/_headers 发 Cache-Control + ETag / 304，每个入口用新 profile 连开两次。托管尚未定，没有部署任何东西。

## 2026-10-20 M5Stack 支持可行性评估（待人确认）
- 结论写在 `docs/M5STACK.md`：可行，先做共用底座（SPI 屏读回、通用屏模型、I2C1 挂设备、USB-Serial-JTAG 串口、S3 SPI3、eFuse 封装号），再按 M5Dial → AtomS3 → CoreS3 → Cardputer 接入；经典 ESP32 板等经典 SPI / RMT / I2S 补齐。不做 Tab5（P4）、NanoC6（C6）、PaperS3。
- 参考了 M5Unified `3590358` / M5GFX `a8ebd7b`（MIT，内含 LovyanGFX BSD-2）的源码来理解自动识别流程，只读、未抄；三者尚未进 LICENSING.md，动手前补。
- 建议的 M5-00 – M5-10 条目尚未写进 PLAN，等人确认范围。

## 2026-10-20 DS18B20 单总线模型（F-04c）
- **依据**：Maxim DS18B20 数据手册（命令、暂存器、温度表、转换时间）、AN126（标准速度时隙）、AN187（搜索算法描述）。没有读或抄 Arduino OneWire / DallasTemperature 源码（RS-3 标许可证不明）；固件驱动也是照 AN126 / AN187 自写。
- **一条总线一个 `OneWireBus`**（`soc/src/devices/ds18b20.rs`，挂在 `PinDevices.onewire`）：`pins_update` 按脚驱动，同一脚放两个独立器件会互相覆盖，所以由总线统一判沿、输出线与后的一路驱动，器件只保存协议状态。释放时驱动 1，代替模块上的 4.7k 上拉（和 DHT11 一样，让只设 INPUT 的固件也能读到高）。
- **时序阈值**：主机低 ≥ 430 µs 算复位（手册 480 µs 起，留 10 % 给忙等误差）；写时隙低 < 30 µs 为 1（器件在 15–60 µs 窗口内采样，取典型 30 µs）；读时隙要发 0 时从主机下降沿起拉低 30 µs；存在脉冲在主机释放后 30 µs 起拉低 120 µs。读时隙在下降沿就消费掉，随后的上升沿只检查是否复位，不当写位。
- **CLI 多器件的温度偏移**：`--ds18b20 GPIO,N` 的第 i 个器件读 `--env` 温度 + 0.5·i °C。全部同温时，MATCH ROM 选错器件或线与读到别的器件都看不出来；加固定偏移后 accept 能核对「ROM 1 → 23.5、ROM 2 → 24.0」。代价：多器件读数不是同一个环境值；以后要逐个设温度时加脚本动作。替代：所有器件同温（无法验寻址），否掉。
- **序列号固定**：`28 | 3A^(0x41·i) 5C 1E 0B+i 00 00 | CRC`，确定性，输出逐字节可比；搜索顺序由 ROM 位决定。
- **上电温度寄存器 85 °C（0x0550）**：和真件一样，转换前读暂存器得到 85，固件 / 用户能看到这个经典坑。
- **CLI 结构**：`--dht11` 与 `--ds18b20` 的解析和结尾统计挪到 `wire_sensor_args` / `report_wire_sensors`，因为 `run` 函数受 lint_size 限长（818 行不许涨）；行为不变（c3-dht11 用例照过），`run` 因此缩短，allow 表已更新。
- **未做**：网页（不在本条范围，wasm 没导出接口）；寄生供电、超速模式、EEPROM 写入 10 ms 忙、转换精度误差与自热。

## 2026-10-20 · F-01a 分享链接（台面状态 v1）
- 格式：JSON `{v:1, w, sel?, cp?, fw?:{ex,h}, chip?, scene?, ext5v?, mods?, harness?, env?, heat?, loc?, run?:{endMs,s}, cut?}` → `CompressionStream('deflate-raw')` → base64url → `?s=`；编解码在 `web/src/app/sharestate.ts`（纯模块，F-01b / F-02 / F-03 共用）。不加 npm 依赖。
  - 输入脚本存成 `--inputs` 正文（换行分隔、秒精确到微秒），不用 `toScriptInline`：和 CLI 文件同一格式，Node 里解码后直接写文件就能重放；新增 `inputlog.fromScript / fromAction / toScriptBody` 做反向解析。
  - 场景只在和示例默认不同（或自定义作品、开了外接 5V）时才写，链接短（weather 按 BOOT + 改温度约 233 字符）。
  - 版本号比当前新 → 提示刷新；解不开 / 校验不过 → 提示后开默认台面。字段逐个校验，脚本必须能被 `fromScript` 解析。
- 打开链接：存成本地副本，键 `share:<fnv32(s)>`（`work.key`），BOM、放置、装配线束都走这个键（`scopeCaseHarness`、`loadBom(work, template)` 用原作品的清单做起点），不覆盖自己的作品。看的人保持自己的界面语言（`loc` 只记录不切换）。
- 恢复：等首次开机 → 必要时换成链接里的内置固件 → 哈希不同就提示「示例固件已更新」→ `session.seek` 重新上电快进到 endMs → 自动接着跑。台面「历史」不记录这一段快进（v1 已知限制）。
- 隐私：真网开关（`realnet`）和回包（`netreply`）整条丢掉；手机提交的表单里 ssid / pass / password / psk / key 等字段，非演示值（MyHome / 12345678 / wrongpass）换成 `***`；固件热点的 `join` 保留（是固件自己的热点）。被剥的项记进 `cut`，两边都提示。
- 自带 .bin 不进链接（只带台面，提示下一版导出文件）；超过 8000 字符去掉输入脚本、只留台面和首个环境值，同样提示。
- 开机时的线束（i2cwire / antenna）、真网开关、网络预设本来就经 worker `apply()` 记进输入日志，不用补。
- asmstate / caseparams 只读不写；sharestate 里自带一个 fnv32（`custom.ts` 的会带进重依赖）。
## 2026-10-20 PIR / 光敏电阻 / 继电器 / RC522 模型（F-04d）
- **放在 `PinDevices.parts`（soc `devices/gpio_parts.rs`）**：跟 DHT11 / HC-SR04 一样随 PinDevices 跨软复位保留，C3 / S3 / 经典 ESP32 共用；RC522 也挂在这里（只记片选和卡），不给 SocBus 加字段，减少和 M5 会话改同一文件。
- **HC-SR501 按可重复触发（H 档，模块出厂常见跳线）**：有人期间一直高，人走后再保持 `hold`（`--pir GPIO,秒`，默认 5 s，对应延时电位器）；输出落下后 2.5 s 封锁期（BISS0001 典型值）内不再触发。上电约 60 s 预热不模拟（教程固件都不等，等了只会拖慢验收）。替代：L 档不可重复触发——少见，以后加 `,l` 参数即可。
- **继电器只看 IN 脚电平**：默认高电平吸合（三极管驱动模块），`--relay GPIO,low` 为低电平触发光耦板；吸合约 10 ms 延时与触点抖动不模拟；电源估算按线圈一直吸合计 5V 70 mA（最坏情况，教程要提醒的正是 USB 口带不带得动）。
- **光敏电阻**：3V3—LDR—脚—10 kΩ—GND，越亮电压越高；GL5528 级参数（10 lux 时 10 kΩ、γ 0.7、暗阻 1 MΩ 封顶），10 lux 正好 1650 mV。C3 / S3 ADC 12 dB 量程约 2.5 V 饱和，亮处读数饱和是真机也会有的现象，不改公式。C3 只允许 GPIO0–5（ADC1/2 脚）、S3 GPIO1–20。
- **RC522**：按 NXP MFRC522 数据手册寄存器帧（读 `0x80|reg<<1`、写 `reg<<1`，同一帧内连读 FIFO）、ISO 14443-3 REQA / WUPA / 防冲突 / SELECT（CRC_A）/ HLTA 实现，可读 4 / 7 字节 UID；收发与 CalcCRC 立即完成，超时由「没卡」直接置 TimerIRq；MFAuthent 回 ProtocolErr，读块不做（F-04d 范围只到 UID）。软复位或关天线让卡回 Idle。只接 SPI2（C3 `spi2_transfer`、S3 `spi_transfer` 在别的设备都不认时才交给它）；片选三种走法都认：IO_MUX FSPICS0、GPIO 矩阵 FSPICS0–5、普通 GPIO 拉低（Arduino 写法，GPIO 拉高结束一帧）。默认 CS 取 Arduino 核的 SS 脚（C3 GPIO7、S3 GPIO10），`--spi rc522@cs=N` 可改。经典 ESP32 的 SPI 路径属 M5 会话在改的区域，暂不接（报错）。参考：MFRC522 数据手册、ISO/IEC 14443-3 公开描述；未看任何 GPL 驱动代码。
- **固件**：s3-pir-relay / s3-rc522 用 `../../c3-*/main/main.c` 同一份源码，按 `CONFIG_IDF_TARGET_ESP32S3` 换脚（S3 LDR 在 GPIO2，因 GPIO3 是 strapping 脚；RC522 用 SPI2 IO_MUX 脚 12/13/11/10）。
- **CLI 行数**：`run` 受 lint_size 限制不能变长，新增动作 / 事件 / 报告放进 `cli/src/parts.rs`（`parts_action`、`parts_events`、`pin_reports`），顺带把编码器 / 超声 / DHT11 的结束汇总挪进 `pin_reports`（输出顺序与文字不变）。

## 2026-10-20 M5 批次（M5-01 – M5-14）汇总决定

- **经典 ESP32 四线 PSRAM 容量（M5-14）**：默认关闭，`--efuse-pkg 6` 隐含 2MB（PICO-V3-02 封装内置），Core2 等外置 PSRAM 由板预设传 `--psram 8`（CLI 取 0/2/4/8）。PSRAM MMU 表项（1152..1279）复位值取恒等映射而不是无效：TRM 没写复位值，IDF 的 low/high 模式写回循环在 2MB 芯片上会读 +2MB 处，恒等映射不报错且与真机可观察行为一致。替代：无效（PICO-V3-02 启动 LoadStoreError）。flash JEDEC 容量 = max(镜像头, 4MB)；CS1 无芯片时 MISO 读 0xFF；reboot 保留 efuse / chip_v3 / psram（板子事实）。
- **USB-Serial-JTAG 与 UART0 控制台去重（M5-05 / M5-03，`core/crates/esp32s3/src/usj_console.rs`）**：IDF 次控制台会把同一行同时写到 USJ 和 UART0。启发式：USJ 的 INT_ENA=0 + 2 ms 窗口 + 内容匹配才判为镜像并丢弃。理由：只按时间会丢掉纯 USJ 固件的 main_task 行，全保留则每行出现两次。USJ 只模拟 CDC 一侧，主机默认已连接（SOF 每 1 ms，64 字节满自动送出），否则 IDF 会卡 50 ms 发送超时。一个串口输入框同时喂 UART0 RX 和 USJ OUT。参考 Arduino HWCDC.cpp（LGPL）与 IDF 源码理解行为，未复制。
- **S3 GPIO 下拉语义与 4 个 AtomS3 golden 变化（M5-08）**：开漏释放、外部无人驱动、只有 IO_MUX 下拉（FUN_PD）的焊盘现在读 0（之前按 D-03 读 1）。原因：M5GFX 区分 Cardputer / Adv 对 G9/G8/G6/G5 做 `input_pulldown`，旧规则四脚全读 1 → 误判 Adv；真硬件上弱下拉也会把浮空焊盘拉低。替代：在预设里固定电平（拒绝，属于掩盖问题）。副作用：M5Unified 的 I2C 总线检测先下拉再要求读 1，在无上拉焊盘上现在读 0，直接跳过位拨 I2C 探测——不存在的器件探测快速失败。所以 4 个 AtomS3 golden 快照只有翻转计数变化（如 GPIO2 156→36、GPIO41 1133→3），检测结果相同，是有意变化，已重存快照。C3 / 经典 ESP32 暂保留旧规则（不对称，待统一）。
- **已解决（G-12，见 2026-10-23 一节）：经典 ESP32 PDM RX 样本两两颠倒（M5-13）**：M5Unified（`Mic_Class.inl` 约 770 行）认为经典 ESP32 RX FIFO 每两个 16 位样本顺序相反并会换回；我们 `i2s.rs` 的 `encode_rx` 对 PDM 跳过了交换（`!msb_right && !pdm`），M5Unified 录到的样本因此是锯齿。去掉 `&& !pdm` 后 M5Unified 正确，但 IDF 的 esp32-pdm-mic 从 1000 Hz 变成 3005 Hz（golden 不允许），所以没改，待调查：IDF 在真机上是否也颠倒（即 IDF 例子期望值本身有误），还是只有 rx_chan_mod=1（右槽，M5Unified）才颠倒（IDF 用 2）。在此之前 M5 麦克风 demo 只检查 peak > 0，频率行仅供参考。
- **待人处理的许可事项（M5-00）**：LovyanGFX 内的 `utility/lgfx_qoi.c/.h` 与 `Fonts/Custom/{Orbitron_Light_24,Roboto_Thin_24,Satisfy_24,Yellowtail_32}.h` 4 个字体头文件没有任何许可声明，需人复核（可用 `nm app.elf` 看 bin 里是否真有）；LovyanGFX（BSD-2）库内没有独立 license 文件，其 BSD-2 声明必须在托管任何 M5 Arduino bin 之前加入 NOTICES。在此之前 M5 Arduino 固件只在本地构建，不进仓库、不上站点。
- **M5-01 SPI LCD**：GC9A01 并入参数化 `DcsPanel`（PanelSpec 描述尺寸 / 偏移 / 极性 / ID），新屏只加常量；1 位哑时钟按 MISC.ck_idle_edge 翻转计数建模；屏挂在哪个 SPI 主机由 SCLK 的 GPIO 矩阵 func_out 决定；背光认 LEDC PWM 路由到 BL 脚且占空比 > 0；3 线与 4 线读共用读位流，使 CoreS3 MISO=DC=35 共用脚无副作用。参考 M5GFX（MIT）只读学习。
- **M5-02 I2C 按引脚总线**：哪个控制器的矩阵输出信号同时落在 SDA/SCL 焊盘上就由它访问总线，两脚都是普通 GPIO 时走位拨从机状态机；旧 `--i2c` 仍挂 I2C0 不看引脚（golden 不变）；上拉默认开。`--efuse-pkg 5` 同时清 APB_CTRL_DATE bit 31（M5GFX 该位为 1 时把 PICO-D4 映射成 6）。
- **M5-04 器件**：MPU6886 / FT6336U / FT3267 参数化复用 `Mpu6050` / `Ft6236`；BMM150 输出未补偿原始值（默认磁场 (25,0,−40) µT 为估算）；PCF8563 世纪位 1 按 19xx 解释（与 M5Unified 一致，与 NXP 原意相反）。
- **M5-05 板预设**：用 Rust 常量表（`boards.rs`）而非 JSON，`table_is_consistent` 在编译期 / 单测发现拼错；`verified` 标志区分「跑通过」与「按资料推测」（存根只警告，CLI 标 UNVERIFIED）。
- **M5-06 IMU 安装方向**放在板预设（`BoardPreset.imu_mount`），器件默认恒等映射：驱动会按板补偿安装方向，模拟器须提供补偿前原始轴。AtomS3 Lite / R 复用 m5stack_atoms3 的 bin。
- **M5-07 S3 PSRAM 四线 / 八线由板型决定**，默认八线：Arduino esp32 3.3.2 的 `m5stack_cores3` 声明 `psram_type=qspi`，模型按 AP 四线 die 回 ID `0D 5D 52`（8MB）；不改 eFuse / sdkconfig 让固件走八线（不符合真机）。
- **M5-08 其它**：I2S PDM RX 只做到 PCM 层；板载麦克风两声道放同一样本（`both`）；键盘图例映射是推断的，标「需真机」。
- **M5-10 / M5-11 / M5-12 经典 ESP32 外设**：GP-SPI 用独立 `ClassicSpi`（启动 / 中断 / DMA / 环形 W 缓冲语义差异大）；RMT 复用 `rmt.rs`（`RmtLayout::ESP32`，接收 / 载波 / APB FIFO 不做）；I2S 单独建模 `esp32/src/i2s.rs`（片内 lldesc DMA），PDM 在 PCM 层；ADC 校准走 eFuse ADC_VREF=3（1121 mV）的 IDF line fitting 路径。均只参考 TRM 与 IDF（Apache-2.0），未复制 espressif/qemu。
- **M5-13 其它**：经典 ESP32 触摸脚测量立即完成、OUT 固定 1000（只为让 M5Unified 区分 Atom Lite / Matrix）；`BoardPreset.battery_adc` 让无 PMIC 的板用 ADC 分压读电池（复用 AXP2101 OCV 曲线，开机 80%）。

## 2026-10-20 F-05 故障挑战关卡
- **格式**：levels.json 关卡加 `fault` 字段：`args` = 原样台面（叠在关卡 args 上）、`fix` = 参考台面修法、`fix_ref` = 参考固件修法、`knobs` = 玩家可改的开关（每个对应一个单值 CLI 开关）。叠加规则 check.py `merge_args` 与 web `faults.ts mergeArgs` 相同（已有开关改值，否则追加），所以网页和命令行跑的参数逐字相同、指纹相同。
- **check.py**：`--ref` 跑故障关做双跑自检（原样须 FAIL、修法须 PASS，标题行指纹取修好的那次），这样 `--ref --all` 保持全绿又能证明故障可复现；带开关（`--i2c-wire / --antenna-loss / --power / --servo`）就按原样 + 开关跑一次。npm 包同规则。
- **没加新 CLI 开关**：现有 `--i2c-wire`（elec::i2cbus 上升时间）、`--antenna-loss`、`--power` + `--servo`（欠压）足够覆盖四关；不碰 core。
- **跳过**：上拉电阻故障（要改 soc/i2c.rs，M5 会话正在改）；接错脚（内核不建模 I2C 引脚分配，无法命令行一致）。
- **新固件 `firmware/s3-adc1-wifi`**：fault-adc 的参考固件修法（ADC1_CH3 / GPIO4）。不发布到网页 fw/（那就是答案），faults.mjs 直接上传本地构建。
- **页面显示的命令**：有开关的关显示 `--ref --level <id> <开关>`（单次运行）；fault-adc 这类没开关的关只显示 `app.bin` 那行，因为单独的 `--ref --level <id>` 是自检、结论与页面「运行实验台固件」不同。faults.mjs 直接执行页面上显示的命令对比。accept.json 补 s3-adc1-wifi 用例。
- **check_config 的作品集合**：levels.json 的 `work` 除了 catalog/templates.ts 的模板 id，也接受 app/works.ts 里声明的作品（faults 没有商店模板，实验台回退到空白模板）。
- **作品 faults 不上首页卡片**：没有采购 / 组装内容，首页作品区下方一行链接进入；开关状态按关存 localStorage（仅本机便利，读写包 try/catch）。
- 备选：把健康配置写进 args、故障放 fault —— 否，`--ref --all` 就证明不了故障能复现。

## 2026-10-20 F-07a UART 长输入 + MicroPython 验收
- **UART RX 语义**：`periph.rs` 的 STATUS.rxfifo_cnt 封顶硬件 FIFO 深度 128（`UART_FIFO_LEN`，ESP32 / C3 / S3 相同，TRM），而不是 10 位字段上限 1023：IDF 驱动按 FIFO 深度开读缓冲，报更多会写越界；之前的 127 少报一个。多出的字节视作「还在线上」，INT_CLR 后只要 `rx` 不空就重新置 TOUT（达阈值再置 FULL）——FULL 在真机是电平式的，TOUT 相当于下一批字节到达后再次空闲。备选：真做 128 字节 FIFO + 线上队列按波特率进 FIFO —— 否，要改时序，所有 golden 会变。golden 173/173 字节一致。
- **`\xNN` 转义**（`cli/src/escape.rs`，`--uart-in`、`uart=`、`usbcdc=`）：只认 `\n` 和严格两位十六进制 `\xNN`，其它反斜杠原样保留；不加 `\\`，因为 web `inputlog.ts` 的 `esc` 不转义反斜杠，加了会改变旧输入日志的含义。旧日志只有含字面 `\xNN` 的文本解码会变。web 侧 `unesc` 仍只认 `\n`，F-07b 做网页时同步（届时 `esc` 也应把 `\`、`;` 写成 `\xNN`）。
- **验收用例取第三方 bin**：accept.json 新字段 `bin`（相对仓库根的路径）；文件不存在时 accept.sh 记 ⏭️、golden.py 记 skipped，都不算失败；check_config 对带 `bin` 的用例不查 firmware/ 目录。下载由 `tools/fetch_third_party.sh --micropython` 可选执行并校验 sha256，bin 只在 git 忽略的 third_party/ 下，不发布。
- **raw-paste 用定时发送**（`tools/micropython/paste.py` 生成 `--script`）而不是按提示符走状态机：CLI 脚本只有时间轴；每 128 字节窗口隔 0.1 s，远大于固件消化时间。网页（F-07b）照 RS-1 用提示符驱动。脚本里 `;`、`#`、`\`、控制字节和块首尾空格都写成 `\xNN`（脚本按 `;` 分割、动作会 trim）。

## 2026-10-20 F-01b `.tryboard` 作品文件
- **格式**：照 RS-4：`TRYBOARD 1\n` + 状态 v1 JSON 一行 + `\n` + 原始 bin。状态加可选字段 `bin {name, h, size}`（可选字段不升 `v`，ARCH 规则）；sha256 用完整 64 位 hex，不用链接里 10 位的 `fw.h`，因为这里是防损坏而不是认示例版本。按字节找前两个换行再解码，bin 不按文本处理。
- **打开走重新加载**：读状态 → `encodeState` 串和 bin 一起存 IndexedDB → 跳到短的 `?f=<shareKey 的 8 位 hex>`；`main.tsx` 取回状态串交给 `readShare`（和 `?s=` 同一函数），开机后 `restoreShare` 多一个可选参数 `own` 装自带 bin。不直接跳 `?s=`：长操作的状态远超 8000 字符，Node / nginx 等对请求行有 8–16 KB 上限会回 431。自带 bin 加载前再跑一次 `fwCheck`，防手改文件把别的芯片镜像配到本作品。场景、作品、检查点都在会话创建前定好，原地恢复要另写一条路径；重载保证和链接完全同一路径。备选：sessionStorage 放 base64（S3 镜像几 MB 会超限，否）；原地换场景（重复 main.tsx 的启动逻辑，否）。
- **IndexedDB 只做本机缓存**：刷新还能恢复；按 `?f=` 键存，只留最近 3 个，访问全部 try/catch，被禁用时提示后不跳转。项目里第一次用 IndexedDB，没加依赖。
- **坏文件整体拒收**：魔数 / 版本 / JSON / 大小 / sha256 任一不过就提示「文件已损坏」，台面不动、不跳转。备选：只恢复台面不带 bin —— 否，损坏文件里状态也不可信。
- **拖放**：页面级 `drop` 只接 `.tryboard`，且 `defaultPrevented` 时让给已有拖放区（检查点上传、零件库），`.bin` 拖到别处的行为不变。
- **链接提示改文案**：F-01a 的「下个版本支持导出文件」两条提示改成指向 ⋯「下载 .tryboard 文件」，三种语言同步改。
- 不做：上传服务器；CLI 直接读 `.tryboard`（RS-4 列为后续项，现有「导出输入日志」已能给 CLI）。


## 2026-10-20 分享卡（F-02）
- **二维码自写**（`web/src/app/qr.ts`，约 330 行）：照 ISO/IEC 18004 写字节模式、纠错 M、8 种掩码按罚分选。版本做到 1–40 而不是 RS-4 说的 1–25：条目要求「链接 > 2000 字符才去掉运行记录」，2000 字符要 v37 左右，v25-M 只装 997 字节。典型链接 200–600 字符落在 v10–v20；屏幕扫码稳定上限约 v25 仍是经验值，没有真机验证。剥掉运行记录后仍超 2331 字节就报错，不出卡。
- **测试夹具来自 qrencode 4.1.1**（本机 brew 已装的 CLI，只用来生成 `web/test/qr-qrencode.json`，测试运行时不调用、不是依赖）：固定版本 + qrencode 选的掩码，自写编码器逐模块一致。测试端解码器 `web/test/qrdecode.ts` 自带 GF 表并校验每块 RS 校验子为 0，sharecard.mjs 用它解码从 PNG 像素采样的二维码。
- **录像 mime**：分享卡按 `video/mp4;codecs=avc1,mp4a.40.2` → `avc1` → `video/mp4` → webm 顺序挑；台面「录像」保持 webm 优先（media.mjs 校验 webm 轨道参数，不改其行为）。两者文件扩展名和 Blob 类型都按 `rec.mimeType`，修掉 Safari 录 MP4 却叫 .webm 的问题。分享卡码率 4 Mbps（6 秒约 0.8–3 MB）。
- **没有短链接服务**：架短链服务要部署和域名，超出自主范围；卡片上印 host + 路径 + `?s=` 开头并省略号截断，完整链接靠二维码和「复制链接」。
- **卡片固定浅色**（不跟页面主题）：二维码黑底白码才稳，分享出去也不该受分享者主题影响。版式 1080×1350，上 810 px 是台面画面（静图用 `renderStill` 2× 超采样，视频每帧自己 `render()` 后同一任务里拷贝，因为 WebGL 缓冲不保留）。
- **出口是弹窗而不是自动下载**：一次点击要下两个文件，Chrome 会拦第二个；弹窗里预览视频，再分别下载视频 / PNG / 复制链接。`recordCanvas` 加了可选 `onBlob`（不传时行为不变）。
- 公共接口改动（全是可选参数、向后兼容）：`shareLink(base, state, max?)`、`makeShare(ctx, max?)` 返回值多 `truncated`；`recordCanvas(..., opt?: { prefer, bitrate, onBlob })`；新增 `pickMime` / `videoExt`；`renderStill(c, '')` 不画角标；`actions.shareCard`；测试钩子 `window.__tbCardLast`。
- 备选：npm qrcode / nayuki（MIT，但要先进 LICENSING）——否，自写 + 夹具对照足够；GIF / muxer —— 否，理由见 RS-4 §3。


## 2026-10-20 F-03 嵌入页
- **入口独立**：`embed.html` + `web/src/embed/`，不走 `createShell`；海报模块只引 i18n / sharestate / examples / works，`run.ts` 动态导入，会话、three.js、wasm 都在点击后。共享文件只做追加（vite.config 入口、`_headers`、三种语言 lab.ts 末尾 7 个键）。
- **不调 `readShare`**：它会 `saveCaseHarness` 写 localStorage；嵌入页自己解码、按 main.tsx 同样规则映射作品，直接用 `restoreShare`（只用到 `shell.toast`，传一个小 toast 对象），shareopen.ts 不改。
- **localStorage 内存副本**：点 ▶ 时把 `window.localStorage` 换成内存 Map（从真实存储拷贝），保证会话代码任何保存都不落盘，也避开 Safari 第三方 iframe 存储被拦时抛异常。备选：逐处加「嵌入模式」开关 —— 否，改动散在多个共享文件，漏一处就违约。
- **sandbox**：条目要求 `allow-scripts allow-same-origin`；但这样「在 TryBoard 打开」的 `target=_blank` 会被拦。文档给 RS-4 的完整写法（加 `allow-popups allow-popups-to-escape-sandbox`），并注明前两项是能运行的最小集合；测试宿主页用完整写法。
- **`_headers`**：只给 `/embed`、`/embed.html` 加 `frame-ancestors *`（与 Cache-Control 同块），其它页面不加 `frame-ancestors 'self'`（RS-4 建议的），避免影响现有托管行为，上线前再定。
- **工具栏尺寸**：鼠标设备且 iframe ≥ 480 px 时按钮 32 px（博客里 iframe 常 < 768 px，台面要留高度）；触屏 / 窄屏保持 44 px。

## 2026-10-20 M5-09（Grove 单元与网页 M5 板）
- **ENV 单元模型（M5-09a）**：QMP6988 整数补偿、SHT3x / SHT4x 命令集参考 M5Unit-ENV（MIT）与 Sensirion / QST 数据手册重写，未复制；OTP 用一组让多项式在量程内单调的虚构值。Grove 单元挂独立引脚总线（`i2c_bus_add`），不占 I2C0。`env_set` 改为更新所有总线上的环境传感器。
- **网页板 id 即内核预设 id（M5-09b）**：`BoardDevs.preset`；worker 在 `tb_boot` 后立即 `tb_board_preset`（与 CLI 同序），不匹配就拒绝运行。备选：独立 `scene.preset` 字段（否：一块板两个 id）。`tools/check.py` 指纹对任何 LCD 控制器都保留像素数行（原来只 GC9A01，导致 M5 板网页 / CLI 指纹永不相等）。
- **Cardputer 键盘**：宿主 `KeyboardEvent.code` → keyboard.rs 键名（Meta → opt），仅实验台有焦点时生效，日志 `key=<name>,1|0`，与 CLI 相同。
- **3D 外壳（M5-09c）**：一个参数化生成器 + 毫米尺寸表（`web/src/bench3d/m5shell.ts`），不画商标 / logo，不用外部模型。按键松开时主动拉高引脚：经典 ESP32 的 G37 / G39 没有内部上拉，悬空会读成按下。
- **Grove 单元放在 `SceneSpec.grove`（M5-09d）**：与 board 并列，不作为实验台上的可拖零件；只有 M5 预设时才送进内核。备选：可拖 Grove 零件 + 连线（否：Port A 引脚固定，连线没有可选项）。
- **撤销 / 重做竞态**：seek 进行中按下的撤销 / 重做不再丢弃，记下目标步，seek 结束后再跳（wiremode.mjs 原先偶发失败，与 M5 合并无关）。m5board.mjs 回放比对改为暂停后一次快照取输入日志与串口，逐字节比较。
## 2026-10-20 教学元件上网页（F-04a 第 1 部分）
- **wasm 新增导出并重编**：`tb_ds18b20_attach` / `tb_pir_attach` / `tb_relay_attach` / `tb_ldr_attach` / `tb_part_action` / `tb_parts_report`，只把已有 soc 模型接到浏览器，不改仿真行为；简报原说不重编 wasm，但不导出网页就接不上，故在 worktree 用 scratchpad target 重编并拷进 web/public/wasm（cargo test、clippy -D warnings 通过）。主会话合并后需按主树重编一次 wasm。
- **参数与 CLI 一个来源**：`web/src/partsdev.ts` 的 `partsArgs` / `partsFromArgs` / `rc522Spec` 生成与解析 `--ds18b20` / `--pir` / `--relay` / `--ldr` / `--spi rc522`；输入日志新增 `parts` 字段和 `pir` / `lux` / `card` 事件，`cliArgs` 直接给出可重放命令；worker 只在模型接受动作时才记日志。
- **RC522 只核对 CS**：C3 默认 CS=7 时 `--spi rc522`，其它 CS 写 `@cs=N`；SCK / MOSI / MISO 由固件 SPI 配置决定，模型不看，接线检查只按教程画线。
- **指示灯看 GPIO 电平**：继电器 LED、PIR 圆顶着色读 GPIO 电平，不从模型取内部状态（少一个导出，结果一样）。
- **W2 豁免 PIR**：HC-SR501 板上有稳压，VCC 接 5V 是正常接法；继电器本来就是 5V 模块。RC522 / 光敏 / DS18B20 接 5V 仍报 W2。
- **PIR 放置默认保持 2 s**：与 c3-pir-relay 示例和 accept 用例一致，属性面板里说明真模块靠电位器调。
- **3D 固定槽位**：五种元件各有固定 x 偏移和离板距离，只按信号脚决定放在面包板哪一侧，避免同时放多个时重叠。
- **控制放在示例面板**：教学元件的控制同时出现在「这个示例」面板，不必先点开元件卡（回归脚本也靠它）。
- 备选：每个元件单独做显示面板 —— 否，简报限定不做显示面板。
## 2026-10-20 ILI9341 / ST7789 裸屏 + SH1106（F-04b）
- **裸屏用新名字，不改 `st7789`**：`st7789` 仍是 StickC Plus2 的 135×240 偏移玻璃（M5 预设、esp32-spi-lcd 依赖它）；裸模块用 `st7789-240x240`（1.3"，GRAM 240×320 的 (0,0) 起 240 行）和 `st7789-240x320`。PanelSpec 名字 `ST7789_240` / `ST7789_320` 不带空格，accept.sh 的 `LCD (\w+) non-black` 才匹配得上。备选：`st7789` 加尺寸参数（否：要改已有解析和预设）。
- **ILI9341 参数**：常白 TN（不 INVON 就是真彩）、BGR 子像素（IDF spi_lcd_touch 示例同样设 BGR）；RDDID 回读 00 93 41（取 ID4 的值，真机 04h 回读未核）。ST7789 裸模块按 RGB、常黑 IPS。
- **C3 接受全部 DCS 屏**：`lcd_attach` 只拒绝 CO5300，仍用固定 `lcd_pin` 接线（与 GC9A01 相同），不支持 `@pins`；只改了 `esp32c3` 的 `attach_lcd(kind)` 签名（唯一调用方 chip.rs）。
- **ILI9341 驱动用组件 `espressif/esp_lcd_ili9341` 2.1.0**：核过 license.txt 为 Apache-2.0，LICENSING 加一行；这样验收的是真实的厂商初始化序列（18 条厂商寄存器）。备选：固件里自己发命令（否：不是常见用法）。
- **SH1106 单独一个模型**（`devices/sh1106.rs`），对外接口与 Ssd1306 相同（`render` 128×64、`ascii`、`lit_pixels`、`display_on`、`version`、`frame`），`Machine::sh1106()` 另给访问器；CLI 摘要行同样以 `OLED lit pixels` 开头，accept 的 `oled_min_pixels` 通用。DC-DC（ADh）上电默认开，SSD1306 的 20h / 21h / 22h / 8Dh 不认、计入 `foreign_cmds`，所以 SSD1306 驱动接 SH1106 会像真机一样错位 2 列、只写一页。
- **一个 ST7789 固件跑两种玻璃**：s3-st7789 按 240×320 画；240×240 用例（`fw` 字段）只看上 240 行，下边框和白带落在玻璃外，正是真机上"买错尺寸"的样子。
- **护栏两处顺带改动**：`tools/check_config.py` 收集 `--spi` 设备名的正则从 `\w+` 放宽为 `[\w|-]+` 并按 `|` 拆分（带连字符的裸屏名和 usage 里的 `a|b|c` 写法才认得出）；CLI 的 OLED 摘要挪到新文件 `cli/src/oled.rs`（`report_oled`），`run()` 和 main.rs 不超 lint_size 上限。

## 2026-10-20 AHT20 / INA219 / DS3231（F-04e）
- **INA219 测什么**：默认高边串在板子的 USB 5V 输入上，`after_run` 里每个运行段把电气模型的 `v5` / `i_usb` 写进去；`--power ext` 只把舵机换到外部电源，板子仍由 USB 供电，所以不切换。只有挂了 INA219 才走这一步（`Machine.ina219` 标志），其它用例行为不变。分流电阻按常见模块 R100（0.1 Ω）。备选：测 3V3 轨（否：模块常用来量"整块板吃多少电"，且 USB 口是用户真会接表的地方）；加 CLI 开关手动给负载（否：先跟电气模型走，有需要再加 `Ina219::set_load` 的入口）。
- **公共接口**：`devices::make_i2c` 新名字 `aht20` / `ina219` / `ds3231`；`Ina219::set_load(bus_v, current_a)`；`Aht20` / `Ds3231` 的 `temp_c`（AHT20 还有 `humidity`）由 `env_set` 写；`rtc_set` 在 PCF85063 / PCF8563 都没有时设置 DS3231；`Ds3231::int_active()` 给中断脚（未接 GPIO）。
- **DS3231 星期**：寄存器 1..7 的起点由固件定，模型记下写入时的偏移；上电默认按 Arduino RTClib 习惯 1 = 周日。世纪位：2100 年起置位，写入时置位 = 21xx。
- **AHT20 CRC** 与 Sensirion 相同（多项式 0x31、初值 0xFF），直接复用 `sht::crc8`。
- **模块电流**写进 `board.rs` 的 `module_current`（AHT20 5 µA 估算、INA219 0.7 mA、DS3231 0.2 mA 按手册典型值）；注释写明 parts.ts 尚未加，等网页接这三个器件时同步。
- 参考：AHT20、INA219、DS3231 数据手册；未读任何 GPL 实现。

## 2026-10-20 BLE 多 IDF 签名（F-08c）
- **新提交按 tag 命名目录**：`tools/fetch_third_party.sh` 新增 11 个 bt-lib 提交，目录名用 IDF tag（5.1.0、5.2.2…；5.1.4 与 5.2.1 同提交只下一份）；旧目录名（5.1-5.2、5.3、5.4、5.5.0、5.5.1）不改，免得老脚本和笔记失效。新提交只有 libbtdm_app.a，没有 `_flash`。
- **osi 版本范围 0x10006–0x1000A**：逐个读了 5.1 / 5.1.1 / 5.1.2 / 5.1.5 / 5.2 / 5.2.2 / 5.3 / 5.3.1 / 5.5.1 的 bt.c，HLE 用到的 osi 表偏移（36 / 52 / 56 / 100）全一样，所以只放宽版本判断，不按版本分支。
- **pll_track 可以找不到**：5.1.0 / 5.1.1（0x10006）的 bt.c 不调 `sdk_config_extend_set_pll_track`，`sig::locate` / `sig_xt::locate` 找不到时不再报错、给 0；改到 osi_reg 时判：版本 ≥ 0x10007 却没找到才报错。备选：按版本分两套 locate —— 否，多一套代码路径但判据一样。
- **覆盖自测用裸链接**：`tools/ble_cover.sh` 把每个库用 5.5.1 工具链 `--gc-sections` 裸链接（未定义符号 PROVIDE 到 0x40001000，避开 Xtensa longcall 跨 1 GB 报错），elf2image 后让 Python `ble_sigs.py check` 和 Rust `cover.rs` 都按 ELF 符号对答案。产物在 git 忽略的 `third_party/btlib-cover/`，没有就跳过。
- **S3 `_flash` 缺口不修**：S3 libbtdm_app_flash.a 裸链接时 ld 放松 longcall 会把 `or a10,a2,a2` 缩成 `mov.n`，send_packet 签名不中；改前改后都不中，真 RUN_IN_FLASH_ONLY 固件没见过，记 STATUS 缺口，自测里标 known gap 不算失败。
- **check 容忍 AMBIGUOUS_OK**：Python check 对允许多处命中的函数，只要真值在命中里就算对（与 Rust 侧一致）。
- **固件不重编**：worktree 的 firmware/build 从主仓库复制（同源码），改前改后 CLI 输出对比用复制的镜像。
- 签名是否算 Espressif 库的衍生作品，仍待人审（同 E-04 的说法）。

## 2026-10-20 Arduino 库矩阵（F-08a 显示与传感器）
- **钉默认分支提交而非发布标签**：17 个库仓库标签命名混杂（有无 `v`、注释标签对象 vs 提交），按 2026-10-20 默认分支 HEAD 钉完整提交，`library.properties` 版本写进 STATUS 矩阵。备选：钉标签 —— 否，各库标签风格不一，统一钉提交更简单。
- **草图自写**：按各库官方示例的调用顺序自写最小草图，末行打 `TRYBOARD_OK lib-*`，不拷贝示例文件（许可证干净、输出可断言）。
- **MFRC522 用 Unlicense 版**：Unlicense 等同公有领域，比 MIT 更宽松，视同 ✅。
- **OneWire、TFT_eSPI 只进本地 accept**：许可证未核，`bin` 不上站点；accept 用例照常跑（只编译不分发）。
- **TFT_eSPI 配置走 `flags.txt`**：`build_arduino.sh` 新增可选 `flags.txt` → `--build-property compiler.cpp.extra_flags`，用 `USER_SETUP_LOADED` 传面板与引脚，不改钉住的库源码；同一套标记写进 `BUILD_INFO.txt`。
- **引导跳过填充段**：esptool 给 Arduino 产物插加载地址 0 的填充段，C3 / S3 / ESP32 的 `boot.rs` 改为跳过 0x1000_0000 以下的段（与 IDF 二级引导 `should_load` 行为一致，只读文档理解）；之前这些 bin 直接引导失败。
- **lvgl Arduino 版不做**：需要库外 `lv_conf.h` + 显示驱动，官方示例依赖 TFT_eSPI（许可证未核）；LVGL 已有 IDF 示例覆盖。
- **ILI9341 / RTClib 先写草图不加用例**：模型在 F-04b / F-04e，未合并前加用例会让 main 的 accept 变红；合并后由主会话或后续条目补 `arduino-lib-ili9341`（`lcd_min_pixels`）/ `arduino-lib-rtclib` 用例。

## 2026-10-20 按原速回放（F-03b）
- **在 worker 的实时循环里排程，不另写步进**：`seekTo` 和 `loopSlice` 都是固定 1 ms 切片，事件在同一个切片边界施加就能保证到 endMs 时状态逐字节一致；挂钟节奏只影响什么时候跑，不影响跑出什么。备选：主线程按挂钟定时发输入 —— 否，输入落在哪个切片取决于消息到达时间，结果不可复现。
- **跳到结尾 = 原快进路径**：重新上电再 `seek` 到 endMs，正确性不用另证；代价是再上电一次（嵌入页可以接受）。备选：worker 内把剩余事件一口气跑完 —— 省一次上电但多一条要维护的路径。
- **入口**：嵌入海报在有运行记录时给勾选框（默认不勾，保持 F-03 的快进行为和测试不变），`&replay=1` 预选；实验台 `/app` 只认 `&replay=1`，不加界面开关（实验台已有暂停和时间线）。备选：⋯ 菜单加「复制原速回放链接」—— 先不做，等有人要。
- **界面同步只做看得见的**：按键（板上按钮 / 面包板按键下沉）、房间温度、姿态、障碍物距离按 tick 的模拟时间跟上；其它输入（串口输入、BLE、网络回复）只在串口 / 面板结果里体现。
- **回放中不跑 `pumpNet`**：录好的网络回复按原时刻作为事件施加；如果像快进那样预填回复缓存，实时循环会在请求一出现就提前回答，结果就和快进不同。到 endMs 后与 seek 共用 `settleReplay`。


## 2026-10-20 长连接 TCP + WebSocket（F-09a-1）
- **只在登记路由上升级，不是见 `Upgrade` 就升级**：内置 `/echo`，其余由应用写进 `Tcp::ws_routes`。未登记的升级请求仍按原来的 HTTP 404 回，现有固件和 golden 不受影响，也不会有没人取的 inbox 越堆越多。备选：任何路径都升级、消息进 inbox —— 否，CLI 里没有应用时 inbox 只增不减。
- **长连接记账只给 WebSocket 连接**：HTTP 路径（`send_resp` 一次发完 + FIN）一个字节不改，只在升级后的连接上按 `snd_una` / 对端窗口发。理由：golden 要字节一致，而且 HTTP 回复本来就小于 lwIP 的窗口。备选：HTTP 也走窗口 —— 回复大于窗口时字节节奏会变，现有用例要重录。
- **不做 HTTP keep-alive**：本条目不需要，加上会改 `Connection: close` 头，所有网络用例的字节都变。
- **连接用 `tcp::Key` 标识，不另发连接号**：xiaozhi 场景一条连接；四元组本来就唯一，少一张映射表。
- **服务端不发 ping、不做空闲超时**：xiaozhi 协议靠设备端心跳；需要时 F-09a-2 自己调 `ws_send(OP_PING)`。
## 2026-10-20 CYD 示例（F-10a2）
- **复用 `firmware/common/bare_tft.h`**：加 `#elif CONFIG_IDF_TARGET_ESP32` 分支给 CYD 引脚（HSPI = SPI2_HOST：SCLK 14 / MOSI 13 / CS 15 / DC 2，RST 接 EN 记 -1，背光 21），C3 / S3 分支不动；图案与 c3-ili9341 完全相同，accept 直接复用它的 lcd_regions。备选：esp32-cyd 自写一份绘图 —— 否，同一图案两份代码没有收益。
- **面板驱动沿用 `espressif/esp_lcd_ili9341` 2.1.0**：c3-ili9341 已在用，不引入新依赖；TN 屏按 BGR、不反色（与 IDF spi_lcd_touch 示例一致；真机 CYD 有 ILI9341 / ST7789 两种玻璃，这里只覆盖 ILI9341 版）。
- **板预设 `cyd` 标 verified**：accept 用例走 `--board cyd`，即端到端跑过；`name` 字段对非 M5 板填产品型号 `ESP32-2432S028`。MISO 12 写进 lcd 引脚串（原理图上有，模型不读）。LDR / RGB LED / 喇叭只写在 note / outputs，未接模型（触摸见下）。
- **XPT2046 按位流建模**：控制字节（起始位 1）收满 8 位后，下一个时钟出 BUSY，再出 12 / 8 位结果；DOUT 位队列在 CS 保持低时跨 SPI 传输保留，所以三字节全双工、XPT2046_Touchscreen 式「下一条命令塞进 16 位传输低字节」的流水读法、esp_lcd_touch 式「命令相 + 16 位读相」半双工都对。依据数据手册，未读任何 GPL 实现。备选：按字节对齐解析 —— 否，流水读法跨传输就错。
- **触摸原始值量程是估算**：面板左 / 右边 = X 200 / 3700，上 / 下边 = Y 240 / 3800（RNT 等 CYD 教程的常用标定），按竖屏 240×320 像素线性映射；Z1 600 / Z2 3200（压力 1495，高于常见 300–400 阈值）。真机的轴向、反向、量程未校准，结论标「估算」。
- **挂在 `GpioParts`、由 SPI 传输钩子交换**：同 RC522 的做法；经典 ESP32 的 `spi_transfer` 只加一行 `rx.or_else(xpt2046_exchange)`，片选按 CS0 信号（矩阵 / IO_MUX）或 GPIO 低判断，lib.rs 只加 `mod spi_touch;`，方便和 F-10c 合并。C3 / S3 暂不接（CYD 只有经典 ESP32）。PENIRQ 由 `Machine::touch` 直接驱动，不走板级 `touch_int`。
- **板预设加 `spi_touch` 字段**：`BoardPreset` 新增可选 SPI 触摸串，在屏之后接上，触摸区取屏尺寸；其余预设为 None。
- **worktree 引用主仓库 third_party**：worktree 里建了 git 忽略的 `third_party` 符号链接指向主仓库，用来加载 ROM ELF；不提交。
## 2026-10-20 F-10c 经典 ESP32 RMT 接收 / 载波 + NEC 红外
- **`ir=` 格式**：`ADDR,CMD`（两个 16 位十六进制）、单个 32 位十六进制（`cmd<<16 | addr`，与 IDF 示例打印的 scan code 一致）、`repeat` / `rep`（重复码）。备选：只收 8 位地址 + 命令再自动补反码 —— 不做，扩展 NEC 和厂商码都是 16 位，按原样给更通用。
- **载波时钟**：CARRIER_DUTY 的高 / 低计数按通道基准时钟（ref_always_on=1 用 APB 80 MHz，否则 REF_TICK 1 MHz），不经通道分频；0 当 65536。`carrier_out_lv` 按 IDF 语义：在该电平上调制。依据 TRM 和 IDF `rmt_ll.h`（Apache-2.0），未看 QEMU（其 esp32.rmt 只是占位）。
- **红外接收头模型**：遥控器直接驱动接收引脚的低有效包络，加 150 µs 接收头延迟；红外 LED 一侧的「眼睛」把间隔 > 60 µs 的脉冲串合成一个 burst，载波 20–60 kHz 才算数（> 25 µs 的单脉冲记为「未调制」不认），15 ms 无脉冲结束一帧并按 ±25 % 解 NEC。`--ir RX,TX` 默认 LED 对着接收头（线或），所以固件能自发自收。备选：按载波逐周期驱动接收引脚 —— 接收头本来就输出解调后的包络，没必要。
- **LED 眼睛只在经典 ESP32**：C3 / S3 的 RMT 载波未建模，`--ir` 带 TX 时在这两个芯片上报错，不静默。
- **不给红外模块加电气电流**：接收头约 1 mA、LED 峰值电流取决于限流电阻，等网页接入、有接线时再加。
- **编码器**：`firmware/esp32-ir/main/ir_nec_encoder.c/.h` 原样复制自 IDF `ir_nec_transceiver` 示例（Unlicense OR CC0-1.0，保留文件头）。
## 2026-10-20 Arduino 库矩阵 Wi-Fi / BLE / 舵机 / 灯带（F-08b）
- **钉发布标签而非默认分支**：与 F-08a 不同，这 6 个库默认分支离发布差很远（NimBLE-Arduino 主分支 3.0.0-dev、FastLED 主分支在 3.10.8 之后），按发布标签对应的提交钉；FastLED 最新 3.10.8 在 C3 编译失败（RISC-V RMT 中断函数 `noexcept` 声明不一致），退到 3.10.3。备选：给 FastLED 打补丁 —— 否，钉住的库源码不改。
- **10 例 = 6 个第三方 + 4 个核心自带库**：MIT / BSD / Apache 范围内能凑出的 Wi-Fi / BLE / 舵机 / 灯带第三方库只有 FastLED、WiFiManager、PubSubClient、NimBLE-Arduino（ESP32Servo、IRremote 只进本地）；核心 WiFi / HTTPClient / BLE / WebServer 是 Arduino 用户最常用的入口，也顺带补上 E-05 / F-08c「Arduino 产物未实测」的缺口。备选：Adafruit NeoPixel —— 否，LGPL-3.0 不在本条目范围。
- **PubSubClient 用例断言当前失败行为**：虚拟网络只有 80 端口，用例断言 `mqtt connect failed rc=-2` 并用 `absent` 确认没有误报成功；broker 做好后改成断言发布 / 订阅。备选：不加用例 —— 否，Wi-Fi 连接和 TCP 拒绝这段行为值得回归。
- **NimBLE-Arduino 不加用例**：运行卡在虚拟控制器对厂商命令 0xfc01 只回状态（主机要 6 字节静态地址，长度不符就重置），本条目不改 core；加了会让 accept 变红。记为 STATUS 遗留。
- **WebServer 例加 DNSServer**：虚拟手机加入热点后先做连通性探测，固件不答 DNS 时探测一直挂着、后续请求不执行；照核心 CaptivePortal 示例加 `DNSServer` 应答所有名字，比改手机行为更贴近真实配网页。
- **核心 BLE 在 C3 上是 NimBLE 主机**：arduino-esp32 3.3.2 的 C3 预编译 sdkconfig 开的是 `CONFIG_BT_NIMBLE_ENABLED`，E-05 里「Arduino 默认 BLE = Bluedroid」对 3.3.x / C3 不成立（只记录，不改 E-05 结论）。
## 2026-10-20 环境脚本时间轴交互稿（F-11 第一步，待人审）
- **界面名用「环境脚本」**：DESIGN.md §3 已有「时间线」（编辑历史），DESIGN_V2 §4 已有「运行记录」（输入日志），再叫时间轴会撞名。备选：场景 / 剧本 / 时间轴 —— 列为稿子 §9 Q1 请人定。
- **只用已有输入动作，CLI 不改**：脚本编译成 `env=` / `lux=` / `dist=` / `pir=` / `gpio` / `mv` / `net=` / `netfault=` 等现有行，`--inputs` 直接重放。备选：新增 `ramp=` 之类插值动作让 CLI 自己插值 —— 否，要改内核且网页 / CLI 两份插值实现容易不一致。
- **编译规则**：整数毫秒、编译时量化、量化值变了才发、同一轨道最小间隔 100 ms（关键帧除外）；施加走 F-03b 的 worker `dueList`，不用主线程定时器。原型实测只靠量化一段 30 s 脚本 1500 行，加最小间隔后约 320 行。
- **状态 v1 加可选 `tl`，`run.s` 保持完整日志**：老页面忽略 `tl` 结果不变，不升 `v`。备选：`run.s` 只存手动事件、打开时现编译 —— 链接更短但属语义变化，要升 v2，列为 §9 Q2。
## 2026-10-20 显示屏上台面（F-04a2）
- **裸屏用新 PartSpec `tft`（panel = ili9341 / st7789-240x240 / st7789-240x320），脚位按芯片固定**：内核把 SPI2 固定接到该芯片的 LCD 脚（与 CLI `--spi` 相同），网页不能随意改线，所以放置步骤直接给出固定脚位环（`fixedPin` / `stepOk`）。备选：允许任意脚再在 wasm 里重映射 —— 需要改仿真模型，超出本项范围。
- **`LCD_WIRING` 移到 `web/src/chipid.ts`**：芯片字面常量只放这里，且 node 测试可直接引用；`boards.ts` 只做转出。
- **换芯片的固件自动改线（`retargetTft`）**：上传另一芯片的固件时内核换了 LCD 脚，TFT 的线跟着改，否则 3D 和接线检查显示过期脚位。
- **SH1106 复用 `oled` 元件加 `ctl: 'sh1106'`**：画面、尺寸和 SSD1306 相同，只换控制器；wasm I2C 器件种类 12 = sh1106，`tb_oled_*` 和 `tb_report` 在没有 SSD1306 时回退到 SH1106，报告行与 CLI 一致（check.py 去掉括号细节后），这样网页与 CLI 指纹相同。备选：新增独立 3D 元件 —— 重复代码。
- **示例 c3-ili9341-temp 的 DS18B20 接 GPIO1**：C3 上 GPIO4 是 LCD RST。
- **商店清单 → 台面放置支持 TFT / SH1106**（`templates.ts`）：手机上主要靠清单放元件，否则 ILI9341 会被静默丢掉。
- **元件数上限测试 70 → 80**（`catalog.test.ts`）：新增 4 个元件，这是容量上限而非行为断言。

## 2026-10-21 xiaozhi 脚本服务端（F-09a-2）
- **服务端是纯状态机，World 只做胶水**：`xiaozhi::Server` 不碰 Tcp / Net，单测直接喂 `WsIn` 断言时刻和顺序；`World::xz_step` 取 inbox、发 `Net::ws_send`。备选：服务端直接持有 Net —— 否，时序测试要搭整条 TCP。
- **xz_step 放在 poll 的 pending 下发之前**：推送当次就走；放后面要多等一次唤醒（`next_timer` 报 0 才发），每帧多一轮。
- **60 ms 按排程时刻累加**：第 k 帧 = 起点 + k × 60 ms，poll 被信标 / WPA 定时器提前或推迟唤醒都不漂；迟到的 poll 一次补发所有到期帧。
- **OTA 用 `Tcp::pages`，不改 `response()`**：现有 HTTP 路径一字节不改；代价是精确路径匹配（带查询串的 OTA 地址会 404，xiaozhi 固件不带）。
- **不校验 token、只建模 Protocol-Version 1**：真固件带的是 NVS 里存的 token，校验只会让换服务端的固件连不上；v2 / v3 帧头留到有固件需要时。
- **下行 Opus 用合成最小帧（素材待人定）**：RS-2 §8 第 4 项（合成音还是 CC0 录音）没拍板，先用 SILK WB 60 ms TOC + 固定 LCG 字节，不含任何第三方音频；能被解码器接受、但听起来是噪声。F-09b 拿到人定的素材后通过 `Server::frames` 替换。
- **对话文字用英文**：Rust 输出只用英文（AGENTS §6）；固件 printf 照常中文。
- **xz 服务端跨复位保留**：和虚拟手机、网络条件一样属于「外部世界」，复位只清会话和队列。
- **端到端固件用 `espressif/esp_websocket_client` 1.7.0**：Apache-2.0（核组件包 license.txt）；注册表最新 1.8.0 的许可证标为 Custom，未核，不用。只做 accept 固件，不进站点。

## 2026-10-21 F 批待拍板事项（人授权 AI 代决：「你决定」）
人在 F5 汇报后回复「你决定」。以下按研究稿推荐拍板；凡属 AGENTS §10「必须问人」的（上线、花钱、账号）不在授权内，维持不做。
- **F-07b MicroPython 分发 = (iii) 只给官方下载链接，用户自己上传**（RS-1「需人拍板」1）：不托管、不改 LICENSING，不用处理 berkeley-db BSD-4 广告条款和缺 SBOM。备选 (i) 托管官方 bin + 手写 NOTICE、(ii) 自建 + SBOM —— 等上线前再议。
- **PRODUCT 定位扩展到「在这里改代码」**（RS-1 2）：只限 MicroPython main.py 编辑 + raw-paste 运行；C / Arduino 仍是「本地编译后上传」。F-07b 开工时改 PRODUCT.md。
- **S3 第一阶段只支持 SPIRAM_OCT 变体**（RS-1 3）：网页检测到四线 PSRAM 重启循环时提示换 OCT 变体。
- **F-09b RS-2 §8**：(1) 不装 IDF 6.x（磁盘只剩 28 GB，路线 A 不进验收）；(2) PIE / EE.* 暂不立项，先看 F-09b-0 实测，用到 PIE 就换纯 C libopus 或退路线 C，再决定是否单独立项；(3) 不做网页连 xiaozhi.me 真服务（第三方账号、隐私）；(4) 固件目录 `s3-xiaozhi-lite`，对用户的名字用描述性写法「语音助手（兼容 xiaozhi 协议）」/ "Voice assistant (xiaozhi-protocol compatible)"，不用 xiaozhi 图标；下行语音素材用我们自己脚本合成的音（共振峰 / 音调合成，不含任何第三方录音或 TTS 输出），只提交生成脚本和小文件。备选 CC0 录音 —— 要逐条核来源，收益小。
- **F-11 第二步按稿子 §9 推荐全部采纳**：Q1「环境脚本」；Q2 方案 A（`run.s` 完整 + 可选 `tl`，不升 v）；Q3 网格 10 ms、最小间隔 100 ms；Q4 最长 600 s、第一版不循环；Q5 a（手动值记为事件，下个脚本值覆盖，提示「由环境脚本控制」）；Q6 不做噪声；Q7 嵌入页显示只读进度条；Q8 手机可编辑；Q9 改房间温度。
- **arduino-cli core 3.0.7 不装**：约数 GB，磁盘只剩 28 GB（94%），F-08c 的 Arduino 3.0.x 列为 ✗（理由：磁盘），以后磁盘宽裕再议。
- **不上线**：公开部署属 AGENTS §10 必须问人，「你决定」不当作上线授权。
- **LICENSING 行已在**：esp_websocket_client 1.7.0 ✅（LICENSING 第 35 行）；F-08b 前四个 ✅，ESP32Servo / IRremote 维持「只进本地 accept、上站前人核」（第 30 行），不在本次授权内放宽。
- **F-09b-0 结论（2026-10-21，AI 自主）**：micro-opus 0.4.1 不用 PIE（静态 0 条、动态约 1 万帧无非法指令），按上一条 (2) 不立 PIE 项；F-09b-1 走路线 B，用 micro-opus 定点（显式 `CONFIG_OPUS_FLOATING_POINT=n`，S3 默认是浮点，SILK 编码慢 7.7 倍跑不过实时）+ `CONFIG_OPUS_ENABLE_XTENSA_OPTIMIZATIONS=y` + 编码复杂度 0（模拟中占 18 %）。备选：复杂度 5（47 %，网页墙钟开销翻倍多）、关 Xtensa 优化（慢约 20 %，没必要）、纯 C libopus / 路线 C（不需要）。micro-opus 进仓库前 F-09b-1 要先在 LICENSING.md 加一行（Apache-2.0，内含 libopus BSD-3、micro-ogg-demuxer Apache-2.0）。详见 RS-2 §10。

## 2026-10-21 F-07b MicroPython main.py 编辑器
- **分发与定位**：采用选项 (iii)：站点不托管 MicroPython bin（不进 web/public、不进构建产物），固件菜单只放一行说明 + 官方下载页链接（C3 `ESP32_GENERIC_C3`；S3 只提示「请用 SPIRAM_OCT 版本」，不做重启循环检测）。PRODUCT.md「在这里改代码」段已先改。理由：MIT 许可本可再分发，但托管要跟版本、写 NOTICES；用户自己下载更省事也更清楚来源。备选：站点自带 bin（需人定）、littlefs 镜像预置 main.py（RS-1 推迟）。
- **识别**：在 `session.fwBuf` 里扫 `MicroPython` 字节串（`web/src/mpy.ts isMicroPython`），开时 `bc.mpy=true` 并切到 dock `py` 标签。备选：看串口横幅（要等启动，切换标签晚）。
- **写入协议在主线程跑**：`MpyLink` 只靠提示推进（`>>> ` → `raw REPL` → `R\x01`/`R\x00` → `OK` / `\x04` → `\x04>`），没有固定延时；所有字节走 `session.sim.uart`，因此进输入日志、可 `--inputs` 重放。20 s 墙钟超时只用于报错，不影响仿真结果。备选：放 worker 里（要新协议消息，收益小）。
- **窗口字节**：worker 用非流式 TextDecoder 解串口，`0x80` 到主线程变成 U+FFFD，所以窗口字节 ≥ 0x80 时按 128 处理（MicroPython 默认窗口就是 128）。
- **raw REPL 退路一次推完**：F-07a 已让 UART RX 排队所有字节，不需要分块等待。
- **自动重发**：每次上电（不含软复位）第一次出现 `>>> ` 时重发保存的 main.py（等价于没有 littlefs 镜像时的「刷新后恢复」）；打开带 `run` 的分享时暂停自动重发（输入日志里已有那次写入），用户点运行后恢复。
- **保存位置**：main.py 存 localStorage `tryboard-mpy-main`；从分享打开的文本在用户运行前不覆盖自己的副本。bin 不跨刷新保存（刷新后要重传 bin 或打开 .tryboard），记为已知限制。
- **分享**：`ShareStateV1.mpy?: string`（≤ 64 KB，可选字段，不升 `v`）。
- **输入日志转义**：`uart=` / `usbcdc=` 改用 `escUart`：`\n` 外的控制字符、`\`、`;`、`#` 和首尾空格写成 `\xNN`，`unescUart` 只认 `\n` 和严格两位 `\xNN`，与 `cli/src/escape.rs` 一致；`phone=` 维持旧规则。旧日志里的普通文本解码不变。
- **编辑器**：textarea + 等宽字体，Tab 插 4 空格，Ctrl/Cmd+Enter 运行；不加语法高亮依赖。


## 2026-10-21 F-11 第二步（环境脚本）实现细节（自主决定，待人审）
- 距离轨量化到 1 cm，按键松开写成浮空（`z`，不是强制高电平），与手动按键一致。
- 网络轨的值不回写到界面的网络选择器（避免和手动预设互相覆盖）；温度轨改房间温度，不走单个器件的 `sensorOffset`。
- 最小间隔 100 ms 按轨道各算；新加的关键帧继承前一个的插值方式；预设从当前播放头往后放，免得一放就「过期」。
- 作品脚本按作品存 localStorage `tryboard-scenario:<key>`；分享链接里的 `tl` 只在本次打开时生效，不覆盖本地作品。
- 暂缓：撤销 / 重做接入、滑块上的「由环境脚本控制」提示、跟随 / 适配缩放、回放中编辑的警告、光照 / 人体传感器值在其它面板显示。备选：一次全做（工具调用预算不够，先交可验收的主干）。

## 2026-10-21 xiaozhi-lite 示例固件（F-09b-1）
- **下行语音自己合成**：`tools/audio/gen_xz_voice.py` 用共振峰合成（声门脉冲 + 三个 Klatt 共振器，按元音滑动）生成 1.2 s「助手」语音，离线编成 20 个 16 kHz 60 ms Opus 包（`core/crates/soc/src/wifi/xz_voice.bin`，2015 字节，全是 SILK WB TOC 11）；麦克风测试音 `tools/audio/xz_mic.wav` 同法合成。不含录音、不含 TTS 输出。备选 CC0 录音 —— 要核出处，合成足够验证链路。
- **编码器用 micro-opus 自带的 libopus 在主机上编 `opus_demo`**：同一份 BSD-3 源码（LICENSING 已有 micro-opus 行），不另装 brew opus-tools；生成结果确定（重跑字节一致）。
- **默认下行不变，新动作 `xz=voice,demo|noise` 切换**：默认仍是 F-09a-2 的合成噪声帧，现有用例 golden 207/207 字节一致；demo 每句播同一段（`Server::frames` 原语义）。
- **CLI `--i2s kind@bclk:ws:data`**：S3 默认 I2S 引脚（喇叭 16/17/18、麦 39/40/41）和 bread-compact-wifi 不同；加可选引脚写法，不带 `@` 时行为不变。新 `Machine::i2s_attach_at`。
- **喇叭 16 kHz，不是 bread-compact 的 24 kHz**：下行就是 16 kHz，固件里不重采样，少一层误差；真 xiaozhi 固件的 24 kHz 输出留给以后跑原版固件时再说。
- **N16R8 配置**：开八线 PSRAM（micro-opus 120 KB 伪栈和编解码状态放这里）+ `PARTITION_TABLE_SINGLE_APP_LARGE`（Wi-Fi + WS + Opus 约 1.2 MB，超 1 MB 默认分区）。
- **一个音频任务同时管编码和解码，钉在核 1**：半双工按键说话不会同时编解码，一个任务一份伪栈（省 120 KB）；不钉核时「首帧编码」日志会连打两遍（原因未查，留作模拟器待查项），钉核 1 后只打一遍。
- **按键语义**：播报中再按 BOOT = 发 `abort`（user_interrupted）并丢弃剩余下行帧，回待机；不同时开始新一轮。WebSocket 回调只解析、投递队列，不在回调里发送。
- **hello 10 s 超时后 2 s 重连**：重连前先注销旧客户端的事件回调，否则旧连接的关闭事件会被当成新连接断开。
- **accept.sh `audio` 块 `freq` 改为可选、加 `max_rms`**：语音没有单一主频，改用 RMS 区间（0.1–0.3，实测 0.20）；已有用例都带 freq，判定不变。
- **CLI `run` 函数不再变长**：`--i2s` 解析挪到 `i2s_args`（结构护栏 R-14：函数 / 文件只缩不涨）。

## 2026-10-21 网页语音面板（F-09b-2，自主决定，待人审）
- **I2S 引脚放进场景零件**：`max98357a` / `inmp441` 可带 `pins: [bclk, ws, data]`，网页转成 CLI 同款 `kind@b:w:d`，新 wasm 导出 `tb_i2s_attach_at`；不带 pins 时仍用芯片默认脚（旧示例不变）。备选：给示例加专用 I2S 配置字段，弃，因为 3D 接线、接线表、重放都要再读一遍。
- **麦克风 WAV 在上电前就位**：LiveSim 增加 `prepare()`，`start()` 等它（会话里是 mic WAV 的 fetch），否则 WAV 晚几片才接上，和 CLI `--mic` 不一致；示例可用 `mic` 指定 tools/audio 下的 WAV，构建时复制 xz_mic.wav。
- **服务器脚本跟会话走**：`session.xzScript` 记住面板里选的脚本，每次上电（含重启、倒带）由 onBoot 重新发 `xz=on`、`xz=voice,demo`、`xz=script,<n>`，全部进输入日志，CLI `--inputs` 可重放。
- **打断不单设按钮**：按住说话按钮在播报中显示「打断」，本质仍是 BOOT 按下 / 松开（`gpio0=0` / `gpio0=z`，与 accept 脚本一致），固件自己发 abort；面板的「say」文本去掉 `;`、`#`、换行（脚本格式分隔符），最长 200 字。
- **网页重放补上 I2S 和麦克风**：`replayLog` / simrun 按日志的 `i2s` / `mic` 接件，指纹比对才覆盖 I2S 示例。
- **选型层**：需求同时含 wifi + audio_in + audio_out 时，信任行加「语音链路（设备 ↔ 服务器协议）= 行为模拟」「唤醒词、回声消除 = 必须上真机」，检查点同理；语音模板示例首推 s3-xiaozhi-lite。


## 2026-10-21 F-07c 自带 bin 刷新后保留
- **存哪**：新库 `tryboard-bins`（store `bins`，键 = 完整 sha256），不给 `tryboard-files` 升版本：tryfile.ts 的 onupgradeneeded 不带防重建，升版本要额外迁移代码，没好处。打开 / 事务 / 请求三个小函数抽到 `web/src/app/idb.ts`，两处共用；工厂可传参，Node 单测用手写内存假 IndexedDB（不加依赖）。
- **上限**：最多 3 个、合计 24 MB（三个 8 MB 整片镜像）；超过 24 MB 的单个 bin 不存。淘汰按最近使用时间，刚存的那个永远不淘汰（`evictPlan` 纯函数，单测覆盖）。MicroPython C3 镜像约 1.7 MB，S3 OCT 约 1.7–2 MB。
- **恢复哪个**：localStorage `tryboard-ownbin:<作品键>` 记该作品最后跑的自带 bin 的 sha256；刷新（同 URL = 同作品键）后先照常启动默认固件，再取回 bin、过一遍 `fwCheck`、`loadFirmware`，toast 提示可在换固件菜单忘掉。MicroPython 的 main.py 重发走 F-07b 原逻辑（上电 → `>>>` → 自动重发），没改。取不回 / 芯片不对就清掉指针、留在默认固件，不报错。
- **何时不恢复**：`?s=` 链接和 `?f=` .tryboard 文件都不恢复（它们自己定固件）；点「回到参考固件」、点示例链接（含「最近」里的示例）时清指针，免得刷新又跳回自带 bin。
- **失败回落**：存不进（隐私模式、配额、超大）时每页只提示一次「刷新后需重新上传」，台面照常跑，行为同 F-07b。
- **忘掉**：换固件菜单在当前固件是已存 bin 时多一项「忘掉 <文件名>」：删本机副本 + 清指针，当前运行不打断，下次刷新回默认固件。
- **「最近」**：存过的文件条目带 sha256，点一下从本机副本直接跑（走 `pickFirmware` 同一路径：校验、检查点验证、再存一次刷新时间）；副本已被淘汰 / 忘掉时退回原来的选文件。提示文案相应区分。
- **分享语义不变**：`?s=` 仍不带 bin（也不带 bin 的 sha256）。「打开者本机有同 sha256 的 bin 就直接用」没做：要往链接状态加 `bin {name, h}`，等于把分享者的文件名和哈希放进公开链接，且链接本来就丢掉自带固件的运行记录，收益小；记为遗留。
- **`sendCtrl` 删除**：mpypane 的 Ctrl-C / Ctrl-D 按钮直接走 `actions.uart`，该导出从未被用。
- 公共接口：新增 `web/src/app/idb.ts`（`openDb(name, store, idb?)`、`done`、`req`）、`web/src/app/ownbin.ts`（`keepBin` / `takeBin` / `dropBin` / `evictPlan` / `lastBin` / `setLastBin` / `keptNow`）；`actions.releaseBin` / `forgetBin` / `reopenBin`；fwmenu 的 `Recent` 文件项多可选 `h`。
## 2026-10-21 语音面板真麦克风 + BOOT 电平（F-09c，自主决定，待人审）

- **live 麦克风按模拟时间落样**：原来 `MicSource::Live` 是按 I2S 帧率消费的 FIFO，落点取决于浏览器推送和模拟器步进的相对时序，导出后无法重放。改成和 WAV 同一个网格：样本 i 在模拟时间 i / rate 被听到（与 Wav 模式共用 `grid()`，插值算术位级相同）。每块落在 `max(已排队末尾, 已读高水位, floor(now / CPU_HZ × rate))`，中间补零；超前 now 1 s 以上的块丢弃（模拟暂停 / 慢于实时时不会无限堆积）。`push_live_at` 返回落点，wasm `tb_mic_push` 把它交回 worker。
- **先量化再推送**：worker 把浏览器的 f32 先量化成 16 bit（q / 32768 在 f32 中精确），推给核心的就是量化后的值，同时按落点记录 Int16。导出的 16 bit 单声道 WAV（采样率 = 浏览器 AudioContext 采样率，未听到的位置为零）经 CLI `--mic` 读回得到完全相同的样本，所以「导出 WAV + 导出输入日志」→ `tryboard run --mic <wav> --inputs <log>` 串口逐字节一致（Rust 单测 + xiaozhi.mjs 第 7 段验证）。
- **保证的范围（弱于「整段一致」）**：只覆盖切到「我的麦克风」之后的说话。切换之前麦克风听的是示例录音，那部分导出 WAV 里是零；输入日志的 `mic` 仍写示例录音名（不新增日志字段，分享链接不带音频，打开的人退回示例录音），所以倒带、网页内重放（`__tbReplay`）、分享链接都用示例录音，与实时那次不同。I2S 报告的来源行（live / WAV）不同，但不在指纹里。界面提示原样写明这些。录音最长 10 分钟（模拟时间），超过后拒绝导出、重启清零。备选：把音频塞进输入日志（太大，分享链接不能带）；保留 FIFO 只给「近似」承诺（无法回归测试）。
- **权限只在第一次切换时请求**：切换失败（拒权、无 getUserMedia、非 https）退回该作品自己的示例录音（以前退回 1 kHz 测试音），面板显示「…，已换回示例录音」。台架面板的「麦克风来源」下拉与 Voice 页同步。
- **BOOT 电平不改**：核查发现网页上 3D BOOT（pick → buttonCb → `session.pressBoot` → `live.press`）和面板按钮（原 `pressPin(0)`）松开时都记 `gpio0=z`，任务描述里的「3D 记 `gpio0=1`」不成立；只有 M5 预设按钮（`pressBoardPin`）和场景轨道 `up:1` 写 1。S3 的 GPIO0 有板上上拉（`esp32s3/src/periph.rs` 的 board_pullup bit 0），`z` 与 `1` 读数相同，`z` 更接近真实按键（松开即悬空、靠上拉）。所以保留 `z`，面板改走 `session.pressBoot`，与 3D 同一路径；accept 脚本、旧日志、golden 都不变（210/210）。
- **测试用假麦克风**：xiaozhi.mjs 用 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=xz_mic.wav`；macOS 上音频服务沙箱读不到文件、只会采到静音，必须加 `--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess`。agent-browser 会主动拒绝麦克风权限（即使用 --args 或 CDP 连接自启 Chrome），所以 agent-browser 走查覆盖拒权退回路径，真麦克风路径由 puppeteer 验证。
## 2026-10-21 F-11c 环境脚本收尾（自主决定，待人审）
- **撤销步带前后两份脚本**：工作台时间线新增 `{k:'scenario', sc, prev, label}`；`seek(i)` 取 i 之前最后一次脚本编辑的 `sc`，没有则取之后第一次编辑的 `prev`（`scenarioAt`），从未编辑过就不动脚本。备选是记一份初始基线，但 `prev` 不用额外状态、截断后也自洽。
- **一次拖动 = 一步**：按下后第一次改动记一步，之后只更新这一步，松开结束；双击加关键帧、删除关键帧、预设、加 / 删轨道、导入、改长度、开关轨道各一步。重做时重放到编辑发生的时刻，之前的固件读数仍是旧脚本（与当时实况一致），之后用新脚本。
- **「由环境脚本控制」提示放在温度 / 湿度 / 气压 / 距离 / 电位器滑块上方**：工作台没有光照滑块，故不加；手动拖仍可用（交互稿 §9 Q5 a）。键用 `Open the track`（`Open` 已在 net 组里，组之间不能重键），中文仍显示「打开」。
- **缩放用按钮，不做双指缩放**：1 / 2 / 4 / 8 / 16 / 32×，以视口中心为锚；「适应」= 1×。双指和车道拖动手势冲突，先不做。
- **跟随运行默认开**：播放头放在视口 20% 处；关掉后手动横滚不被拉回。
- **回放警告覆盖整段按原速回放**：`shareopen.ts` 的 `replaying` 统一经 `setReplaying` 同步到 `scenFeed.replay`，回放结束或跳过即消失；只提示，不阻止编辑。
- **重启提示随撤销 / 重做恢复**：脚本步记下编辑时的 `stale`（改到了已运行的时间）；倒带重新上电会清掉提示，`seek` 结束后按 `scenarioStaleAt`（本次运行内最后一次脚本编辑的标记，遇到 run 步即为否）补回，重做改过去的编辑仍显示「重启后生效」。

## 2026-10-22 真机标定暂缓（人定）
- 人回复「真机标定我们现在做不了」：O12 / RS-6 HIL（买板子 + `tools/hil/` runner）暂缓，不派子代理、不花钱；结论里「未经真机标定」的标签照旧保留。等人重新提出再开。
- 同一回复里的「开始做吧」按波 7 汇报的「下一步」理解：F-07d（「最近」列表）、F-11d（双指缩放 + 手机抽屉）、embed 回放检查按模拟时间采样、ESP32Servo / IRremote 许可证调研（AI 只整理证据，结论仍待人核）。公开部署和 MicroPython 托管方式没在回复里明说，不算授权。
## 2026-10-22 F-07d「最近」列表跟随本机副本与芯片（自主决定，待人审）
- **忘掉 / 淘汰后移除，不标「需重新选文件」**：带 sha256 的文件条目，本机副本不在了就从「最近」删掉。忘掉时 `dropBin` 成功后立刻清；被淘汰（超 3 个 / 24 MB，或别的标签页忘掉）的在每次打开换固件菜单时用 `keptKeys()`（IndexedDB `getAllKeys`）对照清理。读不了 IndexedDB（隐私模式等）返回 null，此时一条也不删，点了仍退回选文件。备选「标成需重新选文件」要多一种状态和文案，而重新上传本来就在同一菜单里，收益小。
- **从没存进本机的文件条目照旧保留**（无 `h`，点了选文件），行为同 F-07b。
- **芯片过滤**：文件条目新增可选 `chip`（上传时 `session.chip`，`fwCheck` 已保证 bin 与之相符），按菜单顶部当前选中的芯片过滤（每次打开从台面芯片开始，与示例列表一致）；F-07d 之前写入、没有 `chip` 的条目所有芯片下都显示。示例条目不按芯片过滤（点了会连同台面一起切换，不会跑错芯片）。
- **代码位置**：`Recent` / `recentFw` / `pushRecent` 从 fwmenu.tsx 移到新文件 `web/src/app/recentfw.ts`（Node 单测不能导入 .tsx），新增纯函数 `liveRecent` / `recentFor` / `pruneRecent`；`ownbin.ts` 新增 `keptKeys(idb?)`。localStorage 键 `tryboard-recent-fw` 和格式兼容旧数据。芯片字面量只在测试里出现。


## 2026-10-22 F-03c 原速回放检查改按模拟时刻判定（自主决定，待人审）
- **钩子放在嵌入页、只在原速回放期间记录**：`web/src/embed/run.ts` 在原速回放（`inp.paced`）时于 `restoreShare` 之前就经 `session.onTick` 逐 tick 记 `[tick 末模拟秒, 该 tick 串口片段, 室温]` 到 `__tbEmbed.trace`，回放结束 / 跳过即停，上限 2 万条；测试只取最后一次模拟时间归零（回放重新上电）之后的部分。只读、不发消息给 worker，不改仿真结果，不进 UI。备选是 store 订阅 `simSeconds`，但 store 每 0.05 s 才更新一次，粒度不够。
- **判定不放宽**：原条件「首次看到 UNIT F 时 t ≥ 1.1，且有 t > 1.0 的未出现样本」改为「含 UNIT F 的 tick 末时刻 ≥ 1.1，且其前一个 tick（仍未出现）末时刻 > 1.0」，另要求 trace 首条 < 1.0（确实从回放开头记起）；室温检查同理（变 35 °C 的 tick ≥ 1.9，前一 tick > 1.8）。前一 tick 就是最晚的未出现状态，等价于原意图且不靠 100 ms 墙钟取样碰运气。「从 0 起步且有进度标签」等其他检查仍按墙钟取样（与时序无关）。


## 2026-10-22 F-11d 环境脚本双指缩放 + 手机抽屉（自主决定，待人审）
- **(b) 的原因是布局，不是 focus / scrollIntoView / 高度变化**：手机半屏抽屉里脚本面板上方的工具栏（预设 / 加轨道 / 导出 / 长度）不随内容滚动，只剩约 184 px 的内层滚动框，装「轨道胶囊 56 + 轨道头 ~70 + 车道 160 + 缩放行 56」；要点到缩放按钮必须把内层框滚到底（人手滚或 agent-browser / puppeteer 点击前的 scrollIntoView），轨道头随之滚出。缩放本身只改 `scrollLeft`，`scrollTop` 不变（puppeteer 量过）。修法：手机上整个面板（含工具栏）合成一个纵向滚动框（约 360 px），轨道头 `sticky top-0`；点缩放后轨道头、车道、缩放行同屏可见。备选：只把轨道头吸顶（试过，车道被挤成 0 px，否决）；把缩放按钮挪进轨道头（改动设计稿，未采用）。
- **双指缩放是连续值，不吸附 ZOOMS**：手势中跟手更自然；按钮 − / ＋ 从当前值跳到下一档 2 的幂（`zoomStep`），读数非整数时显示一位小数。范围仍 1–32×。
- **锚点 = 起始两指中点下的时刻，跟随中点移动**：`frac = (scrollLeft + 中点x) / laneW` 在两指落下时记住，之后 `scrollLeft = anchorScroll(frac, laneW', 当前中点x)`，所以缩放时两指平移也会带着平移。纯函数放 `web/src/app/scenario.ts`，单测验不变量。
- **双指 / 滚轮缩放关掉「跟随运行」**：否则运行中的播放头会把视图从手指下拉走；按钮缩放保持原行为（跟随开时把播放头带回视口）。
- **车道保持 `touch-action: none`，单指平移自己做**：不改成 `pan-x`，因为浏览器一旦接管平移会发 `pointercancel`，双指手势中途被打断。单指在车道空白处拖 = 横向平移（纵向分量交给面板滚动框），落在关键帧上仍是拖关键帧；指针在捕获阶段统计，第二根手指落在关键帧上也算双指，此时关键帧冻结不动。
- **桌面 ctrl / ⌘ + 滚轮**（触控板捏合也走这个）以光标为锚缩放，用非 passive 的原生 `wheel` 监听才能 `preventDefault` 掉浏览器整页缩放。

## 2026-10-22 F-08d 许可推荐获批（人定）+ 波 9
- 人在看完波 8 汇报（含 LICENSING_REVIEW §16.4 两条推荐）后回复「可以 go」。解读：同意两条推荐并开下一波。
- ESP32Servo：按 (b) 上站——挂 LGPL 三件套（与 arduino-esp32 同处理：BUILD_INFO 记库提交、NOTICES 附 LGPL-2.1 + Bennett / Harrington / Margolis 版权与派生说明、给出库源码位置）。落地为 F-08e。
- IRremote：维持不上站、只进本地 accept。向上游提 issue 属对外发帖，「可以 go」不算对发帖的明确授权，不发；F-08e 把 issue 草稿写进 LICENSING_REVIEW §16 供人自己发。同时先做 (c)：自写基于 RMT 的 NEC 红外发送示例（F-08f），按公开 NEC 时序写，不看、不抄 IRremote 源码结构，可读 ESP-IDF（Apache-2.0）ir_nec 示例。
- 仍不授权：公网部署、MicroPython 托管、Arduino 3.0.x；真机标定暂缓。

## 2026-10-22 F-03d 精细采样触发改为「下一段波形开头」（自主决定，待人审）
- **原因是产品行为，不只是测试时序**：失败那次窗口 t0 = 327203486 周期 = 2.04502 s；CLI 同一固件 GPIO5 第 2 帧是 2.02322 s 拉低 → 2.04322 s 释放 → 2.04697 s 最后一位，触发落在位流中间，只录到后半帧（45 沿）。旧内核 `VcdCapture::armed` 取武装后的「下一个沿」，用户在帧中间点「触发」一样只录半帧；整机加压时页面时钟落后 worker 更多，命中帧内的概率变大。
- **修法（内核 `core/crates/soc/src/vcd.rs`）**：武装后的沿要满足「之前已安静 ≥ 窗口长度」或「这串连续的沿已持续 ≥ 窗口长度」才开窗，其余沿跳过。DHT11 一帧（拉低到最后一位 23.75 ms）短于 30 ms 窗口，所以总在帧首（起始脉冲下降沿）触发；PWM 这类从不安静的信号在持续一个窗口长度后照常开窗，不会永远等。保持度量用窗口长度本身，接口（`tb_vcd_arm` / worker 消息 / 分析仪）不变。
- **武装起点钳到 worker 当前周期**（`Machine::vcd_arm`：`from.max(self.cycles())`）：页面传的 `from` 是落后的界面时钟，否则已经过去的沿会被当成安静时间，又在帧中间触发。
- **不只改测试**：测试等空闲期再武装也挡不住真实用户在帧中点触发；且页面时钟本就落后 worker，测试侧对齐不可靠。判定（> 80 沿、无丢弃、40 位解码）未改。
- **界面文案**同步：「Next edge from now」→「Next burst from now」、「Waiting for the next edge…」→「Waiting for the next burst…」，zh / ja / ko 一起改。单测：原武装用例把保持长度改成 150 周期（同一触发沿，窗口终点随之变），新增「帧中武装跳过近沿」「连续信号持续一个窗口后开窗」两例。
- 备选：只对 DHT11 数据脚加 1 ms 安静保持（要新增参数、对其它协议无效，未采用）；固定「武装满一个窗口后任意沿都触发」（武装在帧前 8 ms 时仍会落在帧中，否决）。

## 2026-10-22 IRremote 上站（人定）
- 人：「IRremote 你研究下吧，我是觉得没问题可以上去」。主会话补查后，人定的结论是可以上站，走 MIT + NOTICE。
- 补查的事实：
  - issue #397（2016，z3t0）是新版本从 LGPL 改为 MIT 的公告。
  - 4 个 GPL-3.0 头（LocalDebugLevelStart.h、LocalDebugLevelEnd.h、LongUnion.h、TinyIR.h）与作者 ArminJo 自己的 GPL 仓库 Arduino-Utils、PWMMotorControl 里的同名文件一致，是版权人本人带进来的通用文件。
  - 这 4 个头只有宏、类型和结构声明、常量，不单独产生目标代码；TinyIR.h 所声明的实现 TinyIRReceiver.hpp 本身是 MIT。
- 落地：F-08e 一并处理 NOTICES、许可页、BUILD_INFO。请作者统一文件头的英文 issue 草稿保留为可选，不发、不阻塞上站。
- F-08f（自写 RMT NEC 示例）不再是替代品，作为额外的无库示例保留。

## 2026-10-22 F-08e ESP32Servo 走 LGPL 三件套上站（自主实现决定）
- 实查发现「arduino-esp32 的 LGPL 那一路」此前只写在文档里：`arduino-blink` 已在 `web/public/fw` 上站，但 `tools/build_web.sh` 只拷 `flash.bin`（`BUILD_INFO.txt` 没放到 bin 旁边），`tools/gen_licenses.mjs` 只读 ESP-IDF `managed_components`，许可页 / NOTICES 里没有 arduino-esp32，仓库里也没有 LGPL-2.1 原文可复用。所以 F-08e 顺手把这条路补齐，arduino-blink 一起受益。
- 决定：
  - `tools/fetch_third_party.sh` 取 arduino-esp32 发布标签 3.3.2 的 `LICENSE.md`（LGPL-2.1 全文）到 `third_party/arduino-esp32/LICENSE.md`；arduino-esp32 和 ESP32Servo 共用这一份，NOTICES 按原文去重只出现一次。备选：从 gnu.org 取、或复用 IDF 里 lwip SharpSnmpLib 的 license.txt——前者不是 arduino-esp32 实际分发的那份，后者与本组件无关，不用。
  - `tools/build_web.sh` 发布 `arduino-*` 示例时把 `BUILD_INFO.txt` 一起拷到 `fw/<id>/`（「每个 bin 旁边」）；`tools/build_arduino.sh` 的 BUILD_INFO 每个库多记许可证和钉提交的源码 URL（`<repo>/tree/<sha>`）。
  - `tools/gen_licenses.mjs` 新增「Arduino 示例固件」一节：读已发布 `fw/arduino-*/BUILD_INFO.txt`（没有已发布固件时退回 `firmware/build/arduino-*`，与 ESP-IDF 一节同理），列 arduino-esp32 核心 + 每个库（版本 = 钉的提交，链接 = 该提交的源码树）。库许可以 `docs/LICENSING.md` 为准写成白名单表；ESP32Servo 记 `LGPL-2.1-or-later`，版权行写 Bennett / Harrington（ESP32PWM）/ 派生自 Arduino Servo（Margolis 2009）。
  - 防护：已发布的 Arduino bin 用了白名单外的库（OneWire、TFT_eSPI 等）时 `gen_licenses.mjs` 报错退出 2，与「乐鑫修改版 MIT」那条同一做法；回退列举（未发布时）则跳过这些示例；`web/test/licenses.test.ts` 覆盖。
  - 同一轮里人又定 IRremote 也上站（决定本身由主会话记在 main 的 DECISIONS）：白名单加 `Arduino-IRremote`（MIT AND BSD-3-Clause），NOTICES 附全部版权人、`digitalWriteFast.h` BSD-3 和 4 个 GPL 头的说明。
  - `firmware/examples.json` 加 `arduino-lib-esp32servo`（C3，SG90 接 GPIO6）和 `arduino-lib-irremote`（C3，红外 LED 接 GPIO4；暂无红外件，场景里用普通 LED 件代替），让两个库真的上站；标题和说明走 i18n data 字典，zh / ja / ko 一起加。

## 2026-10-22 F-08f 自写 NEC 红外发送示例 + C3 / S3 RMT 载波
- 决定：新增 `firmware/arduino/ir-nec-rmt/`，只用 arduino-esp32 核心 RMT API（`rmtInit` 1 MHz tick、`rmtSetCarrier` 38 kHz / 33 %、`rmtWrite` 34 个符号：引导码 9000/4500 µs、32 位 560 + 560/1690 µs 低位先发、560 µs 收尾），地址 0x00、命令 0x36，与 lib-irremote 用例一致。协调方后续告知：人已批准 IRremote 上站，本例不再是替代，作为无第三方库的额外示例；lib-irremote 不动。
- 参考：公开 NEC 协议时序；arduino-esp32 3.3.2 `esp32-hal-rmt.h` / `.c`（LGPL 核心，只读 API 语义：`rmtSetCarrier` 的 carrier_level=true 实际映射为 `polarity_active_low`，故草图传 false 让高电平段带载波）；ESP-IDF v5.5 `rmt_reg.h`（C3 / S3 CONF0 carrier_en [21]、carrier_out_lv [22]，CARRIER_DUTY 紧跟 INT_CLR）与 `rmt_tx.c` `rmt_apply_carrier`（占空比按组时钟 resolution_hz 计），Apache-2.0。**未打开** third_party/arduino-libs/Arduino-IRremote 的任何文件，也未看 IDF ir_nec_transceiver 示例源码。
- core：`Rmt::carrier` 不再限经典 ESP32，C3 / S3 按上述位与组时钟（`src_hz / (div_num+1)`）换算；`PinDevices::ir_eye` 换成 `rmt_ir`（喂眼睛 + 返回是否开载波），经典 / C3 / S3 的 `route_rmt` 共用，开载波时不喂 WS2812 解码器（S3 lib.rs 守住 1500 行上限）；`ir_attach` 去掉「LED 眼睛只限经典 ESP32」的限制。C3 复位 CONF0 本就开载波（0x710200），驱动建通道时会关，golden 210/210 不变即佐证。新单元测试 `rmt::tests::c3_tx_carrier`。
- 备选：用 PWM 日志验 38 kHz（RMT 不走 LEDC，不适用）；改在经典 ESP32 上构建（已有载波，但 Arduino 库示例都在 C3，保持一致）。

## 2026-10-22 F-08a 遗留：C3 的 `--spi` 接受 @pins（Adafruit ILI9341 草图）
- 决定：C3 的 DCS 屏引脚从固定 `lcd_pin` 改为 `SocBus::lcd_pins`（默认 `LcdPins::C3_DEFAULT`，与 `lcd_pin` 同值并有单元测试守住），实现 `lcd_attach_pins` / `lcd_default_pins`；`--spi kind@...` 在 C3 上认 cs / dc / rst / bl，sclk / mosi / miso 照常解析但不校验（C3 模型本就不看 SCLK / MOSI 路由，SPI2 传输直接送屏）。`--spi` 语法不变。用例 arduino-lib-ili9341 用 `ili9341@sclk=4,mosi=6,miso=5,cs=10,dc=1,rst=0,bl=-1`，sclk / mosi / miso 写的是 Arduino-ESP32 3.3.2 C3 默认（pins_arduino.h：SCK 4、MISO 5、MOSI 6），仅作说明。
- 理由：不改用户草图也能跑才有意义（选项 a）；golden 211/211 不变，佐证默认接线行为未变。
- 遗留：Adafruit 竖屏发 MADCTL 0x48（MX | BGR），模型显示为左右镜像文字；真机常见 ILI9341 模块此设置是正向，IDF spi_lcd_touch 示例也无条件 `esp_lcd_panel_mirror(true, false)`，疑为面板模型 MX 约定与常见玻璃相反（会牵连 c3-ili9341 / CYD 用例），按范围不改面板模型，lcd_regions 只取左右对称的区域；C3 SPI2 不把 LCD 读回送 MISO，readcommand8 读回 0xFF，未断言。
- 备选：草图改成 C3 默认 lcd_pin（DC 5 / RST 4 / 显式 `SPI.begin`）——否，等于为模拟器改用户代码。

## 2026-10-22 F-08b 遗留：core 内置虚拟 MQTT 3.1.1 broker
- 决定：新建 `soc/src/wifi/mqtt.rs`（纯状态机 `Broker`，输出 Send / Close / Status / Log），挂在 `Tcp::mqtt`，1883 端口始终监听（不像 xiaozhi 需要 `xz=on` 开启），复用 WebSocket 的长连接 TCP 记账；跨连接下发经 `Tcp::side` → `Net::pending`。脚本动作 `mqtt=pub|pub1|retain,<topic>,<payload>` 放进 `Machine::net_action`，CLI 与网页（`tb_net_action`，未新增 wasm 导出）共用；CLI 结束报告改由 `World::service_logs` 统一列出 xz / mqtt（守住 main.rs `run` 798 行与 1500 行上限）。PubSubClient 草图改为先订阅 `tryboard/#` 再发布、收满 2 条打印 TRYBOARD_OK，用例改断言成功输出（功能完成后更新预期）。
- 理由：只有 PubSubClient 一个用例碰 1883，常开不影响其余 210 例（golden 一致）；broker 放在 Tcp 里，同连接回复随 ACK 立刻出去，确定性好；retain 存储算「互联网」状态，复位保留。
- 参考：OASIS MQTT Version 3.1.1 规范（报文格式、剩余长度、主题通配 4.7、保活 3.1.2.10、retain 3.3.1.3）；PubSubClient 2.8（MIT）只看其行为（CONNACK 第 4 字节为 0 才算连上、15 s PINGREQ）。没有读或参考任何 GPL broker（mosquitto 为 EPL/EDL，也未参考）。
- 备选：broker 放 World、经 inbox 一次 poll 后再回（xiaozhi 模式，CONNACK 晚一拍，多一套事件类型）；按需 `mqtt=on` 才监听（多一步，PubSubClient 默认场景不直观）；做 QoS 2 / 持久会话（范围外）。

## 2026-10-22 F-08f 续：网页红外收发件 + 遥控器，S3 载波用例（自主实现决定）
- 元件：新增零件类型 `irrx`（VS1838B 类接收头，OUT / GND / VCC，3V3 供电）和 `irled`（KY-005 类 940 nm 发射模块，S / GND）；都映射到 CLI `--ir RX[,TX]`（只取第一个），网页与 CLI 一样强制 1 ms 时间片（`partsTimed`）。3D 按实际尺寸程序生成，LED 固定放在接收头镜头一侧、朝向镜头（模块整体转 180° 时两件换边），与内核「LED 对着接收头」（loopback）一致。
- 遥控器：按常见 21 键「Car MP3」遥控器（地址 0x00，CH- 0x45 … 9 0x4A），每键发 `ir=FF00,<~cmd><cmd>`，另有「重复码」发 `ir=repeat`；进输入日志，`tryboard run --inputs` 重放。键位是公开常见码表，不是从任何库抄的。
- 解码显示：新 wasm 导出 `tb_ir_attach(rx, tx)`（负数 = 无）、`tb_ir_events()`（把新解出的帧按 `秒\tGPIO\t文本` 写进 REPORT），`tb_part_action` 认 `ir=`，`tb_parts_report` 带上 `ir_report()`；worker 每轮取一次发 `ir` 消息，`irfeed.ts` 存最近 12 条，LED 卡片显示。文本与 CLI 眼睛行相同。
- esp32-ir 固件：自检后继续监听（`portMAX_DELAY` 循环，TRYBOARD_OK 只打一次），原来 4 秒后停止接收，网页遥控器按晚了没反应。accept 期望不变；golden 只重存 esp32-ir（IDF 镜像带版本 / 编译时间）和新用例。
- S3：`firmware/arduino/ir-nec-rmt/boards.txt` 加 `s3` 变体（`build_arduino.sh` 支持变体名 `-` = 不加后缀，C3 目录名不变），accept 新用例 `arduino-ir-nec-rmt-s3`。S3 固件直接解出 2 帧，RMT 模型未改。
- parts.mjs 的 CLI 对拍参数加 `--ws2812-log`：网页报告总列出 WS2812 解码器（RMT TX 脚会挂一个 0 帧的），其它网页测试早已这样做；判定未放宽。
- 备选：遥控器做成独立的「遥控器」零件（多一种零件、无引脚，放弃，按键放在接收头卡片里）；解码显示走 `tb_parts_report` 轮询（每轮要整份报告，放弃）。

## 2026-10-22 F-04b 遗留：ILI9341 玻璃列方向与 GRAM 相反（MADCTL 0x48 为正）
- 决定：`PanelSpec` 加 `glass_flip_x`（模组玻璃列与 GRAM 列反向绑定），只 ILI9341 为 true；在 `render()` 里把窗口列 `wx` 映射成 `w-1-wx`，GRAM 写入仍按数据手册 MX（列地址顺序）不变，RDDST / 0Bh 回读不受影响。ST7789 / ILI9342C / E / GC9A01 / GC9107 / ST7735S 为 false，行为不变。IDF 验收固件（firmware/common/bare_tft.h 新增 `TFT_MIRROR_X`，c3-ili9341 / c3-ili9341-temp / esp32-cyd 设 1）在 init 后 `esp_lcd_panel_mirror(true, false)`，与 IDF spi_lcd_touch 示例一致；s3-st7789 不设，命令序列字节不变。
- 依据（三个独立来源一致：竖屏正向需要 MX=1）：Adafruit_ILI9341 1.6.4 `setRotation(0)` = `MADCTL_MX | MADCTL_BGR`（0x48，BSD）；TFT_eSPI `TFT_Drivers/ILI9341_Rotation.h` rotation 0（非 M5STACK）= `TFT_MAD_MX | TFT_MAD_COLOR_ORDER`（M5Stack 的 ILI9342C 用 MY | MV，是另一块屏，故 ILI9342 不改）；ESP-IDF v5.5 `examples/peripherals/lcd/spi_lcd_touch` 对 ILI9341 在 init 后无条件 `esp_lcd_panel_mirror(panel, true, false)`，LVGL 旋转 0 也是 mirror(true, false)。数据手册 MX 只定义 GRAM 列地址顺序，不规定玻璃朝向，所以建成模组属性而非控制器属性。LovyanGFX 的 Panel_ILI9341 本地没有副本，未引用。
- 影响：arduino-lib-ili9341 文字由镜像变为正（颜色质心 x 由 138.7 变 100.3），lcd_regions 新增两个左右不对称区域钉住方向；c3-ili9341 / esp32-cyd / esp32-cyd-touch / c3-ili9341-temp(-hot) 画面与区域不变（固件多发一条 MADCTL：LCD 命令数 +1、SPI 传输 +2），CYD 触摸 60,250 → 像素 60,250 不变；golden 这 6 例重新 save。
- 备选：不改固件只改模型——否，IDF 固件发 0x08 会在模型里（也在真机上）镜像，c3-ili9341-temp 数字会反；在 `pixel_byte` 里异或 MX——否，会让 GRAM 内容偏离数据手册。

## 2026-10-22 P2-16 收尾：台面 I2C 走实际接的针 + 手机元件库放置（自主实现决定）
- **台面 I2C 器件挂针级总线**：网页 `web/src/i2cdevs.ts`（`attachI2c` / `i2cArgs`）把场景里带 `sda` / `scl` 的 I2C 器件挂到 M5-02 的针级总线（wasm `tb_i2c_bus_add` + `tb_i2c_attach_bus`），没写针的旧器件仍走 I2C0（`--i2c`，不看针）；顺序与 CLI 一致（先 `--i2c` 再 `--i2c-bus`）。输入日志 `cliArgs`、genlevels、checks、各 webtest 的 CLI 对照都改用同一个 `i2cArgs`，网页与 `tryboard run --i2c-bus sda=..,scl=..:dev@addr` 参数一致。关卡和 golden 输出不变（关卡场景的针本来就是固件用的针）。
- **接线提示 W8**：固件把 I2C 控制器路由到哪两个焊盘由 `PinBuses::route` 在每次事务时记下（`fw_pads[port]`，即使没有总线匹配也记），经 `Machine::i2c_fw_pads` → wasm `tb_i2c_fw_pins` → worker `i2cfw` 消息 → `session.i2cFw` 到接线检查。W8 比对**实际接线**（有效导线）与固件焊盘：SDA/SCL 对调报「SDA / SCL 接反」，接到别的针报「I2C 引脚和固件不一致」。模拟本身按场景器件的 `sda` / `scl` 挂总线（放置时即实际接的针），所以 W8 与「扫得到 / 扫不到」一致。
- **修了既有 bug：固件软复位丢针级总线**。C3 / S3 / 经典的重启路径重建 SocBus 时只搬了 I2C0/1 器件，`i2c_pins` 被清空，s3-bme280 扫不到设备 abort 重启后台面器件就「消失」。新增 `PinBuses::carry()`：总线和器件（外部世界）保留、线电平重新开始、上拉并回 `board_pullup`；`fw_pads` 也保留，避免崩溃循环的固件让 W8 提示闪烁。
- **已知缺口**：`Machine::i2c_load()`（P2-11 上升时间估算）只看 I2C0，挂在针级总线上的器件不计入电容，器件多时会低估；不在本项范围，后续把 `PinBus` 器件数并进估算。
- **手机放置**：手机元件库是盖在台面上的整页抽屉，原来没有「放」入口。每行在 Add / 已在清单旁加 44px「放」按钮（`[data-place]`，只对有放置定义且不缺条件的零件显示）；`startPlace` 在手机上 `setMui({ lib: null })` 收起抽屉，露出针环；针环沿用已有的「按下预览、松开连接」。
- **体积护栏**：`createSession` 的 harness / i2cFw 两组订阅改用新的 `web/src/subs.ts`（`subs<T>()`，on / emit），函数从 538 行减到 536；S3 `lib.rs` 守住 1500 行上限。
- 备选：W8 改成看模拟总线是否收到事务（要等固件真的扫描，提示会晚且依赖固件行为，否决）；手机上用长按拖放（与滚动冲突、触屏拖拽 3D 台面难以定位，否决）。

## 2026-10-22 F-08g：网页 MQTT 发布面板（自主实现决定）
- 决定：broker 日志不新增 wasm 导出，而是并进 `tb_net_json`（多一个 `mqtt: [[ms, 行], …]` 字段，最近 50 条），`tb_net_version` 加上日志条数，网络页签现有的刷新链路（postNet → netFeed）直接带过来；发布走现有 `mqtt=` 动作（`{type: 'input', act: {kind: 'mqtt'}}` → worker `apply` → `tb_net_action`），自动进输入日志。
- 顺带修了既有缺口：worker `apply()` 没有 `mqtt` 分支，输入日志里的 `mqtt=` 在网页侧只被记录、没送进内核（倒带 / 分享链接重放会丢云端消息）；现与 `net` / `netfault` 同分支，内核拒绝的（非法主题）不进日志。
- 主题默认值：取 broker 日志里最近一条 SUBSCRIBE 的过滤器；不含通配直接用，`前缀/#` 换成 `前缀/in`，其他情况 `tryboard/in`（发布主题不能含通配，PubSubClient 示例订阅的是 `tryboard/#`）。主题含逗号会被 `mqtt=` 动作切开，面板直接禁用发送；消息里的换行换成空格（输入日志一行一个动作）。
- 送达方式做成三选一（QoS 0 / QoS 1 / retain），与 `Cmd::parse` 的 `pub|pub1|retain` 一一对应，而不是 QoS × retain 两个开关（内核 retain 只发 QoS 0）。
- 备选：照 `tb_ir_events` 另加 `tb_mqtt_log`（多一个导出和一套轮询，且 take 语义不适合可回看的日志，否决）；面板放进「请求」视图左栏（与网络条件挤在一起，手机上太长，否决，改为单独的 MQTT 视图，只在固件连过 1883 后出现）。


## 2026-10-22 F-12：静态更新日志页 + Atom + sitemap + robots（自主实现决定）
- 数据放 `web/changelog.yaml`（进 git，人手写），构建期 `tools/gen_changelog.mjs`（`build_web.sh` 在 `gen_licenses.mjs` 之后调用）生成 `web/changelog.html`、`web/public/changelog.xml`（Atom 1.0）、`web/public/sitemap.xml`、`web/public/robots.txt`，四个都是生成物、不进 git（robots 的 `Sitemap:` 行带站点地址，所以也生成）。
- YAML 手写最小解析（只认 `entries:` 下的 `- key: value` 列表、`[a, b]` 行内数组、整行 `#` 注释；按第一个 `: ` 切键值，标题里的冒号不受影响；其它写法直接报错），不加 npm 依赖。
- 审核规则（违规 exit 2 并逐条列出）：未知 tag（new / improve / announce / removed）、缺字段、未知芯片标、日期不是 YYYY-MM-DD、title > 60 字符、desc > 200 字符、标题以 Fix / Fixed / Refactor 开头、出现内部术语（PLAN ID 形如 F-08g / U-07 / M5-09、wasm、worker、HLE、golden、accept、fingerprint、MMIO、VHCI、R-xx 等）、link 不是站内路径、指向不存在的入口、`example=` 不在 `firmware/examples.json`、`work=` 不是 `WorkId`。规则思路借鉴自有项目 newshub 的发布前审核（同一作者，无授权问题，未复制代码）。
- 公开入口页 = `/`（index.html）、`/select`、`/app`、`/licenses`、`/changelog`；`home` / `advisor` / `levels` 是旧地址跳转页，`embed` 只给 iframe 用，审核拒绝链到它们，sitemap 也不列。lastmod：changelog 取最新条目日期，licenses 取构建日，其余取该 html 在 git 的最后提交日期（取不到用构建日）。
- 页面只做英文，与授权页一致：I18N.md §1 规定 `tools/*.mjs` 的输出只用英文，构建期生成的静态页没有 `t()` 运行时（授权页同样在页面上注明 "generated in English only"）；页脚入口文案走 `t()` 四语。
- 站点地址未定：`TRYBOARD_SITE_URL` 环境变量，缺省占位 `https://tryboard.example`；canonical、Atom、sitemap、robots 都用它。**上线前必须设置**（否则搜索引擎拿到的是占位域名）。（2026-10-22 已定域名，缺省改为 `https://tryboard.indaloop.app`，见「站点域名」条）
- 页头 / 手机抽屉 / 页脚 / 主题脚本抽到 `tools/static_shell.mjs`，授权页与更新日志页共用（各自的 css 都 `@source` 它）；不再复制第三份。
- 备选：用 js-yaml（多一个依赖，否决）；做成 React 页（首屏要等 JS，SEO 与授权页不一致，否决）；RSS 2.0（Atom 的 id / updated 语义更清楚，否决）。

## 2026-10-22 站点域名 tryboard.indaloop.app（人决定）
- 决定：站点用 `https://tryboard.indaloop.app`（人已有 indaloop.app；indaloop 为出品方，tryboard 为产品子域名）。个人品牌域名 wqu.guru 不作站点主域名，只用于作者链接 / 开发日志等，链回本站。
- 代码：`tools/gen_changelog.mjs` 缺省 SITE 改为该域名（`TRYBOARD_SITE_URL` 仍可覆盖，比如预发布地址），去掉“未设置”告警；全部入口页和 `tools/static_shell.mjs` 的 `og:image` 改为绝对地址 `https://tryboard.indaloop.app/og.png`（抓取方多数只认绝对地址）；`tools/webtest/og.mjs` 检查 og:image 必须在该域名下且 dist 里有对应文件。
- 分享链接、二维码、嵌入页仍用 `location.origin`，不写死域名。
- 理由：.app 在 HSTS 预加载列表里，强制 HTTPS，本站本来就需要（wasm、麦克风、剪贴板）；子域名表达出品方 / 产品层级，以后换独立域名只改一处常量和这些 meta。
- 未做（需人）：DNS 绑定、托管平台配置、上线部署。
- 备选：tryboard.indaloop.dev（人不持有 .dev）；tryboard.wqu.guru（个人品牌不像产品，否决）；独立域名 tryboard.app / .dev（未查可注册性，留待用户量起来再议）。

## 2026-10-22 E-09：经典 ESP32（LX6）BLE（自主实现决定）
- **决定**：照 E-04 的 S3 路线，签名只从 IDF 5.5.1 自带的 `components/bt/controller/lib_esp32/esp32/libbtdm_app.a`（Apache-2.0）生成；HLE 代码与 S3 共用（`esp32s3::ble` 泛化为 `Bus` trait + `Osi` 布局表），经典芯片只提供地址、osi 表布局、签名集合。没有从 espressif/qemu 复制或翻译任何代码。
- **窄 / 宽规范化**：LX6 链接器把库里的密度指令放宽（`mov.n a10,a2` → `or a10,a2,a2`），S3 的已知缺口方向相反（缩窄）。匹配器对完全精确的单元把 16 位窄形式和对应 24 位宽形式视为相等（`ble_sigs.py xt_same` / `sig_xt::same`）。同一批库下 S3 `gen-xt` 输出与改前逐字节相同；S3 70 个、C3 76 个固件误认单测仍为零。
- **get_mode 按调用点**：LX6 的 `btdm_controller_get_mode` 与 get_sleep_mode、sleep_enabled 等 5 个函数同形，改为在 `esp_bt_controller_enable` 里 `btdm_controller_enable` 调用前 96 字节内找唯一一个签名匹配的 call 目标。
- **唤醒路径**：bt.c 在每次 `esp_vhci_host_send_packet` 前后调 `btdm_in_wakeup_requesting_set`，它经控制器内部的 `r_osi_funcs_p` 取信号量；该指针由被钩住的 `btdm_osi_funcs_register` 设置，所以为 NULL（首次 HCI 发送 LoadStoreError）。把它挂成 Nop（复用 `Hooks.pll_track` 槽，LX6 没有 pll_track 钩子），签名在全部经典固件里唯一。备选：直接写控制器全局变量（要从 l32r 字面量反推地址，更脆，否决）。
- **BR/EDR 命令**：虚拟控制器对 Link Control（除共用的 Disconnect / Read Remote Version）和 Link Policy 命令回 Command Complete 状态 0x01 Unknown HCI Command，单独计数（`Ble::bredr_cmds`，CLI 末尾打印）；现有 C3 / S3 / ESP32 固件都不发这类命令。
- **覆盖**：third_party/btlib 只有 C3 / S3 的历史库，没有 esp32 的，签名只对 5.5.1 生成并实测；旧 IDF 版本的经典 ESP32 BLE 固件可能认不出（报「没认出」而不是误跑）。
- **共享源码**：`firmware/c3-bluedroid-nus/main/main.c` 加了 `CONFIG_IDF_TARGET_ESP32` 分支（CHIP_NAME / FW_ID）；C3 / S3 运行输出不变，但行号后移，重编后二进制会变。
- **网页**：示例库里没有任何板的 BLE 示例入口，按约定不给 esp32-devkitc 加。

## 2026-10-22 E-10：Xtensa CPU 主频按寄存器计时（自主实现决定）
- 起因：S3 版 IRremote SimpleSender 的 NEC 0 空隙 713 µs（+27 %）解不出；C3 679、经典 ESP32 564。差别来自软件开销（反馈灯 RMT 写）：Arduino `initArduino` 调 `setCpuFrequencyMhz(F_CPU)`，S3 / 经典 ESP32 板 `f_cpu=240000000L`，而模拟所有芯片都按 160 MHz、每条指令 1 个周期，240 MHz 代码慢了 1.5 倍。临时把 S3 改成 3 条指令 2 个周期即全解，确认是主频而不是解码容差
- 决定：时基仍是 160 MHz（`CPU_HZ`、外设、VCD、网页时间都不动），只改指令耗时：SoC 在 CPU 时钟寄存器写入时算 `cpi3`（每条指令的时基周期 ×3，PLL 下 CPUPERIOD_SEL 0 / 1 / 2 = 6 / 3 / 2），每个调度量子拷给两个核；累加余数，3 条 240 MHz 指令 = 2 周期。XTAL / RC 阶段保持原来的 1 周期（启动早期，不建模 40 MHz）
- 不改：CCOUNT 仍 = 时基周期 + 偏移（每秒 1.6 亿），240 MHz 固件以为每秒 2.4 亿，按 CCOUNT 忙等的代码（`esp_rom_delay_us` 等）在 240 MHz 下仍偏长 1.5 倍——这是原有问题，本项不变；要修需 CCOUNT 按指令数走并换算 CCOMPARE 事件时间，留给以后。WAITI 空转、HLE 返回仍按 1 周期
- 影响：IDF 验收固件 sdkconfig 全是 160 MHz，行为不变；只有 Arduino 编的 S3 / 经典 ESP32 固件变快（golden 只这些用例变）。CPI 仍为 1，未经真机标定
- 备选：放宽 NEC 解码容差或加绝对余量（IDF `IR_NEC_DECODE_MARGIN` 200 µs）——否：会掩盖 1.5 倍的计时错误；草图里定义 `NO_LED_FEEDBACK_CODE`——否：改用户代码绕过模拟器问题

## 2026-10-22 托管与运维入口：Cloudflare Pages + Justfile（人认可推荐）
- 决定：静态站托管在 Cloudflare Pages（免费套餐，不开 Workers Paid / 不引入 Pages Functions），本机构建后 `wrangler pages deploy` 直传（不走 Pages 的 Git 构建、不建 CI）；仓库根加薄 `Justfile`（只包 `tools/*`，脚本仍是唯一实现），`just --list` 是常用命令入口。
- 不做配置化：站点无后端、无运行时密钥，构建期只有 `TRYBOARD_SITE_URL`（与 Pages 项目名一起放在 Justfile 顶部变量，`TRYBOARD_PAGES_PROJECT` 可覆盖）；内容配置（accept / levels / examples / catalog）已由 `tools/check_config.py` 校验。不引入 `.env`、`~/.config/tryboard`、env-policy（参考 newshub 的那套是为有状态、有密钥的服务准备的）。
- 理由：
  - 费用：Pages 静态请求与带宽不计费；免费套餐超额是拒绝服务而不是扣费；只有引入 Functions / Workers Paid / R2 才有按量计费，届时重新评估（并加限流）。
  - 不能放 CI：`web/public/{wasm,fw,rom}` 被 git 忽略，干净 checkout 要 ESP-IDF（几 GB）+ ROM 才能构建；仓库也还没有 remote。所以在本机构建，`just deploy` 拒绝脏工作区（`force` 可覆盖），把 commit hash / dirty 标记带进 Pages 部署记录。
  - 现有约束都满足：`_headers` 本来就按 Pages 语法写；dist 67 MB / 456 个文件、无单文件 > 25 MiB；不用 SharedArrayBuffer，不需要 COOP/COEP。
- 预览：`just deploy preview` 用 `--branch preview`，构建时 `TRYBOARD_SITE_URL` 设为 `https://preview.<项目>.pages.dev`（canonical / sitemap 不指向正式站；页面里的 og:image 仍是正式域名绝对地址，可接受）；`just smoke` 对 `*.pages.dev` 额外检查 `X-Robots-Tag: noindex`（Pages 对预览部署自动加，首次预览时核实）。
- 运维 recipe：`doctor`（只查工具链存在性）、`size-check`（wasm 首载 ≤ 2 MB，原始字节）、`deploy [prod|preview] [force]`、`smoke <url>`（页面 200 + no-cache、wasm immutable + application/wasm、robots）、`pages-local`（`wrangler pages dev` 本地模拟 `_headers`；本机 wrangler 4.118 自带 workerd 只支持到 2026-08-06，所以钉 `--compatibility-date 2026-08-01`）、`deployments`（回滚走 Cloudflare 控制台 Deployments → Rollback）。
- `just lint` 的注释检查默认只查相对 HEAD 改动 / 新增的文件：全仓库仍有 32 条历史问题（accept.sh 不卡它），`just lint all` 查全量。
- 实测（worktree ops-justfile）：`just smoke http://localhost:8799`（`pages-local` 起主目录的 dist）12 项全过；`size-check` 1,656,361 B / 2,000,000；脏工作区 `just deploy preview` 被拒；`just lint` 里 lint_size 报 `productStep 961 -> 963`，HEAD 上已有，与本改动无关。未做真实部署（正式部署要人点头，AGENTS §10；还需人在 Cloudflare 建 Pages 项目、绑 tryboard.indaloop.app、`wrangler login`）。
- 备选：部署到自有服务器 hetzner3（cloudflared tunnel + Caddy）——否：那台机器 8 核 16 GB 无 swap、负载约 5.7，跑着 newshub 和 4 个实盘 trader，公开站被刷会拖累交易程序；机房在赫尔辛基，而用户多在中日韩，边缘未命中都要回源；`.wasm` / `.bin` 还得另配 Cache Rules；回滚、预览、证书都得自己维护。以后需要后端（短链、realnet 代理、账号）时，在 hetzner3 起小容器经 tunnel 挂 api 子域名，静态站仍留在 Pages。Netlify / Vercel：功能相近，但 `_headers` 按 Pages 语法写、只在 Pages 上核实过，不换。indaloop.app 的 DNS 是否在 Cloudflare 待人确认（不在则绑自定义域名要加 CNAME）。

## 2026-10-22 G-02：故障关「SDA / SCL 接反」的开关改台面（自主实现决定）
- 决定：开关 flag 用 CLI 已有的 `--i2c-bus`（一关一个值，KNOB_FLAGS / faults.ts 同步）；基础参数里 SSD1306 走无引脚 `--i2c`，BME280 由开关挂到 `sda=9,scl=8`（原样）或 `sda=8,scl=9`（修好）。不改内核、不加 wasm 导出
- 与 F-05 其他开关不同：`--i2c-bus` 开关同时改台面场景（`faults.ts` `faultScene`：按 kind@addr 改对应零件的 sda / scl），打开这关和每次切换时 `restoreScene` + 时间线记一步 + 重新上电，这样 3D 线、接线检查 W8、实时仿真（引脚总线）和检查运行用的是同一份接线。只走 wireMods.retarget 不行：改线不改仿真（台面会显示接反而实时仿真仍读得到）
- 离开时不在卸载里还原（点开导线看 W8 也会切走检查面板，卸载即还原会让线问题一闪就没），改为进入每一关时 `faultScene(scene, l, knobs, home)` 把 I2C 零件设回「该关开关值，无 `--i2c-bus` 时取作品默认场景（examples 里 `work.example` 的 scene）」，否则下一关（fault-wire 等）会带着接反的 BME280 因错误原因失败
- 顶栏撤销 / 回放后开关从台面反推（`knobsFromScene`：哪个选项套到当前场景不改线就是哪个），不去拦撤销跨过开关步；二者取简单的
- 实时台面两条总线共用 8 / 9 号焊盘（OLED 8/9、BME280 9/8），内核 `i2cpins.rs` `add` 拒绝焊盘重叠的第二条总线（worker 里 console.warn「pad already on another bus」，非 error），效果同样是扫不到 0x76；CLI 检查运行里 OLED 无引脚，不受影响
- 备选：只改检查不改台面（F-05 做法）——否：W8 不会出现，目标要求台面接线视图一致；改用 wireMods 让玩家用接线工具把线换回来——否：接线工具明确不改仿真，修好后实时台面与检查不一致

## 2026-10-22 G-03：RFID 门禁（`door`）的引脚、屏幕文字和新零件（自主实现决定，阶段一）
- 引脚：RC522 沿用 c3-rc522（SCK4 MISO5 MOSI6 CS7 RST3）；SH1106 只能离开 6 / 7（SPI 占用），也不能用 8（ESP32-C3-DevKitM-1 板载 WS2812，规则 R24 报警），18 / 19（R09 USB）和 20 / 21（R10 日志串口）同样报警，最终 SDA=GPIO2、SCL=GPIO9（两个都是 strapping 脚，但 I2C 上拉保持高电平正好满足启动要求，规则无告警）；继电器 IN GPIO10、无源蜂鸣器 GPIO1（LEDC 2700 Hz）、红 LED GPIO0
- 屏幕只用 ASCII（WELCOME / DENIED / LOCKED / LOCKOUT + 小字说明）：5×7 字库没有中文；串口 printf 仍是中文，检查点按中文匹配
- 新零件（parts-bench.ts）：`door-strike-12v`（12 V 电磁锁，无仿真模型，requires `psu-12v1a`）、`psu-12v1a`、`enclosure-door`（86×120×28 mm 估算，sim estimated `assembly:door`）。BOM 信任等级：RC522 读卡 = 行为级（只模拟 UID，不模拟 MIFARE 认证），继电器后面的电磁锁 / 12 V / 市电 = 必须上真机
- 选型顾问 `PART_MAP`：rc522 → `rc522`、relay → `relay-1ch`（从 EXAMPLE_ONLY 移出），custom.ts `wiresFor` 补两者接线（顾问 SPI 三脚 = SCK / MOSI / 第三脚，RC522 的第三脚给 MISO，SDA / RST 用 gpio 两脚）
- 顺手修两个工具缺口：`tools/check_config.py` 零件 id 也读 `parts-bench.ts`（parts.ts 用 `...BENCH_PARTS` 展开，原来扫不到）；npm 包 `tryboard check` 关卡运行漏传 `dht11` / `parts`（`--spi rc522` / `--relay` 等），door 四关 npx 与 check.py 指纹原先不一致，补上后一致
- 示例 id 用 `c3-door`（固件目录名 = 示例 id），作品 `door` 的 `example: 'c3-door'`；catalog.test.ts 的 toScene / 引脚对照按 door → c3-door 查示例
- 阶段一不给作品加首页卡片（`card`）：首页卡片要 views/templates.ts 的产品视图，没有时会走 showcase 的旧分支出错；产品页对没有 TEMPLATES 的作品已有「没有成品」兜底
- 备选：SH1106 和 RC522 共用 SPI（SH1106 SPI 版）——否：目录里的 sh1106 是 I2C 模块；换 xiao-c3 板——否：DevKitM-1 引脚多，c3-rc522 已用它

## 2026-10-22 G-04：红外遥控小夜灯（`irlamp`）的引脚、键码表、功耗检查和零件（自主实现决定，阶段一）
- 芯片 S3，复用 lamp 的灯带（DIN=GPIO5 经 74AHCT125、外部 5 V）和外壳；红外接收头 OUT=GPIO4（与 lamp 的 5 / 6 / 7 / 15 不冲突，S3 上不是 strapping / USB / 日志脚），VCC 接 3V3 让 OUT 保持 3.3 V
- 键码表照实验台遥控器（web/src/app/irfeed.ts，常见 21 键「Car MP3」NEC 遥控器，地址 0x00）：数字 1–9 = 0x0C 0x18 0x5E 0x08 0x1C 0x5A 0x42 0x52 0x4A，VOL+ 0x15，VOL- 0x07，开关 0x45。0x45 在 Car MP3 款上印的是 CH-，在另一种 21 键款上印的是电源键（那款 VOL+ / VOL- 是 0x09 / 0x15，与本表冲突，所以只按 Car MP3 款）；阶段二网页需要把这个键标成「电源 / CH-」或在产品页说明
- 9 色：红 绿 蓝 黄 青 紫 粉 暖白 白；上电 = 开、8 暖白、亮度 4/8；每通道 = 颜色值 × L / 8（满档 = 原色，便于功耗检查用 #FFFFFF）；重复码只对 VOL+ / VOL- 生效
- 功耗检查（irlamp-4）：现有关卡没有外接灯带电流的检查手段（电气模型不算 WS2812），所以固件每发一帧打印「电流估算 I mA」，I = 8 + 8 × (R+G+B) × 20 / 255（每灯静态 1 mA + 每通道满值 20 mA），关卡用 expect 精确匹配 8 mA / 488 mA，并用 WS2812 最后一帧（8 颗 #FFFFFF）校验这个估算对应的帧确实发出；pass 文案注明是估算。不新增检查类型，免得 check.py / checks.ts 两边改
- 四个检查点都用同一个参考固件 s3-irlamp（同 door）；不加 STAGE 分阶段构建
- 零件：接收头沿用已有的 `vs1838b`（不另建 id）；新增 `ir-remote-nec21`（无引脚、自带 CR2025），采购模板 irlamp 把它列为必需，零件说明里提示多数 VS1838B 套件已附带。顾问 `PART_MAP.irrx` → `vs1838b`（移出 EXAMPLE_ONLY），custom.ts `wiresFor` 补接线（OUT / GND / VCC=3V3）；templates.ts `toScene` 认 vs1838b → `irrx` 场景件
- `--ir` 已经经 partsdev.ts 进 npm 包的 bootOptions，cli.ts / check_config.py 不用改
- 阶段一不加首页卡片（同 G-03）
- 备选：C3 版——否：lamp 外壳和灯带模板都是 S3（s3-devkitc1-v10），复用最省；VOL± 用 100+ / 200+——否：实验台遥控器 VOL± 标得清楚

## 2026-10-22 G-05：温湿度上云（`cloud`）的引脚、主题、间隔语义和 wasm AHT20（自主实现决定，阶段一）
- 芯片 C3，传感器选 AHT20（不用 BME280：AHT20 便宜、模块常见，且已有 soc 模型）；I2C SDA=GPIO6、SCL=GPIO7、地址 0x38、100 kHz，避开 GPIO8（板载 RGB / strapping）和 GPIO9（BOOT）
- 网络：连开放热点 TryBoard-WiFi（192.168.4.100），broker `mqtt://192.168.4.1:1883`，client id `tryboard-cloud`；直接用 ESP-IDF esp-mqtt（MQTT 3.1.1），模拟器无需改内核，不需要手写 MQTT 客户端的退路
- 主题：`tryboard/cloud/data` 发 `{"t":23.5,"h":45.0,"seq":N}`（一位小数，QoS 0）；`tryboard/cloud/cmd` 收 `interval=<1–60>`；每条命令都在 `tryboard/cloud/ack` 回执 `{"ok":true,"interval":N}` 或 `{"ok":false,"cmd":"…","interval":当前}`
- 间隔语义：从上一次发布起算；改间隔成功后立刻发一条（打印「间隔刚改为 N 秒，立即发一条」，不打印间隔），新间隔从它起算——否则改后的第一个间隔是「旧周期剩余 + 新周期」的混合值（实测 2.29 s），数值检查没法写
- AHT20 读法：触发后等 80 ms 再轮询忙位（最多 5 次、每次 10 ms）——vTaskDelay 可能早醒一个 tick，模型正好 80 ms 忙，不轮询会偶发读失败；读失败打印并跳过本次
- npx 指纹一致：wasm `tb_i2c_attach` 原来没有 aht20 编号，新增 kind 13 = aht20（web/src/i2cdevs.ts `KIND` 同步），之前 npm 包里 AHT20 无应答；golden 不变
- accept `c3-cloud` `qemu: false`（QEMU 没有虚拟 AP / broker）；四个检查点同一参考固件；阶段一不加首页卡片（同 G-03）
- 示例 c3-cloud 的 `scene.parts` 暂为空：网页场景还没有 aht20 部件类型（SCENE_TYPE / editor / scene3d），所以网页示例里看不到传感器、读数失败，留给 G-05b（G-05b 已解决，见 2026-10-23 条）
- 备选：BME280（已有网页部件）——否：PLAN 允许二选一，AHT20 更贴合「温湿度」且便宜；手写 MQTT——否：esp-mqtt 直接能跑

## 2026-10-22 授权页 / 更新日志 / Atom 四语（F-12b）
- 决定：静态页构建期按语言各生成一份文件，用后缀而不是目录：`licenses.zh.html` → `/licenses.zh`、`changelog.ja.html`、`changelog.ko.xml`；英文保留原地址（`/licenses`、`/changelog`、`changelog.xml`）。页头语言选择与 React 页同一 `tb-lang` 键；首屏前脚本按 `?lang` > `tb-lang` > 浏览器语言跳到对应版本（只在与当前页语言不同时跳，防循环）。
- 原因：F-12 的目的是 SEO，需要每种语言独立 URL + `hreflang`；Atom 不能在客户端换文字，必须分文件；`static_shell.mjs` 全用相对链接（`./`、`./select`），放进 `/zh/` 目录会全部断掉，后缀方案不用改链接。
- 文案位置：页面外壳与授权页说明放构建专用词典 `web/src/i18n/<loc>/static.ts`（不进任何 `data-i18n` 组，不增加 React 页面下载量）；更新日志条目译文直接写在 `web/changelog.yaml` 每条里，审核要求四语齐全。许可证名、SPDX、版权行、THIRD_PARTY_NOTICES.txt、tryboard.spdx.json 是法律原文，不翻译。商标声明保持英文并标 `lang="en"`（同 site.tsx）。
- 备选：一页内嵌四语、客户端切换——否：搜索引擎只看到英文、Atom 仍要分文件；`/zh/` 目录——否：要把外壳所有相对链接改成绝对路径，并影响 og / smoke 路由。
- 实现补充（F-12b 完成时）：首屏前语言判定 `?lang` 只管本次访问、不写 `tb-lang`（与 React 页 `detectLocale` 一致）；浏览器语言只在英文（x-default）页触发跳转，已本地化的地址在没有保存选择时原地不动，免得搜索引擎和分享链接被弹走；跳转保留 query（含 `?lang`，不会循环）与 hash。语言选择写 `tb-lang`，写不进（隐私模式）就改用 `?lang=`。`<html lang>`、hreflang、Atom `xml:lang` 中文都用 `zh-CN`。锚点与条目 id 各语言都取英文标题 slug，切换语言保留位置。

## 2026-10-22 G-07：480×480 AMOLED（ws-amoled216）上做 LVGL 时钟 / 手表作品的可行性（实测结论）
- 测法：同一台机（负载 4–12，高于 P2-07 的 < 4，倍率偏低几个百分点）；网页 = `tools/build_web.sh` 后 puppeteer 打开 `/app?work=blank&example=<id>#bench`，用 `session.sim.mark()` 取模拟时间 / 墙钟，rAF 里看 `session.frame.lcd` 换引用的间隔，滑动后看页码点区域（x 196–236, y 448–460）的哈希何时变；Node = `tools/bench_wasm.mjs`；CLI = `tryboard run` + `/usr/bin/time`，滑动重画耗时靠不同 `--seconds` 下 `pixels written` 二分。脚本是一次性的，没入库，原始数字在 Reviews/ab/G-07.md。

| 项 | s3-lvgl（GC9A01 240²，LVGL 满负荷整屏动画） | s3-ai-dash（CO5300 480²，LVGL 四页仪表盘） | lens（GC9A01，非 LVGL 局部刷新） |
|---|---|---|---|
| 网页实时倍率（10 s） | 0.48–0.50× | 1.00×（CPU 有空闲，被实时上限卡住） | 1.00× |
| wasm Node 纯核心 | 0.45× | — | — |
| 原生 CLI | 0.64×（10 s 模拟 / 15.6 s） | 11×（10 s / 0.9 s） | — |
| 模拟时间帧率 | 33–34 FPS，约 5.7 万像素 / 帧 ≈ 1.9 M 像素/s | 静止时只有每秒一次的时钟 / 心跳局部刷新 | — |
| worker → 主线程帧间隔 | 中位 50 ms（33 ms 节流 + rAF 量化） | 静止时约 1000 ms；每帧 900 KB 拷贝 + 转移 | 中位 33 ms |
| 主线程 rAF | 16.7 ms，p99 16.8 ms | 滑动重画期间最大 16.8 ms（900 KB 帧不卡主线程） | 16.7 ms |
| 滑动 → 整屏换页 | — | 模拟时间：松手后约 20 ms 被 LVGL 输入轮询读到，约 30 ms 画完 19.5 万像素（纯色块 + 文字约 6.5 M 像素/s），另 4 万像素在 +90 ms；网页墙钟：松手到页码点变化 85–103 ms（4 次） | — |

- 结论（核心慢，不是传帧慢）：网页 0.48–0.50× 与 Node 纯核心 0.45× 基本一致、rAF 无掉帧，瓶颈是 Xtensa 解释器的 CPU 速度；900 KB 帧的拷贝 / 转移 / 纹理上传在 30 fps 节流下看不出代价。
- 按表盘负载分三档：
  - **可直接做**：数字时钟 / 跳秒指针（每秒一次局部刷新，界面同 s3-ai-dash）——网页 1×，滑动换页约 0.1 s 出画面，体验没问题。
  - **可做但慢放**：扫秒针、圆弧进度等 30 fps 局部动画——CPU 会像 s3-lvgl 一样满负荷，网页约 0.5× 实时（动画看着是慢放，帧率 / 时间按模拟时间都对）；作品说明里要写明。
  - **不建议**：480×480 整屏动画（表盘整体旋转、整屏渐变、页面滑动动画）——按 s3-lvgl 的抗锯齿绘制速率 ≈ 1.9 M 像素/s，整屏 23 万像素一帧约 120 ms 模拟时间，模拟内约 8 FPS、网页约 4 FPS。
- 若要先优化：只有核心提速（继续 P2-07 的 Xtensa 快路径）能改善第二、三档；传帧不用动。一处低成本点（未动手）：`web/src/worker.ts` `postLcd` 只按 33 ms 节流取整屏，480 屏 40 行一条带地刷（12 条 / 帧），网页可能看到画到一半的帧（撕裂），可改成在一帧最后一条带写完（RAMWR 窗口到底）时再发——对表盘观感比对速度更有用。
- 备选：另写一个 480×480 整屏动画的 LVGL 基准固件实测第三档——否：任务要求不改产品代码，s3-lvgl 的满负荷像素速率已能估出量级；以后做手表作品时用作品本身的固件再测一次。

## 2026-10-22 G-11：BLE 用了但没认出时网页怎么说
- 决定：`tb_ble_state() == 2` 时蓝牙坞的卡片（`web/src/app/blepane.tsx` `BleUnknownCard`，id `bleUnknown`）改为「这个固件的蓝牙没法模拟」+ 原因（核心原样给的 reason，等宽字体）+ 改法（用 IDF 5.5.1 或 Arduino-ESP32 核心 3.3.2 重编；芯片 / 开发板建议不受影响）+ 三档版本事实（模拟器里跑通过 / 认得出没实跑 / 认不出），按 STATUS 蓝牙三行写，不按任务说明里的「IDF 5.1–5.3.1（C3）」。手机端串口抽屉收起时看不到蓝牙页，peek 条加「蓝牙未模拟」徽标（`#peekBleOff`，键 "Bluetooth not simulated"；不用 off，免得像能手动打开）。
- 去掉旧卡片「再拖一个 app.elf 就能按符号挂上」的承诺：路线 c 没接，网页拖 .elf 只给任务时间线起函数名，BLE 不会因此生效，原文案会误导。
- 没改核心：CLI 末尾那句「app.elf is needed」和 `esp32c3::ble::locate` 注释保持原样（改输出要动 golden）；路线 c 接上时一起改。
- 复现：`c3-ble-hr/flash.bin` 把 `API_vhci_host_send_packet`（0x4204f9da）起 16 字节取反，CLI 报 `API_vhci_host_send_packet not found`，网页进 state 2。
- 备选：串口面板上方再放一条横幅（桌面端 state 2 已自动切到蓝牙页，重复）；把 state 2 也算进 Issues（会让选型 / 检查点的问题数变化，不符合「选型结论不受影响」）。
## 2026-10-22 M5Dial 转环 / Core2 触摸键 / 编码器分片（G-06）
- 决定：Dial 转环在网页复用台灯编码器交互（`ctx.encoder` 加 `btn` / `grab` / `occl`），按下走板键 A（G42）而不是编码器开关（预设 `sw` 为空，真机按屏即 A）；Core2 A/B/C 点按 = 屏外触摸点 (53 / 160 / 267, 255)。worker 的触摸坐标改为夹到 12 位（与 `tb_touch` / 脚本 `touch=` 相同），各触摸芯片模型自己再夹到屏幕；网页屏幕上的触摸仍在 pick 里按屏幕夹。CLI / simrun 的 1 ms 分片条件由「有 `--encoder`」改为「核心已挂编码器」（含 `--board m5dial`）。
- 原因：Core2 按键区在 y ≥ 240，原先 worker 夹到 239 就点不到；分片规则以「仿真里有什么」为准，两边同一判断，避免以后板预设编码器在 10 ms 下与网页实时（恒 1 ms）分叉。实测 Dial 演示固件 10 ms / 1 ms 输出一致，现有 accept 期望不变。
- 参考：M5Unified（MIT）`M5Unified.inl` 触摸按键判定（y ≥ 240 − 按键高度，键号 = x·614 >> 16），只读未抄。
- 备选：Core2 触摸键单独走 GPIO 事件——否：真机就是触摸芯片报点，固件判定，走触摸才能和 CLI `touch=` 回放一致。

## 2026-10-22 INA219 / DS3231 / AHT20 接进网页（G-09）
- 决定：三块 I2C 模块作为「桌面平放模块」（与 DS18B20 等教学零件同一路径）放在开发板旁，杜邦线接 3V3 / GND / SCL / SDA，而不是插面包板：ZS-042 宽 38 mm，竖插会占满半块板。wasm `i2c_kind` 加 14 = ina219、15 = ds3231，与 `web/src/i2cdevs.ts` KIND 同步；AHT20 在 G-09 前网页也没有，一并接入（示例需要）。
- 决定：c3-i2c-trio 固件在 `TRYBOARD_OK` 之后每秒打印一行 `live: aht20 T=.. C  H=.. %, ds3231 .. C, ina219 .. mV .. mA`：原固件约 5 s 结束，「拖温度后 DS3231 跟随」会变成竞速。名字小写以避开 accept 正则；`T= / H=` 让网页环境卡的「固件读数」能读到（session.ts READING 的 P 改为可选）。
- 决定：INA219 模型改为按一次转换锁存分流 / 总线读数（`sampled_at`，一个转换时间内的读取都返回同一组值），不再每次读寄存器都重新采样。原因：网页 / `--inputs` 回放时片段更细，电气模型的 USB 电流在读分流和读电流之间变了，固件的 `cur == shunt` 检查 0/4；真片的电流寄存器由同一次转换的分流值算出。单测改为先 `set_load` 再读、换负载后推进时间，另加一条「一次转换内读数一致」。
- 决定：可信度面板里 INA219 标「行为模拟」（电流来自电气模型估算），AHT20 / DS3231 标「仿真」；元件库 `parts.ts` 的 `sim` 字段不在本项改，留给 G-08 统一核对。
- 备选：放宽固件 `cur == shunt` 为容差——否：是削弱验收；让网页按大片段跑——否：网页帧节奏固定，且 CLI 回放也会碰到。

## 2026-10-23 红外自发自收用已有回环，不新加光路（G-15）
- 决定：同一实验台上同时有红外 LED 和接收头时，沿用 `IrLink` 的 loopback（`machine::ir_attach` 恒开，rx / tx 都在即生效），LED 发出的 20–60 kHz 载波包络（RMT 边沿或 LEDC `feed_carrier`）延迟后驱动接收头输出；不建距离、角度、遮挡，示例说明里写明。
- 备选：新加「LED → 接收头」耦合件或距离模型——否：现有回环已覆盖，esp32-ir 早已在用；距离 / 角度等真需求再做。

## 2026-10-23 G-08 选型可信度核对

- 决定：零件标「仿真验证 / 行为模拟」的前提是网页能跑——wasm 有模型，且有示例或作品在网页可开。网页可跑集合 = `web/src/i2cdevs.ts` KIND ∪ `firmware/examples.json` 场景零件类型 ∪ `boards.rs` 预设 / Grove 器件；只在 `make_i2c` 里的器件（现有 bmm150、pcf8563 别名、sht31/35/41/45 别名）是「仅 CLI」，结论为「必须上真机」，标签加「（命令行可模拟）」。
- 决定：规则落在 `web/src/trust.ts`：`ADVISOR_RUN`（选板零件 → 网页模型）、`PART_CONF`（实验台表从 `bench/ui/conf.tsx` 移来，纯 .ts 便于单测）、`capConf`（结果卡 trustRows 用）、`trustProblems`（单测用）。`web/test/trust.test.ts` 从仓库源码现算集合，不手写清单；故意把一个 CLI-only 器件标仿真必须报出。注意：单测把 wasm KIND 成员也算网页可跑（ws-amoled216 板经它挂器件），「有示例」这一腿靠 examples.json 场景类型核对——目前 ADVISOR_RUN 的模型都是场景类型。
- 决定：选板声明不得高于实验台同一零件等级；首跑报出 buzzer、servo（full > 实验台 行为模拟），两者改 partial。
- 决定：板预设 note 含 inferred / assumed / unchecked / heuristic / estimated 的项写进 `BOARD_DEVS[id].check`，`verified: false` 写 `unverified`；板属性面板（预设选择下方）逐条显示「需真机确认」，即使 verified: true。单测读 boards.rs 保证同步。
- 未改：元件库 `catalog/parts.ts` 的 ina219 / aht20 / ds3231 等 `sim.level = none` 是低报不是夸大；改它会打开 `place.ts` 从元件库放上实验台的路径（还要 SCENE_TYPE 等），另立项。
- 备选：在 check_config.py 里做校验——否：可信度表都在 TS 里，Python 侧要重写解析；网页运行时读 boards.rs——否：网页拿不到 Rust 源，改由单测保证同步。

## 2026-10-23 M5Dial 蜂鸣器出声（G-13）
- 结论：M5Unified 在 Dial / DinMeter 上 `spk_cfg.pin_data_out = G3, buzzer = true, magnification = 48`（`M5Unified.inl`、`utility/Speaker_Class.inl`，MIT，只读未抄）：不是 LEDC，而是 I2S std 16 位立体声、只接 DOUT，每个 PCM 样本变成一个 32 位 1 位 ΔΣ 字（两个 16 位槽）。BCLK / WS 不出引脚。
- 决定：复用 MAX98357A 喇叭汇（`Max98357a.buzzer = true`），每帧两个槽字 popcount 得密度 → 单极性 PCM（密度 × 满量程，管脚低 = 蜂鸣器无电流，静音即 0），采样率就是 I2S 帧率（48 kHz）。CLI `--audio-wav` / 报告行、wasm `tb_audio_*`、网页 Web Audio 全部原样复用；预设新字段 `buzzer: Option<u32>`；电流估算 `BUZZER_I` 30 mA × RMS（估计，无器件手册）。
- 决定：报告行 `[tryboard] I2S buzzer ...` 只在电平变过（`sounded`）后出现：M5.begin() 起 I2S 就一直发恒定空闲电平，否则所有 Dial 用例的 golden 都会多一行。现有 `arduino-m5-dial-demo` 按 BtnA 时固件本身调 `tone(2000, 100)`，现在真的被听到，golden 多一行报告（唯一差异，已核对）。
- 决定：网页 `BoardDevs.sound`（目前只有 Dial）控制声音开关；worker 在板预设挂了声源时（`tb_audio_stat(0)` 非 NaN）也取 PCM，CoreS3 的 AW88298 预设因此也会把 PCM 送到主线程，但没开声音开关（CoreS3 不在本项范围，未验收）。
- 局限：不是逐位波形，ΔΣ 高频噪声与蜂鸣器谐振 / 响度未建模；作品结论标「行为模拟，响度需真机」。
- 备选：按 I2S 位流逐位输出到 GPIO 电平（`--trace-io` 能看到每一位）——否：48 kHz × 32 位 ≈ 1.5 M 事件 / 秒，开销大且听感一样；做成 LEDC / PWM 蜂鸣器——否：与 M5Unified 实际驱动方式不符。

## 2026-10-23 经典 ESP32 PDM RX 半字成对颠倒（G-12，M5-13 遗留）
- 决定：`core/crates/esp32/src/i2s.rs` `encode_rx` 去掉 PDM 豁免：16 位 RX 只要 `rx_msb_right = 0` 就把 FIFO 里每对半字互换，PDM 与标准模式同一条规则（按位建模，不看是哪个固件）。单测 `pdm_rx_writes_mono_pcm_and_eof` 两种位状态都测：`rx_msb_right = 0` 时样本 1,2,3,4 写成 2,1,4,3，置 1 时保持 1,2,3,4。
- 依据：① 运行时寄存器对比：IDF esp32-pdm-mic 与 M5Unified（StickC Plus2）写进 I2S0 的 CONF 都是 `0x00010120`（rx_msb_right = 0）、FIFO_CONF 都是 `0x00111820`（16 位单声道），只差 rx_chan_mod（2 / 1）和 DSR16；rx_chan_mod 只选留哪个槽，改变不了同一 FIFO 字里两个相邻时间样本的先后，「只有右槽颠倒」的假设不成立。② IDF 自己：`i2s_hal_pdm_set_rx_slot`（HW v1）固定 `rx_msb_right = 0`；标准模式默认配置对 16 位置 `msb_right = true`（`i2s_std.h`），即 IDF 用这一位修正半字顺序，只是 PDM / 内置 ADC 路径（`i2s_legacy.c` `i2s_adc_set_slot_legacy` 同样清 0）没修。③ M5Unified `Mic_Class.inl` 约 768 行注释写明已在经典 ESP32 真机验证并换回。此前的 PDM 豁免让未修正的 IDF 例子显示 1000 Hz、让真机验证过的 M5Unified 出错，方向反了。依据只有 IDF（Apache-2.0）源码、M5Unified（MIT）源码和运行时寄存器对比，未查 TRM 原文：IDF `i2s_hal.c:159` 注明 tx_msb_right 实测与 TRM 描述相反，故这一位不以 TRM 文字为准；未看 GPL 的 QEMU I2S。
- 最小复现：新 `tools/audio/saw50.wav`（50 Hz 上升锯齿）+ 新草图 `firmware/arduino/m5-mic-order`（StickC Plus2 / Core2，统计 0.1 s 录音后半段「对内上升」的样本对）。旧模型 3/400（全反），新模型 397/400（3 = 锯齿回落）。不要用相邻样本整体单调来判：M5Unified 每对样本才更新一次直流偏移（高通），锯齿输入在对与对之间会回落，只有对内差值不受影响。
- esp32-pdm-mic 不回退：例子按 IDF API 写，真机上同样拿到颠倒样本；改为读取后像 M5Unified 一样把每对换回（main.c 注释说明），频率仍 1000.0 Hz。新模型 + 未改的例子 = 3005.5 Hz，即真机上未修正 IDF 程序应有的表现（未在真机校准）。
- golden 差异（219/224 一致，其余逐条）：esp32-pdm-mic——固件重编，版本串 / 编译时间 / ELF SHA / idle hook 地址变化，RMS 0.3531 → 0.3530；用未改源码在旧模型上重编同样得到 0.3530，属重编产物。arduino-m5-stickc-demo-stickc_plus2 `freq=1040 → 1000`、-core2 `freq=3000 → 1000`：旧值是颠倒样本的过零计数，新值与 1 kHz 测试音一致，两例 accept 加频率数值检查（1000 ± 20）。新用例 arduino-m5-mic-order-stickc_plus2 / -core2 无旧快照。合并后需 `tools/golden.py save` 重存。
- 备选：只对 rx_chan_mod = 1 颠倒——否：无硬件机制支撑，属对草图特判；保留豁免、改 M5 期望——否：与 M5Unified 真机结论相反；把 esp32-pdm-mic 期望改成 3005 Hz——否：那是未修正程序的输出，不该当正确例子。
- 遗留：S3（HW v2，`soc/src/i2s.rs`）不受影响，M5Unified 在 S3 上也不换；ESP32-S2 同为 HW v1，无板可验证。

## 2026-10-23 温湿度上云网页流程（G-05b）
- 决定：`templates.ts` 的 SCENE_TYPE / toScene 加 aht20（与 oled / bme280 同形：addr + sda + scl），c3-cloud 示例 `scene.parts` 填 AHT20 0x38 SDA6 / SCL7 并开 env 控件；目录件 aht20 补 `sim: verified`（G-09 已有网页模型，采购页原显示「需真机」不对）。
- 决定：作品 cloud 只有产品页、没有组装模板，先用 worktpl 的 PRODUCT_ONLY（同 G-04b 做法）出 2D 产品；组装步对「有产品无模板」的作品显示占位卡片 + 「下一步：产品」，不再提示去气象站。3D 成品 / 组装留 G-05c。
- 决定：产品页 / 首页卡片的「云端改间隔」都走 `mqttPub('pub,tryboard/cloud/cmd,interval=N')`，和网络页签 MQTT 面板同一路径，所以进输入日志、可 `--inputs` 重放；不另造通道。
- 决定：产品页中途挂载时 Wi-Fi / MQTT 行早已打印过，见到「发布 #N」即视为已连 broker、已订阅，避免误显示「离线」。
- 决定：产品页线束面板的 Wi-Fi 行按采购模板 `firmware.wifi` 判断，cloud 不再显示「本项目不用 Wi-Fi」。
- 备选：给 cloud 先做 3D 产品（工作量属 G-05c）；另开 cloud 专用命令通道（会绕过输入日志，不选）。

## 2026-10-23 成品板作品怎么走四步：Dial 计时器（G-16a）
- 决定：M5Dial 是成品板（屏、触摸、旋钮、按键、RTC、蜂鸣器都在壳里），作品四步照走、只换内容：**采购**只买板子 + USB-C 数据线（模板 `dialtimer`：required = m5-dial + 数据线，suggested / wiring 为空；面包板 / 杜邦线是否仍被 `ALWAYS` 自动加入由 G-16b 处理，阶段一不改采购逻辑）；**台面**直接用板子预设 `--board m5dial`（检查点 args 带它），没有接线步骤；**组装**不是接线，而是桌面支架 / 外壳（关卡 dialtimer-4 的 buy 写"Dial 桌面支架（可选）"），3D 在 G-16c；**产品**页 = 能转能按、能听到蜂鸣的 Dial（G-16b）。
- 新零件 `m5-dial`（board，sim verified，model m5dial；放在 `catalog/aioboards.ts` 的 `M5DIAL`，芯片取 `AIO_CHIP.m5dial`，因为 parts.ts 已到 lint_size 1500 行上限）：引脚只列 5V / GND 和两个 Grove 口（Port A G13 / G15、Port B G1 / G2），板内 GPIO 进 `onboard`；WS1850S RFID、电池充电、尺寸未核对，写在 todo。顾问 `catalogmap.ts` 不改：顾问板子表里没有 M5 系列，加板子属顾问数据，不在本项。
- 计时用 `millis()`，不用 BM8563：网页 simrun 不支持 `rtc=` 脚本动作，关卡要两边指纹一致；一分钟倒数在模拟里跑 62.4 s（墙钟约 5.5 s）。同理关卡里按键用 `gpio42=0 / 1`（与 CLI `btn=A` 等价、两边都支持），accept 用例保留 `btn=A`。
- 新增检查项 `audio {freq, tol, min_rms}`（check.py + web checks.ts，同一套判定）：从 stderr 的 `I2S speaker / buzzer … RMS … freq …` 行读取；这一行只追加给判定，不进指纹，所以已有关卡指纹不变。网页 simrun 读 `tb_audio_report()`（先取长度再读缓冲，否则读到旧内容）。
- `audio.rs analyze()` 改频率算法：只统计 ≤ 20 ms 的相邻上升过零周期（`freq = 周期数 × 采样率 / 跨度`），不再用"过零数 / 总时长"。原因：间歇蜂鸣（响 200 ms、停 200 ms）把静音段算进时长，2 kHz 读成约 1 kHz。连续音（已有用例）结果不变，新增单测 `analyze_beeps_ignore_gaps`。
  - 合并后 golden（G-16a 合并，2026-10-23）：s3-xiaozhi-lite / -hello-timeout / -abort 的 I2S 喇叭 `freq` 读数变化（如 31x → 34x Hz），语音合成音不是连续单音，过零周期统计口径变了；帧数 / RMS / peak 不变，按本项改动 `golden.py save`。
- 顺手修 npm 包 `packages/tryboard` 的 `check --level`：原来没把关卡的 `board` / `grove` 传进 SimJob，板子预设被忽略（所有 M5 板关卡在 npx 下都跑在裸板上）；现在与网页一致。
- 许可：M5Unified / M5GFX 已在 LICENSING ✅（MIT），build_web 为 arduino-* bin 附 BUILD_INFO；公开部署前仍需核对 M5GFX 字体声明进 NOTICES（同 M5 其他例子）。
- 备选：用 BM8563 计时——否：网页不支持 rtc=，且计时器不需要日历；只在 CLI 验收、关卡不判声音——否：作品卖点就是"到点会响"，必须可判；把蜂鸣做成连续音以迁就旧算法——否：真实计时器是间歇响。

## 2026-10-23 AMOLED 桌面时钟（G-17a）：成品板四步、温度源、BLE 对时
- 成品板作品的四步（第三轮开头要求先记）：采购 = 板子 ws-s3-touch-amoled-216 + USB-C 数据线（件库暂无此板的支架 / 外壳件，留给 G-17c，不硬塞别的外壳）；台面 = 直接用 ws-amoled216 板预设（屏、触摸、PMU、RTC 都在板上），不上面包板，模板 wiring 为空，示例 scene 只有 board；组装 = 支架 / 外壳，归 G-17c；检查点只用串口 expect + `lcd_colors`（已有判据，check.py / checks.ts 都不加新判据）。
- 表盘用纯色矩形拼七段数码（#40C8FF，LVGL obj 不抗锯齿），不用大字号字体：像素数和重心可精确判（04:00 = 24016 px，09:41 = 20032 px），时间错了就对不上；秒数、日期等文字不参与判定。与 G-07 一致只做跳秒，不做扫秒针。
- 温度页选 S3 内部温度传感器（esp_driver_tsens），不选 AXP2101：AXP2101 模型的结温寄存器 0x3C 只是占位常数，读数不随任何东西变；TSENS 在 CLI 读数 25.0 °C（静态），页面和示例简介都写明测的是芯片结温，不是室温。
- BLE 对时成功，不需要串口降级：NimBLE 服务 0xFF10、特征 0xFF11（READ | WRITE），写 4 字节小端 epoch 秒，按本地墙钟时间写进 PCF85063（不做时区）；长度不对返回 INVALID_ATTR_VALUE_LEN。虚拟手机 2.5 s 写入即回 `write FF11 ok`，读回同 4 字节。
- 共享代码：`bootOptions`（web/src/checks.ts）原先把 `--spi co5300` 当成无屏、不解析 `--battery`，npx / 网页跑检查点时屏和电量都与 CLI 不同；改为透传 co5300、解析 `--battery pct[,usb]`，verify.ts 与 npm cli 把 battery 放进 job。已有检查点都不用这两个参数，旧指纹不变。
- 备选：用 Montserrat 大字号画时间——否：抗锯齿边缘让像素数随字形浮动，判不准；AXP2101 温度——否：见上；`--rtc` / `--ble-phone` 放进检查点参数——否：网页没有这两个开关，改用脚本动作 `ble=scan / connect / write`，CLI 与网页共用。

## 2026-10-23 合并后修复（G3fix）：草稿首页卡片、手机作品菜单被遮挡
- 首页卡片：`WorkDef.card` 加 `draft?: boolean`，`HOME_WORKS` 过滤掉 draft。dialtimer 的卡片文案（G-16a 已写好并翻译）保留但标 draft，等 G-16b 网页流程完成再去掉；amoclock 没有 card，本来就不上首页。`card` 只被首页和 `relatedWork`（同样走 HOME_WORKS）用到。
- 手机作品菜单：菜单原本渲染在顶栏里，顶栏 `fixed z-20` 自成层叠上下文，菜单的 z-30 压不过底部面板 / 工具栏（z-24…27）；作品增加后菜单变长，下半部分（空白实验台等）落在面板之下点不到。改为手机端像 FwMenu 一样 portal 到 body（遮罩 z-40、菜单 z-50），高度放到 `100dvh-3.5rem` 并保持可滚动；`usePop` 加 `panelRef`，portal 出去的面板仍算"内部点击"。
- 备选：抬高顶栏 z-index——否：会盖住 z-30/40 的其它弹层；只缩短 max-h——否：底部面板高度可变，仍会被盖。

## 2026-10-23 AMOLED 时钟网页流程（G-17b）
- 产品页先做 2D（`views/amoclockproduct.ts`，走 worktpl `PRODUCT_ONLY`，同 cloud）：480×480 帧画在屏上，屏幕指针拖动映射成 `touch=` / `release`，侧边 PWR = `pwrkey=short`；3D 成品与支架等 G-17c。采购只放成品板 + 线：件库没有支架件，按 G-17a 的决定留到 G-17c。
- 手机对时：产品页按钮依次发 `ble=scan`，等看到 `TryBoard-Clock` 再 `ble=connect`，连上且 GATT 读完后 `ble=write ff11 <4 字节小端>`，全部进输入日志，可 `--inputs` 重放。固件用 `gmtime` 无时区，所以手机发的是本地时间当 epoch（`Date.now()/1000 - tzOffset*60`）。
- 为复用通用接口：`ProductHandlers` 加可选 `touch` / `pwrkey` / `sync`；首页卡片 `LiveCfg` 增加 `touchInt` / `battery`（从 `BOARD_DEVS['ws-amoled216']` 取）。逻辑放在 `steps/amoclock.tsx`，productStep 只加单行钩子（lint_size 不增长）。
- 备选：直接做 3D 产品页——否：支架 / 外壳在 G-17c 才定，先 2D 保证流程可走通；手机按钮一次只写 FF11——否：未连接时写不进去，按真实手机流程扫描 → 连接 → 写。

## 2026-10-23 Dial 计时器网页流程（G-16b）
- 采购 / 台面不改代码：采购模板 `dialtimer` 只列 m5-dial + 数据线，`ALWAYS` 面包板 / 杜邦线没有被加进来（agent-browser 实测只出这两件）；台面直接从示例 scene 加载 m5dial 预设（屏、触摸、旋钮、G3 板载蜂鸣器）。
- 产品页：还没有装法模板（G-16c 才加支架），照 cloud 的做法在 `views/worktpl.ts` 的 `PRODUCT_ONLY` 里给 dialtimer 一个只有成品视图的模板；G-16c 加进 TEMPLATES 后这条 fallback 不再生效。因此产品页仍显示通用的"参考成品"横幅（与 cloud 相同），等 G-16c 有装法后自然成立。合入 G-05c 后 cloud 已进 TEMPLATES，`PRODUCT_ONLY` 只剩 dialtimer。
- 3D：`app/dial3d.ts` 直接复用台面的 `bench3d/m5shell.ts`（`m5Shell('m5dial')`），屏幕网格换成 240×240 DataTexture 喂 GC9A01 帧；不另建模型。交互：拖动 / 滚轮在橙色环上 = 编码器步进（横向 14 px 一格，与台面一致），环上短按（< 600 ms、无步进）= BtnA（G42，按下 100 ms 再松开，M5.update() 才能看到两个边沿），点屏 = 触摸（uv → 面板像素）；蜂鸣时环上方点光源发亮。无 WebGL 时用 `views/dialtimerproduct.ts` 的 2D 俯视图，同一套输入（环拖动每 15° 一格）。
- 手机产品键：开始 / 暂停、+1 分钟、−1 分钟、取消（点屏），id `p-dial-*`；桌面右栏同样四个按钮 `pDial-*`。都走台面同一条输入路径（gpio42 / enc / touch），所以进输入日志可回放。
- 手机产品键一行最多 5 个（`mobile.tsx` PhoneToolbar，原来 4 个）：Dial 是唯一有 4 个产品键 + 声音的作品，换成两行后底部面板变高，3D 视图只剩 333 px（< 屏高 45%，mobile.mjs「3D fullscreen」失败）；其它作品都 ≤ 4 个，不受影响。手机上取消键叫「取消」，桌面按钮仍叫「取消（点屏幕）」。
- 首页卡片去掉 draft；卡片 demo 12 s 循环：1 s 转一格、2 s 按 BtnA 开始、8 s 点屏取消。
- 声音验收用 analyser：产品页开声音后 1 分钟倒数（1× 墙钟约 60 s）到点，`__tbAudio.pcm.rms` 峰值 0.47。
- i18n："Paused" 从 app 组（lab.ts）移到 site 组，因为首页卡片也会显示计时器状态（R-20 分组测试要求）。
- 备选：产品页用 SVG 平面图——否：brief 要求 3D 可转可按；为产品页单独建 Dial 模型——否：与台面外观会分叉，m5shell 已按实物尺寸生成。

## 2026-10-23 温湿度上云加「手机配网」检查点（G-05d）
- **固件流程**（c3-cloud，配网门户放在 `main/prov.c`，照自家 C-02 固件 c3-softap-prov 写）：开机读 NVS 命名空间 `prov`，有 ssid 就直连；没有就开开放热点 TryBoard-Setup（192.168.4.1，配网页 + DNS 劫持）等 **1 秒**：有手机连上就等表单 POST → 存 NVS → 关热点 → 连 MyHome（192.168.5.100）→ 照旧上 MQTT；1 秒内没手机就关热点、连出厂网络 TryBoard-WiFi（192.168.4.100）。配网得到的网络连续 3 次连不上就清 NVS 并重启，重新开热点。
- **为什么要「出厂网络」兜底**：cloud-1..4 原判定（3 秒内 192.168.4.100、CONNACK）不变，且这些检查点没有手机、每次都是空 NVS；只按「无凭据就开热点一直等」会让 cloud-1..4 全挂。1 秒窗口是为了让 cloud-2 的 CONNACK 仍在 3 秒内（实测 2.70 s，原来更早）。真产品一般无限期等手机，这里的短窗口是模拟器课程的妥协，新检查点的 brief 写明了。
- **不用 APSTA**：热点与默认虚拟路由器都在 192.168.4.0/24（DECISIONS C-02），APSTA 会冲突；改 AP 网段要动手机侧地址假设，否掉。broker 仍写 192.168.4.1：虚拟网络对任何目的 IP 的 TCP 都应答（net.rs），配网后从 192.168.5.100 经网关照样连得上，且热点已关、不会被芯片自己的 AP 接口截走。
- **检查点顺序**：新检查点 id `cloud-prov`，放在 cloud-1 之后、cloud-2 之前（works.ts 与 levels.json 同序）。理由：先学会 station 连网（cloud-1），再学「不写死凭据」的配网，之后的 broker / 发布 / 命令都与网络来源无关；放 cloud-1 之前要先懂 station 才能懂「配完切 station」，不顺。不改名 cloud-2..4，免得进度存档、模板（templates.ts level cloud-4）和 golden 跟着变。
- **检查点输入**：用脚本动作 `0:phone=join,TryBoard-Setup; 0.5:phone=open; 1:phone=post,,ssid=MyHome&pass=12345678`（网页与 CLI 共用，同 softap-prov-script）；accept 用例 `c3-cloud-prov` / `c3-cloud-prov-badpass` 用 `--ap-phone --ap-post`。
- **指纹 / golden**：c3-cloud 固件变了，cloud-1..4 指纹与 c3-cloud 相关 golden 随之变化（串口多出热点三行、IP 晚约 1 秒，CONNACK 1.70 → 2.70 s，unimpl 计数随之变），判定不变；golden 229/233 一致，只有 c3-cloud 变（其余是 3 个新用例没有快照），应用层串口除上述三行外逐行相同。新指纹（网页 = CLI）：cloud-1 / cloud-2 ce8e·2bf8，cloud-prov afc2·4bc3，cloud-3 f577·4720，cloud-4 a9ab·c878。
- **台面重新配网（长按 BOOT）**：1 秒窗口过后网页上的手机就搜不到热点了，台面「重新上电」又会把 flash 还原。所以加长按 BOOT（GPIO9）1 秒：清 NVS `prov`、写一个 `wait` 标记后重启，重启后读到标记就开热点**一直等手机**（标记读完即删）。台面 3D BOOT 按住 1 s 或产品步骤的「用手机重新配网（长按 BOOT）」按钮（按住 1.6 s 并打开虚拟手机）触发；accept `c3-cloud-reprov` 用 `gpio9=0/1` 覆盖。重启前先停 MQTT、关掉重连，免得串口出现「Wi-Fi 断开 / MQTT 出错」噪声。
- **首页卡片演示**：首页 cloud 卡片原来在仿真 6.0–6.1 s 的窗口里发 interval=2；固件晚 1 秒订阅后，帧慢时会错过窗口（levels.mjs 实测失败），改为 6 s 后、已订阅且未收到命令时每 2 s 重发一次。
- 备选：编译期写死凭据、只靠长按 BOOT 进配网——否：不是「无凭据时配网」（长按 BOOT 只是台面上的补充入口）；预烧 NVS 分区——否：学员自己编的固件没有这一步，网页也得另做。

## 2026-10-23 AMOLED 时钟装法与 3D 成品（G-17c）
- **装法影响仿真**：模板 `amoclock`（支架 70×60×55 mm、后仰 15°，件：支架 / 钢配重 / 板 / USB-C / 前框）从 worktpl 的 PRODUCT_ONLY 挪进 TEMPLATES（dialtimer 不动，归 G-16c）。钢配重两个位置：A 放底座槽（离天线 40 mm，无影响）；B 粘在板子背面、压在 S3 天线上 → `effects.antennaDb = 45`（同 harness `OBSTACLE_DB.metal`）。asmstate.summarize 与组装复测取 `max(模板, 线束滑块)`，复测按 `--antenna-loss 45` 跑 amoclock-4 → 手机连不上、对时失败。templates.ts 不 import harness（会把线束文案拖进首页的 i18n 分组），写常量 `STEEL_DB = 45` 并注明出处。
- **BLE 也吃天线损耗**：原来 `--antenna-loss` 只作用于 Wi-Fi。虚拟手机 `loss_db` 由 `Machine::ble_phone` 每次动作时从 harness 带入（`Ble::phone_cmd_through`）；手机听到的 RSSI = 名义 -52 dBm − 损耗，低于 Wi-Fi 同一扫描门限 -92 dBm 就收不到广播（连接报 "no connectable device found yet"），stderr 记一行 `board antenna blocked … (estimate)`。45 dB → -97 dBm 收不到，30 dB（电池）→ -82 dBm 仍能连。是行为估算，门限借用 Wi-Fi 的，未经真机标定。备选：在固件侧停广播——否，固件没变，问题在空中；单独给 BLE 一个门限——暂无依据，先与 Wi-Fi 一致。
- **温度页「f C」**：LVGL 的 `lv_snprintf`（`lv_label_set_text_fmt`）默认不支持浮点，`%.1f` 输出成 `f`。改为 newlib `snprintf` 格式化后 `lv_label_set_text`，页面显示 `25.0 C`。新增 accept `amoclock-temp`（滑到第 2 页，温度数字区 #ffb221 像素 1050–1260，新固件 1158，旧固件 452 会判错）与 `amoclock-metal`（`--antenna-loss 45`：广播在、连接 / 对时都没有）。
- **指纹 / golden**：amoclock 固件变了（多一个 snprintf），amoclock-1..4 指纹随之变为 e80c·480a / 8b84·ee03 / 1904·7215 / 1b23·17ca（npx 与 check.py 一致），判定不变；amoclock* 相关 golden 的 CLI 输出（unimpl 计数、温度页像素、指纹）会变，另多 2 个新用例。firmware/build 不进 git：合并到 main 后先 `tools/build_fw.sh amoclock`（旧固件 amoclock-temp 只有 452 px 会判错），再在 main 上重存 `tools/golden.py save amoclock amoclock-swipe amoclock-off amoclock-temp amoclock-metal`。
- **3D 成品**（`web/src/app/amoclock3d.ts`，仿 dial3d.ts）：复用台面 `amoledBoard('ws-amoled216')` 立在后仰支架上，屏幕是实时 480×480 帧；点 / 拖屏 = CST9220 触摸（移动 30 ms 节流），PWR 键帽 = 电源键，桌上手机 = BLE 对时（屏上显示搜索中 / 已对时 / 找不到时钟）；配重按装法显示在底座或板背。无 WebGL 时仍走 2D 产品页。

## 2026-10-23 Dial 计时器装法 / 成品（G-16c）
- 决定：dialtimer 从 worktpl 的 `PRODUCT_ONLY` 移进 `TEMPLATES`（模板 `DIALTIMER`，SVG 装配，不进 `HAS_3D`），零件三件：桌面支架（楔形，托座倾斜 30°、6 mm 围边）→ M5Stack Dial（选择 A 搁在围边上 / B 按进托座）→ USB-C 线；关卡 dialtimer-4 加 `"assembly": "dialtimer"`，pass 文案照 irlamp-4 补"网页另要求装配无警告"。
- 影响仿真的一处：B 时 `effects.ringBlock = true`，`effectScript` 丢掉复测脚本里的 `enc=`（与 irBlock 丢 `ir=` 同一机制），dialtimer-4 的 `0.5:enc=+1` 没了 → 设定 06:00 / 开始 06:00 等缺失 → 复测判"装进去后变了"。产品页同样生效：3D 拖环、2D 视图、手机 / 桌面 ±1 键都走 `dialtimer.tsx` 的 `ringTurn`，被卡住时不发 enc；3D 视图显示提示，装配改变后重建 Dial 场景（`Dial3D.stand`）。
- 3D 成品：`dial3d.ts` 的 `dialStand()` 程序化楔形支架 + 围边（B 时围边画到 13 mm 够到转环），镜头随支架后移；无装配时保持 G-16b 的平放样子。
- 备选：蜂鸣孔朝下贴桌 → 响度降低、dialtimer-3 声音判定失败——否（本项不做）：声音判据只在 dialtimer-3（62 s 关卡），复测关卡是 dialtimer-4；要做得在网页 checks.ts / CLI 两边都对 RMS 加衰减，且没有可依据的衰减数，留作以后；磁吸底座挡住转环——采用同一思路，换成更常见的"打印托座围边太高"。
- 尺寸：M5Dial 外形取 m5shell（45 × 45 × 14 mm，环 r 22），支架尺寸为设计估算，未核对真机。


## 2026-10-23 新手引导课（PLAN H，方向 A）
- 决定：在实验台台面加「新手模式」，课程内容写在 `web/src/app/lessons.ts`（按作品 + 检查点组织，每关 5 步），先做 weather 01 关，再补 02、03；不做独立入门课页（方向 B 待人定）。人 2026-10-23 说「直接开始在本地实现吧，实现并且验证」。
- 默认开关：新访客默认开（目标用户是新人），存本机偏好；现有 webtest 在启动时显式关掉新手模式，行为与之前一致——这是测试前置条件，不是放宽断言；另加新手模式专门的回归。
- 代码行高亮：课程数据手写「事件 → 源码行」（GPIO 翻转 → `gpio_set_level` 那行等），不从 DWARF / PC 反查；界面标「跟着事件高亮」。理由：不需要调试信息进 wasm、零成本；备选 DWARF 行表（真实但要带 .debug_line，首包变大、O2 下行号跳）——以后再说。
- 延时三档：网页内不能编译，改 100 / 1000 ms 用预编的 s3-blink 变体（`BLINK_MS` 宏），代码里的数字点一下换内置固件。备选：在内存里改立即数——否，脆、和真实流程不符。
- 参考：learn-arduino-red.vercel.app 的课程形态（只看交互形态，未拷贝任何代码 / 素材 / 文案）。
- H-01 实现（2026-10-23）：
  - 步骤卡位置：放在右栏属性面板顶部（`shell.tsx` 桌面版面板 head），选中零件的属性仍在其下方；备选：浮在 3D 台面上（挡标注卡和零件，H-02 的引线会打架）、放左栏（左栏已换成步骤列表，太挤）。手机不变（不出课程、不出开关，`lessonCard` 在手机上直接返回 null），留给 H-07。
  - 只在「当前检查点」（第一个未通过的）有课程时出现；关卡已过、custom 作品、没有课程的作品显示原来的检查点卡。开关对所有作品都显示（顶栏），偏好键 `tb-beginner`（'0' 为关，其余 / 缺省为开），`?beginner=0|1` 只管本次访问。每课进度按作品存在 `tryboard-app-lesson:<work>`（JSON `{检查点: 步}`），步数 = 总步数表示完成。
  - 工具条：有课程且非手机时只留 运行 / 选择 / 转视角 / 复位视角 / 按 BOOT +「更多工具」；展开后是完整工具条 +「收起」。PLAN 写的「看电流」没放进来：万用表要先学会点两个测点，放进第 01 课反而多一步；留在「更多工具」里。切换新手模式时如在 万用表 / 尺子 / 接线模式，先退回选择。
  - 顶栏：有课程时「第 N 关 · 标题 + 5 段进度」占四步条的位置，并隐藏搜索框（只隐藏不卸载：createCmdk 只绑定一次 #cmdk 输入框）与网络开关（1440 宽下放不下，新手用不到；组装入口芯片仍在）。开关常驻在 ⋯ 菜单右侧，宽 < 1500 时只显示拨钮。为给开关腾位置，宽 < 1500 时搜索框由 160 px 收到 100 px，关闭新手模式时四步条可见范围与之前一致（对比截图见 Reviews/ab/H-01.md）。
  - 测试前置：66 处 `newPage()` 后加 `evaluateOnNewDocument` 设 `tb-beginner=0`，5 处 `localStorage.clear()` 前置脚本改为清完再设 0（否则顺序上 clear 会冲掉）；这是前置条件，不删不改任何断言。
- H-03 实现（2026-10-23）：
  - 「发生了什么」做成 dock 新 tab，tab 内左右分栏：左事件流、右本关源码 + 跟随高亮。理由：稿子里事件流在步骤卡、代码在下栏，但 dock tab 互斥，要同时看到事件和高亮行只能放在同一 tab；放步骤卡要改 H-02 / H-04 也在改的 `lesson.tsx`。「代码」tab 在课程中也显示本关源码与同样的高亮。备选：步骤卡里列最近 3 条（与并行项冲突，留给后续需要时再加）。
  - 事件行照实列出每个 GPIO 边沿，包括上电 `gpio_reset_pin` 时约 8.9 ms 处的三条（1 → 0 → 1，间隔几十个周期），不合并、不过滤：与 `--trace-io` 一一对应便于对拍，也是真实发生的事；代价是开头三行时间都显示 0.01 s。备选：同一引脚 1 ms 内的边沿合并成一行（更干净，但对拍要套同一规则）。
  - 「运行中」按顶栏运行状态 `bc.run === 'run'` 判断：运行中高亮最新事件对应行，暂停 / 未运行高亮当前步骤的 `codeLines`。

- H-07 实现（2026-10-24）：
  - 手机课程面板并进现有 PhoneDock，不另做第二个底部抽屉：收起（peek）时 peek 区就是步骤面板（标题 + 进度、当前步骤、高亮代码 ≤ 4 行、最近 2 条事件、上一步 / 下一步），高度由 lab.css 按 `body[data-lesson]` 调 `--m-peek`（≥ 300px，台面留 ≥ 240px）；上拉直接全屏，首个 tab「课程」显示同一面板加「动手试试」清单，课程中跳过 half 档。理由：两个抽屉会争同一块屏幕和手势，台面 ResizeObserver 已跟 dock 高度走；串口 / 发生了什么等 tab 仍可在全屏里切。备选：独立 lesson sheet 叠在 dock 上（手势冲突、要再管一套高度）。
  - 手机不换成新手短工具条（`b.lessonTools` 在手机返回 false），保留原 5 键；检查点横幅在课程中隐藏（面板已显示进度）；课程首次出现时镜头对准板子再拉远 3 档。
  - 抓手只有 24px 高，另加 44px「展开」按钮 `#mLessonOpen` 满足触控尺寸。
  - 源码加载拆到 `fwsrc.ts`，面板显示代码行时不必加载代码 tab 的懒加载块。
  - 未做：「看电流」开关和 H-05 演示在手机上没有入口；换固件会重置镜头取景。

## 2026-10-25 新手课 v2（PLAN H-09–H-18）
- 决定：按画布 K2YcvpBtLqLXTyd7XZbEZ4 继续做新手课：先做 H-09 台面只放本课零件，再并行 H-10 自动打勾、H-11 精简，再 H-12 课程地图；之后 H-13 参数卡 + 电学、H-14 信息标签、H-15 课程层、H-16 新课、H-17 原理图。
- 理由：人提出「动手试试不会自动完成」；对照 learn-arduino，差距最大的是反馈不自动、台面零件太多、零件不能改、课太少。自动打勾不自动翻页，避免学员还在看结果时页面跳走。
- 不做 / 待人定：暖色主题（H-18，会改全站配色）、新增界面语言（翻译与维护成本）。参考站只借结构，不抄文字和素材。
- 替代：独立入门课页（方向 B）仍不做。

## 2026-10-25 H-09 台面过滤只在画面层
- 决定：课程零件白名单只过滤交给 3D 台面的 SceneSpec（`wiring.ts` `sceneView`，经 `session.setBenchParts`），`s.scene`、仿真设备、接线表和搭建树仍是全套；第 03 课沿用第 01 课的 LED（课程累加），第 02 课不加零件（BOOT 在板上）。
- 理由：仿真结果与 CLI 指纹必须不变；零件 id 不变，标注卡 / 看电流 / 演示照旧按 id 找目标。
- 替代：改 `s.scene` 本身（会改设备列表、需要重启固件、撤销历史也会记一笔），不做。搭建树精简放到 H-11。

## 2026-10-25 H-12 课程地图的数据放 course.ts
- 决定：12 课常量 `COURSE` 与状态函数 `courseCard` 放在 `web/src/app/course.ts`，`lessonmap.tsx` 只做按钮和弹层并转导出 `COURSE`；第 1–3 课标题显示 `Lesson.title`（「按一下就亮」「小屏幕写字」），与设计稿的「按一下按钮 / 让屏幕说话」不同，以已写好的课为准。手机按钮放在 `MobileTop`（`LessonHead` 只在桌面顶栏渲染）。
- 理由：`node --test` 只剥 `.ts` 类型，`.tsx` 不能被数据测试导入；标题两处写会走样。完成判定：当前作品读实时 `bc.checkpoints`（ok / ref，含分享作品的不同存储 key），其他作品读 `tryboard-app-checks:<work>`；参考固件跑通也算完成，与左栏检查点列表一致。「进行中」= 正打开的这课或步骤进度 > 0。
- 替代：把数组写在 `lessonmap.tsx` 里并让测试解析源码文本（脆）；只在 `LessonHead` 放按钮（手机上没有入口）。
## 2026-10-25 H-10 动手试试自动打勾的取舍
- 决定：信号只勾**当前步骤**的任务；`run` / `view:current` 当作状态，进入步骤时再探一次（已在跑本课固件或已开着看电流的，进步骤就勾上），其余（按 BOOT、点 delay、选零件）是动作，只在当前步骤发生才算。BOOT 次数从进入本步骤起算。
- 理由：任务写在步骤里，学员在别的步骤里误点不该替后面的步骤打勾；但「运行」「看电流」是持续状态，回到该步时要求重新点一遍会显得检测失灵。
- 没法检测的「Find X in the code」「Think: …」「Rotate the view and find the USB-C port」「Follow the SDA and SCL wires」「Pick a word」统一改 `reveal` + `answer`（答案写出行号或结论）；没做「代码面板点到该行即完成」（代码面板没有行点击事件，留作以后）。「Click the LED to change its colour」先用 `select:led:5`（点到即勾，换颜色归 H-13）；「把电阻换成 1 kΩ」标 `prop:led:5.ohm=1000`，how 文案直说「后续更新才能换阻值，先跳过」，H-13 发信号后改这条文案。
- 存储：新 key `tryboard-app-lesson-tasks:<work>`，只存原始检测值 `{v, from}`，文字按当前语言渲染；不与步骤进度 key 合并（beginner.mjs 断言后者格式）。
- 备选：所有步骤都监听信号（误勾多）；完成后自动翻页（设计稿明确不要）。


## 2026-10-25 H-13 LED 压降按颜色、tb_fault kind 3 的 b 参数
- 决定：`elec::fault` 的 LED 拐点电压按颜色取：红 1.8 V（原值不变）、绿 2.0 V、蓝 2.8 V。来源：常见 5 mm LED 规格书 20 mA 典型 V_F（红 ~2.0、绿 GaP ~2.2、蓝 InGaN ~3.0 V）减去模型里 10 Ω 体电阻 × 20 mA 的压降；可信度 = 估算，未在实机校准，卡片上标「估算 · 未在实机校准」。
- wasm `tb_fault` kind 3：`a` = 串联电阻 Ω（0 = 无），`b` = LED 拐点电压，`b ≤ 0` 或 NaN 时按红 1.8 V；`///` 文档没变，`wasm.gen.ts` 重新生成无差异。旧调用（b = 0）结果字节一致，CLI / accept / golden 不受影响。
- 3D 亮度：`sqrt(I / I(220 Ω 红))`，夹在 0.05–1.6；用平方根是因为人眼亮度感知近似压缩，线性会让 10 kΩ 几乎看不见。PWM 占空比逻辑不动，亮度系数只乘在发光强度上。
- 阻值 / 颜色存进 scene 的 PartSpec（`ohm?` / `color`），走 `applyScene`，不直接改 3D 物体，因此可撤销、随作品保存；`wiring.ts` 缺省 220 Ω 统一来自 `LED_OHM_DEFAULT`。
- 备选：在前端写闭式公式算电流（与 CLI 的 elec 求解可能分叉，没选，前端闭式只用于亮度）；Vf 用 20 mA 规格值直接当拐点（与现有红 1.8 V 不一致，会改 golden）。

## 2026-10-25 H-14 课程信息标签

- 决定：LED 电流参数用 H-13 的电学模型（`ledAmps`，220 Ω 红 ≈ 5.7 mA，含 GPIO 内阻 33 Ω 与 LED 体电阻 10 Ω），不用设计稿写死的 6.8 mA；数值随台面阻值 / 颜色实时变，并标「估算」。
- 决定：桌面四个 tab 放在步骤卡上方（同一个 `#lessonCard` 里），手机放进全屏面板（peek 态不放，空间不够）；tab 等宽、文字可换行，英文在 310 px 右栏与 390 px 手机已走查，zh / ja / ko 未逐一截图。
- 决定：点接线表行用 `pick.highlight` + `viewTo`，不用 `b.select`：选中会让 shell 把课程卡换成属性面板，用户就看不到表了。手机上点行后面板收到 peek，让出台面。
- 决定：数据手册类参数只写文档名（ESP32-S3 datasheet / SSD1306 datasheet），不写页码与章节，因为没有逐页核对，不编造。
- 备选：接线表另写一份静态数据（会与台面实际导线分叉，没选）；tab 用横向滚动（日 / 韩文第四个 tab 被截一半，没选）。

## 2026-10-26 H-15 / H-16 课程映射（课号 → 作品 + 检查点）
- 决定：12 课的落点如下；课号与关号解耦，`course.ts` 是唯一顺序来源。

  | 课 | 内容 | 作品 · 检查点 | 固件 |
  |---|---|---|---|
  | 0 | 认识开发板 | basics · 无检查点（找到四样即完成） | 不跑固件 |
  | 1–3 | LED / 按键 / OLED | weather · 01 / 02 / 03 | s3-blink / s3-button / s3-oled |
  | 4 | PWM 呼吸灯 | basics · basics-pwm | 新增 s3-fade（GPIO5 LEDC） |
  | 5 | WS2812 灯带 | lamp · lamp-1 | lamp-strip |
  | 6 | 无源蜂鸣器 | basics · basics-buzz | 新增 s3-buzzer（LEDC 方波） |
  | 7 | 舵机 | weather · 05 | s3-servo |
  | 8 | BME280 | weather · 04 | s3-bme280 |
  | 9 | 电位器 | lamp · lamp-2 | lamp-knob |
  | 10 | USB 键盘 | usbkey · usbkey-1 | usbkey |
  | 11 | 综合：桌面气象站 | weather · 06 | weather |

- 理由：工作台的关卡 UI、选中状态、通过记录都按 `work.checkpoints` 索引（`main.tsx` 93 / 193 / 584），检查点不能游离于作品外；PWM 和蜂鸣器在现有作品里没有对应关，硬塞进 weather 会改动所有非新手用户的关卡流程，所以新开一个只供课程使用的 `basics` 作品（首页与作品切换菜单不列出）。第 11 课选 06 而不是 07：07 没有参考固件，跑不起来。第 0 课没有检查点，「完成」取该课动手任务全部打勾。
- 备选：在 weather 里插新关（改变既有用户的关号与进度，没选）；第 0 课也挂一个固件检查点（这一课不接线、不写代码，硬造检查点没有意义，没选）。

## 2026-10-26 H-17 原理图布局算法

- 决定：原理图不用通用自动布线，用固定网格：U1（开发板）在左，只画台面用到的引脚（3V3 / 5V / GPIO / GND 顺序）；每颗 LED 画成从它的 GPIO 引脚直接引出的一行串联回路（GPIO → R → D → 接地符号），行距 110；其他零件画成右侧一列方框（U2…，标题取 `partInfo().name` + I2C 地址），每根线两端各放一个同名网络标签，不画长线；GPIO 被 I2C 总线使用时网络名改成 SDA / SCL。手机竖排：开发板在上、引脚沿底边每列 76，LED 回路往下挂，方框排在下面、标签在引脚上方。选中直接走 `b.select`，由 steps/bench.tsx 已有订阅同步 3D 高亮，视图状态放独立 store `schUi`。
- 理由：课程零件少（01–03 课最多一颗 LED + 一块 OLED），固定网格保证不交叉、可测（坐标是纯函数输出），也不用加依赖；网络标签是教科书画法，正好讲「同名 = 相连」；电流直接复用 `ledAmps`，与参数卡同一个数。
- 取舍：多颗 LED 或多个方框时画面只会变长不会重排；方框引脚顺序按接线顺序，不按真实封装；只有 LED / 电阻有专用符号，其余零件（按键、舵机、传感器）先画成方框（未知类型也不丢）；画面宽度固定，03 课桌面上文字缩得较小。
- 补充（缩放，2026-10-26 复核）：`view.tsx` `fitSheet` 按纸面实际尺寸（ResizeObserver）在横排 / 竖排两种布局里选能放得更大的那个，缩放取 `clamp(fit, 1, 1.6)`：符号文字 12 单位，所以屏幕上永远 ≥ 12 px，纸面不够时允许滚动而不再缩小；横排只要放得下（fit ≥ 1）就优先，符合设计稿。1440×900 下纸面约 532 × 520，横排 720 / 1040 宽放不下，第 01 / 03 课桌面都走竖排（1.29× / 1.05×），更宽的屏幕才出横排。竖排列距 76 → 64，五根引脚宽 336，390 手机 1:1 放下。说明文字（导线颜色不画 / 同名标签 / 接地）桌面挪到右侧「选中的符号」栏下方，避开浮动工具条。
- 备选：通用自动布线（ELK / dagre 一类，需要 npm 依赖且结果不稳定，没选）；所有零件都用长线直连（03 课就会交叉，没选）；把视图状态放 lessonUi（与 H-15 同时改 lesson.tsx 会冲突，没选）。
## 2026-10-26 H-15 课程层实现取舍
- 决定：(1) 无检查点的课用 `lessonKey(e) = "lesson-<no>"` 作为 `Lesson.checkpoint` 存档键，`lessonFor` 签名不变；完成 = 该课所有步骤的动手任务全部打勾（零任务不算完成）。(2) 下一课按钮 / 上一课按钮跳过未写的课；完成卡优先显示下一节**已写**的课，一节都没有时预览下一节**计划中**的课（黄框照常、开始按钮 disabled），不留空。(3) 跨作品切换走整页跳转 `/app?work=&cp=#bench`，step / wireSel / info / taskUi / benchKeep 随重载归零，不另写重置逻辑；同作品切课在 `bench/lesson.tsx` 清 wireSel、info、3D 高亮。(4) `basics` 用 `WorkDef.courseOnly` 标记，topbar 菜单按它过滤，而不是按空 checkpoints 判断。(5) 顶栏窄屏取舍：12 段进度放在标题下方（两行叠放，不和标题抢宽度），< 2200px 藏「基础课 /」前缀，< 2000px 上一课 / 下一课只剩箭头（aria-label / title 保留全文）；1440 与 1920 宽实测标题完整；手机不在顶栏加按钮（390 宽放不下），课序信息放面板头与完成态。(6) "Lesson {n} done" 的中文从「第 n 关完成」改为「第 n 课完成」（课号与关号已解耦）；"Basics course" 词条从 lab 组移到 site 组（works.ts 被首页引用）。
- 理由：保持 H-12 地图、H-10 任务存储、H-07 手机面板的现有挂点不动；验收里的「对下一个已写的课走跨作品过渡」在 H-15 时不存在（第 5 课 lamp-1 还没写），预览计划中的课能如实展示设计稿的黄框。
- 备选：Lesson.checkpoint 改成可选（牵动 lessonStep / taskUi / body[data-lesson] 多处，没选）；完成卡在没有已写下一课时隐藏（看不到过渡设计，没选）。

## 2026-10-26 H-16 第 7 课（舵机）取舍
- 决定：台面只留 `servo`（05 关判定只看 GPIO4 的 50 Hz 脉宽，固件不碰 GPIO5，不放 LED）；不写 `events`（lessonfeed 不解析 K.PWM，「转到 X°」靠串口日志代替）；脉宽参数分三条来源：代码里 0.5–2.5 ms（code）、SG90 数据手册写的约 1–2 ms 对应 ±90°（datasheet）、实际满 180° 约 0.5–2.5 ms 且两端因个体而异（typical）；电流 0.15 A / 0.7 A 取自 elec::servo 的估算（estimate）；「舵机一动就重启」放在 buyTip 和第 5 步思考题里，指向故障关 fault-power。三个公共测试（course.test.ts courseStep、lessonmap.test.ts 已写课清单、beginner.mjs 课程地图）原来写死「只有 1–3 课」，改成「1–3 必在，其余按 COURSE 推算」，免得每加一课都要改。
- 理由：零件少、讲解只围绕舵机；数据手册与常见代码对脉宽的说法不一致，分开标来源最诚实；给 lessonfeed 加 PWM 规则会改公共接口（`Lesson` 新字段 + 解析），与第 4 / 6 课（也是 LEDC）并行改同一文件易冲突，留给主会话统一做。
- 备选：在 lessonfeed 里加 `pwm` 规则把脉宽换成角度（公共接口，没选，写进汇报）；保留 LED 当参照（与本课无关，没选）。
## 2026-10-26 H-16 第 5 课（彩色灯带）取舍
- 决定：(1) 新增任务完成信号 `strip:<pin>=<n>`（亮灯数 ≥ n 即打勾）：session onTick 收到 `m.strips` 帧时发一次（边沿），bench/lesson.tsx 的 probe() 在本课固件运行时用 `session.frame.strips` 补发（状态，步骤晚于点亮打开也能勾）；只在当前固件是本课 `fw`（或步骤 codeChips 固件）时发，lamp 作品默认固件（STAGE 3）同样点亮灯带，不能替本课打勾。(2) 本课不写 `events` / `i2c`：lessonfeed 只叙述 GPIO 边沿和 I2C，GPIO5 由 RMT 驱动，iotrace 虽有 K.WS2812 事件但 feed 不处理，不伪造。(3) 参数文档名用 `Worldsemi WS2812B datasheet`：`WS2812B datasheet` 已作为字面量出现在首页可达的 catalog/parts.ts，i18n 分组测试要求它在 site 组。(4) 「改一改」一步只用揭示答案任务：没有预编译的换色 / 换亮度固件。
- 理由：最小信号、复用已有 worker 帧数据，不改固件与 wasm；如实标注 feed 能力缺口。
- 备选：从串口「LAMP ON 8」判完成（只证明固件走到那一行，不证明灯亮，没选）；给 lessonfeed 加 WS2812 叙述（超出本课范围，留作后续）。
## 2026-10-26 H-16 第 0 课（认识开发板）实现取舍
- 决定：(1) 板上区域用新的 `PickTarget.spot`（`'usb' | 'chip'`，只在 onPick 时由命中点在板局部坐标里判定），卡片额外发 `select:board@usb` / `select:board@chip`，原 `select:board` 照发，第 1 课「点芯片」不受影响；BOOT 点击会被当成按下，所以「找到 BOOT」用 `press:boot×1`。(2) `taskTarget` 认 3V3 / 5V / GND 引脚和 `@spot`。(3) 入口：left.tsx 在作品没有检查点或 URL 带 `cp=lesson-<no>` 时显示无检查点课的卡；课程地图跳无检查点的课一律整页跳转 `/app?work=…&cp=lesson-<no>`（同作品内没有 selectCheckpoint 可用）。(4) 无固件课：代码讲解页签与代码卡显示「本课不跑代码」，检查点框改成「第 N 课 · 打勾完成」；面包板留在台面上（basics 作品本身的场景，parts: [] 只决定本课接线清单）。(5) 芯片参数放参数页签（数据手册来源），不塞进步骤卡。(6) 已有测试里「第 0 课未写」「每课都有固件 / 接线」的假设按新事实更新（lessons / course / lessonmap 测试、beginner.mjs 地图可开卡 0,1,2,3），没有放宽判定。
- 理由：最小改动地复用 H-10 任务信号与 H-15 课程层；spot 不改已有锚点和投影。
- 备选：给 USB 口 / 芯片做独立的 PickTarget kind（牵动 scene-api 所有消费方，没选）；第 0 课单独建一个只有开发板的作品（作品列表多一项且与 basics 进度分开，没选）。
## 2026-10-26 H-16 第 4 课（呼吸灯）实现取舍
- 决定：(1) s3-fade 用软件分 100 步改 duty（`ledc_set_duty` + `ledc_update_duty` + `vTaskDelay`），不用 LEDC 硬件渐变（`ledc_fade_*`），每步都在 IO 轨迹里留下一个 PWM 事件，check.py 的 `pwm.steps` 和课内事件流都能逐级判；固件为自写，未参考 GPL 代码。(2) 改一改用 `FADE_MS` 宏芯片，变体 s3-fade-1000 / -4000 共用 s3-fade 的 main.c，CMake 里 `FADE_MS=` 编译宏切换，build_web.sh 变体元组加入两者。(3) 事件流新增 `Lesson.pwm`（LessonPwm：pin / text 含 `{pct}` / line / every）：K.PWM 事件在占空比落到 `every`（默认 20 %）整数倍且与上一行不同时出一行，FeedItem 加 `duty`。(4) l4.ts 只从 lessons.ts 引类型，标注 / 连线文案在本文件内写，避免循环引用。(5) course.test / lessonmap.test / beginner.mjs 的「已写课」期望加 4。
- 理由：软件分步让每级占空比都对应一行源码（第 38 行）和一个确定的事件，便于高亮和判定，硬件渐变在模拟器里的逐级表现未核实；宏芯片沿用第 1 课 `*_MS` 的做法。
- 备选：ledc_fade_with_time（事件太少，没选）；每个 PWM 事件都出一行（每 20 ms 一行刷屏，没选）。
## 2026-10-26 H-16 第 6 课「发出声音」（无源蜂鸣器）取舍
- 决定：(1) 蜂鸣器信号接 **GPIO6**：GPIO5 已是第 1 / 4 课的 LED，GPIO6 在 S3 DevKit 排针上紧挨 GPIO5、不是 strapping / USB / PSRAM 引脚，且 build.ts 的蜂鸣器摆位本来就靠近 IO6。(2) basics 台面不改 s3-blink 例程：`WorkDef` 新增可选 `scene`，`session.ts benchInit` / `shareopen.ts` 先用作品自己的 scene 再回落到例程的（lessons.test 的 sceneOf 同步）；basics 台面 = LED@5 + 蜂鸣器@6，第 6 课 `parts: ['buzzer']`。(3) 多音判定：原 pwm 判定只认最后频率；CLI 与网页 simrun 在 `PWM GPIOn steps` 后新增一行 `PWM GPIOn tones 262@t 294@t …`（只记占空比 > 0 的频率，连续相同合并，**只有出现 ≥ 2 种频率才打印**，所以已有关卡输出与指纹不变）；levels.json `pwm.tones: n` 要求至少 n 种不同频率，有 tones 时跳过主行的频率相等判定（check.py 与 checks.ts 对称）。(4) 「发生了什么」：`Lesson.tones`（pin / text / notes / line）把 K.PWM 事件里音高变化读成一行「蜂鸣器唱 do」，静音间隙与持续同音不加行；`FeedItem.hz` 让右半句显示「GPIO6 → 262 Hz 方波」。(5) 「改一改」不预编译旋律变体（网页不能编译），用 reveal 任务给出《两只老虎》的音符列表。(6) 参数：音符频率 / 占空比 / 时长标 code，响度 ~80 dB@10cm 与 2–4 kHz 谐振标 typical（各家模块差别大，不挂具体数据手册）。
- 理由：一课一个新零件且不动其他课与例程；新增报告行只在变调时出现，避免重存 golden。
- 备选：改 s3-blink 例程的 scene（会影响例程页与其他作品，没选）；在 pwm 判定里解析 steps 行求不同频率（steps 只在 ≤ N 次变化时完整，没选）；蜂鸣器接 GPIO4（离 IO5 另一侧、与蜂鸣器摆位不符，没选）。
- 补充：CLI 的 steps / tones 两行挪到 `parts::pwm_steps`（main.rs 的 run 函数与文件行数受 R-14 lint_size 限制，不能再长）；GPIO6 标注的「现在」读数在引脚走 PWM 时显示「{hz} Hz 方波，{pct} % 时间为高」（LEDC 路由后 GPIO 输出寄存器恒为低，原来会一直显示低电平）。beginner.mjs 课程目录一项的期望从「只写了 1–3 课」改为「正好 1,2,3,6」。

## 2026-10-26 H-16 第 10 课「做个 USB 键盘」：对应 usbkey-2，新增 usb 任务信号
- 决定：(1) COURSE 第 10 课的检查点由 `usbkey-1` 改为 `usbkey-2`（「按键打出字母」）。usbkey-2 的判定是「枚举成 configured + PC 打出 abc」，正好覆盖本课两件事；usbkey-1 只要求枚举，没按键课就算完成。(2) lessontasks 新增 DoneSpec `usb:configured` 与 `usb:typed=<文本>`（PC 收到的累计文本包含该串即命中）；新导出 `usbSignals(view, fwName)`，由 session.ts 的 onUsb 和 bench/lesson.tsx 的 probe 调用，只在当前固件是本课固件时发信号（和 strip 信号同一个 `lessonFw` 门，门里补了「fw 非空」）。(3) 不新增固件，复用 usbkey；台面只留 K1–K3（key:4/5/6），USB 走已有虚拟 PC 面板。
- 理由：一课对应一个检查点，课完成 = 检查点通过；信号最小，直接取 UsbView 的 configured / typed。
- 备选：保留 usbkey-1，把打字当课内任务（课完成早于打字，没选）；把 usbkey-1 和 usbkey-2 都挂到第 10 课（COURSE 一课只有一个 cp，没选）；从串口 `KEY n c` 行判定打字（看不到 PC 端是否真收到，没选）。
## 2026-10-26 H-16 第 8 课（BME280）取舍
- 决定：(1) 台面只留 `bme280`，OLED 仍在模拟场景里（weather 作品与 04 关判定都带 ssd1306@0x3c），所以扫描打印 `0x3C 0x76`；第 2、4 步正文如实说明「第 3 课的 OLED 在模拟器里仍挂在这两根线上」。(2) 新任务完成信号 `env:<temp|humidity|pressure>`：环境滑块手势结束（change）与温度数字框 / 预设（setTempNow）时发 `env:<key>=<值>`，起点是手势开始时的值，值不变不打勾；不限本课固件（任何固件下拖滑块都是真实的环境变化）。(3) `LessonI2c` 加可选 `reads`：重复 START 后对同一地址的读与前面写寄存器号合成一次传输并计读回字节，默认关，第 3 课行为不变；规则行指向 `rd()` 里的 `i2c_master_transmit_receive`（第 23 行），保持 lessons.test 的「I2C 规则指向发送行」不变。(4) BME280 速查卡加湿度滑块（原来只有温度，湿度只在构建树「环境」里，被课程步骤面板挡住）。(5) 数据手册数字（地址、±1 °C、±3 %RH、±1 hPa、量程、chip ID 0x60）只标「BME280 数据手册」，不写页码。
- 理由：最小改动复用 H-10 任务信号与 H-03 feed；环境滑块是本课唯一的交互，必须能自动打勾；不加 `reads` 时 feed 会丢掉所有寄存器读（只剩启动时的写）。
- 备选：从串口 `T=` 值变化判完成（要解析串口且固件每秒才打印一次，没选）；把 OLED 从场景里去掉（要改 04 关判定参数，没选）；新写只读 BME280 的固件（简报要求复用 s3-bme280，没选）。
## 2026-10-26 H-16 第 9 课（电位器 · ADC）改挂作品
- 发现：课程映射把第 9 课「电位器」挂在 lamp · lamp-2（ref lamp-knob），但 lamp-knob 用的是 EC11 旋转编码器（PCNT，GPIO6/7/15），lamp 台面只有 `ws2812` + `encoder`，没有电位器，固件也不碰 ADC。按派单内容（分压、0–4095、ADC1 / ADC2、衰减）写在 lamp-2 上，callout 和任务都无法对应真实台面与固件。
- 决定：第 9 课改挂新的课程专用作品 `adc`（`courseOnly`，example `s3-pot`：电位器滑片 GPIO4 = ADC1 通道 3、12 dB 衰减，读数作 GPIO5 LED 的 PWM 占空比），不设检查点（`lessonKey` = `lesson-9`，所有任务打勾即完成，同第 0 课规则）。固件、示例场景与 accept 用例 `s3-pot` 都已存在，不写新固件、不加关卡。lamp-2 / lamp-knob / lamp 作品不动。课程表第 9 课的「台面」文案改为「开发板 + 面包板 + LED + 电位器」。
- 顺带修复：U-07 迁移（5708df9）后 `bench.onPot` 没人注册，3D 里拖电位器不再改模拟电压；session.ts 重新接上（拖 3D → `setAnalog`，滑块 → `setPot` 同步 3D 旋钮，并回写面板滑块）。
- 新任务信号 `adc:<pin><N` / `adc:<pin>>N`：worker 每帧已带固件实际读到的 ADC 原始值（`m.adc[pin].raw`，D-02 读数条用的同一份），session 取最新一个发 `adc:<pin>=<raw>`，仅本课固件运行时发（同 `strip:` 的门控）；任务「拧到底：读数 < 100」「拧到顶：读数 > 3500」与固件打印 TRYBOARD_OK 的两端阈值一致。
- 理由：与 basics 作品同一理由（现有作品里没有对应关）；不并入 basics 是因为 basics 台面来自 s3-blink（只有 LED），第 4 / 6 课在并行改它，换示例会互相冲突。
- 备选：第 9 课按 lamp-2 改讲旋转编码器（课程内容变成 PCNT，课表里就没有 ADC 了，属课程调整，留给主会话决定）；在 basics 加 `basics-adc` 检查点（要换 basics 台面并加关卡与 4 语言关卡文案，与第 4 / 6 课冲突，没选）。
## 2026-10-26 H-16 第 11 课（综合：桌面气象站）取舍
- 决定：(1) lessontasks 新完成类型 `oled:<亮点数>`（session onFrame + probe 补发）、`follow:temp`（setEnv 发 `env:temp` 后，本课固件串口读数与新室温相差 ≤ 0.25 °C 才勾）、`asm:done`（store.assembly 全部放好即发，clean / warn 都算）。(2) `Lesson.buyAll` + lessoninfo `#lessonBuyAll`：参数 tab 汇总已写课程的 buy / buyTip，链接 `#shop`，不另抄 BOM。(3) 电流数字取自 board.rs（芯片 20 mA + 核 12 mA + 板 11 mA）、零件目录 currentMa、ledAmps，测试用正则对照源码防漂移；稳压器 800 mA、GPIO 20 mA 标 datasheet，其余标 estimate。(4) 组装只能在 6 个检查点全过后解锁：课程中 ⋯ 菜单常显「换固件」（原先 >1100px 隐藏、课程又藏了顶栏按钮，无路可达）；left.tsx 全过时若已钉住的检查点有课程，优先显示课程卡（否则解锁组装即被踢出第 11 课）。(5) I2C 叙述 0x76 绑在第 38 行 i2c_master_transmit_receive；固件去抖是 50 ms（brief 写 30 ms，以代码为准）；lab 词条避免裸「OLED」「BME280」键与其它页面冲突，改用「OLED screen」「BME280 sensor」。
- 理由：复用已有 worker 帧 / 串口 / store 状态，最小新增信号；数字与代码同源，防手抄过期；两处 UI 改动都是课程模式专属的可达性修复。
- 备选：课程里直接预置检查点解锁组装（绕过判定，没选）；装壳任务只认无警告（BME280 贴芯片的警告恰是教学点，没选，写进遗留）。

## 2026-10-26 H-16「发生了什么」只讲本课固件（第 8 课 0.52 s 之谜）
- 结论：不是时钟 / 仿真一致性问题。网页与 CLI 的 S3 都按 160 MHz 计周期：s3-bme280 两次读间隔网页 159 999 994–160 000 004 周期、CLI 160 000 004（1 s）；weather 固件网页与 CLI 都是 83 200 002 周期（0.52 s）。0.52 s 来自作品默认固件 weather（打开 weather · 04 时先跑它），在按「运行本课代码」载入 s3-bme280 之前，事件流就按本课规则讲 weather 的 I2C 读，还配本课源码行。
- 决定：`lessonfeed.tsx` 的 pull 只在 `session.fwName` 是本课固件（`lesson.fw` 或代码芯片变体；新 `isLessonFw` 在 lessons.ts，lessontasks 的 `lessonFw` 改用它）时出行，否则跳过事件、显示「还没运行」提示。
- 理由：最小改动，与任务信号已有的门控（strip / usb / oled 只认本课固件）一致；拿别的固件的事件配本课代码行会误导。
- 备选：打开课就自动载入本课固件（改了 H-15 打开即跑作品固件的行为，影响检查点与跨课切换，没选）；CPU_HZ 按芯片取（两边本来一致，不需要）。

## 2026-10-27 H-19 第 0 课不跑固件
- 决定：COURSE 条目带 `noFw`（目前只有第 0 课）且它是当前打开的课时，打开 / 刷新 / 切进来都不启动作品固件；已在跑的停掉。按「当前打开的课程条目」判断（第 0 课的 lessonKey 是 `lesson-0`，不靠 `?cp=`）。同作品 basics 切到第 4 / 6 课时照常启动本课固件。
- 理由：课文写「本课不跑代码」，顶栏 Running + 串口 LED ON/OFF 与课文矛盾；第 0 课只认识板子，任务都是点 3D。
- 备选：继续跑 blink 但把课文改成「板子上的程序在跑」（与课程设计 v3/Lesson0 不符，没选）；给第 0 课一个空固件（仍显示 Running，没选）。

## 2026-10-27 H-20 课程完成规则：任务全勾或检查点通过
- 决定：`entryDone = 检查点通过 || 任务全勾`（无检查点的课仍只看任务）；`CourseCard` 另带 `cpPassed`，地图卡片与右栏完成卡在检查点通过时多标一个 ✓「检查点已通过」。地图与右栏用同一个判定函数。
- 理由：H4 遗留：只点完任务时地图显示「进行中 5/5」，学习者以为没做完；任务本身就是本课的学习目标，检查点是额外的自动验证。
- 备选：维持「检查点通过才算完成」并在 5/5 时提示去跑检查点（多一步，新手不理解检查点，没选）；只认任务、忽略检查点（丢掉自动验证信息，没选）。

## 2026-10-27 H-25 原理图字号与专用符号
- 字号：H-17 收尾（2d8fb75 `fitSheet`）已保证缩放 ≥ 1，本次只实测不改算法：1440×900 第 03 课 12.57 px（scale 1.05），1280×800 第 03 课 12 px（scale 1，纸面滚动），手机 390×844 12.14 px；beginner.mjs 新增 1280×800 断言，按 svg 实际宽度 / viewBox 宽度算字号（不信 data-scale）。
- 符号：`SchSym.glyph`（oled / button / buzzer / servo）挂在原 `kind: 'box'` 上，不新开 kind，原有方框布局、引脚位置、网络标签与 PickTarget 全不变，只换画法：OLED = 模块框 + 深色屏幕 128 × 64（照 v3/SchematicOled）；按钮 = 常开按键（两触点 + 横杆 + 按柄），桌面不画外框、引线从 IN / GND 接到按键；无源蜂鸣器 = 半圆罩 + 两脚，桥在 I/O 与 GND 之间，VCC 只留短引脚（模块内三极管驱动）；舵机 = 模块框 + 圆圈 M + 三线汇入 + 舵臂。手机布局引脚在顶边，符号画在框右侧当示意，不画内部引线。
- BOOT：课里有指向 `button:BOOT` 的提示（第 02 课、第 11 课）时，`schematicOf(..., { boot: bootGpio })` 在板子那一行画 SW1（GPIO0 → 常开按键 → 接地，像 LED 回路），点它 = 3D 同一 `{ kind: 'button', id: 'BOOT' }`（右栏卡片显示 BOOT 参数卡）。手机列宽 64，SW1 标注放在接地符号下方。
- 位号：按钮 SW1…、蜂鸣器 BZ1…，其余模块仍 U2…（原来按钮 / 蜂鸣器也叫 U）。
- 设计稿只有 OLED 的画法；按钮 / 蜂鸣器 / 舵机按通用电路符号自绘（无外部素材）。
- 备选：按钮 / 蜂鸣器做成独立 kind 并重排成内联回路（像 LED）：要改布局与网络标签逻辑、风险大，没选；BME280 等暂无专用符号的仍画方框。
