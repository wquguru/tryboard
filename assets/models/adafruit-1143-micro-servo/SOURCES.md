# 9 g 微型舵机（Adafruit 1143，与 SG90 同外形）

| 项 | 内容 |
|---|---|
| 文件 | `adafruit-1143-micro-servo.glb`（32.0 KB） |
| 原始文件 | https://github.com/adafruit/Adafruit_CAD_Parts/blob/c128bceb1f96b6ea8b68f250bda986ba85da24ea/1143%20Micro%20Servo%20-%20High%20Torque%20Metal%20Gear/1143%20Micro%20Servo%20High%20Torque%20Metal%20Gear.step |
| 仓库 / 提交 | https://github.com/adafruit/Adafruit_CAD_Parts @ `c128bceb1f96b6ea8b68f250bda986ba85da24ea` |
| 作者 | Adafruit Industries |
| 许可证 | MIT（Copyright (c) 2016 Adafruit Industries，全文见同目录 LICENSE） |
| 是否修改 | 已修改 |
| 网站里用在 | 实验台舵机、小黄转台（可选替换，默认程序生成） |
| 转换工具 | occt-import-js 0.0.23（LGPL-2.1，构建期）、@gltf-transform/core 4.5.1（MIT，构建期）、meshoptimizer 1.3.0（MIT，构建期） |

## 改动说明
- 用 occt-import-js 三角化，Z 朝上转为 Y 朝上（单位仍为 mm）
- 按 B-rep 面颜色拆分材质，金属色设为金属度 1；去重、焊接重复顶点、同材质图元合并、量化（KHR_mesh_quantization）
- 减面（meshoptimizer，目标保留 50% 顶点，误差 ≤ 0.2%）：1524 → 1248 个三角形
- 原文件没有颜色，按部件指定颜色：body #2F6FD0、spline #EDEDED
- 没有删部件；原文件没有 logo、商标图形或贴图（转换脚本仍会清掉任何贴图）

## 署名
3D 模型 "1143 Micro Servo High Torque Metal Gear" 来自 Adafruit CAD Parts（https://github.com/adafruit/Adafruit_CAD_Parts），Copyright (c) 2016 Adafruit Industries，MIT 许可（许可与版权声明见同目录 LICENSE）。已转换为 glTF并修改（见上）。不使用 Adafruit 的名称或 logo 作产品标识。
