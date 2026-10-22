# 授权条款复核（可放宽项与待确认项）

查证日期：2026-10-16。依据是许可证全文、仓库 LICENSE / README、官网条款页和法规原文（链接见每节和文末）。每条结论标一个等级：

- **【明确允许】**：许可证或官方原文直接写了。
- **【合理解读】**：原文没直接写，按条款文字和通行理解推得出，有人可能不同意。
- **【需书面确认】**：原文模糊或对我们不利，要对方书面答复才能做。
- **【未查到原文】**：没找到一手原文，不下结论。

本文不改 `docs/LICENSING.md`，只在第五节给逐条修改建议，由人决定是否采纳。

---

## 一句话结论

我们的保守规则里，有一半可以合法放宽：**KiCad / 乐鑫 KiCad 库 / Adafruit / M5Stack 的 3D 模型可以转成 glTF 上网站（还可以允许下载），只要集中署名、改过的模型单独以 CC BY-SA 4.0 公开**；**读 GPL 源码来理解硬件行为不违法**，只要不复制、不逐行翻译；**我们自己的 Apache/MIT 固件不需要附源码**，附一份许可证清单就行；开发板丝印上的型号文字可以照实画出来。**不能放宽的有三处**：一是用"乐鑫 MIT / 乐鑫修改版 MIT"许可的组件（ESP-ADF、esp-sr、esp_audio_codec、esp_audio_effects 等，小智就依赖它们）编出来的固件，我们不能托管，因为新版条款明文禁止"为非乐鑫产品再分发"；二是乐鑫 logo；三是 espressif.com 上没有授权声明的下载文件（原理图 PDF、尺寸 DXF）。另外，做联盟链接时，页面上必须显著标明"广告"。

---

## 一、可放宽项清单

| # | 项目 | 现规则 | 可放宽为 | 依据（等级） | 剩余风险 | 要做的动作 |
|---|---|---|---|---|---|---|
| 1 | KiCad 官方 3D 模型（STEP/WRL） | 只参考尺寸，自己建模，不把 .step 打包进网站（RESEARCH_PROCURE） | 可以转 glTF 放进网站渲染，**也可以给下载**；纯格式转换不算改编；整个场景和我们的代码不受 SA 约束 | CC BY-SA 4.0 §2(a)(4)、§3(a)(2)；CC FAQ 关于"合集"的回答（转格式【明确允许】；场景算合集不算改编【合理解读】） | 简化网格、换贴图、去 logo 算"改编"，这些文件本身要以 BY-SA 4.0 公开 | 模型放 `web/public/models/kicad/`，附 LICENSE.md 和来源清单；署名页列出每个模型；改过的模型标"已修改" |
| 2 | 乐鑫 KiCad 库（模组 STEP） | 同上，"去掉乐鑫标志" | 同第 1 项：可以上网站、可以下载 | 仓库 LICENSE.md，条款与 KiCad 官方相同（【明确允许】） | 屏蔽罩上的乐鑫 logo 是商标，CC 不授权商标 | 转换时把 logo 换成中性纹理（这一步算改编，产物以 BY-SA 4.0 公开）；型号文字可以保留（见第 11 节） |
| 3 | Adafruit CAD Parts | 可以用，保留 MIT（已是宽松规则） | 维持；补一条：不用 "NeoPixel" 叫 WS2812 | 仓库 LICENSE（MIT, © 2016 Adafruit）；Adafruit 商标页（【明确允许】） | 丝印上的 Adafruit logo 是商标 | 第三方声明页附 MIT 原文；页面统一写 "WS2812 / 可寻址 RGB 灯带" |
| 4 | M5Stack 板子 3D 模型 | 未列入 | **可以用**：`m5stack/M5_Hardware` 整库 MIT，含 `Structures/` 里的 2D/3D 结构文件和 KiCad 3D 库 | 仓库 LICENSE（MIT, © 2021 M5Stack）、README 目录说明（【明确允许】） | logo 同上 | 同第 3 项 |
| 5 | GPL 模拟器源码（espressif/qemu、CircuitJS、SimulIDE、Velxio） | "只读规格不读实现"（LICENSING 规则 2 写的是"不复制代码"，口头执行更严） | **可以读**，用来理解寄存器行为和时序细节；不复制、不逐行翻译、不照搬结构 | GPLv2 §0；《计算机软件保护条例》第六、十七条；17 U.S.C. §102(b)（【明确允许】读；"读后自写"不侵权【合理解读】） | 一旦读过就算"接触"过，如果写出来的代码结构和顺序高度相似，就有侵权风险 | 按第 9 节的纪律执行，并写进 DECISIONS |
| 6 | 我们托管的自编固件（ESP-IDF + Apache/MIT 组件） | "协议 + 源码提交 + 构建配置"三件套 | 法律上只需要**许可证清单 + 各许可证原文**；源码和构建配置改为"可复现性"建议，不再算授权义务 | Apache-2.0 §4、BSD/MIT 条款都不要求提供源码（【明确允许】） | 只要混进 LGPL / GPL 组件，就要回到三件套 | 用 `esp-idf-sbom create --file-tags` 给每个 bin 生成清单；三件套只对 LGPL/GPL/EUPL 固件保留 |
| 7 | 乐鑫 ROM（esp-rom-elfs） | 可分发，附 LICENSE / NOTICE | 不变，但仓库**没有 NOTICE 文件**，规则应改为"LICENSE + README 版权声明 + ROM 第三方清单" | 仓库根目录只有 LICENSE、README（【明确允许】） | 无 | 改 LICENSING.md 文字 |
| 8 | 板丝印型号文字（"ESP32-S3-DevKitC-1"、"ESP32-S3-WROOM-1"） | 设计稿里有，规则未明确；RESEARCH 写"换成中性纹理" | **型号文字可以照实画**，用来准确描述我们模拟的是哪块板；logo 不画 | 商标法第五十九条描述性使用、指示性使用的司法三要件；乐鑫硬件设计指南的"去标"要求针对的是生产 PCB（【合理解读】） | 乐鑫可能认为整板外观会让人误以为得到了官方授权 | 3D 视图角标写"外观示意，非乐鑫官方模型"；页脚商标声明加上型号；顺带发邮件确认（第四节邮件 A） |
| 9 | 引脚图 | 自己画 | 自己画仍是首选；若要直接用 esp-dev-kits 仓库里的引脚图 / 实物图，可按 CC BY-SA 4.0 使用 | esp-dev-kits README "Open Source Licensing" 一节（【明确允许】，但与文档站免责声明冲突，见第 2 节） | 图里有乐鑫 logo；文档站写"No licenses … are granted herein" | 先继续自画；如果要用原图，等邮件 A 的回复 |
| 10 | KiCad / Fritzing 尺寸事实 | 只用尺寸事实 | 不变，而且可以写清楚：尺寸、引脚间距是事实，不受版权保护 | 《计算机软件保护条例》第六条与著作权法的思想 / 表达二分（【合理解读】） | 照着 SVG 描出来的图不是"尺寸事实" | 不描图；尺寸记进数据表，注明数据来源 |
| 11 | 字体 | 未明确 | Noto Sans SC、JetBrains Mono 可以自托管、转 WOFF2、子集化 | OFL-FAQ 2.1、2.2.1、1.12（【明确允许】） | 子集化算修改，修改版不能用保留字体名（Noto Sans SC 的保留名是 "Source"；JetBrains Mono 没有保留名） | 字体旁边放 OFL.txt；子集文件不要起带 "Source" 的名字 |

---

## 二、逐条分析

### 1. KiCad 官方库（符号 / 封装 / 3D 模型）

**原文依据**
- 许可证 + 例外（[kicad.org/libraries/license](https://www.kicad.org/libraries/license/)，与 [kicad-packages3D LICENSE.md](https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/master/LICENSE.md) 同文）：
  > "To the extent that the creation of electronic designs that use 'Licensed Material' can be considered to be 'Adapted Material', then the copyright holder waives article 3 of the license with respect to these designs and any generated files which use data provided as part of the 'Licensed Material'."
  
  例外放弃的是 **CC BY-SA 4.0 第 3 条整条**（署名 + 相同方式共享），适用对象是"用库做出来的电子设计"以及"由设计生成的文件"。
- 同页的 "What does this mean?"：
  > "if you wish to redistribute the KiCad libraries, or parts thereof (including in modified form) as a collection then the exception above does not apply."
- CC BY-SA 4.0 原文（[legalcode](https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt)）：
  - §1(k) "Share" 包括 "reproduction, public display … distribution … make material available to the public"。浏览器加载 glTF 时，文件已经传到了用户机器上，所以**不给下载按钮也属于 Share**。
  - §2(a)(4)："simply making modifications authorized by this Section 2(a)(4) never produces Adapted Material"。为了在其他媒介里使用而做的技术性修改（转格式）不算改编。
  - §2(a)(5)(C)：不得对受许可材料施加"Effective Technological Measures"（指受反规避法保护的技术措施，如 DRM）或附加限制。
  - §3(a)(2)：署名可以"in any reasonable manner based on the medium"完成，"providing a URI or hyperlink to a resource that includes the required information"就算合理方式。
- CC FAQ（[creativecommons.org/faq](https://creativecommons.org/faq/)）："All Creative Commons licenses … allow licensed material to be included in collections … this does not change the license applicable to the original material"；把 CC 素材和别的东西组合在一起，**只要不构成改编**，就只需要署名。

**现规则**：只参考尺寸自己建模，不把 .kicad_mod / .step 放进网站；RESEARCH_FIDELITY 写"转换后的 glTF 也要以 CC BY-SA 4.0 公开"。

**能否放宽**
- **可以把 KiCad 3D 模型转成 glTF 后在网站里渲染**【明确允许】。代价是署名；纯转格式的 glTF 仍然是原作品，不是改编。
- **"不让下载"省不掉任何义务**【明确允许】。浏览器拿到文件就已经算 Share。反过来，加密或混淆模型来阻止下载可能违反 §2(a)(5)(C)（如果构成"有效技术措施"）。所以**直接允许下载更省事**，把 glTF 和 LICENSE 放在同一目录就行。
- **SA 只约束模型文件本身（以及改过的版本）**，不会延伸到 three.js 场景、我们的代码、我们自画的模型【合理解读，CC FAQ 支持】。场景是多个独立作品放在一起，属于"合集"。
- **改过的模型**（减面、合并、换材质、去 logo）构成 Adapted Material，这些文件要以 CC BY-SA 4.0（或更高版本）公开，并标明"已修改"【明确允许】。我们对这些模型的修改也随之进入 BY-SA，但只限这些文件。
- **例外条款覆盖什么**：用户在我们网站上搭好的装配、导出的截图和 BOM，可以算"用库做的电子设计及生成文件"，用户分享时不需要署名【合理解读】。**我们托管模型库本身不在例外之内**，那是原文说的"redistribute … as a collection"【明确允许】。
- **KiCad 官方 FAQ**：除许可证页上的 "What does this mean?" 外，没有找到专门回答"在其他软件或网站里使用 3D 模型"的官方 FAQ【未查到原文】。论坛帖子都是个人意见，不作依据。

**剩余风险**：kicad-packages3D 里个别模型如果来自厂商、另有声明，要按文件检查。仓库总 LICENSE 没写例外，但转换脚本应该检查每个模型目录里有没有额外的 LICENSE 文件。

**建议做法**
1. 目录：`web/public/models/kicad/<name>.glb`，旁边放 `LICENSE.md`（复制 KiCad 原文）和 `SOURCES.md`（每个模型：原路径、KiCad 库版本 / 提交、是否修改、修改内容）。
2. 网站"第三方素材"页署名格式：
   `3D 模型 "<名称>" 来自 KiCad Libraries（https://gitlab.com/kicad/libraries/kicad-packages3D），© KiCad Library Team 及贡献者，CC BY-SA 4.0（https://creativecommons.org/licenses/by-sa/4.0/）。已转换为 glTF；<已简化网格 / 未修改>。不提供任何担保。`
3. 器件详情面板放一个"模型来源"小链接，跳到上面这一条。

### 2. 乐鑫自家 KiCad 库、开发板 STEP / 尺寸图、引脚图

**原文依据**
- [espressif/kicad-libraries LICENSE.md](https://github.com/espressif/kicad-libraries/blob/main/LICENSE.md)：CC BY-SA 4.0 + 与 KiCad **逐字相同**的例外，并写明 "These are the same license conditions as those used by KiCad project for the official libraries"。README 写明仓库含 "Symbols, Footprint, and 3D Models"。乐鑫这份 LICENSE 没有转载 KiCad 那段 "What does this mean?"，不过明确引用了 KiCad 的条款。
- [esp-dev-kits README](https://github.com/espressif/esp-dev-kits) "Open Source Licensing"：
  > "Documentation: All documentation content in this repository (including text, diagrams, and images) is licensed under the … CC BY-SA 4.0"

  仓库里确实有引脚图和实物图，例如 `docs/_static/esp32-s3-devkitc-1/ESP32-S3_DevKitC-1_pinlayout_v1.1.jpg`、`esp32-s3-devkitc-1-v1.1-isometric.png`。
- 但 esp-dev-kits 文档站的 [Disclaimer and Copyright Notice](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/disclaimer-and-copyright.html) 写着："No licenses express or implied, by estoppel or otherwise, to any intellectual property rights are granted herein." **它和 README 的授权互相冲突。**
- 开发板原理图、PCB、尺寸文件放在 `dl.espressif.com`（例如 `DXF_ESP32-S3-DevKitC-1_V1.1_20220429.dxf`），**不在仓库里**，没有单独的授权声明。
- [乐鑫网站服务条款](https://www.espressif.com/en/content/terms-use) VIII.1："You are not allowed to upload, post, publish, reproduce, transmit or distribute in any way any component of the website itself"；IX.6："Unless otherwise expressly stated herein, you may not use the content of the website for any commercial purposes in any manners without Espressif's prior written consent."
- 本轮没有在 espressif.com 上找到"开发板整板 STEP 模型"的下载页和对应条款【未查到原文】。

**现规则**：自己画；esp-dev-kits 图按 CC BY-SA 4.0；espressif.com 下载件不用。

**能否放宽**
- 乐鑫 KiCad 库的模组 3D：**同第 1 节，可以上网站**【明确允许】。
- esp-dev-kits 仓库里的引脚图 / 实物图：按 README 可以用 CC BY-SA 4.0【明确允许】。但因为文档站免责声明冲突，而且图里有乐鑫 logo，**建议先不直接用原图**，等邮件 A 的答复【需书面确认】。
- dl.espressif.com 的 DXF / PDF：**可以读出尺寸、孔位、排针坐标这些事实来自己建模**【合理解读】；**不能托管原文件**，也不能把 DXF 直接转成我们的模型【需书面确认】，因为没有授权，网站条款还限制商业用途。
- 乐鑫官网的整板 STEP：没找到授权，按"不托管、只读尺寸"处理【未查到原文】。

### 3. Adafruit / Seeed / M5Stack / 微雪

| 来源 | 原文 | 结论 |
|---|---|---|
| [adafruit/Adafruit_CAD_Parts](https://github.com/adafruit/Adafruit_CAD_Parts) | LICENSE：MIT，"Copyright (c) 2016 Adafruit Industries"。README："STEP, Fusion 360, and STL files for various boards"；仓库里有 HUZZAH32、Feather ESP32-S2 等 ESP32 系列整板 STEP | 【明确允许】可转换、托管、修改，保留 MIT 声明 |
| [adafruit/Fritzing-Library](https://github.com/adafruit/Fritzing-Library) | README："Released under CC Attribution Share-Alike"（链接到 3.0） | 同 Fritzing，见第 4 节 |
| [Adafruit 商标页](https://www.adafruit.com/trademarks) | NeoPixel 名称只在用了 Adafruit 或授权经销商的 NeoPixel 时才能用，否则用通用名或 "NEOPIXEL-COMPATIBLE"；Feather 名称只给符合 Feather 规格的产品；商标申请邮件主题写 "trademark use"（转述自页面） | 我们页面统一叫 **WS2812**；仓库里目前没有 "NeoPixel" 字样，保持即可 |
| [Seeed-Studio/OPL_Kicad_Library](https://github.com/Seeed-Studio/OPL_Kicad_Library) | GitHub 识别为 CC-BY-SA-4.0，内含 XIAO ESP32S3 等目录；有没有 KiCad 式例外，未逐字核对 LICENSE | 按 BY-SA 4.0 处理，与第 1 节同样做法【明确允许】 |
| [Seeed-Studio/wiki-documents](https://github.com/Seeed-Studio/wiki-documents)（wiki.seeedstudio.com 源码） | 仓库许可证 GPL-3.0 | 文档和图片按 GPL-3.0 分发，与网页素材混用很麻烦；**只录事实、链接原页**（维持现规则） |
| Seeed wiki 上的 XIAO 3D 下载 | — | 【未查到原文】不托管 |
| [m5stack/M5_Hardware](https://github.com/m5stack/M5_Hardware) | LICENSE：MIT，"Copyright (c) 2021 M5Stack"；README 写明含 PCB、`Structures/`（2D/3D 结构文件）、`KiCad/3D/` | 【明确允许】这是新增的可用来源，含 STEP |
| 微雪（waveshare.com/wiki） | 页面上没找到授权或使用条款（抓取页面全文后检索 license / copyright 都没有命中） | 【未查到原文】维持"只录事实、链接原理图"；要用他们的 3D 或图片就发邮件问 |

### 4. Fritzing parts（CC BY-SA 3.0）

**原文**：[fritzing-parts LICENSE.txt](https://github.com/fritzing/fritzing-parts/blob/develop/LICENSE.txt)："All graphics and documentation of Fritzing are licensed under Creative Commons Attribution-ShareALike 3.0 Unported … you may publish circuits and diagrams that you create with Fritzing and that use these graphics -- as long as you credit us, and publish your works under the same license."

CC BY-SA 3.0 §4(b)（[legalcode](https://creativecommons.org/licenses/by-sa/3.0/legalcode.txt)）：改编作品可以用"this License"或"a later version of this License with the same License Elements"发布，也就是说可以升级到 BY-SA 4.0。

**结论**
- **只参考尺寸自己画**：尺寸是事实，不受限【合理解读】。前提是不描摹 SVG 路径，也不照搬配色和造型细节。
- **直接用 SVG**：SVG 文件本身（以及改过的 SVG）要按 BY-SA 3.0 或 4.0 署名公开【明确允许】。Fritzing 自己的说法更进一步：用这些图做出来的电路图也要同协议。也就是说，**用户导出的面包板图会被认为要 BY-SA**，这会给用户带来义务，和我们"导出图归用户"的设想冲突。KiCad 有例外条款，Fritzing 没有。
- 所以维持"不用 Fritzing 图形"。这不是因为法律禁止，而是 SA 会传到用户的产出上。

### 5. wokwi-elements / wokwi-boards / avr8js / rp2040js

- wokwi-elements：MIT（GitHub 许可证元数据，2026-10-12 推送）【明确允许】。
- wokwi-boards：**仓库没有许可证**（GitHub 元数据 license 为空，2026-09-15 推送）。没有许可证就是保留所有权利，不能复制或改编【明确允许"不能用"】。要用就得请 Wokwi 补一个许可证（见第四节邮件 D，经人同意后发）。
- avr8js、rp2040js：MIT【明确允许】。和 ESP32 无关，以后做 AVR / RP2040 时可以直接用。

### 6. ESPRESSIF MIT License 与 Espressif Modified MIT License

**原文**
- 旧版 "ESPRESSIF MIT License"（[esp-adf LICENSE](https://github.com/espressif/esp-adf/blob/master/LICENSE)，esp-sr、esp-who、esp_new_jpeg、esp_video 也用这一版）：
  > "Permission is hereby granted for use on all ESPRESSIF SYSTEMS products, in which case, it is free of charge, to any person obtaining a copy of this software … to deal in the Software without restriction, including … publish, distribute, sublicense …"
- 新版 "Espressif Modified MIT License"（例如 [esp_capture 1.1.1 license.txt](https://components-file.espressif.com/components/espressif/esp_capture/1.1.1/license.txt)，SPDX `LicenseRef-Espressif-Modified-MIT`）：
  > "Permission is hereby granted for use EXCLUSIVELY with Espressif Systems products."
  > "1. This Software MUST BE USED IN CONJUNCTION WITH ESPRESSIF SYSTEMS PRODUCTS."
  > "3. Redistribution of the Software in source or binary form FOR USE WITH NON-ESPRESSIF PRODUCTS is strictly prohibited."

**组件注册表实查（2026-10-16，取最新版本的 license.txt 首行）**

| 组件 | 许可证 |
|---|---|
| esp_audio_codec 2.6.2 / 2.5.0、esp_audio_effects 1.4.3 / 1.3.0、esp_capture 1.1.1 | Espressif **Modified** MIT |
| esp_codec_dev 2.0.0-beta5 | Espressif **Modified** MIT |
| esp_codec_dev 1.5.4、1.6.2 | Apache-2.0（**同一组件，版本不同，许可证也不同**） |
| esp-sr 2.6.0、esp_new_jpeg 1.0.2、esp_video 2.5.0 | ESPRESSIF MIT（旧版） |
| esp-dl 3.3.13 | MIT |
| esp_lcd_gc9a01、led_strip、button、esp_lvgl_port、esp32-camera、esp_websocket_client、esp-tflite-micro、esp_jpeg | Apache-2.0 |

小智（xiaozhi-esp32 `main/idf_component.yml`）依赖 esp_audio_effects ~1.3.0、esp_audio_codec ~2.5.0（都是修改版 MIT）、esp-sr ==2.4.7（旧版乐鑫 MIT）、esp_codec_dev ~1.6.2（Apache-2.0）。

**分析**
- 旧版措辞"for use on all ESPRESSIF SYSTEMS products"：固件的编译目标是乐鑫芯片，但实际运行在我们的模拟器上，模拟器不是乐鑫产品。"在模拟器里运行算用于乐鑫产品"只能算**有争议的解读**；这句也可以读成"许可限于乐鑫产品上的使用"。
- 新版措辞明确多了：必须"in conjunction with"乐鑫产品，并且**禁止为了用于非乐鑫产品而再分发二进制**。我们托管固件、让它在浏览器里跑，按字面就是"为了用于非乐鑫产品而再分发"。**不能放宽。**
- 有一个对我们有利的论点：用户在模拟器里试跑，是为了之后买乐鑫芯片（产品定位就是"买之前先试"），可以说是"与乐鑫产品配合使用"。这个论点能不能成立，只有乐鑫说了算【需书面确认】。
- 官方解释或 GitHub 讨论：搜索没有找到乐鑫对这两种许可证适用范围的官方解释【未查到原文】。esp-open-rtos 等项目只提到它"与 BSD 不兼容"。
- 用户自带固件：用户上传、在自己浏览器里运行，我们不分发，现规则成立【合理解读】。但用户这样用本身可能不符合该许可证，所以服务条款里写一句"用户对自己上传固件中的第三方许可负责"。

**建议**：小智、ADF、esp-sr、esp-who 类示例固件**不托管**，等邮件 B 的答复；构建脚本加一道检查，发现 `LicenseRef-Espressif-Modified-MIT` 或 "ESPRESSIF MIT" 就拒绝发布。esp_codec_dev 锁在 Apache-2.0 的 1.x 版本。

### 7. ESP-IDF（Apache-2.0）及其组件：托管 .bin 要附什么

**原文**
- Apache-2.0 §4：再分发时 "(a) You must give any other recipients of the Work or Derivative Works a copy of this License"；(b) 改过的文件要有醒目的修改说明；(d) 如果原作品带 "NOTICE" 文件，要转载其中的署名。
- [ESP-IDF Copyrights and Licenses](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html)："These third party libraries can be included into the application (firmware) produced by ESP-IDF"。列出的有 Newlib / Picolibc（BSD）、FreeRTOS（MIT）、lwIP（BSD）、wpa_supplicant（BSD）、Mbed TLS（Apache-2.0）、Xtensa 头文件（MIT）、TLSF（BSD-3）等。BSD 条款要求二进制分发时"reproduce the above copyright notice … in the documentation and/or other materials"。
- ESP-IDF 仓库根目录有 LICENSE，**没有 NOTICE 文件**（根目录清单实查）。
- Wi-Fi / PHY / BT / 共存闭源库：[esp32-wifi-lib](https://github.com/espressif/esp32-wifi-lib)、esp-phy-lib、esp32-bt-lib、esp-coex-lib 都是 Apache-2.0（GitHub 元数据，wifi-lib 的 LICENSE 原文确认）。
- 我们当前固件实际拉取的组件（`managed_components` 实查）：esp_lcd_gc9a01、cmake_utilities、esp_tinyusb、led_strip 是 Apache-2.0；tinyusb 是 MIT（© hathach）。
- 工具：[espressif/esp-idf-sbom](https://github.com/espressif/esp-idf-sbom)（Apache-2.0）可以从 `build/project_description.json` 生成 SPDX / CycloneDX；加 `--file-tags` 会扫描 `SPDX-License-Identifier` 和版权行。

**结论**【明确允许】：每个托管的 .bin 旁边放：
1. `LICENSES.txt`：Apache-2.0 全文，加上固件实际链接到的每个第三方组件的版权行和许可证原文（Newlib COPYING.NEWLIB、FreeRTOS MIT、lwIP BSD、wpa_supplicant BSD、tinyusb MIT 等）；
2. `sbom.spdx.json`：由 esp-idf-sbom 生成，作为清单依据；
3. 如果我们改过 IDF 源文件，加一份修改说明（目前没改）。

**源码和构建配置不是 Apache / BSD / MIT 的义务**，可以从"授权三件套"降成"可复现性建议"。arduino-esp32（LGPL-2.1）、Tasmota / ESPHome（GPL-3.0）、WLED（EUPL-1.2）这类固件维持三件套。

### 8. esp-rom-elfs 与 ROM 二进制

**原文**（[esp-rom-elfs README](https://github.com/espressif/esp-rom-elfs)）：
> "The ROM code of the currently available ESP32 series of chips is not open-source. You can use the ELF files in this repository under the terms of Apache License 2.0 … the license is also applicable to the compiled files. In the license text this case is referred to as 'Object' form."

ROM 里的第三方代码见 IDF COPYRIGHT 页 "ROM Source Code Copyrights"：Newlib（BSD）、Xtensa libhal（MIT）、TinyBasic Plus（MIT）、miniz（公有领域）、TJpgDec（"No restriction on use … Redistributions of source code must retain the above copyright notice"）、Zephyr USB 栈部分（Apache-2.0 / BSD-3）。

**结论**
- 我们文档写的 Apache-2.0 **核实无误**【明确允许】。
- ROM 代码就在 ELF 里，可以按 Apache-2.0 的 Object 形式再分发；从 ELF 提取出 .bin 属于技术性转换，同样可以分发【合理解读，README 明说许可证适用于编译产物】。
- 仓库**没有 NOTICE 文件**，LICENSING.md 里"附 LICENSE / NOTICE"要改成"附 LICENSE 全文 + README 的版权行 + ROM 第三方清单"。
- espressif/qemu 的 `pc-bios/*rom*.bin` 没有单独声明，但内容来自同一份 ROM。继续"从 ELF 自己提取、不用 qemu 的 bin"，没有损失。

### 9. GPL / AGPL 源码：能不能读

**原文**
- GPLv2 §0（[gpl-2.0.txt](https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt)）："Activities other than copying, distribution and modification are not covered by this License; they are outside its scope." 阅读不在 GPL 管辖范围内。
- 《计算机软件保护条例》（[维基文库](https://zh.wikisource.org/wiki/计算机软件保护条例)）：
  - 第六条："对软件著作权的保护不延及开发软件所用的思想、处理过程、操作方法或者数学概念等。"
  - 第十七条："为了学习和研究软件内含的设计思想和原理，通过安装、显示、传输或者存储软件等方式使用软件的，可以不经软件著作权人许可，不向其支付报酬。"
  - 第二十九条：因"可供选用的表达方式有限"而相似的，不构成侵权。
- 17 U.S.C. §102(b)（[Cornell LII](https://www.law.cornell.edu/uscode/text/17/102)）："In no case does copyright protection … extend to any idea, procedure, process, system, method of operation …"
- espressif/qemu 的 ESP 文件头写的是 "GPL version 2 or (at your option) any later version"（例如 `hw/riscv/esp32c3.c`）。

**结论**
- **GPL 不禁止阅读源码，法律也不要求 clean-room**【明确允许】。clean-room（一组人读、另一组人写）是**举证手段**：在"接触 + 实质性相似"的侵权判断里，用来证明没有抄。我们只要证明写出来的东西是独立表达就行。
- **可以放宽到**【合理解读】：
  1. 可以读 espressif/qemu、CircuitJS、SimulIDE、Velxio 源码，理解寄存器语义、复位值、时序和没写进 TRM 的行为；
  2. 不复制代码、不逐行翻译成 Rust、不照搬函数拆分、命名和控制流顺序；
  3. 寄存器地址、位域这类事实，优先从 ESP-IDF `soc/` 头文件（Apache-2.0 OR MIT）生成，不从 qemu 抄；
  4. 读了什么、得出什么行为结论，就写一条 DECISIONS（"行为参考：qemu esp32c3_xxx.c 的 Y 现象，已用固件差分验证"），留下"我们从行为出发、有独立验证"的记录；
  5. 不在同一时间对照着 GPL 文件写同一个函数（这一条防的是"不自觉地照着写"）。
- 各项目许可证：CircuitJS（pfalstad/circuitjs1）GPL-2.0；**SimulIDE 现在的开发仓库（Arcachofo/SimulIDE-dev）是 AGPL-3.0**，较早的 SimulIDE/SimulIDE 是 GPL-3.0；Velxio 是 AGPL-3.0，另有商业授权（COMMERCIAL_LICENSE.md 写明"SaaS / web app where you keep your source private"需要商业授权）。AGPL §13 只在**修改并以网络服务提供它的程序**时才生效，读代码不触发。
- 不能放宽的部分：AGPL / GPL 代码和素材（Velxio 的元件图、CircuitJS 的界面资源）一行都不进仓库。

### 10. ngspice：能否编一个不含 GPL 的 wasm

**原文**（[ngspice COPYING](https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/COPYING)）："The ngspice license is the 'Modified BSD' license … except for the files listed below"：

| 部分 | 许可证 | 怎么处理 |
|---|---|---|
| `src/xspice/icm/table` | **GPLv2 or newer** | 必须排除：`--disable-xspice`（同时失去全部 XSPICE 代码模型），或者保留 XSPICE，只从 `src/xspice/icm/GNUmakefile.in` 的 `CMDIRS = spice2poly digital analog xtradev xtraevt table tlines` 里删掉 `table` |
| `src/maths/KLU` | LGPLv2 | `--disable-klu`（configure.ac："Use KLU linear systems solver. Default=yes"，默认开着，要显式关） |
| `src/frontend/numparam` | LGPLv2 or newer | **无法用开关排除**：`src/frontend/Makefile.am` 里 `SUBDIRS = plotting help parser wdisp numparam trannoise`，无条件编译。只能按 LGPL 处理 |
| `src/tclspice.c` | LGPLv2 | 不用 `--with-tcl` 就不编 |
| `src/osdi` | MPL-2.0 | 文件级 copyleft，可以保留（附源码链接），也可以 `--disable-osdi` |
| `src/maths/sparse` | MIT 类 | 无负担 |
| `src/xspice`（table 以外）、`devices/ndev` | 公有领域 | 无负担 |
| ngspice 手册 | CC BY-SA 4.0 | 不搬手册原文 |

**结论**【明确允许】：**编一个"不含 GPL"的 wasm 可行**（去掉 table、关掉 KLU、不编 tcl），但**做不到"纯 BSD"**，因为 numparam 是 LGPL 且无法排除。LGPL 的做法：ngspice 编成独立的 `.wasm` 文件，单独加载，并提供对应源码版本和构建脚本，让用户能自己替换成重编的版本。这样我们的主程序不受影响。BSD 部分要在第三方声明页转载版权行。EEcircuit 的构建配置是否含 table，本轮因 GitHub API 限流没有核对【未查到原文】。

### 11. 乐鑫商标：ESP32 字样、"兼容"、开发板外观与丝印

**原文**
- [乐鑫 Logo Guidelines](https://www.espressif.com/en/about-espressif/logo-guidelines)："When using the Espressif's logo, kindly include the following disclaimer: 'All Espressif's logos are trademarks of Espressif Systems (Shanghai) Co., Ltd.'"；联名合作联系 marketing@espressif.com。页面只讲**怎么正确使用** logo（比例、颜色、留白），**没有授予任何使用许可**。
- [乐鑫网站服务条款](https://www.espressif.com/en/content/terms-use) XIV："You must not establish a link in such a way as to suggest any form of association, approval or endorsement on our part where none exists."；联系方式 legal@espressif.com。
- [ESP 硬件设计指南 · Terms of Use for Reference Designs](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/disclaimer-and-copyright.html)："Use of these reference designs does not grant any rights to use Espressif's trademarks … any Espressif trademarks appearing on the PCB silkscreen, such as the Espressif logo or module part numbers, must be replaced with the manufacturer's own markings." 说的是**用参考设计生产 PCB** 的情形。
- CC FAQ："trademark rights are not licensed by the CC licenses"。所以模型的 CC 授权不包括屏蔽罩上的商标。
- 《商标法》第五十九条第一款（转引自[中伦律所文章](https://www.zhonglun.com/research/articles/8458.html)，全文未直接取得）：注册商标中含有本商品的型号，或者直接表示商品质量、功能、用途等特点的，"注册商标专用权人无权禁止他人正当使用"。同一文章总结的司法要件（北京高院解答）："使用出于善意""不是作为自己商品的商标使用""使用只是为了说明或者描述自己的商品"。
- 注册情况（Justia 转引 USPTO）：ESPRESSIF 文字商标美国注册号 6119571（2020-08-04）；"ESP" 有申请（序列号 79293589）。**"ESP32" 本身的注册情况没有查到**【未查到原文】。

**结论**
- 网站文字里写 "ESP32""ESP32-C3""ESP32-S3"，说明我们模拟的是什么芯片：描述性 / 指示性使用【合理解读，属于最强的那一类】。
- "兼容"：可以写"支持 ESP32-C3 / ESP32-S3 固件""运行为 ESP32 编译的固件"。**不要写"乐鑫官方""乐鑫认证""ESP32 模拟器官方版"**，产品名和域名里也不要出现 ESP32（现规则已有）【合理解读】。
- 3D 里画 DevKitC 外形、丝印 "ESP32-S3-DevKitC-1"、屏蔽罩上的 "ESP32-S3-WROOM-1"：这是为了准确表示用户选了哪块板，满足"善意、说明用途、不当作自己的商标"三要件【合理解读】。设计指南的"必须替换"针对的是生产 PCB 的厂商，不是对产品的描绘。**乐鑫 logo（图形标）不画**：logo 指南没有授予许可，商业用途要联系【需书面确认】。
- 需要的声明：
  - 页脚（替换现有那句）："Espressif, ESP32, ESP32-C3, ESP32-S3 and related product names are trademarks of Espressif Systems (Shanghai) Co., Ltd. TryBoard is an independent project and is not affiliated with, endorsed or sponsored by Espressif."
  - 3D 视图角标："开发板外观为示意建模，非乐鑫官方模型。"
  - 外链到 espressif.com 的地方不用 logo 当按钮。

### 12. 价格数据与店铺外链；联盟链接

**原文**
- 《广告法》（[维基文库](https://zh.wikisource.org/wiki/中华人民共和国广告法_(2021年))）第二条：适用于"商品经营者或者服务提供者……介绍自己所推销的商品或者服务的商业广告活动"；第九条（三）禁止"使用'国家级'、'最高级'、'最佳'等用语"；第十一条：引用数据"应当真实、准确，并表明出处"；第十四条：广告"应当具有可识别性"。
- 《互联网广告管理办法》（2023-05-01 施行，[维基文库](https://zh.wikisource.org/wiki/互联网广告管理办法)）第九条第三款："通过知识介绍、体验分享、消费测评等形式推销商品或者服务，并附加购物链接等购买方式的，广告发布者应当显著标明'广告'。"
- 淘宝联盟：**现行《推广者规范》原文没取到**【未查到原文】。能找到的是阿里 CDN 上的旧版 PDF（[淘宝客推广业务规范](http://download.taobaocdn.com/mtop/release/shangbiao/tktgxy.pdf)、[淘宝联盟（推广者）合作规范](http://download.taobaocdn.com/mtop/release/shangbiao/tblmhz.pdf)），据第三方转述，里面有"不得使用未通过合法备案的网站""不得用阿里系品牌词做域名或名称""除官方搜索服务外，不得提供基于淘宝商品链接 / 店铺名的搜索功能"等条款。这些是否仍然有效，要以 pub.alimama.com 规则中心的现行版本为准。
- 京东联盟、立创商城推广：**没找到条款原文**【未查到原文】。

**结论**
- **现在的做法**（人工核价、给区间、写日期和"参考"、链接到淘宝 / 立创的搜索页、不收佣金）：我们不是卖家，也不替卖家推销，不属于《广告法》第二条的商业广告【合理解读】。没有找到禁止链接到淘宝搜索页的原文【未查到原文】。保留现规则："参考价 + 核价日期 + 来源"，不写"最低价"，不用平台 logo。
- **做联盟链接以后**：我们就成了推销商品的"广告发布者"，评测或选型页面加购物链接，要**显著标明"广告"**（第九条第三款）【明确允许 → 明确义务】；"最佳""最便宜"之类用语不能出现在推广内容里（第九条）；价格数据要写来源和日期（第十一条）。另外，"中立选型"的产品定位会受质疑，建议把推荐结果和联盟链接分开展示：推荐逻辑不看佣金，在页面上写明这一点。
- 平台规则（淘宝联盟要求网站备案、限制基于淘宝链接的搜索功能等）可能直接影响我们"按元件搜店铺"的功能。**申请联盟之前要逐条读现行规范**。

### 13. Poly Haven、three.js、Manifold、Rapier

| 项目 | 原文 / 元数据 | 结论 |
|---|---|---|
| Poly Haven | [polyhaven.com/license](https://polyhaven.com/license)："Our assets are all licensed as CC0 … You can use our assets for any purpose, including commercial work. You do not need to give credit" | 【明确允许】可托管、可修改，不需署名（建议在素材页致谢） |
| three.js | mrdoob/three.js：MIT | 【明确允许】附 MIT 声明 |
| Manifold | elalish/manifold：Apache-2.0 | 【明确允许】附 LICENSE；有 NOTICE 就一并附上（本轮未检查是否有 NOTICE） |
| Rapier | dimforge/rapier、rapier.js：Apache-2.0 | 同上 |

### 14. 字体：Noto Sans SC、JetBrains Mono（OFL-1.1）

**原文**（[OFL-FAQ 1.1-update7](https://openfontlicense.org/ofl-faq/)）：
- 2.1："Can I make webpages using these fonts? Yes! … The referenced fonts can be hosted on the same server as other site assets … explicitly allowed by the licensing model"；
- 2.2.1：只做 WOFF/WOFF2 压缩、元数据不变的，"not considered modification"，不用改名；
- 1.12：嵌入文档时可以只取子集，不受修改限制。网页字体属于分发，子集化一般算修改，所以要看保留字体名。

**保留字体名（RFN）实查**
- JetBrains Mono `OFL.txt`："Copyright 2020 The JetBrains Mono Project Authors"，**没有 RFN**。
- Noto Sans SC（google/fonts `ofl/notosanssc/OFL.txt`）："Copyright 2014-2021 Adobe … with Reserved Font Name 'Source'"。RFN 是 "Source"，"Noto Sans SC" 这个名字不受影响。

**结论**【明确允许】：两款字体都可以自托管、转 WOFF2、子集化。要做的：字体目录放 `OFL.txt`（含版权行）；子集文件名和字体内部名称都不要带 "Source"。另外，从工程上看，国内访问 Google Fonts CDN 不稳定，自托管本来就更好。

### 15. M5Unified / M5GFX（M5-00，2026-10-20 读本地克隆）

**实查**
- M5Unified `35903583211e1f39ca88920714525fbcd1eb714a`（library.properties 0.2.27）、M5GFX `a8ebd7bdaae2e9bdc2f3c69c25b83a84d819af72`（0.2.34）：根目录 `LICENSE` 均为 "MIT License, Copyright (c) 2021 M5Stack"。
- M5GFX `src/lgfx/v1/LGFXBase.hpp:8` 注明基于 LovyanGFX（FreeBSD，BSD-2）；仓库内没有 LovyanGFX 的独立 license 文件，需随 NOTICES 附上其许可证原文和版权行。
- 库内自带许可证文件：`Fonts/GFXFF/license.txt`（Adafruit BSD，2012）、`Fonts/efont/COPYRIGHT.txt`（/efont/ BSD 式）、`Fonts/IPA/IPA_Font_License_Agreement_v1.0.txt`（IPA 字体许可 v1.0）。
- 文件头自带声明：`utility/lgfx_pngle.*`（MIT, kikuchan 2019）、`lgfx_qrcode.c`（MIT, Richard Moore 2017）、`lgfx_tjpgd.c`（ChaN 2019，自有条款）、`lgfx_miniz.c`（公有领域 / unlicense）、`Fonts/Custom/DejaVu*.h`（链接 DejaVu 许可）。
- 无任何声明：`utility/lgfx_qoi.c` / `.h`（文件头直接是 include）、`Fonts/Custom/{Orbitron_Light_24,Roboto_Thin_24,Satisfy_24,Yellowtail_32}.h`（squix 在线工具生成，原字体多为 OFL / Apache，库里没带）。

**结论**：【明确允许】MIT / BSD 部分，保留版权与许可声明即可。【需要继续确认】无声明的 qoi 与 squix 字体头文件：只是编进固件里（链接时只有被引用的才进 bin），要托管含它们的 bin 前先确认 bin 里是否真有这些符号，有就补查上游（phoboslab/qoi MIT；squix 字体的原字体许可）再写进 NOTICES。IPA 字体仅在用到日文字体时进 bin。

### 16. 2026-10-22 ESP32Servo / IRremote 证据（F-08d）

只整理证据，**结论待人核**；docs/LICENSING.md 第 30 行的「只进本地 accept、未核前不上站」不变。读的是 `third_party/arduino-libs/` 下按 `tools/fetch_third_party.sh` 钉的本地克隆（HEAD 与钉的提交一致），GitHub 元数据用 `gh api repos/<owner>/<repo>` 只读获取。

#### 16.1 ESP32Servo（madhephaestus/ESP32Servo `f7282217605d8bd9a4f3070cf9901d10d13ede1d`，library.properties 3.2.1）

**实查**
- 仓库根和子目录都没有 LICENSE / COPYING；`library.properties` 没有 `license=` 字段（author=Kevin Harrington, John K. Bennett）；没有 `library.json`。
- GitHub `license` 字段为 `null`（未识别出许可证）。
- README.md 第 55–71 行「## License」：「Copyright (c) 2017 John K. Bennett」+ LGPL-2.1-or-later 标准声明。
- 源码只有 `src/` 下 4 个文件，加 7 个示例：

| 文件 | 许可声明 | 版权人 | 备注 |
|---|---|---|---|
| `src/ESP32Servo.h` | LGPL-2.1 或更高（第 24–36 行标准声明） | © 2017 John K. Bennett | 第 6 行「Original Servo.h written by Michael Margolis in 2009」：派生自 Arduino Servo 库（LGPL-2.1+），类注释（第 39 行起）沿用原 Servo.h 的说明文字 |
| `src/ESP32Servo.cpp` | LGPL-2.1 或更高（第 4–16 行） | © 2017 John K. Bennett | 与 .h 同；实现为 ESP32 LEDC / MCPWM 重写 |
| `src/ESP32PWM.h` | **无许可声明** | 「Author: hephaestus」（= 维护者 Kevin Harrington），2018 | 文件头只有说明；按 README 的 License 节可读作随库 LGPL-2.1+，但文件内无明示 |
| `src/ESP32PWM.cpp` | **无许可声明** | 「Author: hephaestus」，2018 | 同上 |
| `examples/Sweep/Sweep.ino` | 「This example code is in the public domain.」 | — | 其余 6 个示例无声明；我们的 `firmware/arduino/lib-esp32servo` 是参照 Sweep 自写的 sketch（Sweep 为公有领域，无影响） |

**判断**
- 全库按 LGPL-2.1-or-later 理解最合理：两个主文件有明示头，README 明示，派生源头 Arduino Servo 本身也是 LGPL-2.1+；`ESP32PWM.*` 无头是缺陷，不构成另一种许可。没有 GPL 文件头。「仓库无 LICENSE 文件」≠「无许可」，之前第 30 行的描述只说对了一半。
- 我们的 bin 静态链接 ESP32Servo。LGPL-2.1 对静态链接的分发义务（§4、§6）：随 bin 显著告知用了该库且受 LGPL 约束并附 LGPL-2.1 原文；提供库的完整源码（或在同一指定位置提供等价访问）；并按 §6(a) 提供应用的源码或目标文件，让用户能用改过的库重新链接；不得禁止为调试而逆向。
- 这些义务**和 arduino-esp32（LGPL-2.1）完全同类**，本仓库对它已经走「三件套」（LICENSING.md 第 26 行，本文第 172 行）：sketch 源码 + 精确库 / 核心提交 + 构建配置（FQBN、arduino-cli 版本）＝用户能从源码重编重链，满足 §6(a)。所以 ESP32Servo 不新增义务**种类**，只是同一份 NOTICE / 源码清单里多一个 LGPL 组件。「链接到上游 GitHub 是否算 §4 的同一指定位置」与 arduino-esp32 是同一个问题，按那边的处理走，不在此重复讨论。

#### 16.2 IRremote（Arduino-IRremote/Arduino-IRremote `498dc591b255d8ba2e239c875804bdab2ab0fe91`，library.properties 4.7.1）

**实查**
- 根目录 `LICENSE`：MIT 全文，版权行「(c) 2009 Ken Shirriff / (c) 2016 Rafi Khan / (c) 2020-2022 Armin Joachimsmeyer et al.」。
- `library.json` 第 28 行 `"license": "MIT"`；`library.properties` 无 `license=` 字段。
- README.md 第 1320–1327 行：「Up to the version 2.7.0, the License is GPLv2. From the version 2.8.0, the license is the MIT license.」；Copyright 节写「Initially coded 2009 Ken Shirriff」。我们钉的是 4.7.1，在 MIT 段。Shirriff 本人同意改许可的证据只有仓库自述和 LICENSE 里列了他的版权行，**无法独立核实**（没有找到他签字的改许可记录）。
- GitHub `license` 字段：`{"key":"other","spdx_id":"NOASSERTION"}`——GitHub 没把 LICENSE 认成标准 MIT（推测是 MIT 正文前多了 3 行版权和一个 URL，不影响条款本身）。
- `src/` 共 39 个文件，逐个看文件头（前 80 行）：

| 文件 | 许可声明 | 版权人 | 备注 |
|---|---|---|---|
| `IRremote.hpp`、`IRremoteInt.h`、`IRVersion.h`、`IRProtocol.hpp`、`IRReceive.hpp`、`IRSend.hpp` | MIT | Ken Shirriff、Rafi Khan、Armin Joachimsmeyer（2009/2015–2026） | 历史 Shirriff 代码所在文件，头为 MIT |
| `IRProtocol.h`、`IRFeedbackLED.hpp`、`private/IRTimer.hpp`、`TinyIRReceiver.hpp`、`TinyIRSender.hpp`、`ac_LG.h/.hpp`、`ir_Denon/FAST/Kaseikyo/Lego/NEC/RC5_RC6/Sony.hpp`、`ir_DistanceWidthProtocol.hpp` | MIT | Armin Joachimsmeyer | |
| `ir_BangOlufsen.hpp` / `ir_JVC.hpp` / `ir_LG.hpp`、`ir_Samsung.hpp` / `ir_MagiQuest.hpp` / `ir_OpenLASIR.hpp` / `ir_Pronto.hpp` | MIT | 分别加 Daniel Wallner / Kristian Lauszus / Darryl Smith / E. Stuart Hicks / Daniel Weidmann / Bengt Martensson | NOTICE 要列全这些人 |
| `ir_Template.hpp` | MIT | 「Shuzu Guru」/「Unknown Contributor」 | 模板，不被 `IRremote.hpp` 包含 |
| `ir_Others.hpp` | MIT 正文 | **无版权行** | |
| `ir_BoseWave.hpp`、`IRremote.h` | **无许可声明** | — | `IRremote.h` 只是兼容旧版的 stub；BoseWave 被 `IRremote.hpp:278` 无条件包含 |
| `digitalWriteFast.h` | BSD-3-Clause | 基于 code.google.com/p/digitalwritefast | |
| **`LocalDebugLevelStart.h`**（第 13–29 行）、**`LocalDebugLevelEnd.h`**（第 5–21 行） | **GPL-3.0 或更高** | © 2024–2026 Armin Joachimsmeyer，「part of Arduino-Utils」 | 只有调试宏；被几乎每个 `ir_*.hpp` 包含（如 `ir_NEC.hpp:37/412`） |
| **`LongUnion.h`**（第 4–20 行） | **GPL-3.0 或更高** | © 2020–2022 Armin Joachimsmeyer，Arduino-Utils | 只有 union 类型定义；`IRremote.hpp:259` 无条件包含 |
| **`TinyIR.h`**（第 5–22 行） | **GPL-3.0 或更高** | © 2021–2025 Armin Joachimsmeyer | 常量宏 + 结构体 + 函数声明；`ir_FAST.hpp:36/53` 无条件包含，`ir_FAST.hpp` 又被 `IRremote.hpp:290` 无条件包含 |
| `IRCommandDispatcher.h/.hpp` | GPL-3.0 或更高 | © 2019–2026 Armin Joachimsmeyer | **不被** `IRremote.hpp` 包含，我们的 sketch 也不用 |
| `examples/*/PinDefinitionsAndMore.h`（31 个） | GPL-3.0 | Armin Joachimsmeyer | 我们的 `lib-irremote.ino` 参照 `SimpleSender.ino`（文件头 MIT，© 2020–2026 Joachimsmeyer）自写，只 `#include <IRremote.hpp>`，不含 `PinDefinitionsAndMore.h` |

**判断**
- **MIT 文件头不覆盖全部源文件**：只要 `#include <IRremote.hpp>`，就无条件编入 4 个 GPL-3.0-or-later 头（`LocalDebugLevelStart.h`、`LocalDebugLevelEnd.h`、`LongUnion.h`、`TinyIR.h`）；另有 2 个无声明文件、1 个 BSD-3 文件。
- 这 4 个 GPL 头只含宏、类型和常量，几乎不在 bin 里留下可受版权保护的表达，技术上可以主张「不构成派生作品」；但保守读法是 GPL-3 头参与了每次编译，而且我们按三件套给出的源码清单本身就会分发 GPL-3 文件。作者与 MIT 主体是同一人（Joachimsmeyer），这些头来自他自己的 GPL 仓库 Arduino-Utils，很可能是上游疏忽，但要作者确认才算数。
- 把整个 bin 当 GPL-3 分发也走不通：本地 `firmware/build/arduino-lib-irremote/app.elf` 的符号里有 `libcoexist_reversion_git` 和一批 `phy_*` 符号，说明即使红外 sketch 也链接了乐鑫闭源 coexist / PHY 库，给不出 GPL-3 要求的完整对应源码（这一点按符号名推断，没逐个核对来源库）。

#### 16.3 选项

- **(a) 两个都直接上站**。需要的 NOTICE：ESP32Servo——LGPL-2.1 原文 + 「© 2017 John K. Bennett；ESP32PWM by Kevin Harrington；派生自 Arduino Servo（Michael Margolis 2009）」+ 库提交与源码位置（并入 arduino-esp32 的三件套）；IRremote——MIT 原文 + 上表全部版权人 + `digitalWriteFast.h` 的 BSD-3 声明 + 对 4 个 GPL-3 头的处理说明。IRremote 部分的风险在 GPL-3 头，(a) 等于接受「宏 / 类型不构成派生作品」的论证。
- **(b) 有条件上站**。ESP32Servo：条件是**挂到 LGPL 三件套那一行而不是 MIT / BSD 那一行**（BUILD_INFO 记库提交、NOTICES 附 LGPL-2.1 + 上述版权行、提供库源码），与 arduino-esp32 同样处理。IRremote：条件是上游作者确认（或改许可）那 4 个 GPL-3 头为 MIT；在 GitHub 提 issue 属于对外发帖，按 AGENTS.md §10 要人先同意。
- **(c) 不上站，自写最小实现替代**。舵机：用 arduino-esp32 的 `ledcAttach` / `ledcWrite` 写 50 Hz 脉宽，约 30–50 行、半天（含 accept）；但舵机原本就靠 LGPL 的 arduino-esp32，替换 ESP32Servo 并不减少义务种类，意义不大。红外：用 arduino-esp32 的 RMT（`rmtWrite`）按公开 NEC 时序（9 ms 头 + 4.5 ms + 560 µs 单位）写发送，约 50–100 行，半天到一天（含 accept 与 web 侧红外接收对拍）；可参考 ESP-IDF `examples/peripherals/rmt/ir_nec_transceiver`（Unlicense OR CC0），IRremote 本身 MIT 可读，但 GPL-3 头不得照抄。代价：DECISIONS 第 1336 行写明 F-08b 是为了展示「热门第三方库能跑」，(c) 会丢掉红外这一项的演示价值。

#### 16.4 推荐（待人核）

- **ESP32Servo → (b)**【需要继续确认】：事实是 LGPL-2.1-or-later（不是「无许可」），义务与已在三件套里的 arduino-esp32 同类，没有 GPL 文件。建议人核后把它从第 30 行的「待人核」改成「挂 LGPL 三件套上站」，NOTICE 写明 Bennett / Harrington / Margolis 派生关系。
- **IRremote → 暂不上站；人同意后先走 (b) 问上游，问不到再做 (c)**【需要继续确认】：主体 MIT 没问题，但 4 个无条件编入的 GPL-3 头与 MIT 声明矛盾，且 bin 含闭源库，无法以 GPL-3 兜底。(a) 的「宏 / 类型不算派生」论证可以成立，但属于法律判断，不由 AI 定。

#### 16.5 人定（2026-10-22）

- ESP32Servo：人对 §16.4 回复「可以 go」，按 (b) 挂 LGPL 三件套上站（F-08e 落地）。
- IRremote：人随后又定「我觉得没问题可以上去」，按 MIT 上站（F-08e 同一轮落地）。依据（主会话补查，经协调转来）：
  - (a) issue #397（2016，z3t0）就是新版本切换到 MIT 的那次改许可，与 README「2.8.0 起 MIT」一致；
  - (b) ArminJo/Arduino-Utils 和 ArminJo/PWMMotorControl（都是 GPL-3.0）里有同样的 `LongUnion.h` / `LocalDebugLevelStart.h`，说明这 4 个头是版权人本人拷进来的样板文件；
  - (c) `TinyIR.h` 声明的实现 `TinyIRReceiver.hpp` 是 MIT（与 §16.2 表一致）。
- NOTICES 写法：MIT 全文 + LICENSE 与各协议文件的全部版权人 + `digitalWriteFast.h` 的 BSD-3 声明 + 一句说明（4 个 GPL 头只含宏、类型 / 结构声明和常量，不产生自身目标代码，所配实现为 MIT），源码位置给钉的提交 `498dc591`。

##### 上游 issue 草稿（可选：请作者统一文件头，不阻塞上站）

向上游提 issue 属对外发帖（AGENTS.md §10），**没有发**，也不要用 `gh` 代发，由人决定。发之前把行号对一下钉的提交 `498dc591`；上游如有回复，回到本节记录链接。

- 仓库：https://github.com/Arduino-IRremote/Arduino-IRremote/issues/new
- 标题：`License question: four GPL-3.0 headers included by IRremote.hpp (MIT library)`

> Hi Armin, and thanks for maintaining IRremote. It is a great library and we would like to use it in an educational project.
>
> We are building TryBoard, a browser-based ESP32 simulator for hobbyists, and would like to ship a small precompiled example (based on `examples/SimpleSender`) that uses IRremote 4.7.1. While preparing the third-party notices we read the license headers of everything under `src/`, and we found a small inconsistency that we hope you can clarify.
>
> The repository `LICENSE` and `library.json` say MIT, and almost all source files carry MIT headers. However, four headers that are always compiled in when a sketch includes `IRremote.hpp` carry a GPL-3.0-or-later notice ("part of Arduino-Utils"):
>
> - `src/LocalDebugLevelStart.h`
> - `src/LocalDebugLevelEnd.h`
> - `src/LongUnion.h` (included unconditionally from `IRremote.hpp`)
> - `src/TinyIR.h` (included from `ir_FAST.hpp`, which `IRremote.hpp` includes unconditionally)
>
> (Checked at commit `498dc591b255d8ba2e239c875804bdab2ab0fe91`.)
>
> Because of these headers, it is unclear whether a firmware binary built with IRremote can be distributed under MIT terms alone. As the author of both the library and these files, would you be willing to license these four files under MIT, the same as the repository `LICENSE` (for example by changing their headers in the IRremote copy)? A short comment here confirming your intent would also help.
>
> We fully understand if you prefer to keep them as they are. Thank you for your time!


---

## 三、不能放宽的项及原因

1. **托管用 ESPRESSIF MIT / Espressif Modified MIT 组件编出的固件**（小智、ESP-ADF、esp-sr、esp-who、esp_audio_codec / esp_audio_effects / esp_capture / esp_video、esp_codec_dev 2.x）：修改版条款明文写"Redistribution … FOR USE WITH NON-ESPRESSIF PRODUCTS is strictly prohibited"；旧版条款也只授权"for use on ESPRESSIF SYSTEMS products"。只有乐鑫书面许可才能托管。
2. **乐鑫 logo（图形标、组合标）**：logo 指南只规定用法，不授予许可；CC 授权不覆盖商标。画到 3D 或页面上要先书面确认。
3. **espressif.com / dl.espressif.com 上没有授权声明的文件**（原理图 PDF、PCB PDF、尺寸 DXF、整板模型）：网站条款 VIII.1 / IX.6 禁止复制和商业使用。只能读出尺寸事实自己建模。
4. **wokwi-boards**：没有许可证，就是保留所有权利。
5. **GPL / AGPL 代码与素材**（espressif/qemu、CircuitJS、SimulIDE、Velxio）：读可以，复制、翻译、照搬结构不行。网站要是想闭源或收费，就更不能混进去。
6. **Fritzing 图形**：法律上允许用，但 SA 会传到用户导出的图上（Fritzing 官方就是这么解释的），和我们"用户产出归用户"冲突。产品上维持不用。
7. **Seeed wiki 内容（GPL-3.0）、微雪 wiki（未查到授权）、平台 3D 库（SnapEDA 等，未逐条核对）**：只录事实、外链。
8. **联盟链接不标"广告"**：《互联网广告管理办法》第九条第三款是明确义务。

---

## 四、需要发邮件确认的事项

收件地址都取自乐鑫官网原文：legal@espressif.com（网站服务条款里出现两次）、marketing@espressif.com（Logo Guidelines 页的联名合作联系）。乐鑫网站上没有找到专门的开源授权邮箱，建议发给 legal@，抄送 marketing@；或者通过官网 "Sales Questions" 表单提交，备注请转法务或开源团队。按 AGENTS.md，**对外发信、在 GitHub 公开提问都要人点头**。

### 邮件 A：商标与开发板外观（致乐鑫法务，抄送市场）

To: legal@espressif.com
Cc: marketing@espressif.com
Subject: Trademark and product-depiction questions for an independent ESP32 education simulator

> Dear Espressif Legal and Marketing teams,
>
> I am the developer of TryBoard, an independent, browser-based educational simulator. It runs unmodified ESP32-C3 and ESP32-S3 firmware (built with ESP-IDF) at instruction level, so hobbyists can try a project before buying hardware. Our goal is to help users pick the right Espressif chip and board. The site will be free at launch; we may later add paid features or advertising.
>
> We would like to confirm that the following uses are acceptable to Espressif:
>
> 1. Using chip and product names (e.g. "ESP32-C3", "ESP32-S3", "ESP32-S3-DevKitC-1", "ESP32-S3-WROOM-1") in descriptive text such as "runs firmware built for ESP32-S3". Our product name and domain will not contain "ESP32" or "Espressif".
> 2. Showing a 3D illustration of development boards that reproduces the board outline and the silkscreen model text (e.g. "ESP32-S3-DevKitC-1" on the PCB and "ESP32-S3-WROOM-1" on the module shield), labelled "illustrative model, not an official Espressif model". By default we leave out the Espressif logo. Would Espressif permit showing the logo on the module shield for realism? If so, under what conditions?
> 3. The esp-dev-kits repository README states that documentation content "including text, diagrams, and images" is licensed under CC BY-SA 4.0, while the documentation site's Disclaimer page says no licenses are granted. Can we rely on CC BY-SA 4.0 for the pin layout images in `docs/_static/` (with attribution and the same license)?
> 4. May we use the board dimension files linked from the user guides (e.g. `DXF_ESP32-S3-DevKitC-1_V1.1_20220429.dxf` on dl.espressif.com) as the basis for our 3D board models? We would not redistribute the original files.
>
> Our footer will read: "Espressif, ESP32, ESP32-C3, ESP32-S3 and related product names are trademarks of Espressif Systems (Shanghai) Co., Ltd. TryBoard is an independent project and is not affiliated with, endorsed or sponsored by Espressif." Please let us know if you would prefer different wording.
>
> Thank you for your time.
>
> Best regards,
> [Name] / TryBoard
> [Contact]

### 邮件 B：乐鑫 MIT / 修改版 MIT 组件能否随示例固件托管（致乐鑫法务 / 开源团队）

To: legal@espressif.com
Subject: Licensing question: hosting ESP-IDF example firmware that uses Espressif (Modified) MIT components, for an ESP32 simulator

> Dear Espressif team,
>
> TryBoard is an independent, browser-based simulator of ESP32-C3 and ESP32-S3. It is an education tool that lets users run real ESP-IDF firmware before buying Espressif hardware. We would like to host a few prebuilt example firmware images on our website so users can run them in the simulator. Some of these images would include components under the "ESPRESSIF MIT License" (e.g. esp-sr) or the "Espressif Modified MIT License" (e.g. esp_audio_codec, esp_audio_effects, esp_capture), for example the open-source xiaozhi-esp32 project.
>
> The Modified MIT License states that the software "MUST BE USED IN CONJUNCTION WITH ESPRESSIF SYSTEMS PRODUCTS" and prohibits redistribution "FOR USE WITH NON-ESPRESSIF PRODUCTS". We want to respect these terms, so we would like to ask:
>
> 1. Does running such firmware in a simulator of an Espressif chip, so users can evaluate before buying Espressif hardware, count as use "in conjunction with" / "on" Espressif products?
> 2. If not by default, would Espressif grant written permission for TryBoard to host and run such prebuilt firmware images in the simulator? Each image would ship with the full license texts, copyright notices and exact source/version information. The firmware would remain built for, and flashable to, real Espressif chips.
> 3. Is there an official interpretation or FAQ for the "ESPRESSIF MIT License" that we should follow?
>
> Until we hear from you, we will not host any firmware containing these components.
>
> Best regards,
> [Name] / TryBoard
> [Contact]

### 邮件 C（可选）：微雪 / Seeed 的 3D 模型和 wiki 图片

两家官网都没查到授权条款，对方邮箱这次也没核实，建议通过官网的联系 / 技术支持表单提交。英文草稿：

> Hello, we run TryBoard, a free browser-based ESP32 simulator for education. We would like to show a 3D model of your [board name] (and/or its pinout diagram) in our simulator, with attribution and a link to your product page. Could you tell us under what license your 3D models and wiki images are released, and whether this use is permitted? We will not imply any partnership. Thank you.

### 邮件 D（可选，需人同意后在 GitHub 公开提问）：wokwi-boards 许可证

> Hi, wokwi-boards currently has no LICENSE file. Would you consider adding one (e.g. MIT, like wokwi-elements)? We'd like to reuse some board definitions in an open educational simulator, with attribution.

---

## 五、对 `docs/LICENSING.md` 的修改建议（逐条，不直接改）

1. **"乐鑫 ROM" 一行**：把"需附 LICENSE / NOTICE 及 ROM 内第三方声明"改为"需附 Apache-2.0 全文、README 的版权行（'Copyright (c) 2015-2022 Espressif Systems (Shanghai) Co. Ltd.'）及 ROM 第三方清单（Newlib BSD、Xtensa libhal MIT、TinyBasic Plus MIT、miniz 公有领域、TJpgDec、Zephyr USB Apache-2.0/BSD-3）；仓库无 NOTICE 文件"。规则 1 同步改。
2. **"espressif/qemu 源码" 一行**：改为"✅ 可读源码理解硬件行为；❌ 不复制、不逐行翻译、不照搬函数结构；行为参考写进 DECISIONS 并有固件差分验证"。依据加上"GPLv2 §0；《计算机软件保护条例》第六、十七条"。规则 2 同步改。
3. **新增一行 "其他 GPL/AGPL 模拟器"**：CircuitJS（GPL-2.0）、SimulIDE（开发仓库 AGPL-3.0）、Velxio（AGPL-3.0 + 商业授权）：可读，不进仓库。
4. **"ESP32 / Espressif" 一行**：把"ESP32 等已申请"改为"ESPRESSIF 美国注册 6119571；ESP 有申请；ESP32 本身注册情况未查到"。补一句"产品型号可以描述性使用，包括 3D 丝印上的型号文字；乐鑫 logo 不用，除非书面许可"。页脚声明换成第 11 节的新句子。
5. **"开发板 3D / 图形" 一行拆成三行**：
   - KiCad 官方库 / 乐鑫 KiCad 库 / Seeed OPL：CC BY-SA 4.0，"可转 glTF 上网站、可下载；集中署名；改过的模型以 BY-SA 4.0 单独公开；场景和代码不受影响（合集）"；
   - Adafruit CAD Parts、M5Stack M5_Hardware：MIT，可用，附声明，去 logo；
   - espressif.com / dl.espressif.com 下载件：无授权、网站条款限制商业使用，只读尺寸；esp-dev-kits 仓库图片 README 写 CC BY-SA 4.0，但与文档站免责声明冲突，待邮件 A 确认。
6. **"我们托管的示例固件" 一行拆开**：
   - 我们自己的 ESP-IDF 固件（Apache/BSD/MIT 组件）：附 `LICENSES.txt` + esp-idf-sbom 生成的 SPDX 清单；源码与构建配置只作可复现性建议；
   - LGPL / GPL / EUPL 固件：维持三件套；
   - "xiaozhi MIT" 改成"xiaozhi 自身 MIT，**但依赖 esp-sr（乐鑫 MIT）、esp_audio_codec / esp_audio_effects（乐鑫修改版 MIT），在乐鑫书面许可前不托管**"。
7. **新增一行 "乐鑫 MIT / 乐鑫修改版 MIT"**：引原文要点，结论"不托管含这些组件的固件；构建脚本检测到 `LicenseRef-Espressif-Modified-MIT` 或 'ESPRESSIF MIT' 时拒绝发布；esp_codec_dev 锁 1.x（Apache-2.0），2.x 改用了修改版 MIT"。
8. **新增一行 "ESP-IDF 闭源库"**：esp32-wifi-lib / esp-phy-lib / esp32-bt-lib / esp-coex-lib 是 Apache-2.0，可随固件分发。
9. **新增一行 "Fritzing / wokwi"**：Fritzing CC BY-SA 3.0（SA 会传到用户导出图，不用）；wokwi-elements MIT 可用；wokwi-boards 无许可证不可用。
10. **新增一行 "ngspice"**：排除 `xspice/icm/table`（GPL）、`--disable-klu`、不 `--with-tcl`；numparam（LGPL）无法排除，ngspice 编成独立 wasm 并附源码与构建脚本。
11. **新增一行 "字体"**：Noto Sans SC、JetBrains Mono，OFL-1.1，自托管与子集化允许，附 OFL.txt，子集名不带 "Source"。
12. **新增一行 "价格与外链"**：人工核价 + 日期 + 来源，不写"最低价 / 最佳"；不用平台 logo；联盟链接要显著标"广告"（《互联网广告管理办法》第九条第三款），推荐逻辑与佣金脱钩，申请前读各联盟现行规范。
13. **规则 7 "收费前书面向乐鑫确认"**：改成"上线前发出邮件 A、B；收费、广告或联盟上线前要有回复"。
14. **新增规则 8**："网站要有第三方授权页（`/licenses`），列出代码库、ROM、固件组件、3D 模型、字体、HDRI 的来源、许可证与署名；由构建脚本从各素材目录的 SOURCES.md 自动生成。"
15. **文首**：把"2026-10-15 代理调研"补成"2026-10-15 调研，2026-10-16 复核（见 LICENSING_REVIEW.md）"。

---

## 来源（2026-10-16 访问）

- KiCad 库许可：https://www.kicad.org/libraries/license/ ；https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/master/LICENSE.md
- 乐鑫 KiCad 库：https://github.com/espressif/kicad-libraries （LICENSE.md、README.md）
- CC BY-SA 4.0：https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt ；CC BY-SA 3.0：https://creativecommons.org/licenses/by-sa/3.0/legalcode.txt ；CC FAQ：https://creativecommons.org/faq/
- esp-dev-kits：https://github.com/espressif/esp-dev-kits （README "Open Source Licensing"）；https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/disclaimer-and-copyright.html
- 乐鑫硬件设计指南条款：https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/disclaimer-and-copyright.html
- 乐鑫网站服务条款：https://www.espressif.com/en/content/terms-use ；Logo 指南：https://www.espressif.com/en/about-espressif/logo-guidelines
- ESPRESSIF MIT：https://github.com/espressif/esp-adf/blob/master/LICENSE ；Modified MIT：https://components-file.espressif.com/components/espressif/esp_capture/1.1.1/license.txt ；组件注册表 API：https://components.espressif.com/api/components/espressif/<name>
- ESP-IDF 版权页：https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html ；esp-idf-sbom：https://github.com/espressif/esp-idf-sbom
- esp-rom-elfs：https://github.com/espressif/esp-rom-elfs
- espressif/qemu：https://github.com/espressif/qemu （LICENSE、README.rst、hw/riscv/esp32c3.c 文件头）
- GPLv2：https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt ；AGPLv3：https://www.gnu.org/licenses/agpl-3.0.txt
- 《计算机软件保护条例》：https://zh.wikisource.org/wiki/计算机软件保护条例 ；17 U.S.C. §102：https://www.law.cornell.edu/uscode/text/17/102
- 商标正当使用：https://www.zhonglun.com/research/articles/8458.html ；ESPRESSIF 美国商标：https://trademarks.justia.com/880/64/espressif-88064254.html
- Velxio：https://github.com/davidmonterocrespo24/velxio （LICENSE、COMMERCIAL_LICENSE.md）；CircuitJS：https://github.com/pfalstad/circuitjs1 ；SimulIDE：https://github.com/Arcachofo/SimulIDE-dev
- ngspice：https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/COPYING ；configure.ac、src/frontend/Makefile.am、src/xspice/icm/GNUmakefile.in（同仓库）
- Fritzing：https://github.com/fritzing/fritzing-parts （LICENSE.txt）；Adafruit Fritzing：https://github.com/adafruit/Fritzing-Library
- Adafruit CAD：https://github.com/adafruit/Adafruit_CAD_Parts ；Adafruit 商标：https://www.adafruit.com/trademarks
- M5Stack：https://github.com/m5stack/M5_Hardware ；Seeed：https://github.com/Seeed-Studio/OPL_Kicad_Library 、https://github.com/Seeed-Studio/wiki-documents
- wokwi：https://github.com/wokwi/wokwi-elements 、https://github.com/wokwi/wokwi-boards 、https://github.com/wokwi/avr8js 、https://github.com/wokwi/rp2040js
- 小智依赖：https://github.com/78/xiaozhi-esp32/blob/main/main/idf_component.yml
- 《广告法》：https://zh.wikisource.org/wiki/中华人民共和国广告法_(2021年) ；《互联网广告管理办法》：https://zh.wikisource.org/wiki/互联网广告管理办法
- 淘宝联盟旧版规范（现行性未核实）：http://download.taobaocdn.com/mtop/release/shangbiao/tktgxy.pdf 、http://download.taobaocdn.com/mtop/release/shangbiao/tblmhz.pdf
- Poly Haven：https://polyhaven.com/license ；OFL-FAQ：https://openfontlicense.org/ofl-faq/ ；JetBrains Mono：https://github.com/JetBrains/JetBrainsMono ；Noto Sans SC：https://github.com/google/fonts/tree/main/ofl/notosanssc
- 其余 GitHub 仓库许可证取自 GitHub API 的 license 字段（three.js、Manifold、Rapier、esp32-wifi-lib 等）。

收费、广告、联盟上线，或者乐鑫回信内容与本文结论不一致时，建议请律师看一遍。
