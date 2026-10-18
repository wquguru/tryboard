# 选型助手（M9）

页面：`web/select.html`（界面名「选板」，地址 `/select`；旧 `advisor.html` 跳转过来），数据 `web/src/advisor/data.ts`，引擎 `engine.ts`（纯函数），界面 `main.ts`。

## 规则
- 硬需求（模板的 needCaps + 配件隐含的能力）不满足的板子直接淘汰，并给出原因
- 打分：额外能力 +8/项；电池场景按板载充电与整板深睡电流加减分；价格中位数 /6 扣分；芯片能在试板完整仿真 +6；引脚不够 -25
- 引脚分配：排除 flash / 八线 PSRAM / USB（需要时）/ UART0 / 板载占用；小板只在实际引出的引脚里分配，I2C 优先用板子惯用引脚；strapping 脚最后才用并提示；模拟量只用 ADC1
- 功耗：工作期电流 = RX + 15% ×（TX 峰值 − RX）+ 外设；平均电流按占空比加权整板深睡电流；1000mAh × 85% 折算天数。标"估算"

## 待人工核对的事实（发布前逐条对照数据手册 / 厂商页面）
- 各芯片典型电流（TX 峰值、RX、light / deep sleep）
- 各芯片 strapping、flash、USB、UART0、ADC1 引脚表；P4 的引脚表把握最低
- 开发板：DevKitC-1 板载 RGB（v1.0 GPIO48 / v1.1 GPIO38）、SuperMini 板载 LED GPIO8 低电平亮、XIAO 系列 D0–D10 对应 GPIO、XIAO S3 Sense 麦克风 GPIO42 / 41、SD 片选 GPIO21
- 整板深睡电流：XIAO C3 约 44µA、XIAO C6 约 15µA 为厂商宣传值；XIAO S3 Sense、SuperMini、DevKit 类为经验估计
- 价格区间（2026 年常见电商价）
