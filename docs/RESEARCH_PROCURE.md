# 调研：采购与装配（a 采购 → b 必选与模版 → c 实验台 → d 组装 → e 成品）

查证日期 2026-10-16（代理调研，一手来源为主，非法律意见；上线 / 收费前要人复核）。只读调研，未改代码。

## 一句话结论
**采购段**能做到"按作品一键带出 BOM + 二十多条确定性规则当场拦坑 + 参考价外链到店"，数据全部自建（几十个常用件手工录入、按季度核价），**不接任何电商 API**——LCSC / Mouser / DigiKey 的 API 要申请审核且条款限制再展示，淘宝 / 1688 只能放外链；**装配段**能做到"拖进外壳就位 → 装法选择改变仿真读数 → 导出 STL/3MF 外链到打印服务"，用 three.js（已有）+ Manifold wasm（Apache-2.0、0.54 MB）自研吸附与参数化外壳，物理引擎不需要。两段都是自研为主，规则表与元件库约 3–4 周、外壳参数化约 2–3 周。

---

## 1. 元器件数据

| 来源 | 内容 | 授权 / 条款 | 浏览器直接用？ | 我们怎么用 | 自研量 |
|---|---|---|---|---|---|
| **LCSC 立创商城官方 API**（[lcsc.com/agent](https://www.lcsc.com/agent)） | 关键词搜索、详情（含价格、阶梯价）、分类、购物车、下单 | 要先有账号并**申请审核**；默认 1000 次/天、200 次/分；"价格随官网变动"，未见公开的缓存 / 再展示条款；审核不过时官方推荐 Luminovo、CalcuQuote 等第三方 | ❌（需密钥，不能放前端） | **不接**。只用来人工核价；商品页 URL（C 编号）做外链 | 0 |
| **立创 EDA 器件库 / LCSC 器件数据**（[prodocs.lceda.cn](https://prodocs.lceda.cn/en/api/reference/pro-api.ilib_devicesearchitem.lcscprice.html)） | 符号、封装、3D、LCSC 价格（EDA 扩展 API） | 未查到公开的开源授权条款；第三方转换工具（easyeda2kicad）自己声明"不得超出 EasyEDA 服务条款使用" | ❌ | **不搬**。只引用 C 编号与外链 | 0 |
| **JLCPCB 基础库 / 扩展库**（jlcpcb.com/parts） | 贴片用基础件（免换料费）与扩展件 | 官方无批量导出；社区 [yaqwsx/jlcparts](https://github.com/yaqwsx/jlcparts)（代码 MIT）、[tscircuit/jlcsearch](https://github.com/tscircuit/jlcsearch)（代码 MIT，免鉴权搜索接口）——**代码 MIT ≠ 数据授权**，数据来自 JLC 抓取 | 社区接口可以，但不稳定、无授权 | 不用。我们的用户买模块不贴片，JLC 基础库与我们关系不大；将来做"自己画板"时再看 | 0 |
| **Octopart / Nexar**（[nexar.com/compare-plans](https://nexar.com/compare-plans)） | 全球分销商比价、库存、生命周期 | Evaluation 免费额度 100 matched parts（支持文档另写 1000 终身额度，有出入）；Standard 2000、Pro 15000 / 月，价格询价；OAuth 客户端凭证 | ❌（需服务端） | 不用。覆盖的是 DigiKey/Mouser 一类，不覆盖淘宝模块 | 0 |
| **DigiKey Product Information v4**（[developer.digikey.com](https://developer.digikey.com/)） | 价格、库存、参数、媒体 | 需注册应用并同意 API User Agreement（未取得全文） | ❌ | 不用；海外版若有需要再评估 | 0 |
| **Mouser Search API**（[mouser.com/apiterms](https://www.mouser.com/apiterms/)） | 搜索、价格 | 条款要求：不得与 Mouser 竞争、不得与第三方内容混排不区分、**必须标明数据来自 Mouser**，Mouser 可随时终止 | ❌ | 不用 | 0 |
| **淘宝 / 天猫 / 1688** | 国内玩家真正下单的地方（SG90、OLED、BME280 模块） | 商品类接口需申请权限（第三方资料称新应用默认 500 次/天，未经官方核实）；淘宝联盟（淘宝客）转链接口面向推广者，要注册、有佣金合规要求；1688 开放平台面向企业。**普通外链（搜索页 / 店铺页）不需要任何 API** | 外链可以 | **只放外链**：每个元件给"淘宝搜索关键词 + 推荐规格要点"（如"SG90 金属齿 180°"），不放具体店铺、不放联盟推广链接（避免利益冲突与佣金合规；要做先问人） | 小 |
| **KiCad 官方库**（[kicad-symbols LICENSE](https://github.com/KiCad/kicad-symbols)） | 符号、封装、3D 模型 | CC-BY-SA 4.0 + 例外：**用库做出的设计 / 生成文件**免除同协议义务；但**把库（或其一部分，含改过的）作为集合再分发**必须 CC-BY-SA 并保留署名；3D 模型同样是 CC-BY-SA | 数据是文本，可以 | 只**参考尺寸事实**（排针间距、模块外形）自己建模；不把 .kicad_mod / .step 打包进网站 | 0 |
| **Fritzing parts**（[fritzing-parts LICENSE.txt](https://github.com/fritzing/fritzing-parts)） | 面包板视图 SVG（最像我们要的） | **CC BY-SA 3.0 Unported**：用了这些图形，**我们发布的图也要署名并同协议** | SVG 可以 | **不用**。一旦混进页面，相关图形要整体 CC BY-SA，和我们自画素材的授权纠缠；继续自画（`templates.ts` 现在就是自画 SVG） | 0 |
| **Seeed OPL KiCad 库**（[OPL_Kicad_Library](https://github.com/Seeed-Studio/OPL_Kicad_Library)） | Seeed 常用件 | CC-BY-SA-4.0（已在 LICENSING.md） | 可以 | 同 KiCad：只看尺寸 | 0 |
| **立创开源硬件平台 oshwhub** | 开源项目 + BOM | 每个项目自选协议（常见 GPL 3.0、CC BY-NC-SA 等，NC 不能商用）；平台条款页"项目授权许可协议"未取得全文 | — | 只当竞品参考与外链，不搬项目 | 0 |
| **自建元件表**（扩展 `web/src/advisor/data.ts`） | 我们关心的约 40–60 个件：电气参数、I2C 地址、电流、尺寸、外链、参考价 | 事实来自数据手册，我们自己写 | ✅ | **主力** | 1.5–2 周（录入 + 逐条核对） |

### 参考价怎么维护
- 每个件存 `priceCNY: [低, 高]`、`priceSource`（"淘宝搜索 · 前 20 个销量结果的中位区间"）、`priceCheckedAt`（年月）。现在 `advisor/data.ts` 已经有区间价格，补上来源与日期即可。
- 页面上一律写"参考价 ¥x–y（2026-10 查）"，旁边"去淘宝 / 立创搜"外链，不写"最低价"、不写"立即购买"。
- `tools/` 加一个 `price_stale.py`：超过 120 天没核的件在验收报告里列出来，人工按季度更新（几十个件一次 1–2 小时）。不做自动抓取（淘宝反爬 + 条款风险）。
- BOM 合计显示区间（低合计–高合计），并注明"不含运费，模块价格季节波动大"。

---

## 2. 兼容性 / 必选规则引擎

### 可参考的数据与代码

| 来源 | 内容 | 授权 | 我们怎么用 |
|---|---|---|---|
| **ESP-IDF `soc_caps.h`**（components/soc/<chip>/include/soc/soc_caps.h，v5.5.1） | 外设数量：C3 LEDC 6 通道、RMT 2TX/2RX、I2C 1 路、UART 2、GPIO 22；S3 LEDC 8、RMT 4TX/4RX、I2C 2、UART 3、GPIO 49、触摸 15、USB OTG | Apache-2.0（soc 头 Apache-2.0 OR MIT） | 用脚本从 IDF 生成 `caps.json`（与现有 ROM 符号表一样保留来源），资源计数类规则直接查表 |
| **ESPHome 引脚校验**（[esphome/components/esp32/gpio_esp32_c3.py](https://github.com/esphome/esphome/tree/dev/esphome/components/esp32)、`gpio_esp32_s3.py`） | 每颗芯片的 flash/PSRAM 占用脚、USB-JTAG 脚、strapping 脚，以及"报错 / 警告"两级处理 | **Python 部分 MIT**（C++ 运行时才是 GPLv3，见仓库 LICENSE） | 可以照着结构写 TS 版并注明出处；它的分级（禁止 vs 警告）正好对应我们的"必选 / 提醒" |
| **PlatformIO boards JSON**（[platform-espressif32/boards](https://github.com/platformio/platform-espressif32)） | 每块板的芯片、flash 大小、`memory_type`（如 XIAO S3 为 `qio_opi` → 八线 PSRAM）、USB 模式 | Apache-2.0 | 用来确认"这块板 PSRAM 是不是八线、占不占 GPIO33–37"；不含引脚图 |
| **arduino-esp32 `variants/*/pins_arduino.h`** | 板子丝印名 → GPIO（D0→GPIO1 之类）、板载 LED | LGPL-2.1；引脚对应是事实 | 读来核对我们手录的板子引脚表，不复制文件 |
| 乐鑫数据手册 / 勘误表 / 开发板用户指南 | 电气极限、strapping 时序、ADC 勘误 | 事实可用，不搬原文图表（见 LICENSING.md） | 规则的最终依据 |

现有 `web/src/advisor/` 已经有 `pins.flash / strapping / usb / adc1 / psramOctal` 和 `pinProblems`，规则引擎应在它基础上扩成统一的规则表，而不是另起一套。

> 顺带发现一处要修的数据：`advisor/data.ts` 里 C3 写的是"ADC2（GPIO5）在 Wi-Fi 工作时不可用"。IDF v5 文档的说法是 **C3 的 ADC2 因硬件勘误已不再支持**（只能用 `CONFIG_ADC_ONESHOT_FORCE_USE_ADC2_ON_C3` 强开，读数不稳），与 Wi-Fi 无关；S3 才是"ADC2 与 Wi-Fi 共用、读取可能返回 `ESP_ERR_TIMEOUT`"。

### 规则清单草稿（27 条）

级别：**拦**＝不能买 / 不能开机（装配 / 下单前必须改），**警**＝能用但有坑，**提**＝提示。每条都可以确定性计算，不需要 AI。

| # | 级别 | 规则（触发条件 → 提示） | 来源 |
|---|---|---|---|
| R01 | 拦 | C3 用了 GPIO12–17 → "这几脚接着 flash，不能用" | ESPHome gpio_esp32_c3.py；C3 数据手册 |
| R02 | 拦 | S3 用了 GPIO26–32 → "flash / PSRAM 的 SPI 脚" | ESPHome gpio_esp32_s3.py |
| R03 | 拦 | S3 板是八线 PSRAM（N8R8 / N16R8，XIAO S3 等 `qio_opi`）且用了 GPIO33–37 → "被八线 PSRAM 占用" | ESPHome（S3R8 PSRAM pins）；PlatformIO boards `memory_type` |
| R04 | 拦 | S3 用了 GPIO22–25 → "这几个编号芯片上不存在" | ESPHome；S3 数据手册 IO MUX |
| R05 | 警 | C3 的 GPIO9 / S3 的 GPIO0 接了上电会拉低的外设（按键常闭、某些模块带下拉）→ "开机会进下载模式，程序不运行" | 两芯片数据手册 strapping 表；ESPHome `check_strapping_pin` |
| R06 | 警 | C3 GPIO8 上电被拉低 → 下载模式失败；GPIO2 建议上电保持高 | C3 数据手册 strapping |
| R07 | 拦 | S3 GPIO45 上电被拉高、而模组是 3.3 V flash → "flash 供电变 1.8 V，开不了机" | 乐鑫 esp-techpedia S3 指南；S3 数据手册 |
| R08 | 警 | S3 GPIO46 外接上拉 / 高电平外设 → "与 GPIO0 组合成非法启动模式" | 同上 |
| R09 | 警 | 用了 USB D−/D+（C3 GPIO18/19，S3 GPIO19/20）当普通 IO → "USB 串口 / 烧录口会掉，之后只能按 BOOT 烧录" | ESPHome `check_usb_jtag_pin`；数据手册 |
| R10 | 警 | 用了 UART0（C3 GPIO20/21，S3 GPIO43/44）→ "和日志串口冲突，上电会有乱码输出到你的外设" | 开发板用户指南 |
| R11 | 拦 | C3 模拟量放在 GPIO5（ADC2）→ "IDF 已不支持 C3 的 ADC2（勘误），请放 GPIO0–4" | ESP-IDF ADC 文档（C3）+ C3 勘误 |
| R12 | 警 | S3 用 Wi-Fi 且模拟量在 ADC2（GPIO11–20）→ "Wi-Fi 工作时读数可能超时失败，建议 ADC1（GPIO1–10）" | ESP-IDF v5.5 adc_oneshot（S3） |
| R13 | 警 | C3 用了 GPIO11 → "默认是 VDD_SPI 电源脚，当 GPIO 要烧 eFuse（不可逆）" | C3 TRM eFuse（VDD_SPI_AS_GPIO） |
| R14 | 拦 | 外设数量超片上资源：WS2812 灯带路数 > RMT TX（C3 2 / S3 4）；PWM 路数 > LEDC（C3 6 / S3 8）；I2C 总线 > 1（C3） | ESP-IDF soc_caps.h v5.5.1 |
| R15 | 拦 | 同一 I2C 总线两个件同地址：MPU6050 与 DS3231（都 0x68）、PCA9685 与 INA219 / HTU21D（0x40）、两块 SSD1306 都 0x3C → "地址冲突；改跳线到 0x3D / 0x69，或换第二条总线（S3 有两路）" | 各器件数据手册 |
| R16 | 提 | 多个 I2C 模块各自带上拉 → "并联后上拉偏小（如三块 4.7 k ≈ 1.6 k），一般能用；超过 4 块建议拆掉多余上拉" | I2C 规范（NXP UM10204）上拉 / 灌电流 3 mA |
| R17 | 拦 | 5 V 输出信号直接进 GPIO（HC-SR04 Echo、5 V 供电的部分模块）→ "ESP32 引脚不耐 5 V，加分压或电平转换" | 数据手册电气极限（VDD+0.3 V 量级） |
| R18 | 警 | WS2812 用 5 V 供电、数据线直接接 3.3 V GPIO → "高电平门限约 0.7×VDD=3.5 V，3.3 V 处于边缘：短线常能亮，长线 / 部分批次乱闪；加 74AHCT 电平转换或第一颗灯降压供电" | WS2812B 数据手册 VIH |
| R19 | 拦 | 舵机（SG90 等）接到 3V3 引脚供电 → "舵机要 4.8–6 V，从 5V/VBUS 取电" | SG90 规格 |
| R20 | 警 | 舵机 / 灯带 / 电机 + 仅 USB 供电，估算峰值 > 500 mA → "电脑 USB 口可能掉压，板子反复复位；加 5 V 2 A 电源或减少同时动作" | USB 2.0 500 mA；SG90 堵转电流（数百 mA 量级，估算）；WS2812 满白约 60 mA/颗 |
| R21 | 警 | 3V3 轨负载合计（芯片 Wi-Fi 发射峰值约 335 mA + 外设）> 板载 LDO 额定 → "3.3 V 稳压器可能过热 / 掉压" | C3/S3 数据手册射频功耗；板子原理图 LDO 型号（逐板录入） |
| R22 | 警 | 单个 GPIO 直接驱动 > 20 mA 负载（继电器线圈、蜂鸣器、大功率 LED）→ "用三极管 / MOSFET 驱动，继电器加续流二极管" | 数据手册 GPIO 驱动能力（默认驱动档） |
| R23 | 警 | 选了 DevKitC-1 但代码 / 模板用 GPIO48 当板载彩灯 → "v1.1 改到了 GPIO38，看板子丝印版本" | ESP32-S3-DevKitC-1 v1.1 用户指南 |
| R24 | 警 | 引脚与板载外设重复：XIAO S3 用户 LED GPIO21、微雪 1.28″ 圆屏板的屏 / IMU / 电池分压脚（GPIO1 为电池检测）→ "这块板上该脚已经接了东西" | Seeed / 微雪 wiki（逐板录入） |
| R25 | 提 | 需要 USB 键盘 / U 盘 / 摄像头 / 经典蓝牙，但选了 C3 → "C3 没有 USB OTG / 摄像头接口 / 经典蓝牙，换 S3（经典蓝牙要原版 ESP32）" | soc_caps.h（SOC_USB_OTG_SUPPORTED） |
| R26 | 提 | 外壳选了金属 / 天线区上方放了电池、屏幕金属背板 → "Wi-Fi 信号会明显变差（必须上真机）" | 乐鑫模组硬件设计指南（天线净空区） |
| R27 | 必选 | 作品模板必选项：带舵机 → 必带 5 V 电源方案；带锂电 → 必带充电（板载或 TP4056 类）；带面包板 → 必带杜邦线；任何作品 → "能传数据的 Type-C 线"（现在 advisor 已带） | 我们自己的规则 |

规则表格式建议：`rules.json`，每条 `{id, level, when(选型+引脚+装配状态的纯函数条件), msg, source, confidence}`，规则函数写在 TS 里、元数据在 JSON 里；验收：每条规则一对正反用例（`tools/` 下 node 跑），满足 AGENTS.md "每个功能有验收"。

---

## 3. 开发板数据

| 板子 | 引脚 / 板载外设数据源 | 授权 | 能否进网站 | 备注 |
|---|---|---|---|---|
| 乐鑫 ESP32-C3-DevKitM-1 / S3-DevKitC-1 | [esp-dev-kits 文档](https://docs.espressif.com/projects/esp-dev-kits/)（用户指南、引脚表） | 仓库 Apache-2.0；文档图片按 LICENSING.md 记为 CC BY-SA 4.0；espressif.com 原理图下载无授权 | 引脚表是事实 → 自己录；图自己画 | S3 v1.0/v1.1 彩灯脚不同（R23） |
| Seeed XIAO ESP32C3 / S3 / S3 Sense | Seeed Wiki；arduino-esp32 `variants/XIAO_ESP32*`；PlatformIO `seeed_xiao_esp32s3.json`（`qio_opi`） | Wiki 源码仓库 [Seeed-Studio/wiki-documents](https://github.com/Seeed-Studio/wiki-documents) 为 **GPL-3.0**（文字图片不要搬）；OPL 库 CC-BY-SA-4.0 | 事实自己录 | XIAO C3 的 D0/D8/D9 = GPIO2/8/9，正好全是 strapping 脚——典型坑 |
| 合宙 CORE-ESP32-C3 | 合宙 wiki（docs.openluat.com）、数据手册：BOOT=GPIO9，LED 在 IO12/IO13 | 未查到开放授权 | 只录事实 | 便宜、玩家多；有"无内置 flash 版"的说法，按芯片型号确认 |
| M5Stack（AtomS3、StampS3、Core 系列） | [docs.m5stack.com](https://docs.m5stack.com)；[m5stack/m5-docs](https://github.com/m5stack/m5-docs) MIT；M5Unified MIT | 文档仓库 MIT | 引脚表可引用（附 MIT 声明），图仍自画 | 外壳一体，装配段可直接当"成品外壳" |
| 微雪 ESP32-S3-LCD-1.28（圆屏） | [waveshare.com/wiki/ESP32-S3-LCD-1.28](https://waveshare.com/wiki/ESP32-S3-LCD-1.28)：屏 SPI、触摸版 I2C GPIO6/7、背光 GPIO2、GPIO1 电池分压 200k/100k、QMI8658 IMU | 未查到开放授权 | 只录事实，链原理图 PDF | 触摸版与非触摸版引脚不同，要分两条；正好对应 spin / lens 模板的"一板到位"替代方案 |

做法：`boards.json` 每块板 `{chip, module(flash/PSRAM 型号), pins: {丝印名: GPIO}, onboard: [{what, gpio}], power: {ldo, ldoMaxMA, usbOnly}, links, checkedAt}`，引脚对 arduino-esp32 variants 做一次脚本核对。工作量：首批 8 块板约 3–4 天。

---

## 4. 外壳 / 模具

| 方案 | 授权 | 体积（查证） | 浏览器 | 我们怎么用 |
|---|---|---|---|---|
| **Manifold**（[elalish/manifold](https://github.com/elalish/manifold)，npm `manifold-3d` 3.5.4） | **Apache-2.0** | `manifold.wasm` **0.54 MB** | ✅ | **首选**：网格布尔（壳体减开孔、加卡扣、螺柱），速度快、保证流形，导出 STL/3MF 可直接打印 |
| JSCAD（`@jscad/modeling` 2.13） | MIT | 解包 1.6 MB（纯 JS） | ✅ | 备选；API 友好但布尔慢、大模型易卡 |
| replicad + OpenCascade.js | replicad MIT；`replicad-opencascadejs` **LGPL-2.1** | 单个 wasm **22–23 MB** | ✅ 但重 | 不用：体积超首包预算一个数量级，LGPL 还要允许替换；只在需要 STEP 导出 / 圆角时再议 |
| OpenSCAD wasm（[openscad-playground](https://github.com/openscad/openscad-playground)） | **GPL**（Playground 按 GPLv3 部署；openscad-wasm GPL-2.0） | wasm 约 10 MB | ✅ | **不嵌入**（GPL 传染整页）；可以给用户"下载 .scad 自己在 OpenSCAD 打开"——我们生成的 .scad 文本是我们的，不受 GPL 约束 |
| three.js `STLExporter` + 自写 3MF | MIT | 已在用 | ✅ | 导出：STL 用现成导出器；3MF 是 zip + XML，自己写约 1 天（需要单色多零件时用） |

**一键下单打印**：
- **JLC3DP**（[jlc3dp.com/help/article/JLC3DP-API](https://jlc3dp.com/help/article/JLC3DP-API)）：只有**合作伙伴 API**——询价 API 与下单 API，逐家审核、要求公司资质与月订单量，**禁止在合作网站用 JLC 商标 / logo / URL 带 JLC**。我们现阶段拿不到，也不该申请。
- **嘉立创三维猴**、其它国内打印服务：未查到公开 API。
- **结论：只外链**。页面给"下载 STL/3MF → 去嘉立创 3D 打印 / 三维猴 / 淘宝打印店上传询价"，附推荐材料（PLA/PETG/光敏树脂）、壁厚、是否要支撑；不放对方 logo。
- 外链上传页面：JLC3DP 报价页支持 STL/STP/STEP/OBJ/3MF，单次最多 10 个、每个 ≤100 MB（官方帮助页）。

**开源外壳库**：Printables / Thingiverse / MakerWorld 每个模型协议不同，大量是 CC BY-NC(-SA) 或 "Standard Digital File License"（个人非商业、禁止再分发）。**不托管、不改编**，最多以"灵感 / 外链"出现并标作者与协议；我们三套模板的外壳自己参数化生成。

自研量：参数化外壳生成器（盒体 + 开孔 + 卡扣 + 螺柱 + 板子定位，三套模板各一份参数）约 2–3 周；尺寸检查（内腔 ≥ 零件包围盒 + 余量）与 `templates.ts` 现有"内腔高度"检查合并。

---

## 5. 装配交互

| 技术 | 授权 | 用途 | 建议 |
|---|---|---|---|
| three.js（已有）+ `TransformControls` | MIT | 拖拽、旋转 | 用 |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | MIT | 快速射线 / 包围盒相交，做"放不进去 / 穿模"检测与距离计算 | 用（体积小） |
| [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) | MIT | 实时预览开孔 | 可选；最终出图仍走 Manifold |
| 物理引擎：Rapier（Apache-2.0）、cannon-es（MIT）、Jolt.js（MIT） | 均可 | 掉落、碰撞 | **不用**：装配是"槽位吸附"不是物理模拟；物理引擎带来不确定性，违背"确定性实验台" |
| [three-cad-viewer](https://github.com/bernhard-42/three-cad-viewer) | MIT | CAD 风格的爆炸视图、剖切 | 参考交互 |
| [InteractiveHtmlBom](https://github.com/openscopeproject/InteractiveHtmlBom) | MIT | BOM 表 ↔ 板上元件高亮联动 | 参考"点 BOM 行 → 高亮实验台上的件" |
| [Kitspace 1clickBOM](https://github.com/kitspace/1clickBOM) | 未声明 | 一键把 BOM 填进分销商购物车（浏览器扩展） | 只参考思路，我们不做加车 |

**吸附约束的做法（确定性）**：每个零件定义若干"锚点"（螺丝孔、卡扣、轴心、排线口），外壳定义"槽位"；拖拽时在距离阈值内吸附到槽位并对齐朝向，离散选择（就是现在 `Spot` 的 3D 版）。所有结果只取决于"放了哪个槽 + 哪个装法"，可以序列化成 `{placed, choice}`，命令行也能重算——与现有 `Picked` 结构一致。

**装配结果如何影响仿真**（按可信度分档）：

| 装配量 | 怎么算 | 进模拟器？ | 标签 |
|---|---|---|---|
| 传感器离芯片 / LDO 距离 → 温漂 | 距离分段：贴着 +2.5 ℃、≤10 mm +1.0 ℃、通风口 0；再乘负载系数（Wi-Fi 开 / 屏幕亮度） | ✅ 已有（`CHIP_HEAT_OFFSET`），扩成距离函数 | 估算 |
| 排线 / 杜邦线长度 | 两端锚点间路径长 vs 线长；I2C 线长超 ~30 cm 或总电容超限时提示，模拟器里可让 I2C 偶发 NACK（可选，默认关） | 可选 | 估算 |
| 舵盘齿位 / 透镜高度 | 已有：14.4°、1.35× / 1.08× | 只改成品画面 | 估算 |
| 天线上方 / 周围有金属、电池、屏幕背板 | 天线锚点 15 mm 内金属体积 → RSSI 衰减（−3 / −10 dB 档）；进虚拟 Wi-Fi 的 RSSI，弱到一定程度让 `esp_wifi` 掉线重连 | ✅（M6 虚拟网络已在） | **必须上真机**（只做方向性提示） |
| 光照 / 遮挡（光敏电阻在壳内） | 开孔与传感器视线射线，遮挡则读数降 | ✅ 适合（射线本来就是世界层做法） | 行为模拟 |
| 电源走线（舵机线和板子共用细线） | 线长 × 线规电阻 × 峰值电流 → 压降，> 0.3 V 时模拟器触发掉压复位（brownout） | ✅ 可做 | 估算 |
| 内腔干涉、螺丝够不够长 | 包围盒 / BVH 相交 | 只做检查 | 估算 |

---

## 6. 竞品看采购 / BOM

| 竞品 | 采购 / BOM 怎么做 | 对我们的启示 |
|---|---|---|
| **Wokwi** | 没有找到 BOM / 购买功能；`diagram.json` 的 `parts` 就是零件表，元件以 Web Components 呈现（[wokwi-elements](https://github.com/wokwi/wokwi-elements) MIT） | 模拟器圈普遍不碰采购，正是我们的差异点 |
| **Tinkercad Circuits** | 有"元件清单"视图，可导出 BOM（DigiKey Maker 教程描述），不带购买链接 | 至少要能导出 CSV |
| **Seeed / M5Stack 项目页、Hackster** | 项目页顶部"用到的硬件"列表，带自家商城购买链接（页面观察，未逐个核实细节） | 学"作品页先列硬件"的版式，但我们中立、不绑某一家 |
| **立创开源平台 oshwhub** | 项目附 BOM，与立创商城 / 嘉立创 PCB、SMT 一体（页面观察） | 国内用户熟悉"BOM → 立创"这条路；我们的 BOM 也给 C 编号（有的话）方便他们复制 |
| **Protoboard**（2025-10 alpha） | BOM 视图导出 CSV/PDF，带供应商链接与实时价格 | 实时价格要 API，我们用参考价 + 日期替代 |
| **Kitspace** | 开源项目托管 + 1-click BOM 加车（AGPL-3.0 平台） | 加车依赖分销商、对国内模块无用 |

我们的独特之处：**BOM 不是静态清单，而是"模拟器验收过的组合"**——清单上每一行都能在实验台上点亮，并且规则引擎能说出"少了什么会出什么事"。

---

## 推荐方案

| 做什么 | 用 | 参考 | 自研 | 工作量 |
|---|---|---|---|---|
| 元件库（40–60 件，电气 / 地址 / 电流 / 尺寸 / 参考价 / 外链） | — | 数据手册；KiCad 库尺寸 | 扩 `advisor/data.ts` → `parts.json` | 1.5–2 周 |
| 开发板库（首批 8 块） | PlatformIO boards（Apache-2.0）、ESP-IDF soc_caps（Apache-2.0） | arduino-esp32 variants、厂商 wiki | `boards.json` + 核对脚本 | 3–4 天 |
| 规则引擎（27 条起） | — | ESPHome 引脚校验（MIT 部分）的结构与分级 | `rules.ts` + 正反用例 | 1 周 |
| 作品采购模版（weather / spin / lens + 每关的 buy） | — | `levels.json` 的 `buy` 字段 | 模版 → BOM → 规则 → 实验台摆件 | 3–4 天 |
| 买完自动摆上桌 | three.js（已有） | — | BOM 行 ↔ 实验台元件 id 映射 | 2–3 天 |
| 参数化外壳 + STL/3MF 导出 | **Manifold**（Apache-2.0）、three.js STLExporter | JSCAD、three-cad-viewer | 三套外壳参数 + 3MF 写出 | 2–3 周 |
| 3D 装配吸附 | three.js、three-mesh-bvh（MIT） | InteractiveHtmlBom 联动 | 锚点 / 槽位系统（`Spot` 的 3D 版） | 1.5–2 周 |
| 装配 → 仿真影响 | — | — | 温漂距离函数、RSSI 档、压降复位 | 1 周 |
| 下单 / 打印 | — | — | **只外链**（淘宝 / 立创搜索、JLC3DP / 三维猴上传页） | 1 天 |
| 价格维护 | — | — | `price_stale.py` + 季度人工核价 | 半天 + 每季度 1–2 h |

**不用**：LCSC / Nexar / DigiKey / Mouser API（审核 + 条款 + 要服务端，且不覆盖淘宝模块）；Fritzing 图形（CC BY-SA 3.0 传染页面素材）；OpenSCAD wasm 嵌入（GPL）；OpenCascade（23 MB）；物理引擎（不确定性）；联盟推广链接（先问人）。

---

## 页面上能呈现的效果（举例）

**采购（a / b）**
1. 选"会转身的小黄"模版 → 一键带出：S3 开发板、1.28″ GC9A01 圆屏、SG90、5 V 2 A 电源（必选，灰色勾不能去掉，悬停说明"舵机从 USB 取电会让板子复位"）、Type-C 数据线、3D 打印身体（"下载 STL"）。合计"参考价 ¥95–160（2026-10 查）"。
2. 取消 5 V 电源 → 黄条："只靠电脑 USB：舵机启动瞬间估算 600 mA+，超过 USB 2.0 的 500 mA，板子可能反复重启（估算）。"
3. 把开发板换成 ESP32-C3 开发板 → 红条："模版里圆屏用的 GPIO12–15 在 C3 上接着 flash，不能用（R01）"；给出一键重映射（屏的 6 根线改到 GPIO0/1/3/5/6/7，舵机留在 GPIO4，BOOT 键是 GPIO9），并标出任务书里改了哪几行。
4. 加一个 MPU6050 到已有 DS3231 的总线 → 红条："两个都是 0x68。把 MPU6050 的 AD0 拉高改成 0x69。"
5. 加 HC-SR04 → 黄条："Echo 是 5 V 输出，要两颗电阻分压（1 k / 2 k），已加入 BOM（¥0.1）。"
6. 选 XIAO ESP32S3 并把 LED 接 GPIO21 → 提示："这块板 GPIO21 已经接了板载灯。"
7. 每行有"淘宝搜""立创搜"两个外链和"规格要点"（"SG90 · 180° · 塑料齿即可"），没有"立即购买"。

**实验台（c）**
8. 进入实验台，桌面上就是 BOM 里的东西，按模版接好线；没买的件不出现，"缺 5 V 电源"时实验台上的电源轨显示 USB 图标与电流表，舵机动作时电流表冲到红区、串口出现 `Brownout detector was triggered`（掉压复位，估算模型）。

**组装（d）**
9. 3D 拖动 BME280 靠近芯片，距离读数实时变："18 mm → 偏高约 0.6 ℃""贴着 → +2.5 ℃"，第 6 关验收随之通过 / 失败。
10. 把锂电池放在天线正上方 → 天线区出现红色净空框："Wi-Fi 信号约 −10 dB（必须上真机）"，虚拟路由器那边 RSSI 掉到 −78 dBm，偶尔重连。
11. 外壳内腔放不下（加了电池）→ 外壳参数自动加高 8 mm，重新生成，"下载 STL / 3MF · 去嘉立创 3D 打印上传（外链）"。

**成品（e）**
12. 成品卡片列出"本成品的可信度"：逻辑与屏幕 = 仿真验证；温漂 / 电流 = 估算；Wi-Fi 距离 = 必须上真机；以及"买之前还要确认的 3 件事"。

---

## 授权与合规风险

| 风险 | 程度 | 处理 |
|---|---|---|
| 搬运 Fritzing / KiCad / Seeed OPL 图形或 3D 模型 → 页面素材被 CC BY-SA 传染 | 中 | 一律自画；只用尺寸事实；如确需用，单独页面署名同协议并写进 LICENSING.md |
| Seeed Wiki 源码 GPL-3.0、厂商原理图无授权 | 低 | 只录引脚事实，链接原页 |
| ESPHome 代码：照搬 C++ 部分会进 GPLv3 | 低 | 只参考 Python（MIT）部分的结构，自己用 TS 写，注明"参考 ESPHome（MIT）" |
| OpenSCAD wasm（GPL）嵌入页面 | 中 | 不嵌入；只导出 .scad 文本供下载 |
| OpenCascade.js LGPL-2.1 | 低 | 不用；若将来用，需允许用户替换该库（独立 wasm 文件即可满足） |
| 电商价格：抓取淘宝 / LCSC 违反条款；"参考价"被当成承诺 | 中 | 不抓取，人工核价 + 日期 + "参考"字样；不写最低价 |
| 联盟 / 推广链接：佣金披露、广告法、"中立选型"被质疑 | 中 | 现阶段不做；要做先问人，并在页面显著披露 |
| 商标：JLC3DP 明文禁止合作方用其商标 / logo；淘宝、立创 logo 同理 | 低 | 外链只用文字名称，不用 logo，不暗示合作 |
| 第三方 3D 模型（Printables / Thingiverse / MakerWorld）大量 NC 或"标准数字文件许可" | 中 | 不托管、不改编；只以外链 + 作者 + 协议出现 |
| 规则给错导致用户买错 / 烧板 | 中 | 每条规则带来源与可信度；正反用例进验收；页面写"规则基于数据手册，未经真机标定"；先由人逐条复核 `rules.json` |
| 安全类提示（锂电、220 V 继电器） | 中 | 涉及市电的作品不进模版；锂电模版必带保护板 / 充电件并给安全提示 |

### 未能核实 / 需人确认
- LCSC、DigiKey API 的完整条款（缓存、再展示）未取得全文；不接则无影响。
- Nexar 免费额度 100 vs 1000 的说法冲突。
- 淘宝开放平台商品接口配额来自第三方资料。
- oshwhub、Hackster、Seeed / M5 项目页的 BOM 呈现为页面观察，未逐个核实。
- 合宙 CORE-ESP32-C3 的官方原理图授权未找到。
- R18/R20/R21 的电流数字（SG90 堵转、LDO 额定）需按具体型号录入数据手册值后再上线。
