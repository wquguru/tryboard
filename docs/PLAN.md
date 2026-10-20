# 实现规划（PLAN）

2026-10-16 定。人已同意：P0 → P2 全自主推进，每批结束汇报一次，不等确认继续下一批；新作品首页替换旧 home.html。
视觉与交互以 `docs/DESIGN.md` 为准；授权以 `docs/LICENSING.md` 为准。
状态：☐ 未开始 / ◐ 进行中 / ☑ 完成 / ✗ 放弃（写原因）。每项完成要满足"验收"一栏，并在 `docs/STATUS.md` 记结果。

所有网页项的通用验收（下文不再重复）：
- `agent-browser` 跑该页主流程：打开 → 按步骤操作 → 截图并用 Read 看图 → `agent-browser console` 无 error → 结果写进 `Reviews/ab/<项>.md`（含截图路径）
- 涉及模拟结果的，网页与命令行指纹一致
- `tools/accept.sh` 全过；`cargo test`、`cargo clippy -D warnings` 干净

## P0 · 主线跑通：气象站从采购走到成品（约 5–6 周）
做完的标志：新用户不看说明，能在网页里把气象站从选零件做到成品；accept.sh 全过。

| ID | 项 | 验收 | 状态 |
|---|---|---|---|
| P0-01 | 统一工作台外壳（左构建树、右属性、底工具条、时间线、⌘K 占位、右上结论按钮、视图方块），四步共用 | 四个步骤页都在同一外壳里，切换不重载模拟；手机宽度只读不溢出 | ☑ `app.html`（组装 / 成品为占位，见 P0-16/17；采购已接，见 P0-07） |
| P0-02 | 构建树 + 属性面板（零件 / 连线 / 供电 / 环境 / 固件 / 检查点；选中联动） | 点树和点台面选中同一对象；属性随选中变 | ☑ 树 → 属性已验；点台面经 `ScenePickApi.onPick` 走同一 selection，等 board3d 实现后自动生效 |
| P0-03 | 时间线回退（编辑操作和每次运行是一步；回到某步 = 确定性重算） | 回到"运行 #2"再前进，指纹与原来一致 | ☑ 2026-10-16：步骤日志折叠出编辑状态 + 按那次运行的输入日志重新上电快进到那一刻（worker `seek` / `snapshot` / `mark`）；回到运行 #2 指纹与收尾时一致，再前进到运行 #4 也一致，命令行 `--inputs` 重放同一日志 check.py 指纹相同；回退后新操作丢掉后面的分支（interact.mjs + agent-browser，Reviews/ab/P0-03.md） |
| P0-04 | 点零件弹快捷卡片（BME280 温度 / 热源 / 量距离；供电线 USB ↔ 外接 5 V；按键） | agent-browser 点击后卡片出现并能改值，读数跟着变 | ☑ 2026-10-16：BME280 卡片（温度滑块 / 把手放上去 +8 ℃ + 热晕 / 量到芯片 58.2 mm）、舵机供电线 USB ↔ 外接 5 V（只改清单和显示，欠压 P1-02）、BOOT 按下 / 松开；卡片跟着台面转（Reviews/ab/P0-04.md） |
| P0-05 | 作品首页（替换 home.html） | 首屏三作品卡、"我有自己的想法"、"已有固件"三个入口都可点通 | ☑ 三卡可跑真实固件、全部入口点通（levels.mjs + agent-browser，Reviews/ab/P0-05.md）；参考价为估算，待 catalog 替换 |
| P0-06 | 元件库 40–60 件（型号、引脚、电压、电流、I2C 地址、尺寸、模拟程度、参考价区间、核价日期） | 数据 schema 校验脚本通过；超 120 天未核价有提醒 | ☑ 53 件（`web/src/catalog/parts.ts`），`schema.ts` 校验 + `stalePrices`；价格均为代理估计 `verified:false`、部分字段待核（见 Reviews/ab/P0-06.md） |
| P0-07 | 采购页：模版（气象站 / 小黄 / 透镜 / 空白）、必选不可去、建议可增减、清单变更时间线、合计、店铺搜索外链 | 气象站模版带出正确清单；去掉 BME280 出现阻断提示 | ☑ 2026-10-16 `app.html#shop`：清单三组、合计参考价、规则检查（一键补）、切模版 / 换板、时间线点回去重放；BME280 去不掉（必选，提示原因），去掉 5 V 电源出现"只靠电脑 USB"阻断 + 一键补回（Reviews/ab/P0-07.md）。价格仍是代理估计 |
| P0-08 | 规则引擎 27 条（每条有来源、正反用例），能一键补零件 | 规则单测全过；"舵机无外接电源"提示并可一键补 | ☑ R01–R27（`web/src/catalog/rules.ts`），`web/test/rules.test.ts` 每条正反用例；规则未经人逐条复核、电流数字为估算 |
| P0-09 | 买完摆上实验台：按清单自动放置并接好线 | 采购 → 实验台后，台面零件与清单一致 | ☑ 2026-10-16 「摆上实验台」按 `toScene` 重摆台面（I2C / 圆屏变了才重新上电），清单换了作品就换到那个作品的工作台；没有舵机电源时供电只显示 USB（欠压演示留给 P1）。从元件库加的件没有默认接线，不摆，提示列出（Reviews/ab/P0-09.md） |
| P0-10 | 真实器材 3D：面包板孔位、排针、PCB 丝印、屏蔽罩、天线、USB-C、按键、RGB、模块 PCB、SG90、杜邦线（按 DESIGN §4） | 截图可辨认针脚和丝印；中端机不卡（headless 只查无报错） | ☑ 2026-10-16（Reviews/ab/P0-10.md；中端机帧率未实测，基线 weather 228 calls / 11 万三角形） |
| P0-11 | 点到针脚：标注、线高亮、属性面板角色与实时值 | 点 GPIO4 显示 50 Hz 与当前脉宽 | ☑ 2026-10-16：点 3D GPIO4 → 属性面板丝印 / 角色 / 50.0 Hz / 脉宽 1.675 ms / 占空比 + 示波器小窗（PWM 合成、I2C 示意、电源估算），构建树"引脚"分组；外壳调 setTheme('light')（Reviews/ab/P0-11.md） |
| P0-12 | 接线规则检查（输出接输出、5 V 接 GPIO、LED 无限流电阻、缺地）→ 线标红 + 说明 | 每条规则一个网页用例 | ☑ 2026-10-16：W1 输出接输出 / W2 5 V 进 GPIO / W3 无限流电阻 / W4 缺地 / W5 I2C 地址冲突（`app/wirecheck.ts`），setWireFault 标红 + 属性说明 + "连线 n 处问题"；三作品默认无问题；元件编辑器造不出这些，用 `?debug=1` 的 `__tbApp.injectWiring` 造用例，每条一个网页用例（Reviews/ab/P0-12.md）。改接 / 拔线时 3D 线不挪，只标红 |
| P0-13 | 尺子（量零件距离，与温漂联动）；运行历史 + 指纹对比 | 两次运行可比较差异项 | ☑ 2026-10-16：工具条尺子点两个目标 → measure（BME280↔OLED 24.4 mm，到芯片时附温漂估算）；运行历史每次上电一条（固件、环境、供电、热源、时长、最后一行、指纹），点两条列差异项（Reviews/ab/P0-13.md） |
| P0-14 | 蜂鸣器出声：LEDC 频率 → Web Audio（模拟时间驱动，默认静音开关），新固件 weather 加蜂鸣器报警 | 用 Web Audio 分析节点读出频率 ≈ 2.7 kHz；固件验收 | ☑ 2026-10-16：accept 用例 weather-alarm；agent-browser 读 `__tbAudio` lastFreq 2700.1、分析节点 peakHz 2695（Reviews/ab/P0-14.md）。3D 蜂鸣器外观归 P0-17 |
| P0-15 | 检查点接进实验台（气象站 6 个，任务书 + 拖入 .bin 验收 + 结论按钮） | 现有 levels.mjs 的用例在新页面全部迁移通过 | ☑ 2026-10-16 核实：levels.mjs 的检查点用例（各作品参考固件过且指纹 = check.py、上传自己的固件 + 进度记住、旧链接重定向）都跑 app.html 并通过 accept.sh；装配一条由 P0-16 组装步骤覆盖（Reviews/ab/P0-16.md），levels.mjs 里装配用例仍跑 index.html 的装配视图 |
| P0-16 | 组装接进外壳（沿用现有装配引擎和影响规则，先 2.5D/SVG 或现有 3D） | 验收全过才解锁；BME280 放芯片旁时复测 ✗ | ☑ 2026-10-16：`steps/assemble.ts`，沿用 SVG 装配引擎；左树装配层、右栏装法影响（估算）、时间线可回退重算、尺子 / 炸开；复测 ✗ → 回退改放 → ✓（Reviews/ab/P0-16.md） |
| P0-17 | 3D 成品（气象站）：能转，灯 bloom、屏幕纹理、舵机、蜂鸣器；拖动 / 按键 / 热源 / 缩放；事件时间线 | agent-browser 拖动后截图角度变化；热源使读数上升并报警 | ☑ 2026-10-16：`app/product3d.ts`（three.js，独立于 board3d），拖动方位角变化、热源 → 报警且 `__tbAudio.playing`、点 3D BOOT → ℉（Reviews/ab/P0-17.md）。小黄 / 透镜先挂 SVG 成品（3D 归 P1-10） |
| P0-18 | 真机到手清单 + 不能模拟的项 | 成品页显示 | ☑ 2026-10-16：成品右栏按作品列三件事（彩灯引脚 v1.0/v1.1、I2C 扫描与芯片 ID、温度标定 / 舵机供电 / 圆屏反色）和不能模拟的项；内容为代理整理，未经人复核 |
| P0-19 | 输入日志带模拟时间（网页交互可重放），网页 / CLI 一致 | 重放同一日志指纹相同 | ☑ 2026-10-16：`tools/webtest/replay.mjs`（已进 accept.sh）：网页实时串口 = CLI `--inputs` 重放（逐字节），网页验收 worker 与 CLI 指纹相同（Reviews/ab/P0-19.md） |
| P0-20 | 第三方授权页 licenses.html（从 SOURCES.md 和依赖清单生成）；页脚声明；3D "外观示意"字样 | 页面列出全部依赖 | ☑ tools/gen_licenses.mjs 构建期生成（Reviews/ab/P0-20.md）；3D "外观示意"字样外壳已有；字体已自托管（P2-19） |
| P0-21 | 旧页面下线 / 重定向（levels.html → 实验台检查点；advisor → 我有自己的想法；index.html 保留为空白实验台；2026-10-17 由 U-07 改为重定向到工作台） | 旧链接不 404 | ☑ levels.html#NN → app.html?work=…&cp=NN#bench 并选中检查点；index / advisor 保留，页头互链（Reviews/ab/P0-21.md） |

## P1 · 像真的：电气、测量、装配（约 6–8 周）
做完的标志：接错线、少买电源这类常见坑，网页能在买之前指出来；三个作品都能走到成品。

| ID | 项 | 验收 | 状态 |
|---|---|---|---|
| P1-01 | 直流电路求解器（MNA）：电流预算、稳压压降、USB 0.5 A 上限、短路 | 与本机 ngspice 对照 10 个电路误差 < 2% | ☑ 2026-10-16：`core/crates/elec`（MNA + 隐式欧拉 + 分段线性 Katzenelson 法，无依赖）；`tools/elec` 10 个网表与 ngspice-47 对照最大误差 0.039%（进 accept.sh，没有 ngspice 时跳过）；CLI `--power usb|ext` / `--elec-report`、wasm `tb_elec_*`，网页与命令行逐字节一致（Reviews/ab/P1-01.md）。短路 / 接错线的网络求解还没接到实验台的接线检查 |
| P1-02 | 舵机启动电流 → 3V3 掉压 → 欠压复位（驱动 RTC 复位原因 BROWNOUT） | 固件看到 `rst:0xf`；网页时间线显示 | ☑ 2026-10-16：3V3 < 2.44 V（S3 默认档）持续 0.12 ms → 复位原因 15，ROM 头 `rst:0xf (BROWNOUT_RST)`、`esp_reset_reason()` = BROWNOUT；验收固件 s3-brownout（USB 复位 / 外接 5 V 不复位，accept 两个用例）；网页时间线「欠压复位」、供电卡片在线切换。按估算参数，舵机从静止起步（含第 05 关 0→180°、气象站默认）USB 下不复位，只有半路反向扫动才复位（Reviews/ab/P1-02.md） |
| P1-03 | 舵机二阶动力学（加速、过冲、堵转电流；不改固件读数） | 单测 | ☑ 2026-10-16：`elec/src/servo.rs`（比例控制 + 电机 + 减速箱，SG90 参数估算），单测：180° 约 0.3 s、过冲、起步尖峰 ≈ 堵转电流、小动作在比例带内、卡住 = 堵转电流；3D 舵盘用动力学角度（Reviews/ab/P1-03.md） |
| P1-04 | 万用表（电压，依赖 P1-01） | 量 3V3 读数与求解器一致 | ☑ 2026-10-16：工具条「万用表」点针 / 导线读对地电压（电源脚 = 节点电压，信号脚按逻辑电平，PWM 读平均），量 3V3 = 求解器 3V3（elec.mjs + agent-browser，Reviews/ab/P1-04.md）。只有电压档 |
| P1-05 | 示波器 / 逻辑分析仪面板（引脚事件日志画波形，I2C 解码） | 解码出 0x76 读 8 字节 | ☑ 2026-10-16（内核事件缓冲 + `--trace-io`，网页 / 命令行逐条对拍；Reviews/ab/P1-05.md） |
| P1-06 | ⌘K 命令框（搜零件 / 引脚 / 命令） | 四条示例命令可执行 | ☑ 2026-10-16（室温 N ℃、换外接 5 V 并重跑、回到第 n 次运行、量 3V3（提示 P1-04 中）；Reviews/ab/P1-06.md） |
| P1-07 | 3D 装配：零件拖到槽位吸附（three-mesh-bvh）、炸开 / 剖面 / 尺子 | 拖拽用例 | ☑ app/asm3d.ts：参数化外壳剖开、零件悬在上方、拖到发亮槽位 16 mm 内吸附，规则与 SVG 共用 views/asmcore.ts；炸开 / 剖面 / 尺子（BVH 取点）；`tools/webtest/asm3d.mjs`（进 accept.sh）真实鼠标拖 BME280 到芯片旁复测 ✗、通风口旁复测 ✓；`?asm=svg` / 无 WebGL2 兜底（Reviews/ab/P1-07.md） |
| P1-08 | 参数化外壳（Manifold wasm）+ STL / 3MF 导出 | 导出文件能被 three.js 读回 | ☑ app/enclosure.ts（布局纯函数 + Manifold 布尔）、meshio.ts（STL、自打包 3MF）；采购页外壳详情：尺寸、高度 / 壁厚 / 圆角、太矮警告、导出；npm test 在 node 跑真 Manifold（封闭流形、STLLoader 读回、3MF 解压对数），asm3d.mjs 下载文件大小与 STLLoader / 3MFLoader 读回一致（Reviews/ab/P1-08.md） |
| P1-09 | 外部模型管线（Adafruit / M5Stack MIT、KiCad CC BY-SA）STEP → glTF，SOURCES.md 署名 | 授权页出现署名 | ☑ 2026-10-16：tools/models（fetch + convert：occt-import-js → glTF-Transform，构建期）；3 个模型（KiCad USB-C、KiCad Φ12 蜂鸣器、Adafruit 9 g 舵机）进 assets/models，共 163 KB；实验台工具条「外部模型」可选替换，默认程序生成；licenses.html 出现署名与下载（Reviews/ab/P1-09.md）。M5Stack 未用 |
| P1-10 | 透镜折射材质（标"示意"）；小黄、透镜小人 3D 成品 | 截图 | ☑ 2026-10-16：app/lcd3d.ts，圆屏帧缓冲作纹理、小黄随 GPIO4 转身、BOOT 回正面 / 换表情、拖动旋转；透镜 transmission / ior 折射标"示意"；SVG 留作 WebGL 兜底（Reviews/ab/P1-10.md） |
| P1-11 | 小黄、透镜小人拆检查点（各 2–3 个）走完整条线 | 参考固件全过 | ☑ 2026-10-16：小黄 spin-1 画脸 → spin-2 转身 → 07-spin 合体；透镜 lens-1 眼睛 + 眨眼 → lens-2 按键换表情 → 07-lens 合体。新判定 lcd_colors / serial_count，参考固件 CLI 与网页全过、指纹一致；只按任务书自测 6 关 4 关一次过（Reviews/ab/P1-11.md） |
| P1-12 | 开发板库（合宙、XIAO、M5、微雪圆屏）+ 版本差异规则 | 规则用例 | ☑ 2026-10-16：开发板 9 块（新增 AtomS3、微雪 LCD-1.28 两版），规则 R28–R32 + R24 改分级，每条正反用例；采购页换板联动（Reviews/ab/P1-12.md，待核字段列在里面） |
| P1-13 | C3 接 SPI2 / GDMA（圆屏） | 固件验收 | ☑ 2026-10-16：c3-lcd 验收通过，CLI `--spi gc9a01` 与网页 3D 台面在 C3 板上有画面；crypto_hw 链表头改读 GDMA 模型（Reviews/ab/P1-13.md） |
| P1-14 | `npx tryboard check`（wasm 内核打包的 npm CLI，本地包，不发布） | 与 tools/check.py 指纹一致 | ☑ packages/tryboard（tools/build_npm.sh，约 0.9 MB tgz）；8 关参考 + 3 个错配用例与 check.py 输出、指纹、退出码逐字一致（tools/npm_parity.sh，进 accept.sh） |
| P1-15 | 手机只读视图；暗色模式 | agent-browser 390 宽截图 | ☑ 跟随系统 + 右上角切换（localStorage）；app / home / licenses 暗色，3D 台面与成品背景同步；≤ 760px 只读堆叠，成品锁着时手机上按默认装法预览（Reviews/ab/P1-15.md） |

## P2 · 更多外设和作品（约 8 周+）
做完的标志：作品库 ≥ 8 个，覆盖"会动、会响、会感应"。

| ID | 项 | 验收 | 状态 |
|---|---|---|---|
| P2-01 | PCNT + 旋转编码器（鼠标拖旋钮） | 固件验收 | ☑ 2026-10-16：PCNT 4 单元模型 + EC11 引脚器件；s3-encoder（IDF pulse_cnt，4 倍频 + accum）accept 通过；网页 3D 旋钮拖 / 滚 / 按，属性面板 + 快捷卡片，逻辑分析仪看 A/B；网页输入日志与 CLI 逐字节一致（Reviews/ab/P2-01.md） |
| P2-02 | 触摸屏 CST816S / FT6236（3D 屏上点） | 固件验收 | ☑ 2026-10-16：CST816S 模型 + s3-touch（点哪画哪、手势），accept s3-touch / s3-touch-noint；3D 圆屏触摸版，点屏 = 触摸，输入日志 `touch=x,y` / `release` 与 CLI 逐行一致（Reviews/ab/P2-02.md）。FT6236 未做 |
| P2-03 | IMU（MPU6050 / QMI8658，由成品转动驱动） | 固件验收 | ☑ 2026-10-16：两颗 IMU 模型 + s3-imu / s3-qmi8658，accept 设定姿态读数误差 ≤ 0.2°、陀螺 ≤ 0.08 °/s；倾斜滑块、拖 3D 模块转台面、成品页转倾角仪盒子三种来源，输入日志 `imu=p,r,y[,速率]` 与 CLI 逐行一致（Reviews/ab/P2-03.md） |
| P2-04 | HC-SR04（RMT 接收 / 定时，3D 射线测距） | 固件验收 | ☑ 2026-10-16：HC-SR04 引脚器件（Trig → Echo 宽 = 2 × 距离 / 343 m/s）；s3-ultrasonic accept 覆盖 25 / 100 / 300 cm + 超量程；3D 障碍物拖动（射线测距）、滑块 / 快捷按钮；Echo 5 V 风险进接线检查 W2（复用 R17）；15 mA 进 5V 轨（Reviews/ab/P2-04.md） |
| P2-05 | RMT 接收 | 固件验收 | ☑ 2026-10-16：RMT 接收通道（S3 / C3 布局）+ 滤波 + 空闲结束 + 乒乓阈值；s3-ultrasonic 用 IDF rmt_rx 测 Echo 宽度；C3 只有单元测试（Reviews/ab/P2-05.md） |
| P2-06 | I2S + GDMA 接收：MAX98357A 放音、INMP441（验收用固定 WAV，网页可接麦克风） | 固件验收；Web Audio 采样比对 | ☑ s3-i2s-tone（喇叭 440.0 Hz，网页输出端也测得 440.0 Hz）、s3-i2s-mic（I2S1，读回 WAV 1000.0 Hz / RMS 0.3533）；C3 的 I2S0 只有单元测试 |
| P2-07 | LVGL：先测速度，够则支持动画 | 基准报告 | ☑ 能跑动画、模拟时间帧率正确；整屏重画的界面网页 0.51–0.53× 实时（2026-10-17 预解码缓存 + worker 调度后，负载 < 4 时测），见 STATUS「LVGL」与 Reviews/ab/P2-07.md |
| P2-08 | S3 Wi-Fi（复用 C3 MAC 模型） | wifi-http S3 版 | ☑ 2026-10-16：MAC 模型移到 tryboard-soc 共用；s3-wifi-init / scan / connect / http / wpa2 验收通过，网页 s3-wifi-http（Reviews/ab/P2-08.md） |
| P2-09 | 新作品：旋钮台灯、超声波尺子、体感小人、USB 小键盘（各含检查点、参考固件、采购模版、成品） | 参考固件全过 | ☑ 2026-10-16：lamp / ruler / tilt 三条作品线（各 3 个检查点、9 份参考固件、采购模版、平面装配 + 一处装法影响、three.js 成品、首页卡片自动出现）；新判定 `ws2812.last`、`pwm.beeps`、`lcd_colors.cy`（check.py / checks.ts 同步）；check.py --ref --all 与网页指纹逐关一致（Reviews/ab/P2-09.md）。USB 小键盘由 P2-12 完成；可选的「会说话的小黄」没做；新作品组装是平面 SVG，参数化 3D 外壳没做 |
| P2-10 | 拍照（path tracer 静帧）/ 录 10 秒 | 生成文件 | ☑ 2026-10-16：没装 three-gpu-pathtracer，改用 2× 输出 + 超采样 + 渐变背景；录像 MediaRecorder webm 含声音；media.mjs 检查文件（Reviews/ab/P2-10.md） |
| P2-11 | 线长影响 I2C、天线遮挡（标"必须上真机"） | 用例 | ☑ 2026-10-16：确定性模型（上升时间 / RSSI），accept weather-i2c-long / -nack、wifi-scan-antenna / wifi-connect-antenna；实验台 W6、组装滑块（Reviews/ab/P2-11.md） |
| P2-12 | USB 键盘作品展示（已有 OTG） | 成品页 | ☑ 2026-10-16：作品 usbkey（三检查点 + 采购 + 组装 + 3D 成品打字），首页卡片由作品定义生成（Reviews/ab/P2-12.md） |

## P2 收尾 · 2026-10-17（各项「未做」尾巴与验收缺口）
来源：PLAN ☑ 行里写着"未做"的部分、STATUS 里 ☐ / 🟡 且"缺验收"的行（AGENTS §2：没有验收不算完成）。P3 与"需要人做的"不在此列。

| ID | 项 | 验收 | 状态 |
|---|---|---|---|
| P2-13 | 验收缺口：C3 RMT 接收固件（c3-ultrasonic）、C3 I2S 固件（c3-i2s-tone）、TIMG 通用定时器独立验收（gptimer 告警 / 自动重载，C3 + S3）、网页串口输入（echo 示例在网页里发送 → 回显）；清理 STATUS 里过时 / 重复的行（NVS、C3「M2 ☐」行、重复的 CPU / 中断矩阵 / 3D 工作台行） | 新用例进 accept.json 全过；串口输入 webtest 进 accept.sh；STATUS 对应行改 ✅ | ☑ 2026-10-17：accept 新增 c3-ultrasonic（25 / 100 / 300 cm + 超量程）、c3-i2s-tone（440.0 Hz）、c3-gptimer / s3-gptimer（计数读回、停止冻结、自动重载 50 周期、单次告警，带数值容差）全过；顺带修 TIMG 自动重载相位（已有 74 个用例输出逐字节不变）；webtest echo 串口输入进 accept.sh；STATUS 清掉重复 / 过时行（Reviews/ab/P2-13.md） |
| P2-14 | 接线错误走网络求解：W1 输出对打、W3 LED 无限流电阻、短路（3V3 / 5V 接 GND）由 elec MNA 算出电流，属性面板 / 接错线卡片显示估算电流与后果 | elec 单测（三种错接的电流）；网页用例经 `__tbApp.injectWiring`；agent-browser 截图 | ☑ elec `fault.rs`（对打 97 mA、LED 34.9 mA、3V3 短路 0.72 A / 5V 短路 0.73 A、Echo 5 V 钳位 18 mA）；7 个网表对 ngspice 误差 0.0000%；wasm `tb_fault` 主线程求解，面板与接错线卡片显示 mA + 后果 +「估算」；新增 W7 电源短路（跳线）；webtest/elec.mjs 5 种错接与命令行对拍；截图 Reviews/ab/P2-14-*.png |
| P2-15 | 底部坞「代码」页签：参考固件 / 示例的源码只读显示（构建期从 firmware/<名>/main 打包），多文件切换、复制、行号；上传的 .bin 没有源码时说明原因 | webtest：打开 weather 看到 app_main；上传 bin 显示"没有源码"；agent-browser 截图 | ☑ 2026-10-17 构建期 gen_fw_src.py 打包 src.json（按需取），自写 C 高亮，文件切换 / 行号 / 复制，上传 bin 说明原因；code.mjs 7 项（Reviews/ab/P2-15.md） |
| P2-16 | 台面直接放零件：元件库拖到台面放下，进入"接线"提示（按零件引脚逐根接，复用改接线模式），接完参与接线检查与模拟 | webtest：拖一个 LED 到台面、接两根线、跑 blink 亮；agent-browser 截图 | ◐ 2026-10-17 桌面：14 件有引脚模型的可拖 / 点「放」→逐根接线→进场景（LED 跟 GPIO 亮灭、BME280 被扫到），其余灰掉写原因；place.mjs 15 项（Reviews/ab/P2-16.md）。余：手机元件库放置；I2C 模拟不看 SDA/SCL 针 |
| P2-17 | 手机成品全屏 3D：3D 占满、底部串口一行 + 按键网格（BOOT / 热源 / 等作品按键），按 DESIGN_V2 §5 | mobile.mjs 增用例；390×844 agent-browser 截图无横向滚动、console 无 error | ☑ 3D 占满顶栏到底部面板，可拖转、双指缩放（OrbitControls 默认）；底部一行串口（点开即实验台同一串口抽屉半屏）+ 4 列按键格，键取自各作品真实交互（weather BOOT/热源、spin/lens BOOT、lamp 旋钮 ±1/按、ruler 挡板近/远、tilt/imu 放低/放平、usbkey K1–K4）+ 声音/拍照/录像/复位视角/详情/再跑一次；mobile.mjs 增 8 个成品用例全过（Reviews/ab/P2-17.md）。未做：真机触屏、双指缩放无自动化用例；手机成品页不再显示零件 / 装法树 |
| P2-18 | 触摸屏 FT6236（P2-02 尾巴）：I2C 0x38 模型 + 验收固件 | 固件验收进 accept.json | ☑ 2026-10-17：`devices/ft6236.rs`（按 FT6x36 数据手册：CIPHER 0x36、TD_STATUS、P1 事件 / 12 位坐标、G_MODE），CLI `--i2c ft6236@0x38` + 与 CST816S 相同的 touch 脚本；固件 s3-ft6236（裸 i2c_master，INT 下降沿 + 轮询），accept s3-ft6236 / -poll / -absent；网页未挂（可选项，未做） |
| P2-19 | 字体自托管（P0-20 尾巴）：Noto Sans SC、JetBrains Mono 子集化 WOFF2，附 OFL.txt，去掉 Google Fonts 外链，授权页列出 | 构建产物无 fonts.googleapis 引用；授权页有字体条目；agent-browser 截图字形正常 | ☑ tools/fonts/fetch.sh 从 google/fonts 固定提交下载 + sha256；subset.py（tools/fonts/.venv 里的 fonttools）子集化：用到的字 ∪ GB2312 一级字 → tb-sans-sc.woff2 ≈1.05 MB、tb-mono.woff2 66 KB；dist 无 googleapis / gstatic，授权页有字体条目 + OFL 全文，Network 只有本站字体（Reviews/ab/P2-19.md）。未做：按页面拆分子集 / unicode-range 分片 |
| P2-07 | （续）LVGL 网页实时倍率 ≥ 0.5× | 空闲机器上 `tools/bench_wasm.mjs` 与网页右上角倍率；45 个验收输出与关卡指纹逐字节不变 | ☑ Node 0.43→0.50–0.51×、网页 0.34→0.51–0.53×、CLI 0.645→0.78×；81 个 accept 用例 stdout、24 个关卡指纹、LCD ppm、trace-io 前后逐字节相同 |

## UI v2 · 设计 v2 落地（2026-10-17，规范见 DESIGN_V2.md）
| ID | 内容 | 验收 | 状态 |
|---|---|---|---|
| U-01 | 推荐 logo + favicon，全站页头统一 | agent-browser 各页截图 | ☑ 2026-10-17：src/ui/logo.tsx、public/favicon.svg（16px 简化版，跟随系统暗色），站点页头 / 实验台 / 旧实验台 / 授权页（gen_licenses.mjs）统一（Reviews/ab/u2/U-01-*.png） |
| U-02 | 新版选型助手（桌面 + 手机） | agent-browser 走输入 → 结果 → 跑一遍 | ☑ 2026-10-17：按 Advisor.dc.html 重做，逻辑仍在 engine / data；"跑一遍"按推荐芯片挑 examples.json 里真实示例打开 index.html?example=，另链完整作品（Reviews/ab/U-02.md） |
| U-03 | 实验台左上角面包屑 + 切换作品菜单 | agent-browser 点"作品"回首页 | ☑ 2026-10-17：logo + 「作品」链接回 home.html（悬停下划线、≥ 32px、提示未保存连线留本机）、作品名 ▾ 切换菜单勾当前作品（Reviews/ab/u4/b2-workmenu.png）；未做：手机布局（U-05） |
| U-04 | 实验台 v2（顶栏 / 左栏 / 台面 / 右栏 / 底部坞 / 关键状态） | agent-browser + tools/webtest 回归全过 | ☑ 2026-10-17：顶栏运行态 / 撤销重做 / 保存时间 / 分享 / 导出输入，左栏页签（零件 / 接线表 / 检查点），台面浮层（改接线模式 + 引脚圈、接错线卡片、万用表、检查点卡、空台面、欠压），底部坞（串口 / 分析仪 / 时间线，可拖可收）；新增回归 wiremode.mjs 16 项（Reviews/ab/U-04.md）；未做：代码页签、台面直接放零件、分享改动（无后端，灰显并写 DECISIONS） |
| U-05 | 手机：实验台与四步 | 390×844 截图，无横向滚动、控制台无 error | ☑ 2026-10-17：断点统一到 md；手机顶栏（‹ 作品 / ▾ 切换作品 / ⋯）+ 四步分段条带锁，实验台全宽台面 + 检查点横幅 + 串口抽屉（peek / 半屏 / 全屏、发送）+ 属性半屏抽屉 + 全屏零件库 + 五个底部工具 + 改接线横幅选线、按住引脚放大镜；采购 / 组装 / 成品单列卡 + 吸底主按钮，换开发板卡改底部抽屉；新增回归 mobile.mjs（Reviews/ab/U-05.md）；未做：成品不是全屏 3D（3D + 属性卡按键）、逻辑分析仪 / 示波器 / 放置工具手机上不提供、手机上没有双指缩放的专门处理、未上真机（只在 390×844 模拟视口验过） |
| U-06 | 手机：首页 / 选型助手 / 关卡 / 授权 | 同上 | ☑ 2026-10-17：汉堡抽屉（三段主题）、首页单列卡、选型折叠分区 + 底部吸附按钮、授权页每源一卡（gen_licenses.mjs）；390×844 无横向滚动、触控 ≥ 44px（Reviews/ab/U-06.md） |
| U-07 | 国际化：网页 en / zh / ja / ko 四语，代码注释与 CLI 输出英文，README 四语 | 四语各页 agent-browser 截图、390×844 无横向滚动、控制台无 error；`web/test/i18n.test.ts` 四语键齐全、占位符一致；代码（除固件 printf 与其期望文本、翻译词典）无中文；注释连续 ≤ 2 行；cargo test / accept.sh 全过 | ☑ 2026-10-19：四语 × 首页 / 实验台 / 采购 / 成品 / 关卡 × 1440 与 390×844 共 40 屏 agent-browser 无横向滚动、无页面错误（Reviews/ab/U-07-i18n.md）；i18n.test 含 t() 键覆盖；lint_comments 全仓 0（98bbde4）；cargo test、accept.sh（含网页）全过 |
| U-07 | 一个实验台：`index.html` 退役为重定向，示例改在工作台里开（`app.html?work=blank&example=<id>#bench`）；旧实验台独有功能先迁再删（模拟输入滑块、USB 虚拟电脑终端、麦克风声源、声音开关、导出输入、上传 .bin、加零件、测试钩子） | 原 index.html 的 webtest 24 例、editor / replay / levels 改指向工作台后全过；`index.html?example=X` 落到工作台并跑 X；src/lab 删除 | ☑ Reviews/ab/U-07.md |
| U-08 | 页头 / 用词统一：站点导航「作品 / 选型助手 / 实验台」；工作台面包屑「实验台 / 示例 · X ▾」+ 芯片标；「换固件 ▾」菜单（C3/S3、示例、上传、最近用过）取代示例下拉 + 上传；主题全站图标键；授权与商标进 ⋯ 菜单 | agent-browser 各页页头截图；用词表（DESIGN_V2 §6.3）里的旧词在界面上搜不到 | ☑ Reviews/ab/U-08.md |
| U-09 | 步骤条只显示走得通的路：空白只有「采购 / 实验台」；下一步按钮一种样式三态（可去 / 刚解锁 / 锁着写差几个）；锁住的组装 / 成品只显示一张检查点卡；没固件时一个主按钮；去掉重复的「再跑一次」 | agent-browser 截图 + levels.mjs / wiremode.mjs 回归 | ☑ Reviews/ab/U-09.md |
| U-10 | 手机：示例走工作台手机布局；换固件改底部抽屉 | mobile.mjs：390×844 示例页无横向滚动、换固件抽屉触控 ≥ 44px | ☑ Reviews/ab/U-10.md |
| U-11 | 新主张与文案：首页「试板：完全免费的线上 AI 智能硬件实验台」；作品简介、选板页、实验台、页脚等口语化表达按 DESIGN_V2 §7 改；「选型助手」改名「选板」 | DESIGN_V2 §7 表里「现在」一列在界面上搜不到；agent-browser 首页 / 选板 / 实验台截图 | ☑ Reviews/ab/U-11.md |
| U-12 | 去掉 .html 后缀（第一步）：站内链接不带后缀，首页 `/`，选板 `/select`；旧地址（home / advisor / levels / index?example=）跳转 | levels.mjs「旧地址 → 新地址」全过；vite preview 下 `/app?work=weather#shop`、`/select`、`/licenses` 直接可开 | ☑ Reviews/ab/U-12.md |
| U-13 | 授权页 C 版：一页声明 + THIRD_PARTY_NOTICES.txt + tryboard.spdx.json（gen_licenses.mjs 一次生成） | 页面无逐包全文；NOTICES 覆盖原页面全部组件；SPDX 是合法 JSON；390×844 无横向滚动 | ☑ Reviews/ab/U-13.md |
| U-14 | 可信度图标统一（DESIGN_V2 §8.1）：`ui/conf.tsx` ConfIcon + 分布条，选板 / 采购 / 实验台 / 组装 / 成品全换 | 界面上不再出现按可信度着色的徽章（grep 旧类名为 0）；四档图标在 agent-browser 截图里可辨；levels.mjs、mobile.mjs 照过 | ☑ |
| U-15 | 选板 v3（§8.2）：线稿项目卡、零件即清单（必选 / 建议 / 我已有）、三问 + 预算、「刚才 + 撤销」、答案先行、为什么是它、术语解释、全部细节折叠、三板对比（用 C3 代替）、0 板时放宽建议、任务书（无命令行）、分享链接、手机布局 | selectv3.mjs：改零件 / 问题 → 变化行出现 → 撤销复原；分享链接复原同一结果；任务书不含 `npx`；390×844 无横向滚动、触控 ≥ 44px；agent-browser 桌面 + 手机截图 | ☑ |
| U-16 | 选板 → 采购直通（§8.3）：`/app?work=custom&…#shop` 预填清单（地址约定见 DECISIONS），旧 `?t=` 兼容 | selectv3.mjs：选板主按钮 → 采购页清单与选板一致（必选 / 建议 / 我已有）；刷新不丢 | ☑ |
| U-17 | 实验台按零件生成检查点（§8.3）：自动摆件连线、生成 Level、新检查类型 `i2c_ack`（`--i2c-log`）、check.py / npm 包同步、C3 演示固件 `c3-thermo` | 生成的 Level 用 check.py 跑 c3-thermo 全过且与网页指纹一致；空固件（hello）在 I2C 条目上未过、文字「实际 …；要 …」；accept.json 加 c3-thermo；levels.mjs 原有用例全过 | ☑ |
| U-18 | 真买卡（§8.3）：自定义作品检查点全过后、现成作品成品步之后出现；成品页按钮按动词分开（§8.4），media.mjs 改选择器不减断言 | agent-browser 走 `/select` → 采购 → 实验台 → 演示固件 → 检查点 ✓ → 真买卡；media.mjs、harness.mjs 全过 | ☑ |
| U-19 | 全站静态 OG（§8.5）：各 HTML 入口 og/twitter 标签，构建时渲染 og.png；选板结果动态 OG 标 ✗（要部署，问人） | 构建后 dist 每个入口都有 og:image 且文件存在、1200×630；agent-browser 打开 og 预览截图 | ☑（选板结果动态 OG ✗：要服务端与部署，需人点头） |
| U-20 | 结果文案重写（DESIGN_V2 §9）：检查点 / 开机复测 / 没跑完 / 欠压 / 清单检查 / 线束 / 真买卡 / 选板理由，第一层人话、原始数据折叠；状态四个词；指纹改称运行编号 | 界面上搜不到「✗ 未通过」「在规范内」「32 条规则通过」「运行指纹」；levels / custom / asm3d / harness / elec / selectv3 / mobile 改选择器不减断言全过；原始数据里仍有与命令行逐字相同的结论行；agent-browser 桌面 + 手机截图 | ☑ |
| U-21 | 结果卡 v2 精修（DESIGN_V2 §9.5，画布 https://claude.ai/artifact/PT6QqqxSYZdiaiLarXo4K1）：逐条按器件分组、16 px SVG 图标、原始数据整行按钮；结果卡带动作（复测失败 → 重装那一件；检查点没过 → 复制给 AI 修）；跑中卡；手机工具栏主按钮整行、复测失败时底栏换成补救动作；真买卡遮罩 + 三栏等高 + 列表不套滚动；选板理由数字列只放数字、可信度带字；`--muted` 加深、字号五档 | levels / asm3d / mobile / custom / harness / interact / selectv3 改选择器不减断言全过；原始数据仍与命令行逐字一致；agent-browser 桌面 + 390 + 暗色截图（Reviews/ab/U-21.md） | ☑ |
| U-22 | 内置固件走完全程（新人走查 Reviews/ux/report.md P0）：检查点两档（◐ 参考跑通 / ✓ 我的固件），参考跑通也解锁组装 / 成品；每个作品一键「用内置固件走完全程」；选板作品演示固件改记参考；参考固件可下载 flash.bin + 源码 zip（构建期 gen_fw_zip.py，能 idf.py build）；气象站 GPIO5 加 LED，检查点 01 / 02 与台面一致 | levels.mjs / custom.mjs 新断言（参考 ◐、一键全过后组装解锁、旧进度不降级）；解压 zip 用 IDF 5.5.1 build 通过；agent-browser 走气象站 采购→一键→组装→成品，记录 Reviews/ab/U-22.md | ☑ |

## C · 竞品调研后（2026-10-19 人已确认 C-01–C-05，依据 RESEARCH_ESP_EMULATOR.md；C-06 涉及授权，仍待确认）
| ID | 项 | 验收（草案） | 状态 |
|---|---|---|---|
| C-01 | BLE 探针：按 libbtdm 预编译库字节签名在 .bin 里定位 VHCI 边界，只靠 .bin（路线 a′；ROM 地址路线已排除）；不成则改为 ELF 符号拦截（路线 c） | NimBLE `bleprph` 示例：虚拟手机扫到广播名、连接、读一个特征值；结论写进 DECISIONS | ◐ 路线 a′ 在 C3 跑通：`firmware/c3-ble-hr`（NimBLE 外设，IDF 5.5.1）只靠 .bin 认出 VHCI 边界，虚拟手机扫描 / 连接 / 读电量 87% / 订阅心率通知 / 写 01 点亮 GPIO5；accept `c3-ble-hr` / `c3-ble-led`（qemu: false）；网页「蓝牙」坞页签 + 构建树「虚拟手机」，agent-browser 记录 Reviews/ab/C-01.md。余项：路线 c（拖 app.elf 按符号拦截）只做了提示卡、未接；S3（Xtensa libbtdm）未做；签名只用 5.5.1 实机固件验过 |
| C-02 | 固件自建热点（SoftAP）+ 虚拟手机连上去打开配网页 | IDF `softAP` 示例 + WiFiManager 类配网页：虚拟手机连上、GET 192.168.4.1 拿到页面、POST 表单后固件串口打印收到的 SSID。注意：现有虚拟路由器占 192.168.4.1（`soc/src/wifi/net.rs`），Wi-Fi 模型只有 STA 接口；AP 模式下浏览器一侧改当手机（DHCP 拿 192.168.4.2），要新增 AP 接口（发信标、收关联）。做法与结论见 WIFI.md 阶段 5、DECISIONS 2026-10-19 C-02；验收 accept softap-prov* / c3-softap-wpa2 / s3-softap-prov，网页 `tools/webtest/softap.mjs`，走查 Reviews/ab/C-02.md | ☑ |
| C-03 | 网页"真实网络"开关（HTTP 转 fetch，默认关，响应进输入日志可重放） | wifi-http 打开开关后 GET 公网成功、导出输入后 CLI 重放逐字节一致。开关打开的运行：检查点标「依赖外网」，本机进度只记通过、不记运行编号（指纹）；回放 / 回退按记录的回复重放，指纹按重放算，不会误报不一致 | ☑ |
| C-04 | FreeRTOS 任务时间线（CLI `--trace-tasks` 导出 Perfetto；网页可选上传 ELF） | s3-dual 两任务分核泳道正确；Perfetto 能打开 | ☑ |
| C-05 | 经典 ESP32（LX6）：hello / blink / I2C / Wi-Fi | 同 M0–M2 验收在经典 ESP32 上通过；选板 esp32-devkitc 不再用 C3 代跑。按镜像头识别芯片、换板已有（`fwcheck.tsx` / `simrun.imageChip`），只需把芯片 id 0 映射到 esp32 | ◐ hello（与 QEMU 一致）/ blink / fade / I2C（SSD1306 + BME280）/ wifi-init / wifi（开放热点 + HTTP，输出与 C3 相同）/ wifi-wpa2 进 accept 全过；网页 DevKitC V4 台面、选板与换芯片已接，esp32-wifi 示例在网页跑通。✗ RMT / ADC / SPI / I2S / 蓝牙 未做（见 DECISIONS 2026-10-19 C-05、STATUS「ESP32」） |
| C-06 | esp-emu 作第二对照源（`tools/oracle_espemu.sh`，运行时下载、仅本机） | 先在 LICENSING 登记；对 hello / nvs / s3-psram / s3-dual 串口差分 | 待确认 |

界面约定（设计稿 https://claude.ai/artifact/7uo4Q73fYgyusK27EZytZp，源文件 docs/design-v2/compete/）：新面板进现有底部坞，沿用 USB 标签的做法——固件用到才出现（「蓝牙」「网络」）；「任务」常驻。手机上虚拟手机与配网三步都放进现有底部抽屉（半屏 / 全屏），配网一次只显示一步；390×844 无横向滚动照旧。

## D · 学习深度（2026-10-19 人已确认「全自主实现并验证」；画布 https://claude.ai/artifact/WoVszKfeER1BFcXRq3ayVp）
目标：真机上会踩的常见坑，这里也会踩到；踩不到的明确标「需真机确认」。共用约定（输入日志动作名、CLI 参数、随机流）见 DECISIONS 2026-10-19 D 批。不做：CPU 周期 / 缓存模型、HIL 标定、买板子。
| ID | 项 | 验收 | 状态 |
|---|---|---|---|
| D-01 | 网络故障注入：预设 正常 / 信号弱 / 不稳定 / 断网 + 安排一次故障（路由器重启断 8 s / DNS 失败 / 服务器不回应），全部在内核 `soc/wifi` 按模拟周期执行，种子确定、进输入日志 | 新固件 `c3-wifi-resilient`（断线自动重连 + 周期 GET）：`--net-fault reboot@10` 下串口出现 reason=200 断开、重连、之后 GET 200；`dns@…` 出现 DNS 失败、`silent@…` 出现超时后恢复；网页网络页签操作后导出输入，CLI `--inputs` 重放串口逐字节相同、指纹相同；agent-browser Reviews/ab/D-01.md | ☑ 2026-10-19：reboot@10 短断（8 s）IDF 报 reason=7（AP 已忘了站点、回 deauth），长断 reboot@10,20 报 reason=200 / 201，两种都自动重连后 GET 200；dns / silent / weak / offline 见 STATUS；网页导出 → CLI 重放逐字节相同、指纹相同（netfault.mjs）；accept.json 用例待主会话合并时加 |
| D-02 | 真实 ADC：噪声、两头非线性、eFuse 校准数据（`adc_cali` 曲线拟合可用，系数来自 IDF curve_fitting_coefficients，Apache-2.0）、理想 / 真实开关（默认真实）、S3 ADC2 遇 Wi-Fi 读超时；接线时 ADC1 / ADC2 引脚标注 | 新固件 `c3-adc-cali` / `s3-adc-cali`：已知电压下校准后误差 < 1%（未校准偏差另行打印）；`s3-adc2-wifi`：Wi-Fi 连上后 `adc_oneshot_read` → ESP_ERR_TIMEOUT、连上前读数正常；原有 pot / s3-pot 等用例不放宽容差；网页器件面板理想 / 真实切换、48 次读数条，重放对拍；agent-browser Reviews/ab/D-02.md | ☑ 2026-10-19：真实模式默认，校准回读 0.5–2.5 V 误差 0 mV；s3-adc2-wifi 连上后 ESP_ERR_TIMEOUT；pot / s3-pot 期望值随典型芯片读数更新（容差未放宽，见 STATUS）；adc.mjs 重放对拍；Reviews/ab/D-02.md |
| D-03 | 时序敏感代码识别：忙等 `esp_rom_delay_us`、读周期计数器自旋、软件翻转 GPIO（bit-bang）按引脚统计，CLI stderr 一行结论 + wasm 导出；新增 DHT11 单线器件模型 | 新固件 `c3-dht11`（自写驱动，`esp_rom_delay_us` 量脉宽）：读数与设定一致、校验 100/100；CLI 结论行指出 GPIO 与原因；网页结果卡对应行标「需真机确认」；Reviews/ab/D-03.md | ☑ 2026-10-19：模型、固件、CLI 结论行、wasm 导出、分析仪忙等提示（带「需真机确认」）；结论行已接进关卡检查（verify 带 timing，不进指纹），结果卡行标签逻辑由 conf.test.ts 覆盖；2026-10-20 DHT11 进选型数据，custom 生成「DHT11 读数」关卡（见 D-05） |
| D-04 | 逻辑分析仪精细采样：选引脚 + 时间窗，逐沿周期级、缩放、双光标测量、导出 VCD；CLI `--vcd` | 同一运行 CLI 与网页导出的 VCD 逐字节相同；c3-dht11 波形上光标量出 0 / 1 位脉宽；环形缓冲丢弃数显示；Reviews/ab/D-04.md | ☑ `tools/webtest/vcd.mjs` 网页导出 = `tryboard run --vcd` 逐字节（1792 字节、86 个沿）；光标读「High 70.00 µs → 1」；手机端分析仪已进底部抽屉「波形」页签（D-07） |
| D-05 | 结果卡逐条可信度（仿真验证 / 行为模拟 / 估算 / 需真机确认）+ 图例 | levels / custom / mobile 等 webtest 不减断言全过；原始数据仍与命令行逐字一致；agent-browser 桌面 + 390 截图 Reviews/ab/D-05.md | ☑ 2026-10-20：卡片与图例（Reviews/ab/D-05.md）；DHT11 进选型数据（advisor / catalog / custom，DATA 优先 GPIO5 → demo 固件 c3-dht11），自定义作品生成「DHT11 读数」关卡，结果卡温湿度两行标「需真机确认」+ 图例；custom.mjs 断言网页原始行、timing 行与 CLI 逐字一致、指纹相同；agent-browser 桌面 + 390 走查见 Reviews/ab/D-05.md「D-05 收尾」 |
| D-06 | 成品步骤「上真机检查清单」：按作品器件与结果自动生成（规则表在 TS），勾选、复制清单、打印 | 气象站 / 带 DHT11 / 带 ADC / 带 Wi-Fi 的作品生成的条目正确；勾选按作品存本机；打印样式只印清单；Reviews/ab/D-06.md | ☑ 规则见 web/src/app/checklist.ts，DHT11 / ADC / Wi-Fi 条目由 test/checklist.test.ts 覆盖（Reviews/ab/D-06.md） |
| D-07 | 手机布局：网络状况 2×2、安排故障、精细采样、清单在 390×844 下可用 | mobile.mjs 新断言（无横向滚动、触控 ≥ 44px）；agent-browser 390 截图 | ☑ 2026-10-19：网络页签 2×2 预设 + 折叠故障；分析仪进抽屉「波形」页签（全高、按钮 ≥ 44px、点按轮流放 A / B）；mobile.mjs PASS；Reviews/ab/D-07.md（清单 D-06 手机端已在 D-06 验过） |
| D-08 | 常见坑覆盖清单 `docs/PITFALLS.md`：真机常见坑逐条标 能复现（附固件 / 用例）/ 只能提示 / 覆盖不了 | 每条「能复现」都有 accept 用例或 webtest 指向 | ☑ 2026-10-19：32 条，没有用例的（外设超量、栈溢出崩溃、无 PSRAM）降为「只能提示」并注明待补 |

## R · 结构治理（2026-10-19 规划，待人确认后开工）
起因：代码体检发现 `benchStep()` 单闭包 3747 行、`createBench()` 1931 行；共享外设放在 `esp32c3` crate 里被 S3 / ESP32 / machine 引用（`soc` 只有 wifi / ble），`machine` 约 42 处按芯片 `match`；`worker.ts:521` 把经典 ESP32 的任务时间线标成 C3；core 非测试代码约 150 处 `unwrap/expect`，wasm 无 panic hook；22 处各自 `requestAnimationFrame`；芯片常量 web / Rust 各写一份。
原则：**行为不变的重构**，每步都以 R-02 的金标准逐字节对拍；先修 bug、再动结构、最后加护栏防回退。不改 UI 外观，不加依赖。
顺序：R-01–R-04 → 内核线（R-05 → R-06 → R-07）与前端线（R-08 → R-09 → R-10 → R-11 → R-12）两条 worktree 并行 → R-13 → R-14。D 批未完项（D-03 / D-05 / D-07 / D-08）先合完或冻结 `bench.tsx`，否则拆分要重做（AGENTS.md §9 第 11 条）。
| ID | 项 | 验收 | 状态 |
|---|---|---|---|
| R-01 | 性能基线（2026-10-19 试跑：稳定态 60 fps，桌面与 4× 降速手机都不掉帧；问题在启动长任务，见 R-15；s3-lvgl 模拟速度仅 0.5× 实时）：`tools/webtest/perf.mjs` 量各入口首屏字节（gzip）、首次可交互、长任务数、实验台 + 分析仪 + LCD 同开时帧耗时（桌面 + 4× CPU 降速 390×844）；CLI 各芯片模拟速度（MIPS） | 连跑 3 次波动 < 10%；数字写 `Reviews/perf-baseline.md` 与 STATUS；后续 R 项都与它比 | ☑ 2026-10-19：`tools/webtest/perf.mjs`，3 次波动 < 1%，数字见 STATUS「R-01 / R-02」 |
| R-02 | 金标准快照：accept 全部 112 个用例的 stdout + stderr（去掉墙钟时间）存 `Reviews/golden/`，`tools/golden.py save / check` 逐字节比，并进 accept.sh。前置：修「未建模寄存器」列表同次数时按 HashMap 顺序输出导致的不确定（`machine` `unimpl()` 加地址次序）——2026-10-19 试跑除此之外 112 例全部确定 | 连跑两次 112/112 相同；故意改一字节能报出 | ☑ 2026-10-19：`tools/golden.py` 112/112 连跑一致，进 accept.sh（有快照时）；unimpl 同次数按地址排序 |
| R-03 | 芯片信息单一来源：修 `worker.ts:521`（统一走 `CHIP_OF`）；去掉 `?? 'esp32c3'`、`tb_boot_pin` 默认 9 等静默兜底，未知芯片明确报错；Rust 出 `tryboard chips --json`（id / 名称 / BOOT / RGB 脚），`chips.ts` 加测试与之比对 | ESP32 固件任务页签显示 ESP32；`node --test` 新断言：chips.ts 与 CLI 输出一致；未知 chip id 页面出错误卡、无静默降级 | ☑ 2026-10-19：`web/src/chipid.ts` 为网页唯一芯片表（id / 脚数 / BOOT / RGB / ROM），worker / simrun / fwcheck / assets 都走 `chipFromId`；Rust `Chip::ALL / from_id / boot_pin / rgb_pin`，`tryboard chips` 输出 JSON，`test/chips.test.ts` 比对；ESP32 任务导出名 `tasks-esp32-…`（原误标 esp32c3）；伪造 S2 头出错误卡；金标准 112/112（Reviews/ab/R-03.md） |
| R-04 | 不因固件崩模拟器：固件可触达路径（MMIO 读写、DMA 描述符、外设寄存器）的 `unwrap/expect` 改成 unimpl 计数或 `Result`；wasm 装 panic hook，把位置传回页面，出「模拟器内部错误 + 重新运行」卡 | 新 Rust 测试：随机写满各芯片 MMIO 区 10 万次不 panic；网页注入 panic 后无未捕获 console error、可一键重跑；剩余 `unwrap` 逐处注释为何不可能失败 | ☑ 2026-10-19：wasm 装 panic hook（`tb_panic_ptr/len`），worker 捕获后发 `crash`，页面出「Simulator internal error」卡 + 重新运行（Reviews/ab/R-04.md）；新测试 `machine/tests/mmio_fuzz.rs` 三芯片 13 个固件各 10 万次随机 MMIO 读写 + RAM 乱写，0 panic；修出的问题：C3 ADC 越界读写、LEDC 渐变溢出、EAPOL 截短帧越界、WAV 块长溢出、HLE `mask` 下溢、AES `BLOCK_NUM` 原样分配（一次写入卡死 + 吃满内存，FUZZ_OPS=1000000 深跑发现，按一条 DMA 链上限截断）；其余 36 处 unwrap 逐处注释为何不会失败。顺带修：worker 无机器时不回 snapshot，示例加载中换固件被吞（elec.mjs 曾因此跑成 weather）、崩溃后重跑会卡住——snapshot 总回应、worker 消息串行、`LiveSim.start` 代号丢弃过期启动。遗留：`ccmp_encrypt` 对 ToDS+FromDS 短头帧可能越界（见 STATUS） |
| R-05 | 内核分层：`esp32c3` 里的共享件（devices / iotrace / tasktrace / rmt / ledc / i2c / spiflash / crypto_hw / CPU_HZ 等）搬到 `soc`，纯搬移不改逻辑 | `esp32s3` / `esp32` / `machine` 中 `esp32c3::` 引用为 0；cargo test、clippy 干净；R-02 金标准逐字节一致 | ☑ 共用模块整体移进 soc（保留历史；periph 拆出 CPU_HZ / Uart / Systimer / Timg，boot 拆出 find_app，sigin 因 rmt / pcnt 依赖一并搬）；esp32s3 / esp32 不再依赖 esp32c3；machine 只剩 C3 本体引用（Esp32c3 / Stop / MMIO 常量）；cargo test 156 通过、clippy / fmt 干净、金标准 112/112 一致 |
| R-06 | 芯片 trait：`soc` 定义 `trait Chip`（运行一批周期、GPIO、外接器件、trace、网络 / BLE 钩子），`machine` 只调 trait；分派按批次不按单条指令 | `machine` 中按芯片 `match` 只剩构造处；模拟速度与 R-01 相差 ≤ 3%；金标准一致；ARCH.md 写「新增一款芯片」清单 | ☑ 2026-10-19：`tryboard_soc::chip::Chip` 55 个方法（芯片特有功能用缺省 None / false），三颗芯片各在自己 crate 的 `chip.rs` 实现；machine 持 `Box<dyn Chip>`，`Hw` 枚举删除（`grep -n "Hw::" core/crates/machine/src/*.rs` 0 行），按芯片 match 只剩 `Machine::boot` 构造处和 `enum Chip` 元数据表；usb 搬进 soc，cli / wasm 不再依赖 esp32s3；esp32c3 对外转发改 `pub(crate)`。速度（`--seconds 5`，新旧交替各 5 次中位数 MIPS，旧 → 新）：s3-lvgl 113.1 → 114.4、wifi-http 100.3 → 100.4、esp32-blink 64.2 → 66.1、blink 27.8 → 28.1，均在 ±3% 内；cargo test 156 通过、clippy / fmt 干净、金标准 112/112 一致、wasm 1144779 B、gen_wasm_ts --check 通过 |
| R-07 | wasm 接口与 worker 消息单一来源：脚本从 `wasm/src/lib.rs` 的 `extern "C"` 生成 TS 声明；worker ↔ 主线程 43 种消息类型集中到一个文件 | 手改 Rust 导出不同步 TS 时 `tools/accept.sh` 失败；worker.ts 不再手写导出接口 | ☑ 2026-10-19：`tools/gen_wasm_ts.py` 从 lib.rs 的 116 个 `extern "C"` 导出（连同 `///` 文档）生成 `web/src/wasm.gen.ts`，worker.ts 与 simrun.ts 都用 `WasmExports`（原两份手写接口删除，worker 那份少 10 个导出）；accept.sh「wasm export interface」节 `--check`，在 lib.rs 加一个导出不重生成即失败（已验证）。主线程 ↔ worker 消息与相关类型（ToWorker / FromWorker 等 16 个）集中到 `web/src/simmsg.ts`，各处改从它 import。replay / levels / webtest PASS，npm test 173/0 |
| R-08 | 拆 `benchStep()`：按现有 18 个分节（接线检查、左栏、改线工具、直接摆放、构建树、检查器、引脚、运行历史、万用表、标尺、编码器 / 超声、姿态、实时字段、选板项目、结论、热源、快捷卡、调试钩子）拆到 `app/bench/`，闭包变量收进显式 `BenchCtx` | 无函数 > 400 行、`bench.tsx` < 500 行；webtest 全过不减断言；金标准一致；agent-browser 桌面 + 390 走查 Reviews/ab/R-08.md | ☑ 2026-10-19：`bench.tsx` 4048 → 270 行，21 个分节文件 + `ctx.ts`（BenchCtx：16 个状态字段 + 75 个分节装上的函数）+ `progress.ts` / `shared.tsx`，最长函数 362 行（mountCards）；webtest、金标准、accept 全过 |
| R-09 | 拆 `createBench()`（board3d.ts）：开发板、器件网格、拾取、导线、相机灯光分模块 | 同 R-08 的行数与回归要求；截图与重构前像素差 < 0.5% | ☑ board3d.ts 3906→381 行，拆为 bench3d/ 11 个文件（各段改为 `mount*(ctx)` 显式上下文，最长函数 339 行、最大文件 1078 行）；3D 画布像素差 weather 0.000% / c3-lcd 0.045%，accept 全绿（Reviews/ab/R-09.md） |
| R-10 | `benchv2.tsx` 实为实验台组件库，改名拆到 `app/bench/ui/`，去掉 v2 命名 | 无行为变化；webtest 全过 | ☑ 2026-10-19：benchv2.tsx 拆为 bench/ui/ 下 12 个组件文件（≤253 行），无 v2 标识符；tsc、node 测试、levels / mobile / wiremode / weather 全过 |
| R-11 | 统一帧调度：`ui/frame.ts` 一个 rAF 循环，按优先级订阅，页签隐藏 / 面板不可见时暂停；迁移 22 处 | `requestAnimationFrame` 只出现在 frame.ts；R-01 帧耗时、长任务不劣化；后台标签页 CPU 接近 0 | ☑ 2026-10-19：rAF 只在 frame.ts（15 文件迁移）；帧 p50/p95 16.7/16.8 不变，长任务总和 2751 → 2406 ms；后台页主线程 ScriptDuration 107–143 → 22–26 ms/5 s（页签隐藏时 worker 把 UI 帧合并为每 250 ms 一次，串口 / PWM 事件 / 掉电累积不丢，模拟照常 +5.0 s/5 s；`tools/webtest/bgcpu.mjs`） |
| R-12 | 包体：按需加载底部面板（分析仪 / USB / BLE / 网络 / 任务 / 代码）和非当前步骤（选购 / 组装 / 成品） | app 主包 gzip 比 R-01 降 ≥ 30%；首次可交互不劣化；各面板首次打开 < 300 ms | ◐ 2026-10-19：面板（代码 / 任务 / 分析仪 / USB / BLE / 网络）与选购 / 组装 / 成品改按需加载 + 开机 2 s 后空闲预取；`app-*.js` gzip 262.3 → 114.4 KB（−56%），但 app.html 静态闭包只 566.6 → 476.2 KB（−16%，其余是 rollup 把首屏仍用的共享模块分到别的 chunk），按闭包口径未到 30%；首次可交互中位数桌面 +0.6～2.5%、手机 4× −1～−3%；首次打开 36/36 < 300 ms（冷：桌面 ≤ 90 ms，手机 4× 面板 ≤ 86 ms、步骤 183–225 ms；`tools/webtest/opentime.mjs`）。剩余首屏重量 three 150 KB、语言包 66 KB，见 DECISIONS。2026-10-19 第二轮（`tools/webtest/closure.py` 量）：闭包 493.2 → 454.6 KB（本轮 −7.8%，对 R-01 基线 566.6 −19.8%），仍未到 ≤ 396 KB；去掉的是 levels.json、组装模板、⌘K 搜索逻辑（与会话并行取）和只给 work=custom 用的选板数据 / 购买卡；「语言包 66 KB」实为 react-dom（词典早已按语言 import()）；剩下的是 three 149、react-dom 66、实验台与 3D 舞台本身，卡点见 DECISIONS；readyMs 两轮不劣化，首次打开 36/36 < 300 ms |
| R-13 | 配置一致性：catalog（parts / rules）、`firmware/*.json`、chips.ts、CLI 器件名之间加交叉校验（器件 id 都能映射到模型、用例固件存在、关卡引用有效）；必要时写 schema | 检查进 `tools/accept.sh`；故意写错一个 id 能报出 | ☑ 2026-10-19：`tools/check_config.py` 进 accept.sh「Config cross-check」节：accept / levels（含 07 变体）/ examples 的固件目录（含 arduino-*）、芯片、`--i2c` / `--spi` 器件名（从 Rust `make_i2c` 与 CLI 用法解析）、场景零件类型（PartSpec）、关卡作品 id、目录 partId、选型顾问示例 id；解析结果为空也报错（防静默失效）。`--selftest` 在内存里逐项写错 10 处全部报出；真改 examples.json 一处零件类型也报出。现状 0 问题 |
| R-14 | 护栏：`tools/lint_size.py` 文件 > 1500 行 / 函数 > 400 行报错（现存超限进白名单，只减不增）；禁止 `rAF` 出现在 frame.ts 外、芯片字符串字面量出现在 chips.ts 外、其他芯片 crate 引用 `esp32c3::` | 进 accept.sh；每条故意违反一次能报出 | ☑ 2026-10-19：`tools/lint_size.py` 进 accept.sh「Structural guardrails」节，四条规则（文件 > 1500 行 / 函数 > 400 行、rAF 不在 `ui/frame.ts`、芯片字面量不在 chips.ts / chipid.ts、esp32s3 / esp32 / soc / machine 引 `esp32c3::`）；现存 57 处进 `tools/lint_size.allow.json`，只许变小（新增或变大即失败，`--update` 锁定改进）；`--selftest` 在临时树里每条各种一处违规，5/5 报出。R-09 ～ R-12 合并后再收紧白名单 |
| R-15 | 首帧着色器编译不阻塞主线程：试跑基线实验台首帧 `WebGLRenderer.render` 同步编译约 0.9 s（`getUniforms` 等链接结果），整体长任务 1.1–2.9 s；改为场景建好后 `renderer.compileAsync`（three r170 自带，走 KHR_parallel_shader_compile）再首帧，编译期间显示已有加载态 | perf.mjs 实验台长任务总时长降 ≥ 60%；画面与重构前截图一致；无 console error | ☑ 2026-10-19（R-16 合并后复测）：perf.mjs 3 次，实验台长任务总和桌面 3160 → 392–396 ms（−87%，12 行无回访卡顿：R-16 首帧前 WebGL2 fence 等 GPU 进程追上），手机 4× 4540 → 1817–1834 ms（−60%），0 error。原记录：`web/src/shaderwarm.ts` 共用（7 个 3D 视图），场景建好后 `renderer.compile` 预编译场景 + 后处理 pass + 阴影深度替身材质，`isReady()` 轮询完再首帧（未用 compileAsync：材质被 dispose 时它会抛错）。桌面实验台单行 725–895 → 235–267 ms（−65～−72%），但约一半运行里会有一次约 550 ms 的「回访卡顿」随机落在某一行（Chrome 程序二进制缓存命中时 isReady 已报完成、GPU 进程仍积压，首个同步 GL 调用阻塞；试过 fence、逐帧触碰、canary 程序均无效），桌面总计 3160 → 1480–1900（−40～−53%）。手机（4× 降速）总计 4540 → 4140–4490，几乎不变：剖析显示其长任务主要是建场景 + 首帧 JS 的 CPU 时间，不是着色器，转 R-16。画面一致、无 console error（Reviews/ab/R-15.md） |
| R-16 | 手机实验台启动长任务：4× 降速下 createBench / 建场景 + 首帧 JS 约 450–550 ms 一整块（R-15 剖析）；拆成多帧建（先板子与面包板，零件 / 导线分批），或在首帧后再建非关键部分 | perf.mjs 手机实验台长任务总时长降 ≥ 40%；画面最终一致；levels.mjs / mobile.mjs PASS | ☑ 2026-10-19：手机 4 行长任务总和约 4095 → 2104 ms（−49%，3 次均值），桌面约 982–1685 → 约 405 ms；`createBench` 先同步做 GL 初始化，再按约 10 ms 切片建状态 / 零件（生成器 + `scheduler.yield`），每片后 `shaderWarm.warm()`（脏标记，合并编译）；首帧前用 WebGL2 fence 轮询等 GPU 进程追上，消掉首个同步 GL 调用阻塞；levels / mobile / wiremode / harness PASS |


### R2 · 加载体积（2026-10-19 排查，`Reviews/perf-audit.md`；用户授权自主完成）
基线（`node tools/webtest/perf.mjs --desktop`，全部字节，gzip 后线上字节）：首页 1482 KB（字体 1317）、选板 1477、实验台 weather 3607（字体 1317、ROM 928、JS 584、核心 wasm 401、固件 357）、s3-lvgl 3910。

| ID | 内容 | 验收 | 状态 |
|---|---|---|---|
| R-17 | 字体按需：Noto Sans SC 按 unicode-range 切片（Latin / 常用 CJK 分片），en 页面不下 CJK 片；zh 栈系统字体（PingFang / YaHei）在前；字重只留实际用到的 | perf.mjs 首页 / 选板 en 字体字节 ≤ 150 KB；zh 页面中文字形不缺（截图）；四语言 390×844 无横向滚动 | ☑ 2026-10-20：en 首页 / 选板 / 实验台 font 1317 → 84 KB（Latin 片 18 + 等宽 66）；zh / ja / ko 在有系统 CJK 字体的机器上也只下这 84 KB，强制 Noto 时按需取 3–5 片（每片 ≤ 122 KB）；字重 400–700 |
| R-18 | 二进制瘦身：固件截掉尾部 0xFF（加载时补齐语义不变），`.bin` / `.elf` 发预压缩旁文件，`fetchBuf` 用 `DecompressionStream` 解压，失败回退原文件 | 实验台 weather 全部字节降 ≥ 700 KB；所有内置固件 web 与 CLI 指纹一致（levels.mjs、replay.mjs）；accept.sh 全绿 | ☑ 2026-10-20：weather 3607 → 2899 KB（−708），s3-lvgl 3910 → 3061 KB（−849）；ROM 928 → 408、weather 固件 357 → 172；levels / replay 指纹一致 |
| R-19 | 大资源带内容哈希：wasm / ROM / 固件 / 字体 URL 带 hash（manifest 或 `?v=`），可设 immutable 长缓存；写托管缓存建议 | 改一字节 wasm 重建后 URL 变化；二次访问实验台（启用缓存）全部字节 ≤ 100 KB | ☑ 2026-10-20：`?v=<sha256[:10]>`（清单内联 HTML）+ woff2 文件名带 hash + `web/public/_headers`；翻 wasm 一字节 155 个 URL 只变 wasm、JS 块名不变；perf `--revisit` 实验台 weather 首访 1628 KB → 二访 353 B（桌面 / 手机相同，只剩 HTML 304 + favicon 304） |
| R-20 | 词典不阻塞首屏：按页面拆分（site / select / app），当前语言词典 HTML 里预加载，去掉串行瀑布 | zh 首页词典字节降 ≥ 50%；zh 首页首次渲染不劣化（perf.mjs）；i18n 测试与 lint 全过；四语言走查无缺 key | ☑ 2026-10-20：zh 词典 gzip 首页 141.5 → 24.5 KB（−83%）、选板 → 36.2 KB（−74%）、实验台 142.9（三组并行）；ja / ko 首页 −83%；词典请求起点 980 → 165 ms（--rtt 150），首页首次渲染 1285 → 1012 ms、选板 1169 → 923 ms、实验台 2181 → 2052 ms；本机不限速中位数不劣化 |
| R-21 | ROM ELF 去掉不加载的 `.xt.prop` / `.xt.lit`（Apache-2.0 §4b：NOTICE 写明修改） | S3 ROM ≤ 640 KB；accept.sh、golden 全绿（ROM 符号名不变） | ☑ S3 ROM 949 552 → 619 788 B、ESP32 857 500 → 596 888 B（C3 无 .xt.*，不变）；`tools/strip_rom.py` 校验 PT_LOAD 与符号表（S3 5574 / ESP32 3166 / C3 4516 个）一致 |
| R-22 | perf.mjs 记全部字节并按类型拆（font / rom / fw / core / js / css） | 输出每页分类字节；`--only` / `--desktop` 子集 | ☑ 2026-10-19 |
| R-23 | worker 缓存编译好的 `WebAssembly.Module`（boot / seek / verify 不重复编译、不重复拷贝 wasm 字节） | seek 10 次耗时不劣化且 web 指纹一致；无 console error | ☑ 2026-10-20：`seektime.mjs` 短 seek 中位数 62.2 → 45.2 ms（−27%），3 s 整段 141–164 → 109–120 ms；长任务 0 → 0；指纹 / 回归全一致 |

## E · AMOLED AI 网关仪表盘（2026-10-20 人确认「直接做、全自主完成」）
起因：用户贴了一条推文——Waveshare ESP32-S3-Touch-AMOLED-2.16 做的 Magpie（LLM 网关）仪表盘，电脑端程序经 BLE 推数据（截图有蓝牙 ONLINE 图标）。目标：这块板 + 同类固件在网页里跑起来。板子（Waveshare 文档 / 官方仓库 Apache-2.0）：CO5300 480×480 QSPI（CS=12 CLK=38 D0–D3=4/5/6/7 RST=39）；I2C SCL=14 SDA=15 上挂 CST9220 触摸（0x5A，INT=11 RST=40）、AXP2101、PCF85063（INT=13）、QMI8658、ES8311 / ES7210；按键 GPIO18、GPIO0、PWRON（经 AXP2101）；16MB flash + 8MB OPI PSRAM。协议用公开的 Claude Desktop Buddy BLE 协议（NUS + 每行一个 JSON），原作者固件未公开，我们自写示例固件。决定见 DECISIONS 2026-10-20 E。
| ID | 项 | 验收 | 状态 |
|---|---|---|---|
| E-01 | SPI 四线（fcmd/faddr/fwrite_quad 等）时序 + S3 LCD 引脚可配置 + CO5300 屏模型（opcode 0x02 写命令 / 0x32 写像素，`opcode<<24 \| cmd<<8`，480×480 RGB565，亮度 0x51） | 新固件 `s3-co5300`（esp_lcd_co5300 + QSPI，画已知图案）：CLI `--spi co5300 --lcd-ppm` 像素与预期一致；四线下一帧传输的模拟时间约为单线的 1/4；GC9A01 用例输出逐字节不变（golden） | ☑ s3-co5300：四色块 + 灰阶 ppm 核对，像素数据四线 23.0 ms / 单线 92.2 ms（整帧含命令 30.1 / 97.1 ms），golden 112/112 不变 |
| E-02 | I2C 器件：CST9220 触摸（16 位寄存器、0xD000 报点 + 0xAB 应答、ID 0x9220）、AXP2101（芯片 ID、电量 / 充电 / VBUS、PWRON 按键中断）、PCF85063（跟模拟时钟、可设时间）、ES8311 / ES7210 应答空壳 | 新固件 `s3-amoled-i2c`：五颗都探到；触摸脚本坐标对上；电量百分比可由 CLI 参数设定并读回；RTC 写入后走时正确；accept 用例 | ☑ s3-amoled-i2c / s3-amoled-i2c-notouch；`--battery`、`--rtc`，动作 `bat=` / `pwrkey=`（DECISIONS 2026-10-20 E-02） |
| E-03 | 网页：新板 ESP32-S3-Touch-AMOLED-2.16（方形 AMOLED 3D 模型、按尺寸程序生成）、LCD 分辨率参数化（去掉 240 写死）、480×480 屏触摸映射、电量 / 按键交互 | 示例在网页显示 s3-co5300 画面；点屏 = 触摸，与 CLI 重放一致；390×844 无横向滚动；agent-browser 走查 Reviews/ab/E-03.md | ☑ |
| E-04 | S3 BLE：Xtensa 版 libbtdm 签名（`tools/ble_sigs.py`）+ S3 接入 VHCI HLE（照 `esp32c3/src/ble.rs`） | 新固件 `s3-ble-hr`（c3-ble-hr 的 S3 版）`--ble-phone` 结果与 C3 相同；S3 其它固件不误认 | ☑ s3-ble-hr / s3-ble-led 与 C3 判定相同；`esp32s3::ble` 单测：51 个 S3 固件只有 s3-ble-hr 被认出（去掉 BLE_INIT 门槛单跑签名也零命中）。签名覆盖 5.1–5.5.1，只用 5.5.1 实测 |
| E-05 | Bluedroid 主机栈：补虚拟控制器缺的 HCI（Arduino-ESP32 默认 BLE 库即 Bluedroid） | Arduino 或 IDF Bluedroid 的 NUS 外设固件（C3 与 S3）：虚拟手机扫到、连接、写 RX、订阅 TX 收到通知 | ☑ IDF Bluedroid（c3/s3-bluedroid-nus，开了 BLE 4.2 + 5.0 两套 API，同 Arduino-ESP32）；Arduino 未装，没用 Arduino 编译产物实测 |
| E-06 | 虚拟电脑：BLE 中心按 Buddy 协议推心跳 JSON（MTU 协商、无应答写、长消息分片、TX 通知按 `\n` 重组）；数据源：脚本 / 录制 / 本机 Magpie（经本地代理，可选）；CLI `--desk-pc` 与输入日志 `pc=...` | C3 NUS 固件（E-06 自带）收到完整 JSON 并回 ack；网页「蓝牙」坞显示虚拟电脑；导出输入后 CLI 重放逐字节一致 | ☑ 内核 / CLI / 固件完成（`soc/src/ble/desk.rs`，`--desk-pc`、`pc=on\|off\|json,…\|hb,…`，新固件 c3-ble-nus 与 accept 用例，`--inputs` 重放逐字节一致）；网页「蓝牙」坞虚拟电脑面板已由 E-07b 完成；录制 / 本机 Magpie 数据源未做，留作后续（验收不依赖）（接口见 DECISIONS 2026-10-20 E-06） |
| E-07 | 示例固件「AI 网关仪表盘」（S3 + CO5300 + CST9220 + AXP2101 + PCF85063 + BLE NUS，LVGL 4 页：请求 / 上下文 / 会话 / 用量，左右滑翻页） | accept：收到心跳后屏上数值正确（ppm 区域检查）、滑动翻页；网页示例库加入，agent-browser 走查 Reviews/ab/E-07.md | ☑ E-07a 固件：firmware/s3-ai-dash + accept 用例 s3-ai-dash / -swipe / -usage（`lcd_regions` 区域像素检查，DECISIONS 2026-10-20 E-07a）；E-07b 网页：示例库 s3-ai-dash（AMOLED 板，虚拟电脑默认开）、「蓝牙」坞虚拟电脑面板（开关 / 状态 / 心跳编辑 / JSON 行，`pc=` 进输入日志），`tools/webtest/aidash.mjs` 14 项进 accept.sh，走查 Reviews/ab/E-07.md（DECISIONS 2026-10-20 E-07b） |
| E-08 | （后置）LE 安全连接配对：虚拟电脑手写 P-256 ECDH + AES-CMAC（f4/f5/f6）、配对码输入 | 加密特征值的 NUS 固件配对成功、`sec:true` | ☐ |

## M5 · M5Stack 整机（2026-10-20 人确认「完整实现并验证」；评估见 docs/M5STACK.md，证据 Reviews/m5/）
验收固件统一用 M5Unified + M5GFX 的 Arduino 草图（`firmware/arduino/m5-*`，`tools/build_arduino.sh`），必须走真实自动识别路径（不预置 NVS 板型）；没有 QEMU 对照，结论标「未经真机标定」。
| ID | 项 | 验收 | 状态 |
|---|---|---|---|
| M5-00 | 授权与构建：LICENSING 补 M5Unified / M5GFX（MIT）、LovyanGFX（BSD-2）、字体声明；build_arduino.sh 支持钉提交的库；探测草图 `m5-probe`（M5.begin 后打印板型 / 屏尺寸 / IMU / RTC / 触摸 / PMIC），按各板 FQBN 编出 | 6 种 FQBN（AtomS3、Dial、CoreS3、Cardputer、StickC Plus2、Core2）都编出 flash.bin；LGPL 三件套（协议、源码提交、构建配置）随 bin | ☑ 2026-10-20（Reviews/ab/M5-00.md） |
| M5-01 | SPI 屏底座：面板读回（RDDID 0x04 / RDDST 0x09 / D9h）+ 三线半双工 + dummy 位；通用 DCS 面板模型（分辨率 / GRAM 偏移 / ID / 引脚可配：GC9107、ST7735、ST7789、ILI9342C / E、GC9A01）；S3 SPI3 | 单测：各型号 RDDID 读回正确；现有 gc9a01 / co5300 用例 golden 逐字节不变 | ☑ 2026-10-20（Reviews/ab/M5-01.md；m5-probe：AtomS3 board=11 128×128、Cardputer board=24 240×135、Dial board=12 240×240） |
| M5-02 | I2C 底座：外接器件可挂 I2C1 / 按引脚挂；GPIO 开漏线与 + 外部上拉（软件 I2C 探测能看到器件）；eFuse 封装号可配（S3 / ESP32） | 单测 + 固件：软件 I2C 扫描与硬件 I2C 扫描结果一致；golden 不变 | ☑ 2026-10-20（Reviews/ab/M5-02.md） |
| M5-03 | S3 USB-Serial-JTAG 控制台：TX 接 CLI / 网页串口，报主机在线，RX 能输入 | Arduino S3 草图（CDC on boot）`Serial.println` 在 CLI 与网页逐字节一致；输入回显 | ☑ 2026-10-20（Reviews/ab/M5-03.md；IDF 把 UART0 输出复制到 USJ 时按时间 + 内容去重，属启发式，见 DECISIONS） |
| M5-04 | I2C 器件模型：MPU6886、BMI270(+BMM150 AUX)、BM8563、AW9523、AXP192、LP5562、TCA8418、FT6336U / FT3267 ID、INA3221、LTR-553 / AW88298 应答壳 | 每颗单测（ID、关键寄存器、随环境变化） | ☑ 2026-10-20（Reviews/ab/M5-04.md） |
| M5-05 | 核心板预设 `--board <m5-*>`（CLI + wasm）：自动挂板载器件、引脚、封装号；M5Dial 跑通 | m5-probe 在 Dial 上识别为 board_M5Dial；圆屏截图；旋钮 / 触摸 / RTC 输出与脚本一致 | ☑ 2026-10-20（M5Dial 全通：探测 board=M5Dial、编码器 / 触摸 / RTC / 按键；蜂鸣器、RFID、PSRAM 未建模；其余板为未验证桩，见 M5-06..13） |
| M5-06 | AtomS3 / AtomS3 Lite / AtomS3R | 三块识别正确；屏截图；IMU 读数随姿态变化 | ☐ |
| M5-07 | CoreS3 / CoreS3-SE（摄像头不做，SE 识别靠 GC0308 不应答） | 识别正确；ILI9342 截图；触摸 / IMU / PMIC 电量；喇叭 I2S 有输出 | ☐ |
| M5-08 | Cardputer / Cardputer-Adv：ST7789、键盘部件（74HC138 矩阵 / TCA8418）、I2S PDM 接收 | 识别正确；脚本按键回显到屏；麦克风读数非零 | ☐ |
| M5-09 | 网页：M5 板预设（3D 外壳程序生成、板载器件自动出现、Grove 口）+ Grove Unit：ENV III（SHT30 + QMP6988）、ENV IV（SHT40 + BMP280） | agent-browser：选 M5 板 → 示例跑起 → 接 ENV IV → 读数；网页与 CLI 指纹一致；390×844 无横向滚动 | ☐ |
| M5-10 | 经典 ESP32 GP-SPI（HSPI / VSPI）+ SPI DMA | IDF spi_master 示例与 QEMU 对照 | ☐ |
| M5-11 | 经典 ESP32 RMT（8 通道、64 字块） | IDF led_strip 示例；WS2812 帧与 C3 一致 | ☑ 2026-10-20（esp32-ws2812；QEMU 无 RMT，该例 QEMU 关闭；RX/载波未建模） |
| M5-12 | 经典 ESP32 I2S（含 PDM RX）+ ADC1 | IDF 示例；麦克风 / 电池电压读数 | ☐ |
| M5-13 | StickC Plus2、Core2（v1.0 AXP192 / v1.1 AXP2101）、Atom Lite / Matrix | 各板 m5-probe 识别正确；屏截图 | ☐ |
| M5-14 | 经典 ESP32：flash 芯片 ID 容量随镜像头（8 / 16 MB）、PSRAM（PICO-V3-02 内置 2 MB、Core2 8 MB，四线） | m5-probe（stickc_plus2 / core2）不再因 flash 容量 / PSRAM 断言；IDF CONFIG_SPIRAM 示例内存测试通过 | ☑ 2026-10-20（esp32-psram / -8mb / -pico；QEMU 4 MB 一致；himem、2T、时序未建模） |

## F · 留存与传播（2026-10-20 人确认开工；评估、调研、派单手册见 docs/plan-F/）

依据 `docs/plan-F/EVAL.md` §5、提示词见 `docs/plan-F/DISPATCH.md`。与 M5 专项重叠的：F-10a 并入 M5-10（经典 ESP32 GP-SPI），CYD 示例在 M5-10 合并后补；F-10b（ADC）、F-10d（I2S）并入 M5-12；F-04b 等 M5-01（参数化 DCS 屏）合并后再开。

| ID | 内容 | 验收 | 状态 |
|---|---|---|---|
| F-01a | 台面状态 v1 + `?s=` 分享链接（内置固件；剥 Wi-Fi 凭据和真网回包） | share.mjs：链接打开后串口与 CLI 重放逐字节一致 | ◐ |
| F-01b | `.tryboard` 作品文件（> 8k 或自带 bin） | share.mjs 往返用例 | ☐ |
| F-02 | 分享卡：MP4 + 自写二维码 + 链接；修 Safari 录屏扩展名 | sharecard.mjs 解码二维码 = 链接 | ☐ |
| F-03 | 独立 embed.html（点击加载、不写 localStorage） | embed.mjs | ☐ |
| F-03b | 分享 / 嵌入页按原速回放 | 回放结束指纹 = 快进 | ☐ |
| F-04a | 已建模器件全部上网页元件库 + 3D + 手机 | levels / wiremode / mobile.mjs；网页与 CLI 指纹一致 | ☐ |
| F-04b | ILI9341 + SH1106 模型；ST7789 / ILI9341 裸屏 C3、S3 验收（等 M5-01） | accept 截图核对 | ☐ |
| F-04c | DS18B20 单总线（含 SEARCH ROM） | accept：温度随 --env | ◐ |
| F-04d | PIR / LDR / 继电器 + RC522（读 UID） | accept + 脚本动作可重放 | ◐ |
| F-04e | AHT20 + INA219 + DS3231 | accept | ☐ |
| F-05 | 故障挑战关卡 3–5 个（缺的 CLI 故障开关一并补） | check.py --ref --all；faults.mjs 网页判定一致 | ◐ |
| F-06 | 公开数字自动生成（tools/stats.py；README 标记块 + web/public/stats.json，build_web.sh 调用；首页暂无手写数字） | stats.py --check | ☑ |
| F-07a | UART > 127 字节修复 + `--script` `\xNN` + MicroPython C3 验收 | golden 字节一致；MicroPython 用例 | ☐ |
| F-07b | 网页 main.py 编辑器（需人定 MicroPython 分发方式与定位） | micropython.mjs | ☐ |
| F-08a / F-08b | Arduino 库矩阵 2 × 10 例（MIT / BSD 优先） | accept 矩阵写进 STATUS | ☐ |
| F-08c | BLE 多 IDF 签名 + osi 版本放宽 + pll_track | 覆盖自测；误匹配 0 | ☐ |
| F-09a | xiaozhi 虚拟服务端（长连接 TCP + WebSocket + 脚本） | 单测 + golden | ☐ |
| F-09b | xiaozhi-lite 示例 + 语音面板（需人拍板 RS-2 四项） | accept 3 例 + xiaozhi.mjs | ☐ |
| F-10c | 经典 ESP32 RMT 收 + 载波 + IR 器件 | esp32-ir accept | ☐ |
| F-11 | 环境脚本时间轴（先交互稿，人确认后实现） | --inputs 重放指纹一致 | ☐ |

## P3 · 以后再说
经典蓝牙 / A2DP、摄像头、esp-sr 语音唤醒（闭源 + PIE + 授权）、完整 SPICE 瞬态、热仿真、Wi-Fi 信号距离、账号与云同步、联盟链接、云端编译。

## 需要人做的（代理不做）
推远端、部署公网、给乐鑫发邮件（草稿在 LICENSING_REVIEW.md 第四节）、买零件做真机标定（P1）、找 5 个真人试用（P0 末）、收费 / 广告前请律师。
