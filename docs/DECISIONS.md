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
