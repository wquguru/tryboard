# RS-3 兴趣数据：芯片 / 库 / 器件 / 主题 / 竞品

日期 2026-10-20。方法：WebSearch + WebFetch + `gh api`（GitHub 星数、LICENSE 原文）。**数据局限先说**：没有取到 Arduino Library Manager / PlatformIO 的下载量（PlatformIO 注册表是 JS 页面，API 返回 400）、没有 Google Trends、没有淘宝 / 速卖通销量、没有 B 站播放量、没有 ESPHome 按芯片的统计。下文"热度"只能用 GitHub 星数、教程站年度榜、竞品器件目录这类**代理信号**，已逐项标注。

## 1. 芯片热度（回答 O10 是否"经典 ESP32 先于 C6"）

| 信号 | 结果 | 来源 |
|---|---|---|
| Random Nerd Tutorials 2025 年榜 Top5 | 经典 ESP32 出现在 5 篇里的 4 篇（FreeRTOS、ESP-IDF、CYD+ESP-NOW、RFID 网页）；第 1 名是 C3 Super Mini 入门；**S3、C6 均未入榜**，C6 只出现在读者留言（要 Zigbee 教程） | [1] |
| RNT 2024 年榜 | 第 1、2 名都是 CYD（经典 ESP32 + ILI9341 触摸屏） | [2] |
| 购买指南（零售商博客，偏观点） | 一篇称经典 ESP32 仍是 2026 最畅销；一篇称 S3 是 2024–25 新设计最常用；多篇称 C3 是便宜入门；C6 只在要 Thread/Zigbee/Matter 时推荐；乐鑫已将 WROOM-32D/U 标为 NRND | [3][4] |
| 小智 AI（xiaozhi-esp32）GitHub 星数 | 31.6k（今日 gh 查询），MIT，支持芯片 C3/S3/P4，70+ 开发板；官方文档主打 S3 | [5][6] |
| ESPHome 2025.6 起支持 OpenThread，仅 C6/H2 | C6 的增长点是智能家居，量化数据缺失 | [7] |
| Wokwi 支持的芯片 | ESP32、S2、S3、C3、C6、H2、P4(beta)、C5/C61/S31(alpha) | [8] |

**结论**：判断"经典 ESP32 是教程最多的芯片，应先于 C6"**部分成立**。教程量（RNT）和存量确实以经典 ESP32 为主，新增长在 S3（AI 语音）和 C3（低价入门），C6 暂无教程热度证据，只有智能家居 / Thread 的定性信号。但"经典 ESP32 补全"的价值在于**覆盖教程与存量板（CYD、DevKit V1）**，而不是它比 S3 更热。注意 Wokwi 已支持 C6，TryBoard 在芯片数上落后但 C3/S3 完整度更高。

## 2. Arduino 库 Top 20

无下载量，按 GitHub 星数 + 教程常见度排序（星数为 2026-10-20 `gh api`，可能含非 ESP32 用户）。"已建模"指 TryBoard 是否已有对应硬件模型。许可证取 LICENSE 原文；GitHub 显示 NOASSERTION 的我读了文件头。

| # | 库 | 星 | 许可证 | 需要的硬件 / 外设 | 已建模？ |
|---|---|---|---|---|---|
| 1 | lvgl | 25.0k | MIT | 屏幕 + 触摸（SPI/RGB） | 部分（GC9A01、CO5300、CST816S；s3-lvgl 已有） |
| 2 | FastLED | 7.5k | MIT | RMT / I2S 驱动 WS2812 | 是（WS2812；经典 ESP32 缺 RMT） |
| 3 | WiFiManager | 7.3k | MIT | Wi-Fi SoftAP + HTTP | C3 有 SoftAP；经典 ESP32 无 |
| 4 | ArduinoJson | 7.2k | MIT | 纯软件 | 是 |
| 5 | U8g2 | 6.7k | BSD-2（字体另有许可，需核） | I2C/SPI 单色屏 | 是（SSD1306）；SH1106 否 |
| 6 | TFT_eSPI | 5.0k | 混合：BSD 风格 + 继承的 MIT（需人核） | SPI TFT（ILI9341/ST7789/GC9A01） | 仅 GC9A01 |
| 7 | IRremote | 5.1k | MIT（GitHub 显示 NOASSERTION，需核） | RMT / GPIO + 红外 | 否 |
| 8 | PubSubClient | 4.0k | MIT | Wi-Fi + MQTT | 部分（MQTT 不走真实网络，见 EVAL 行 5） |
| 9 | Adafruit NeoPixel | 3.4k | LGPL-3.0 | RMT | 是 |
| 10 | MFRC522 (rfid) | 3.0k | Unlicense | SPI + RC522 | 否 |
| 11 | Adafruit GFX | 2.9k | BSD（LICENSE 原文） | 显示驱动基类 | 是（随 SSD1306） |
| 12 | Adafruit SSD1306 | 2.1k | BSD | I2C OLED | 是 |
| 13 | DHT sensor library | 2.2k | MIT | 单总线 GPIO | 是（DHT11） |
| 14 | ThingPulse esp8266-oled | 2.2k | MIT 类（NOASSERTION，需核） | I2C OLED | 是（SSD1306；SH1106 否） |
| 15 | arduino-esp32（核心，不是库） | 17.6k | LGPL-2.1 | 全部 | 已按"LGPL 三件套"处理（LICENSING.md） |
| 16 | NimBLE-Arduino | 1.1k | Apache-2.0 | BLE 控制器 | 仅 C3 |
| 17 | DallasTemperature + OneWire | 1.0k + 0.7k | MIT；OneWire 未检出文件（需人核） | 1-Wire + DS18B20 | 否 |
| 18 | RTClib | 0.9k | MIT | I2C + DS3231/DS1307 | 否 |
| 19 | ESP32Servo | 0.2k | 未检出（需人核） | LEDC | 是（SG90） |
| 20 | Adafruit BME280 / MPU6050 / Sensor | 0.4k / 0.2k / 1.1k | BSD / BSD / Apache-2.0 | I2C | 是 |

补充：ESPAsyncWebServer（0.7k，LGPL-3.0）、ESP32-audioI2S 与 ESP8266Audio 均 **GPL-3.0**（做 I2S 音频示例时不能进站点，除非走三件套且评估传染性，建议 ❌）。LiquidCrystal_I2C、Adafruit INA219 / AHTX0 / SH110x 许可证 API 返回 null 或 NOASSERTION，需读 LICENSE。

**对 O8 的建议**：20 例进 accept 不受许可证限制（只编译不分发）；要放到站点的示例，优先选 MIT / BSD / Apache 的（FastLED、ArduinoJson、PubSubClient、U8g2、Adafruit SSD1306/GFX、DHT、NimBLE、lvgl）。LGPL 库（NeoPixel、ESPAsyncWebServer、Servo）走三件套；GPL 音频库不上站。NOASSERTION 项在上线前由人核一次。

## 3. 缺失器件优先级（共 15 项）

证据只有三类：RNT 年榜（[1][2]）、Wokwi 器件目录（[8]，可视为竞品对用户需求的排序）、对应库星数（上表）。"Wokwi 有"表示其目录里有该器件。

| 优先级 | 器件 | 证据 | 备注 |
|---|---|---|---|
| 1 | ILI9341 / ST7789 TFT（含 CYD 板：ESP32 + ILI9341 + XPT2046） | RNT 2024 榜前二、2025 榜第 4 都是 CYD；Wokwi 有 ILI9341；TFT_eSPI 5.0k 星 | 依赖经典 ESP32 SPI，和 O10 绑定 |
| 2 | DS18B20 | Wokwi 有；DallasTemperature 1.0k | EVAL O4 已列 |
| 3 | SH1106 / SH1107 | Wokwi 有 SH1107；U8g2/ThingPulse 默认支持 | 与 SSD1306 近似，成本低 |
| 4 | PIR HC-SR501、LDR、继电器模块 | Wokwi 有；纯 GPIO / ADC，成本极低 | 受益于经典 ESP32 ADC |
| 5 | RC522 RFID | RNT 2025 榜第 5；MFRC522 3.0k；Wokwi 有 | SPI |
| 6 | MAX7219 点阵 | Wokwi 有；MD_Parola / LedControl 各约 0.5k | SPI |
| 7 | DS3231 / DS1307 RTC | Wokwi 有 DS1307；RTClib 0.9k | I2C |
| 8 | IR 接收 / 遥控 | Wokwi 有；IRremote 5.1k | RMT |
| 9 | 步进电机 + ULN2003 / A4988 | Wokwi 有 A4988 | GPIO |
| 10 | HX711 称重 | Wokwi 有；库 1.0k | 2 线 GPIO，易做 |
| 11 | MQ 系列气体 | Wokwi 有 MQ2 | ADC |
| 12 | AHT20 | 库仅 75 星，没有竞品目录证据 | 偏低，但 EVAL O4 已列 |
| 13 | INA219 | 库 233 星 | 偏低 |
| 14 | OV2640 摄像头 | esp32-camera 2.8k 星；难度大 | 对应 O14 |
| 15 | DFPlayer、L298N / TB6612 | 未取得证据 | 暂不排 |

注：O4 清单里的 AHT20 和 INA219 在证据上排在后面；DS18B20、SH1106 站得住；建议加 ILI9341 / ST7789 到首位、RC522 到前 5。

## 4. 热门主题

| 主题 | 证据 | 对模拟器的吸引力 |
|---|---|---|
| AI 语音助手（小智） | 31.6k 星（MIT，持续增长：2026-04 25.7k → 今 31.6k）；70+ 板型；B 站 / CSDN / 立创教程多（播放量未取到） | 高：S3 + I2S + 屏幕，TryBoard 已有 MAX98357A / INMP441；缺网络与大模型链路，只能模拟"板子侧" |
| LVGL 智能屏 / CYD | RNT 榜连年前列；lvgl 25.0k 星 | 高：需要经典 ESP32 + ILI9341 |
| Home Assistant / ESPHome | HA 分析页显示 704,743 个安装（仅含开启分析者，日期未显示 [9]）；ESPHome 仓库 11.9k 星 | 中：ESPHome 是 YAML，用户不看固件，模拟价值在"选板"而非调试 |
| Matter / Thread | ESPHome 2025.6 起支持 OpenThread（C6/H2）[7] | 中：需要 C6 + 802.15.4，实现成本高 |
| BLE 小玩具 / 桌宠 | 未取得量化数据 | 中：C3 BLE 已通 |

## 5. 竞品对照

| 项 | Wokwi | Tinkercad Circuits | TryBoard |
|---|---|---|---|
| 芯片 | AVR、ESP32 全系（含 C6/H2、P4 beta）、STM32、RP2040 [8] | 仅 Arduino Uno 类，无 ESP32 [10] | C3/S3 完整，经典 ESP32 部分 |
| 器件 | 官方页列约 70 种（传感器 12、显示 9、电机、74HC 逻辑、示波器 / 逻辑分析仪、SD 卡）；自称 100+ [8][11] | 未取得清单 | 约 20 件有模型 |
| 自定义器件 | Chips API | 否 | 否（EVAL 行 7） |
| 分享 | 链接分享；免费版项目公开，付费（Hobby $7 / Hobby+ $12 / Pro $25 每月）可设"不公开"、自定义库、连本地 Wi-Fi [12] | 未取得 | 无画廊 |
| 嵌入 | 官方文档未提及 iframe 嵌入（第三方 Microlink 声称可生成嵌入） | 未取得 | 无 |
| 热度 | Explodingtopics 搜索量 673K，+14% [13] | 无 | 无 |
| 差异 | 行为级、2D 原理图；无 3D 场景、无选型 / BOM | 同左 | 3D、真实固件、选型信任等级 |

Wokwi 没有画廊式发现页（在我取到的材料里），分享就是 URL。TryBoard 的"链接 + 选型结论卡片"可以走差异化路线，但这是推断，不是 Wokwi 的缺陷证据。

## 6. 对 O4 / O8 / O10 / O14 排序的建议

| 项 | 建议 | 理由 |
|---|---|---|
| O10 经典 ESP32 补 RMT/ADC/SPI/I2S | **保持 P1，甚至提前**，范围按"CYD + DevKit 教程"裁剪：SPI（TFT）、ADC、RMT 优先，I2S 次之 | RNT 2025 榜 4/5、2024 榜前二都是经典 ESP32；LVGL + CYD 同时满足第 1 位器件和热门主题 |
| O4 器件补齐 | 改清单：ILI9341/ST7789、DS18B20、SH1106 在前，加 PIR/LDR/继电器、RC522；AHT20、INA219 降后 | 见 §3；前三项靠 O10 的 SPI |
| O8 Arduino 库矩阵 | 20 例以 §2 前 12 个为准，先做 MIT/BSD 的，GPL 音频库不进 | 许可证见 §2；NOASSERTION 项上线前人核 |
| O14 C6 / 摄像头 | **保持 P2**；C6 证据只有定性（ESPHome Thread、Wokwi 已支持），教程榜上无 C6 | 无量化支持；若转向智能家居叙事再提前 |
| 额外 | S3 + 小智类"AI 语音板子侧"场景值得单独做一例 | 31.6k 星，最强的单项热点信号 |

## 来源

[1] https://randomnerdtutorials.com/?p=186351 （RNT 2025 年度回顾，WebFetch）
[2] https://randomnerdtutorials.com/?p=164661 （RNT 2024 年度回顾，搜索摘要）
[3] https://esp32.co.uk/esp32-versions-explained-which-board-should-you-buy-2026/
[4] https://jlcpcb.com/blog/esp32-versions-guide
[5] https://ossinsight.io/analyze/78/xiaozhi-esp32 ；星数 2026-10-20 `gh api repos/78/xiaozhi-esp32`
[6] https://docs.espressif.com/projects/esp-iot-solution/zh_CN/latest/ai/xiaozhi.html
[7] https://www.matteralpha.com/news/esphome-2025-6-adds-openthread-support
[8] https://docs.wokwi.com/getting-started/supported-hardware
[9] https://analytics.home-assistant.io/integrations
[10] https://macmyths.com/how-to-add-esp32-in-tinkercad/ （博客，非官方）
[11] https://docs.wokwi.com （"100+ components"）
[12] https://wokwi.com/pricing 、https://docs.wokwi.com/getting-started/wokwi-club
[13] https://explodingtopics.com/topic/wokwi?period=24
[14] 库星数与许可证：`gh api repos/<owner>/<repo>` 与 `/license`，2026-10-20；Arduino 索引星数 https://docs.arduino.cc/libraries/
[15] CYD 背景：https://randomnerdtutorials.com/cyd-lvgl/ 、https://mischianti.org/esp32-2432s028-cheap-yellow-display-high-resolution-pinout-datasheet-schema-and-specs
