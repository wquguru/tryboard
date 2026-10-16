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
