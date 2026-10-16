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
| P0-20 | 第三方授权页 licenses.html（从 SOURCES.md 和依赖清单生成）；页脚声明；3D "外观示意"字样 | 页面列出全部依赖 | ☑ tools/gen_licenses.mjs 构建期生成（Reviews/ab/P0-20.md）；3D "外观示意"字样外壳已有；字体仍走 Google Fonts 未自托管 |
| P0-21 | 旧页面下线 / 重定向（levels.html → 实验台检查点；advisor → 我有自己的想法；index.html 保留为空白实验台） | 旧链接不 404 | ☑ levels.html#NN → app.html?work=…&cp=NN#bench 并选中检查点；index / advisor 保留，页头互链（Reviews/ab/P0-21.md） |

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
| P1-07 | 3D 装配：零件拖到槽位吸附（three-mesh-bvh）、炸开 / 剖面 / 尺子 | 拖拽用例 | ☐ |
| P1-08 | 参数化外壳（Manifold wasm）+ STL / 3MF 导出 | 导出文件能被 three.js 读回 | ☐ |
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
| P2-01 | PCNT + 旋转编码器（鼠标拖旋钮） | 固件验收 | ☐ |
| P2-02 | 触摸屏 CST816S / FT6236（3D 屏上点） | 固件验收 | ☐ |
| P2-03 | IMU（MPU6050 / QMI8658，由成品转动驱动） | 固件验收 | ☐ |
| P2-04 | HC-SR04（RMT 接收 / 定时，3D 射线测距） | 固件验收 | ☐ |
| P2-05 | RMT 接收 | 固件验收 | ☐ |
| P2-06 | I2S + GDMA 接收：MAX98357A 放音、INMP441（验收用固定 WAV，网页可接麦克风） | 固件验收；Web Audio 采样比对 | ☐ |
| P2-07 | LVGL：先测速度，够则支持动画 | 基准报告 | ◐ 能跑动画、模拟时间帧率正确；整屏重画的界面网页只有约 0.2–0.4× 实时（未达 0.5×），见 STATUS「LVGL」与 Reviews/ab/P2-07.md |
| P2-08 | S3 Wi-Fi（复用 C3 MAC 模型） | wifi-http S3 版 | ☐ |
| P2-09 | 新作品：旋钮台灯、超声波尺子、体感小人、USB 小键盘（各含检查点、参考固件、采购模版、成品） | 参考固件全过 | ☐ |
| P2-10 | 拍照（path tracer 静帧）/ 录 10 秒 | 生成文件 | ☐ |
| P2-11 | 线长影响 I2C、天线遮挡（标"必须上真机"） | 用例 | ☐ |
| P2-12 | USB 键盘作品展示（已有 OTG） | 成品页 | ☐ |

## P3 · 以后再说
蓝牙（M7）、摄像头、esp-sr 语音唤醒（闭源 + PIE + 授权）、完整 SPICE 瞬态、热仿真、Wi-Fi 信号距离、账号与云同步、联盟链接、云端编译。

## 需要人做的（代理不做）
推远端、部署公网、给乐鑫发邮件（草稿在 LICENSING_REVIEW.md 第四节）、买零件做真机标定（P1）、找 5 个真人试用（P0 末）、收费 / 广告前请律师。
