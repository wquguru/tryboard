# 调研：成品与实验台能做到多逼真、用什么做

查证日期：2026-10-16（授权和活跃度以 GitHub 仓库 API、npm 元数据、官网许可页为准；"最近活跃"指仓库最近一次推送）。这是技术调研，不是法律意见，上线前授权部分要人复核。

## 一句话结论
**视觉和交互可以做到"像真的"，电气只做到"会报错的直流近似"，声音能做到"真的出声"，语音识别和射频不做。** 具体说：three.js 现成的物理材质、泛光、透射、环境贴图足够让成品页转起来、灯亮、屏幕动、透镜折射；声音用浏览器自带的 Web Audio 就行；电路检查（接错线、短路、限流电阻、电流预算、舵机启动掉电复位）最划算的是**自己写一个小型直流网络求解器（修正节点分析，MNA）放进 Rust 内核**，ngspice 只当本机对照，不进网站首包；物理只在"给传感器喂数"时需要确定性，这部分自己写，纯观感的碰撞拖拽可以用 Rapier。开源竞品里能直接拿来用的只有 MIT 的 wokwi-elements 一类，其余（Falstad、SimulIDE、Velxio、QEMU）都是 GPL / AGPL，只能参考。

一条贯穿全文的原则：**凡是会影响固件读数的东西，都在内核里按模拟时间确定性地算；3D 场景只负责画出来。** 鼠标操作记成"模拟时间戳 + 事件"的输入日志，同一份日志重放结果必须一样，这样成品页和关卡验收才能共用一套结论。

---

## 1. 电路级仿真

| 候选 | 链接 | 授权 | 成熟度 / 最近活跃 | 浏览器 | 体积 | 我们怎么用 |
|---|---|---|---|---|---|---|
| EEcircuit（ngspice 编译成 wasm） | github.com/eelab-dev/EEcircuit；引擎 npm `eecircuit-engine` | 仓库 MIT；内含 ngspice（见下） | 185 星，2026-10-06 推送；引擎 1.8.0（2026-10-10） | 是，wasm 以内联方式打进 JS | 20.3MB，gzip 后 5.7MB | 不进首包。可选做"进阶：完整 SPICE 瞬态"页面懒加载；更推荐在 `tools/` 里本机跑 ngspice 当对照（像现在对照 QEMU 那样） |
| ngspice 本体 | ngspice.sourceforge.io | 主体为修改版 BSD，但有例外：`xspice/icm/table` 为 GPLv2 或更新，KLU 与 numparam 为 LGPLv2，OSDI 为 MPL 2.0，手册 CC BY-SA 4.0 | 老牌、持续维护 | 需自行编译 | — | 本机对照进程。若要上网站，必须确认编译产物不含 table 代码模型（否则该 wasm 受 GPL 约束），LGPL 部分要提供源码与重链接条件 |
| Falstad CircuitJS1 | github.com/pfalstad/circuitjs1（另有 sharpie7 分支） | GPL-2.0 或更新 | pfalstad 分支 2026-10-13 仍在推送，2416 星；sharpie7 分支 2024-01 后不活跃 | 是（GWT 编译的 JS） | 约数 MB | 只参考它的交互（电流动画小点、电压着色）和公开的 MNA 方法论，不复制代码、不嵌进我们的包；可以外链让用户去它的网站自己画 |
| tscircuit 的 SPICE 模拟 | docs.tscircuit.com | 未逐项核对 | 活跃 | 是 | — | 了解即可，不推荐依赖 |

**自己写直流网络求解器（MNA）可行性：高，推荐。**
- 规模：一个桌面项目的网络通常不到 100 个节点，稠密矩阵 LU 分解每次不到一毫秒，每 1ms 模拟时间解一次也完全够用。
- 需要的元件模型：电压源（USB 5V、电池）、电阻、开关 / 按键、二极管与 LED（指数模型或分段线性，按颜色给正向压降）、GPIO 引脚（输出时等效为 3.3V 加输出电阻，按驱动档位给几十欧；输入时高阻加约 45kΩ 上下拉）、LDO（带压降与限流的受控源）、电容（后向欧拉伴随模型，用来做浪涌和掉压）、负载电流源（舵机、WS2812、Wi-Fi 发射峰值，由各自的行为模型给出随时间变化的电流）。非线性元件用牛顿迭代。
- 能查出的问题：GPIO 直接对地短路或两个输出对打（电流远超约 40mA 上限）、LED 没串限流电阻（电流超额定，"灯烧了"）、5V 接进 GPIO（超过约 3.6V 绝对最大值）、总电流超过 LDO 或 USB 供电能力、舵机启动或堵转时 3.3V 掉到欠压检测门限以下 → 内核触发欠压复位（确定性，可以进关卡验收）。
- 不能查出的：开关电源纹波、高频振铃、模拟噪声、ADC 噪声频谱。这些标"必须上真机"。
- 工作量：Rust 内核里新 crate 约 1500 到 2500 行，含元件模型、求解器、与面包板连线的绑定、单元测试和与本机 ngspice 的对照测试，约 2 到 3 周。MNA 是教科书方法（Ho、Ruehli、Brennan 1975），不涉及 GPL 代码。
- 可信度标签：网络求解结果标"估算"，阈值来自数据手册；欠压复位标"行为模拟"。

---

## 2. 竞品与可借鉴的开源件

| 项目 | 链接 | 授权 | 活跃度 | 浏览器 | 我们能用什么 | 不能用什么 |
|---|---|---|---|---|---|---|
| wokwi-elements | github.com/wokwi/wokwi-elements；npm `@wokwi/elements` 1.9.2 | MIT | 265 星，2026-10-12 推送 | 是（Web Components，SVG） | 可以直接用或改：二维元件外观（LED、按键、电位器、舵机、OLED、各种传感器），做面包板二维视图、元件图标、3D 里的贴图。只是外观，没有仿真逻辑。用时保留 MIT 声明 | 不用 "Wokwi" 名称做宣传 |
| avr8js | github.com/wokwi/avr8js，npm 0.21.1 | MIT | 850 星，2026-08-31 推送 | 是（纯 TS） | 架构参考（外设按周期惰性推进、和 UI 解耦的写法）；将来要支持 Arduino Uno 时可直接引入 | — |
| rp2040js | github.com/wokwi/rp2040js，npm 1.4.0 | MIT | 531 星，2026-09-25 推送 | 是（纯 TS） | 同上，将来支持 Pico 可直接引入 | — |
| wokwi-docs | github.com/wokwi/wokwi-docs | MIT | 2026-10-14 推送 | — | 参考 `diagram.json` 连线格式、自定义芯片 API 的设计思路（自定义器件编译成 wasm 插进模拟器） | — |
| Wokwi 模拟器本体（含 ESP32） | wokwi.com | 闭源商业服务（未找到公开源码） | 活跃，乐鑫文档有集成页 | 是 | 只当竞品参考：产品体验、示例组织 | 不能用任何代码 |
| wokwi-boards | github.com/wokwi/wokwi-boards | **无授权声明** | 2026-09-15 | — | 不用 | 无授权即不可用 |
| Velxio | github.com/davidmonterocrespo24/velxio | **AGPL-3.0**，另售商业授权 | 3285 星，2026-10-16 推送；乐鑫开发者博客 2026-07 介绍过 | 前端在浏览器，ESP32 部分靠 QEMU 分支，整套用 Docker 部署 | 参考产品形态（多板、元件库、自托管）和 ESP32 支持范围 | AGPL 代码一行不碰；它的 ESP32 核心来自 QEMU（GPL） |
| Renode | github.com/renode/renode | MIT | 3031 星，2026-10-16 推送 | 否（C# / .NET 桌面与服务器） | 参考外设建模粒度、测试脚本化思路；ESP32 官方未支持，社区有 S3 移植 | 不进浏览器，不作依赖 |
| SimulIDE | simulide.com；GitHub 镜像 SimulIDE/SimulIDE | GPL-3.0 | 镜像 2021 后不更新；官网论坛 2025-11 称 ESP32 只在测试版 | 否（Qt 桌面） | 参考"数字 MCU + 模拟电路混合实时仿真"的交互 | 不复制代码 |
| Tinkercad Circuits | tinkercad.com | Autodesk 闭源 | 活跃 | 是 | 参考教学体验：LED 过流"烧毁"提示、万用表探头、面包板拖线手感 | — |
| Fritzing 元件库 | github.com/fritzing/fritzing-parts | 图形与文档 CC BY-SA 3.0 | 2026-08-12 推送 | — | 面包板视图 SVG 可用，但要署名且我们的派生图要同协议 | 不想同协议就别用 |

结论：**能直接进网站的只有 MIT 的 wokwi-elements（外观）和 avr8js / rp2040js（未来别的芯片）**。我们的 ESP32 内核是自研的，这正是和 Velxio（靠 QEMU，AGPL）的差别，要继续保持"只读规格、不读实现"。

---

## 3. 3D 渲染与物理

### 渲染（three.js 生态）

| 候选 | 链接 | 授权 | 活跃度 | 用途 | 说明 |
|---|---|---|---|---|---|
| three.js | github.com/mrdoob/three.js；npm 0.186.1（2026-09） | MIT | 11.6 万星，每天推送 | 现有渲染器 | 仓库当前锁 0.170.0，落后 16 个版本。官方手册说明 WebGPURenderer 在不支持 WebGPU 时自动回落 WebGL2；材质写法转向 TSL（节点材质，同时编译成 WGSL 和 GLSL） |
| WebGPURenderer + TSL 后期 | threejs.org/manual（WebGPURenderer 页） | MIT | 第三方文章普遍认为 r171 起可用于生产；Firefox 部分平台仍有黑屏报告 | 迁移目标 | 现有 `EffectComposer` + `UnrealBloomPass` 不能直接用在 WebGPU 上，要换成 TSL 的后期节点（bloom 节点）。迁移工作量约 1 周，收益是更多光源和计算着色器，不是第一档必须 |
| MeshPhysicalMaterial | three.js 内置 | MIT | 成熟 | 外壳与透镜 | `transmission`、`ior`、`thickness`、`roughness` 做透明 / 磨砂扩散罩和透镜折射（屏幕空间近似：能看到折射扭曲，但放大倍率不是真光学）；`clearcoat` 做亮面塑料；`sheen` 做硅胶。仓库 board3d.ts 已在用 transmission 和 RoomEnvironment |
| 泛光 | three.js 的 UnrealBloomPass（已在用）；pmndrs/postprocessing 6.39.5（Zlib，仅 WebGL） | MIT / Zlib | 成熟 | LED 辉光、屏幕溢光 | 关键是 LED 发光材质亮度给到大于 1（HDR），再按阈值泛光，避免整屏发糊 |
| 环境光 | Poly Haven HDRI | CC0（官网许可页：不需署名，可商用） | 持续更新 | 真实反射与环境光 | 选一张工作台 / 室内 HDRI，PMREM 预过滤；1K 到 2K 分辨率 HDR 约 1 到 6MB，可转 KTX2 |
| 路径追踪 | github.com/gkjohnson/three-gpu-pathtracer | MIT | 1912 星，2026-10-12 推送 | 成品"拍照"静帧 | 实时不现实，适合用户点"拍一张"时渐进渲染几秒，得到带焦散感、柔和阴影的照片 |
| 网格加速 | github.com/gkjohnson/three-mesh-bvh | MIT | 2026-10-12 推送 | 射线拾取、装配碰撞检测、超声波射线 | 外壳装配"装不进去"的判断、鼠标点到屏幕哪个像素 |

### 物理引擎

| 候选 | 链接 | 授权 | 活跃度 | wasm 体积 | 说明 |
|---|---|---|---|---|---|
| Rapier | github.com/dimforge/rapier（JS 绑定已并入主仓库 `typescript/` 目录，旧 rapier.js 仓库 2026-07 归档）；npm `@dimforge/rapier3d-compat` 0.21.0 | Apache-2.0 | 5873 星，2026-10-10 推送 | 3.1MB，gzip 1.17MB | 刚体、关节、凸分解碰撞；有"增强确定性"编译选项。适合纯观感：拖动物体、外壳盖上时的碰撞、成品被推一下晃动 |
| Jolt Physics | github.com/jrouwe/JoltPhysics.js；npm `jolt-physics` 1.1.0 | MIT | 绑定 579 星（2026-08-23）；本体 1.17 万星每天推送 | 约 3.2MB，gzip 约 0.9MB | 性能好、体积更小，API 偏 C++ 风格。备选 |
| MuJoCo 官方 wasm | github.com/google-deepmind/mujoco（`wasm/` 目录）；npm `@mujoco/mujoco` 3.16.0（2026-10-14，DeepMind 维护） | Apache-2.0 | 1.57 万星，每天推送 | 10.7MB，gzip 2.6MB | 机器人 / 执行器建模最强（舵机位置伺服、齿轮、腱），但对桌面小项目偏重。做机械臂、小车类项目时再考虑 |

**建议**：舵机、转台、IMU 姿态这些会反过来影响固件读数的，不用第三方引擎，在 Rust 内核里自己写（几十到几百行，按模拟时间推进，天然确定性；AGENTS.md 也规定内核不引第三方 crate）。Rapier 只在网页侧做不影响读数的观感物理。

### 舵机二阶动力学模型（自研）
- 输入：LEDC 脉宽 0.5 到 2.5ms 映射到目标角 0 到 180°，有约几微秒死区（SG90 类）。
- 内部：位置伺服 = 比例控制器 + 电机。电机端 `J·θ'' = Kt·i − b·θ' − τ负载`，电流受供电电压和绕组电阻限制，速度饱和约 0.1 秒每 60°（SG90 在 4.8V 的标称值，估算）。
- 输出：角度（给 3D 和 IMU）、电流（给 MNA 网络：静止约 10mA 级，转动一两百 mA，堵转数百 mA 到安培级，按型号给，标"估算"）、可选"齿偏"（已有的 14.4° 舵盘装配误差）。
- 和电源联动：启动瞬间大电流 → MNA 里 LDO 输入掉压 → 3.3V 低于欠压门限 → 芯片复位。这就是"舵机一转板子就重启"的经典故障，能确定性复现。
- 工作量：模型加单元测试约 3 到 5 天；和 MNA 联动另计。

---

## 4. 声音

| 用途 | 技术 | 授权 | 浏览器 | 需要的模拟器外设 | 工作量 |
|---|---|---|---|---|---|
| 无源蜂鸣器 | Web Audio `OscillatorNode`（方波）+ 一个带通滤波器模拟压电片 2 到 4kHz 谐振 | 浏览器标准 | 全部主流浏览器 | LEDC 频率与占空比（已有） | 1 到 2 天 |
| 有源蜂鸣器 | 固定频率振荡器，随 GPIO 电平开关 | 同上 | 同上 | GPIO（已有） | 半天 |
| I2S 扬声器（MAX98357A） | `AudioWorklet` 播放采样流；主线程或 Worker 把采样块经 `port.postMessage` 送进去（用 SharedArrayBuffer 环形缓冲更好，但网站要开跨源隔离头 COOP / COEP） | 同上 | 同上 | I2S 发送 + GDMA 发送（S3 的 GDMA 已部分有；I2S 尚未做）。MAX98357A 本身没有寄存器，只是解码 I2S，模型很薄 | I2S 外设 1 到 2 周；播放链 3 到 5 天 |
| I2S 麦克风（INMP441） | `getUserMedia` 取浏览器麦克风 → AudioWorklet 重采样到 16kHz 等 → 送入内核 I2S 接收 | 同上 | 需要用户授权麦克风；要 HTTPS | I2S 接收 + GDMA 接收（RX 方向尚未经固件验收） | 1 周（在 I2S 发送之后） |
| 可选：Tone.js | npm `tone` 15.1.22 | MIT | 是 | — | 不需要，原生 API 足够 |

要点：
- **确定性**：实时麦克风输入每次不一样，只用于"玩"；验收用固定的 WAV 文件喂 I2S 接收，结果可复现。页面上把实时麦克风标成"不进验收"。
- **时钟对齐**：模拟时间和墙钟不同步时（模拟慢于实时），音频会断续。做法是以模拟时间为准生成采样，播放端维持 100 到 200ms 缓冲，跟不上时显示"模拟慢于实时，声音降速"而不是乱掉。
- **ESP-ADF / esp-sr / 小智**：
  - ESP-ADF（github.com/espressif/esp-adf）和 esp-sr（github.com/espressif/esp-sr）授权是 **"ESPRESSIF MIT License"**，原文写明"Permission is hereby granted for use on all ESPRESSIF SYSTEMS products"，即只授权用于乐鑫产品。用户自己的固件跑在我们模拟器里问题不大，但**我们托管用它们编出的示例固件**是否算"用于乐鑫产品"有疑问，要书面问乐鑫。
  - esp-sr 的唤醒词 / 命令词是闭源静态库加模型，在 S3 上用了 PIE 向量指令（我们的 S3 核尚未实现 PIE），而且需要 240MHz 双核实时算力。要跑通得先补 PIE、再看模拟速度，工作量以月计，列入第三档。
  - xiaozhi-esp32（github.com/78/xiaozhi-esp32，MIT，3.1 万星，2026-10-16 推送）的硬件面：I2S 麦克风 + I2S 功放（或 ES8311 这类 I2C 配置、I2S 传数据的编解码芯片）、屏幕、Wi-Fi + WebSocket / MQTT 连服务器。我们网站不带 AI，可以提供一个确定性的"假服务器"（固定回应、回放一段预录音频），验证"录音 → 上传 → 播放回复 → 屏幕表情"整条链路。

---

## 5. 屏幕与输入

| 器件 / 功能 | 接口 | 在 ESP-IDF 里的驱动 | 我们要做什么 | 工作量 |
|---|---|---|---|---|
| LVGL 图形库 | — | lvgl/lvgl（MIT，2.5 万星，每天推送）；乐鑫 `esp_lvgl_port`（esp-bsp 内，Apache-2.0） | 固件里跑 LVGL 需要：esp_timer 节拍（SYSTIMER 已有）、FreeRTOS 任务（已有）、esp_lcd 面板（SPI + GDMA 在 S3 已有；八位并口 / RGB 屏要 LCD_CAM 外设，未做）、绘图缓冲（内部 RAM 或 PSRAM，S3 PSRAM 已有）、触摸驱动（见下）。真正的门槛是**模拟速度**：LVGL 动画是纯 CPU 绘制，要测我们的 S3 核每秒能跑多少条指令，再决定是否先做指令块缓存加速 | 跑通示例 3 到 5 天（假定速度够）；LVGL 官方另有 `lv_web_emscripten`（MIT）可把 UI 直接编成网页，但那不是跑用户固件，只能做"预览"，不推荐 |
| 电容触摸 CST816S | I2C 0x15 + INT 脚 | `esp_lcd_touch_cst816s`（乐鑫组件库） | 寄存器模型：触点数、坐标、手势寄存器；鼠标在 3D 屏幕上点击 / 拖动 → 射线求屏幕坐标 → 写进模型并拉低 INT | 2 到 3 天 |
| 电容触摸 FT6236 / FT5x06 | I2C 0x38 + INT | `esp_lcd_touch_ft5x06` | 同上，寄存器布局不同 | 2 到 3 天 |
| 电阻触摸 XPT2046 | SPI + 中断脚 | `esp_lcd_touch_xpt2046`（社区，MIT） | 需要 SPI 的 MISO 数据通路（现在 MISO 恒读全 1，要补）；按压力、坐标换算 12 位 ADC 值 | 3 到 4 天 |
| 旋转编码器 | 两路正交信号 | S3：PCNT 外设（脉冲计数器）；C3 **没有 PCNT**，只能用 GPIO 中断（esp-iot-solution 的 knob 组件） | S3 要新建 PCNT 模型；鼠标拖旋钮 → 按模拟时间生成正交边沿序列（含可选抖动） | PCNT 3 到 5 天；边沿注入 1 天 |
| 电位器 | ADC | 已有 | 鼠标拖动旋钮 → 电压；再加"到端点有阻尼感"的 UI | 1 天 |
| 超声波 HC-SR04 | Trig 输出 ≥10µs、Echo 回脉冲 | 固件常用 GPIO 中断 + esp_timer，或 RMT 接收（C3 RMT 接收未做），或 S3 的 MCPWM 捕获 | 器件模型：看到 Trig 脉冲后延时约 0.5ms 输出宽度 = 2×距离÷声速 的 Echo 脉冲。距离由场景射线给出，但为了确定性，射线命中的结果按模拟时间记入输入日志（手靠近传感器 = 一串"距离随时间"的事件） | 3 到 4 天 |
| IMU MPU6050 | I2C 0x68 | 社区驱动众多 | 原始加速度 / 角速度寄存器、量程、采样率分频、FIFO；DMP（内置姿态解算固件）不做。数据来源：内核里的刚体姿态（转台角度、用户拖动板子倾斜），加速度 = 机体系下的（重力 + 线加速度），角速度 = 机体系角速度，噪声用固定种子 | 4 到 5 天 |
| IMU QMI8658 | I2C 0x6A / 0x6B | 乐鑫 BSP 有驱动 | 同上 | 3 到 4 天（共用姿态源） |
| 电容触摸按键（S3 TOUCH 外设） | 芯片内置 | IDF touch_sensor | 新外设模型；手指靠近 = 电容计数变化 | 1 周 |

所有输入都走同一套"输入日志"：鼠标事件 → 转成模拟时间戳的器件输入 → 内核消费。验收时直接重放日志。

---

## 6. 3D 模型来源与管线

| 来源 | 链接 | 授权 | 活跃度 | 内容 | 能否上网站 |
|---|---|---|---|---|---|
| KiCad 官方 3D 库 | gitlab.com/kicad/libraries/kicad-packages3D（GitHub 镜像已于 2021 归档） | CC BY-SA 4.0，加一条例外：用库做**电子设计**及其生成文件时放弃第 3 条（署名等）要求 | GitLab 2026-10-14 仍有活动 | 电阻、电容、LED、排针、USB 座、各种封装，STEP + WRL | 可以，但例外条款只覆盖"电子设计"，**我们把模型作为网页素材再分发不在例外内**：要署名，转换后的 glTF 也要以 CC BY-SA 4.0 公开 |
| 乐鑫 KiCad 库 | github.com/espressif/kicad-libraries | 同 KiCad：CC BY-SA 4.0 + 同一例外 | 1407 星，2026-07-28 推送 | ESP32-C3-MINI-1、C3-WROOM-02、S2 / C6 / H2 模组等的 STEP | 可以，条件同上；模组屏蔽罩上的乐鑫标志按 LICENSING 规则去掉或换成中性纹理 |
| Adafruit CAD Parts | github.com/adafruit/Adafruit_CAD_Parts | MIT | 1514 星，2026-10-01 推送 | Feather ESP32-S3、QT Py ESP32-C3 / S3 等整板模型 | 可以，保留 MIT 声明；丝印上的品牌标志去掉 |
| Seeed OPL 库 | github.com/Seeed-Studio/OPL_Kicad_Library | CC BY-SA 4.0 | 2026-06-23 推送 | XIAO 系列等 | 可以，署名 + 同协议（LICENSING 已记） |
| Poly Haven | polyhaven.com | CC0 | 持续 | HDRI、桌面材质、房间道具 | 可以，无需署名 |
| SnapEDA、Ultra Librarian、GrabCAD 等平台 | — | 平台服务条款，通常禁止再分发（本轮未逐条核对） | — | 大量模组 / 器件 | 默认不用 |
| 乐鑫官网原理图 / PCB 下载 | espressif.com | 无授权声明 | — | 开发板 | 不用（LICENSING 已记） |

**浏览器加载 STEP**

| 候选 | 链接 | 授权 | 活跃度 | 体积 | 结论 |
|---|---|---|---|---|---|
| occt-import-js | github.com/kovacsv/occt-import-js，npm 0.0.23 | LGPL-2.1 | 289 星，2024-12 后无推送 | wasm 7.6MB，gzip 3.1MB | 能用但停更、体积大。只在"用户上传自己的 STEP 外壳"时按需懒加载，作为独立模块分发并附源码链接即可满足 LGPL |
| opencascade.js | github.com/donalffons/opencascade.js | LGPL-2.1 | 2023-08 后无推送 | 约 67MB 包 | 不用 |
| OCCT 本体 / FreeCAD / CadQuery | Open-Cascade-SAS/OCCT（LGPL-2.1，活跃）；FreeCAD（LGPL-2.1，活跃） | LGPL-2.1 | 活跃 | 本机工具 | 推荐用于**离线转换**，工具不随网站分发，没有授权负担 |

**推荐管线**：STEP（KiCad / 乐鑫 / Adafruit）→ 本机用 OCCT 或 FreeCAD 批量转 glTF（脚本放 `tools/`）→ glTF-Transform（MIT，github.com/donmccurdy/glTF-Transform，2026-10-13 推送）做合并、简化、meshopt 压缩、贴图转 KTX2 → three.js GLTFLoader 加载。每个转换产物旁边写明来源、授权和署名，生成一页第三方素材清单。用户自己的外壳优先支持 STL / 3MF / glTF 上传（three.js 自带加载器，MIT），STEP 走懒加载。

---

## 推荐技术栈

### 直接用（授权干净，进网站）
- three.js（MIT）：渲染；先在 WebGL2 上把第一档做完，再迁到 WebGPURenderer + TSL。
- three-mesh-bvh（MIT）：拾取、射线、装配干涉。
- three-gpu-pathtracer（MIT）：成品"拍照"静帧。
- Rapier（Apache-2.0）：只做观感物理（拖拽、碰撞、晃动）。
- Web Audio + AudioWorklet（浏览器标准）：蜂鸣器、I2S 扬声器、麦克风。
- wokwi-elements（MIT）：二维元件外观与图标。
- Poly Haven（CC0）：HDRI 与材质。
- glTF-Transform（MIT）：模型压缩管线。
- Adafruit CAD Parts（MIT）；KiCad 官方库、乐鑫 KiCad 库、Seeed OPL（CC BY-SA 4.0，署名 + 同协议）：器件与板子模型。
- occt-import-js（LGPL-2.1）：仅用户上传 STEP 时懒加载。

### 只参考（不进代码）
- Falstad CircuitJS1（GPL）：电流动画、电压着色的交互。
- SimulIDE（GPL）、Velxio（AGPL）、espressif/qemu（GPL）：功能范围与产品形态。
- Wokwi 模拟器（闭源）、Tinkercad（闭源）：教学体验、示例组织、"LED 烧了"提示。
- Renode（MIT，但架构不适合浏览器）：外设建模粒度与测试脚本化。
- ngspice / EEcircuit：在 `tools/` 里本机跑，当 MNA 求解器的对照基准；EEcircuit 可作为第三档"完整 SPICE"可选页面。
- MuJoCo（Apache-2.0）：做机械臂 / 小车时再评估。

### 自研（进 Rust 内核，保证确定性）
- 直流网络求解器（MNA）+ 元件模型：接错线、短路、限流、电流预算、LDO 压降、欠压复位。
- 舵机二阶动力学 + 电流曲线；转台 / 板子姿态的简单刚体，作为 IMU 数据源。
- I2S 外设（S3、C3）、GDMA 接收方向、PCNT（S3）、SPI MISO 通路、电容触摸（S3）。
- 器件模型：CST816S、FT6236、XPT2046、HC-SR04、MPU6050、QMI8658、MAX98357A、INMP441。
- 输入日志：鼠标交互转成模拟时间事件，可重放、可验收。

---

## 逼真度分级

### 第一档：马上能做（几天，用现有内核能力）
- 成品页从 SVG 换成能转的 3D：鼠标拖动旋转、滚轮缩放，外壳用物理材质（亮面塑料带清漆、磨砂塑料、透明亚克力），HDRI 环境光带来真实反射和柔和阴影。
- LED 有辉光并照亮外壳：发光材质 + 泛光；每颗 LED 配一盏弱点光源，在外壳内壁和桌面上投出颜色；磨砂扩散罩让光变柔。WS2812 颜色、亮度来自固件真实输出。
- 屏幕动态：OLED 和 GC9A01 圆屏的帧缓冲每帧更新成贴图，屏幕自发光、四周轻微溢光，表面叠一层玻璃反光。
- 透镜小人：透镜用透射材质折射屏幕，转动视角能看到折射扭曲（屏幕空间近似，标"示意"）。
- 蜂鸣器出声：LEDC 频率驱动方波振荡器，有源 / 无源两种音色。
- 鼠标可操作：点按键（板载 BOOT、用户按键）、拖动电位器旋钮（进 ADC）、拖动"热源 / 手"靠近 BME280 改温湿度（已有滑块改成场景交互）。
- 舵机转台按 LEDC 脉宽转动（先用一阶限速），装配时的舵盘齿偏照样体现。
- 一键截图。

### 第二档：几周（要新外设模型或新子系统）
- 电路检查：MNA 直流求解，面包板上接错线立刻标红；GPIO 短路、两个输出对打、LED 没接限流电阻（灯"烧掉"变暗并冒提示）、5V 接进 GPIO；电流预算表；LDO 压降；舵机启动大电流导致 3.3V 掉压 → 芯片欠压复位，串口里出现真实的复位日志。
- 舵机二阶动力学：起步加速、过冲、带负载变慢、堵转电流，转台惯性可见。
- 扬声器真的播放固件输出的 I2S 音频（MAX98357A）；麦克风接浏览器麦克风（只玩不验收）或固定 WAV（进验收）。
- 触摸屏：在 3D 屏幕上直接点、滑，固件通过 CST816S / FT6236 读到坐标和手势。
- 旋转编码器（S3 的 PCNT）、超声波测距（手靠近，距离读数跟着变）、IMU 由转台转动和用户拖动板子倾斜驱动。
- LVGL 示例界面在模拟器里跑起来（前提是模拟速度够）。
- 灯带照亮整个外壳：多光源或光照探针，半透明外壳整体透光。
- 3D 模型管线落地：KiCad / 乐鑫 / Adafruit STEP 转 glTF，实验台和成品用真实比例的器件模型。
- 迁到 WebGPU 渲染器（可选，换来更多光源）。
- 成品"拍照"模式：路径追踪几秒出一张产品照。

### 第三档：难，或者不做
- 完整 SPICE 瞬态：开关电源纹波、振铃、模拟噪声、ADC 噪声频谱。最多做成可选的 ngspice 页面（懒加载 5.7MB），结论标"估算"。
- 语音唤醒和命令词识别（esp-sr）：需要 S3 的 PIE 向量指令、实时算力，库是闭源且授权限定乐鑫产品。暂不做。
- 摄像头读 3D 渲染画面（M8）：可做但重，单列里程碑。
- 射频：信号强度随距离和墙体衰减、天线方向图、真实干扰。标"必须上真机"。
- 外壳内温升的热仿真：只做现在这种估算（传感器贴芯片 +2.5℃）。
- 真实光学：透镜真实放大倍率与焦散、LED 视角光斑精确分布。不做，透镜放大用已有的档位估算。
- 3D 打印公差、卡扣受力、跌落：不做。
- 电机电磁噪声、电刷火花、浪涌电流精确波形：只做 MNA 里的估算。

---

## 授权风险清单

| 风险 | 等级 | 说明 | 处理 |
|---|---|---|---|
| ESP-ADF、esp-sr 的"ESPRESSIF MIT License" | 高 | 授权只写"用于乐鑫产品"；我们托管用它们编出的示例固件、在非乐鑫硬件（模拟器）上运行，是否被允许不明确；esp-sr 还含闭源库与模型 | 不托管这类示例固件；用户自带的固件可以跑；上线前书面问乐鑫 |
| ngspice 编进 wasm | 中 | 主体 BSD，但 `xspice/icm/table` 为 GPLv2+，KLU、numparam 为 LGPL；EEcircuit 的构建是否含 table 模型未核对 | 不进首包；若上网站，先确认编译配置并在第三方授权页列出 ngspice 各部分；本机对照无风险 |
| Falstad、SimulIDE（GPL）、Velxio（AGPL）、espressif/qemu（GPL） | 中 | 复制或翻译代码会让整体被 GPL / AGPL 约束 | 只看公开文档和交互，不读实现细节写代码；在 DECISIONS 里记录参考了什么 |
| KiCad 与乐鑫 KiCad 库的 3D 模型（CC BY-SA 4.0） | 中 | 例外条款只覆盖电子设计，网站再分发模型要署名、派生模型同协议 | 转换后的模型单独放、整体以 CC BY-SA 4.0 公开，第三方素材页署名；不和我们的代码混在一个授权里 |
| 模型上的商标（乐鑫、Adafruit 标志） | 中 | 模组屏蔽罩、丝印上带标志，和 LICENSING 的"不用乐鑫 logo"冲突 | 转换时去掉标志纹理，换成中性丝印 |
| Fritzing 元件图（CC BY-SA 3.0） | 低到中 | 用了就要署名并同协议 | 优先用 MIT 的 wokwi-elements；确需 Fritzing 时单独署名 |
| occt-import-js（LGPL-2.1） | 低 | 静态打进主包会带来重链接义务 | 作为独立 wasm 懒加载，附源码链接 |
| wokwi-boards 等无授权声明的仓库 | 低 | 无授权即不可用 | 不用 |
| SnapEDA、GrabCAD 等平台模型 | 低 | 服务条款通常禁止再分发 | 不用 |
| 浏览器麦克风 | 低（隐私） | 采集用户声音 | 只在本地处理、不上传，页面写明；验收用 WAV |
| "Wokwi"等竞品名称 | 低 | 商标 | 对比时只做事实描述，不用于宣传 |

主要来源：github.com/eelab-dev/EEcircuit · ngspice COPYING（sourceforge.net/p/ngspice） · github.com/pfalstad/circuitjs1 · github.com/wokwi/wokwi-elements · github.com/wokwi/avr8js · github.com/wokwi/rp2040js · github.com/davidmonterocrespo24/velxio（LICENSE 为 AGPL-3.0，另有 COMMERCIAL_LICENSE.md） · developer.espressif.com/blog/2026/07/velxio-browser-based-esp32-simulation · github.com/renode/renode · simulide.com 论坛 · threejs.org/manual（WebGPURenderer） · github.com/dimforge/rapier · github.com/jrouwe/JoltPhysics.js · github.com/google-deepmind/mujoco · github.com/espressif/esp-adf 与 esp-sr 的 LICENSE · github.com/78/xiaozhi-esp32 · github.com/lvgl/lvgl · gitlab.com/kicad/libraries/kicad-packages3D 的 LICENSE.md · kicad.org/libraries/license · github.com/espressif/kicad-libraries 的 LICENSE.md · github.com/adafruit/Adafruit_CAD_Parts · github.com/fritzing/fritzing-parts 的 LICENSE.txt · polyhaven.com/license · github.com/kovacsv/occt-import-js · github.com/donmccurdy/glTF-Transform。npm 版本与包体积为 2026-10-16 用 `npm view` 和下载包实测。
