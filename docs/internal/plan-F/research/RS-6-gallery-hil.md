# RS-6：画廊 / remix / 动态 OG（O13）与真机 HIL 标定（O12）

日期 2026-10-20。只调研，没有注册、花钱或部署。价格是查询当天的公开页面，网上能查到的数都标了来源；查不到的标「未核实」。

## 一句话结论
- **O13**：先做纯静态（a）。作品放进 URL / `.tryboard`，固件只按「内置示例 id + sha」引用，画廊是仓库里的 JSON，OG 图在构建时出。用户上传自己的 .bin 才需要对象存储和审核，等有真实需求再上（b）Cloudflare Pages + R2，且**始终不做账号**。动态 OG 在微信里没用（见 A3），预期收益要往下调。
- **O12**：先买两块板（C3 + S3 N16R8），再加分析仪、OLED、BME280、USB 电流表，克隆件估计 ¥150–250（淘宝价未核实）。优先标定 QEMU 对照不了的那几行：Wi-Fi、BLE、ADC、I2C 线长、PSRAM tuning。

## A. 画廊 + remix + 动态 OG

### A1 决定架构的是固件大小
用户的 flash.bin 有 200 KB–1 MB，放不进 URL。所以纯静态只能分享「内置固件 + 台面状态 + 输入日志」，O1 已经覆盖这部分；要 remix 自己上传的 bin，就必须有存储。

### A2 三种架构

| | (a) 纯静态 | (b) 静态 + 边缘函数 | (c) GitHub 投稿 |
|---|---|---|---|
| 做法 | 状态编进 URL hash；画廊 = `web/gallery.json`；OG 用构建时的 puppeteer 出图（U-18 已有这条管线） | Pages 托管静态文件；Worker 收投稿，bin 存 R2、元数据存 KV/D1；Worker 渲染动态 OG | 投稿 = Issue 模板 / PR 附 `.tryboard`；人工合入后由 CI 重建画廊 |
| 用户上传 bin | 不支持 | 支持 | 支持（附件或 PR） |
| 审核 | 不需要（我们自己挑） | 必须有队列、举报和下架 | 合入 PR 就是审核 |
| 账号 | 无 | 可以不要（匿名 + 限流） | 投稿人要有 GitHub 账号，对学生是门槛 |
| 前提 | 无 | 托管账号、域名 | **仓库要公开**（AGENTS §2 写明要人拍板） |
| 工作量 | 1–2 个 session | 4–6 个（Worker、R2、审核页、限流、OG 渲染） | 2–3 个（模板 + CI） |

**流量估算**：首次访问约 3–5 MB（wasm ≤2 MB，加 3D、固件），按每个 MAU 约 20 MB 算，1k / 10k / 100k MAU ≈ 20 GB / 200 GB / 2 TB 每月。

| 托管 | 1k MAU | 10k | 100k | 说明 |
|---|---|---|---|---|
| Cloudflare Pages + Workers + R2 | $0 | $0 | $0–5 | Pages 页面没写带宽上限；Workers 免费 10 万请求/天，付费 $5/月起；R2 免费 10 GB、出站流量不收费 [1][2][3] |
| Vercel | $0 | 超 Hobby 的 100 GB → Pro | Pro $20/月 + 每席 $20，超 1 TB 另付超额 | Hobby 只能个人**非商用** [4] |
| Netlify | 已超免费额度（300 credit，1 GB 扣 20 credit ≈ 15 GB）→ 要 Pro $20/月 | 超 Pro 的约 150 GB → 另付超额（单价未核实） | 远超 Pro | [5] |
| Supabase（做后端） | 免费 | 免费 | Pro $25/月 | 免费项目闲置 1 周会被暂停，不适合这种业余项目 [6] |
| GitHub Pages / Issues | $0 | $0 | $0 | github.com 在国内能打开但慢；github.io 和 raw 时通时断 |

### A3 国内访问、ICP 和微信
- Cloudflare Pages / workers.dev：社区报告说国内访问**时通时断**，查不到官方说法 [7]。用自己的域名、不走国内节点，就不需要 ICP 备案。
- 腾讯 EdgeOne Pages：开国内加速**必须先备案**，否则只能选「全球（不含中国大陆）」[8]；免费额度未核实。ICP 备案要用个人身份证和国内主体；做 UGC 还要公安备案。
- **微信基本不读 og:image**。要出卡片，得用 JS-SDK + 认证公众号 + 已备案域名 [9]。所以动态 OG 只在 X / Telegram / Discord 等平台有用，对国内主力用户帮助很小。
- 动态 OG 要在 Worker 里渲染图片（satori / resvg-wasm 一类），属于新依赖，要先进 LICENSING / DECISIONS。

### A4 审核、滥用和隐私
- **bin 本身伤不到看的人**（在 wasm 沙箱里跑）。风险在三处：①固件可以在虚拟屏（SSD1306 / GC9A01 / CO5300）上画任意图文，进了画廊缩略图和 OG 就是内容风险；②上传别人的闭源固件有版权问题；③别人把分享的 bin 烧进真板。
- **凭据泄漏，无论选哪种托管都必须先修**：输入日志里有 `ssid=…&pass=…`（C-02）和 `netreply` 的回包正文（C-03）。分享、导出到画廊之前要把这些字段剥掉，或者让用户明确确认。O1 已经可以单独做这件事。
- **账号**：每个阶段都不做。在国内做 UGC 账号要手机实名，还要守《个人信息保护法》：不满 14 岁的个人信息算敏感信息，要监护人同意；另有《未成年人网络保护条例》。学生是目标用户，不做账号能避开整类义务。只要开始存用户上传的东西，就要写隐私说明和下架流程。

### A5 分阶段
1. **S0（现在，不用拍板）**：O1 URL / `.tryboard` + 凭据剥离 + `gallery.json` 精选 + 构建时为每个精选作品出一张静态 OG 图。
2. **S1（要拍板：上线）**：Cloudflare Pages 自定义域名，纯静态上线；用 (c) 的轻量版收投稿（站内一个按钮打开预填的 GitHub Issue），人工挑选后放进 gallery.json。
3. **S2（要拍板：后端）**：真有人要分享自己的 bin 时，再加 Worker + R2：匿名、限大小（≤2 MB）、限流、举报下架、默认不公开、人工审核后才进画廊，同时加动态 OG。
4. **S3（可选）**：做国内加速 / 微信卡片，需要 ICP 备案和公众号，单独决定。

**各阶段碰到的 §10 项**：S1 要注册托管账号、花钱买域名、公开部署，开投稿仓库还要建 remote / 公开仓库；S2 要下架流程（删除用户数据），新依赖先进 LICENSING；S3 要注册公众号、花钱、备案（用人的身份证）；B 部分要花钱买硬件。

## B. 真机 HIL 标定

### B1 采购清单（克隆件为主）

| 物件 | 海外参考价 | 估人民币 | 优先级 |
|---|---|---|---|
| ESP32-C3-DevKitM-1（或克隆） | 首发 $8 [10] | ¥15–50 | 1 |
| ESP32-S3-DevKitC-1 N16R8（或克隆） | $5.4–13 [11] | ¥35–80 | 1 |
| ESP32-DevKitC-V4（32E） | $10 [12] | ¥20–70 | 3（经典 ESP32 只有 7 个用例；本机没装 esp32 工具链，见 AGENTS §4） |
| 24 MHz 8 通道逻辑分析仪（fx2lafw / sigrok） | €11.8–$27 [13] | ¥25–60 | 1 |
| SSD1306 0.96" I2C | €6–8 [14] | ¥10–20 | 2 |
| BME280 模块（很多是 BMP280 冒充） | €12 [14] | ¥15–35 | 2 |
| USB 电流表（只能看平均值） | 未核实 | ¥20–60 | 2 |
| USB-UART（CP2102 / CH340），面包板、杜邦线、电位器 | 未核实 | ¥20–40 | 2 |
| 可选：PPK2 / INA219 测峰值电流 | 未核实，约 $90 | ¥15–700 | 4 |

淘宝价没核实（要登录）。人民币一列是按海外价折算的估计。必选合计约 ¥150–250，和 EVAL 里 ¥150 的估算同一量级，下单时由人核价。

### B2 测什么、用什么工具

| 项 | 现有工具 | 要新增的 `tools/hil/` | 把哪些「估算」改成「已标定」 |
|---|---|---|---|
| 串口一致（accept 固件） | accept.json `expect`、check.py `fingerprint()` | `run.py`：esptool 烧 `firmware/build/*/flash.bin` → DTR/RTS 复位 → 抓 N 秒串口 → 去掉本来就会不同的行（芯片版本、MAC、eFuse、`MSPI Timing` tuning、时间戳）→ 跟模拟器的输出比。没写 `chip` 的 53 个用例要按 accept.sh 的默认值处理 | 驱动层；真机日志补上 QEMU 给不了的对照 |
| GPIO 时序 | `--vcd`（1 ps）、`--trace-io` | `sigrok-cli -d fx2lafw` 抓波形 → 两边转成边沿列表，带容差比对（24 MHz 约 42 ns 精度） | PWM、I2C、WS2812、DHT11、HC-SR04 |
| ADC 曲线和噪声 | c3-adc-cali（0.5 / 1 / 1.65 / 2 V） | 电位器 + 万用表手动给电压，脚本记 raw 值、算 σ | ADC 行的「真实模式」曲线和 σ2LSB |
| 启动时间 | — | 主机记「复位 → 第一个串口字节 → app_main 那行」 | 启动耗时 |
| 电流 | `--elec-report`、功耗估算 | 第 1 档 USB 电流表看平均值，人工记；第 2 档 INA219 / PPK2 看峰值 | 功耗估算、欠压判断 |
| I2C 线长 | weather-i2c-long / nack | 换 20 / 60 / 150 cm 的线跑 weather，看在哪一档出错 | P2-11 的常数 |
| PSRAM | s3-psram | 串口比对 tuning success 那行 | 记下已知偏差 |
| Wi-Fi / BLE | wifi-wpa2、softap-prov、c3-ble-hr | 真路由器 + 手机（nRF Connect）走一遍，存日志 | 行为模拟里的假设（重连时间、iPhone 弹不弹登录页） |

### B3 工作量和分工
- **人**：下单收货（约 1 周）；插好板子，把 USB 口告诉 agent；Wi-Fi / BLE 那项要人拿手机和路由器配合（约 1 小时）；ADC 和电流要人读万用表 / 电流表（约 1 小时）。
- **agent**：`tools/hil/` 串口 runner 加对比报告（1–2 session），sigrok 边沿比对（1 session），把结果写回 STATUS 的「未经真机标定」列（1 session）。合计 3–4 个 session，各按一个 PLAN ID 拆开。
- 标定结论只对那一块板成立，STATUS 里写成「单板标定（型号 / 批次）」，不当作普遍结论。

## 来源
[1] https://developers.cloudflare.com/workers/platform/pricing/ [2] https://developers.cloudflare.com/r2/pricing/ [3] https://developers.cloudflare.com/pages/platform/limits/ [4] https://vercel.com/pricing [5] https://www.netlify.com/pricing/ [6] https://supabase.com/pricing [7] https://lowendspirit.com/discussion/8352 [8] https://intl.cloud.tencent.com/document/product/1145/63620 [9] https://www.v2ex.com/t/961962 [10] https://www.cnx-software.com/2021/03/26/esp32-c3-devkitm-1-risc-v-wifi-ble-board-to-launch-for-8-modules-for-1-8/ [11] https://www.globalsources.com/Motion-sensor/CORE-Board-1228699312p.htm 、https://www.bitsandparts.nl/en/esp32-s3-devkitc-n16r8-development-board-wifi-buetooth-p1923998 [12] https://www.digikey.com/en/products/detail/espressif-systems/ESP32-DEVKITC-V4/9356990 [13] https://www.sparkfun.com/products/18627 、https://store.open-electronics.org/USB-Logic-Analyzer-24-MHz-8CH-Microcontroller- [14] https://www.az-delivery.de/en/collections/bestseller/arduino

## 需人拍板

| # | 事项 | 选项 | 推荐 | 费用 | 风险 |
|---|---|---|---|---|---|
| 1 | 是否公开上线（§10） | 不上线 / Cloudflare Pages / Vercel / EdgeOne | Cloudflare Pages | $0（流量估算 ≤100k MAU） | 国内访问时通时断；需要注册托管账号 |
| 2 | 买域名 | 不买 / .com / .cn | .com | 约 $10/年（未核实） | .cn 牵扯实名和备案 |
| 3 | ICP 备案 + 国内加速 | 不做 / 做 | 先不做 | ¥0，但要个人身份证，约 1–3 周 | 个人信息上报；UGC 还要公安备案 |
| 4 | 公开仓库 / 建 remote（§2、§10） | 不公开 / 公开 | 方案 (c) 才需要；S1 可以只开一个独立的投稿仓库 | $0 | 公开前要再过一遍许可证 |
| 5 | 接收用户上传的 bin（S2） | 不收 / 匿名 + 审核 | 等有需求再说 | $0–5/月 | 内容审核、版权、隐私说明、下架流程 |
| 6 | 账号体系 | 无 / 第三方登录 | 无 | — | 未成年人和实名义务 |
| 7 | 微信卡片 | 不做 / 公众号 + JS-SDK | 不做 | 认证公众号要年费（未核实）+ 备案 | 主体资质 |
| 8 | 动态 OG 渲染依赖 | 不加 / satori 一类 | 等 S2 再说 | $0 | 许可证要先进 LICENSING |
| 9 | HIL 采购（§10 花钱） | 不买 / C3 + S3 + 分析仪 + 外设 / 再加 ESP32 和 PPK2 | 前者，约 ¥150–250 | ¥150–250（另加约 ¥700 可选） | 克隆板和真 DevKit 有差别；BME280 可能是假货 |
| 10 | 实测谁来做 | 人自己插板、拿手机配合 / 寄给别人代测 / 不做 | 人自己做，每轮约 2 小时 | 人工时间 | 一次测试的结论只对单板成立 |
