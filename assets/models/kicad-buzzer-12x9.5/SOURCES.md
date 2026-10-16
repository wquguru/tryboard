# Φ12 mm 蜂鸣器（12 × 9.5 mm，引脚距 7.6 mm）

| 项 | 内容 |
|---|---|
| 文件 | `kicad-buzzer-12x9.5.glb`（34.7 KB） |
| 原始文件 | https://gitlab.com/kicad/libraries/kicad-packages3D/-/blob/8975715167d1a76f9b44be155ac02326f704cdbb/Buzzer_Beeper.3dshapes/Buzzer_12x9.5RM7.6.step |
| 仓库 / 提交 | https://gitlab.com/kicad/libraries/kicad-packages3D @ `8975715167d1a76f9b44be155ac02326f704cdbb` |
| 作者 | KiCad Library Team 及贡献者 |
| 许可证 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)（KiCad 库许可，含设计例外，见同目录 LICENSE.md） |
| 是否修改 | 已修改 |
| 网站里用在 | 实验台蜂鸣器模块上的蜂鸣器本体（可选替换，默认程序生成） |
| 转换工具 | occt-import-js 0.0.23（LGPL-2.1，构建期）、@gltf-transform/core 4.5.1（MIT，构建期）、meshoptimizer 1.3.0（MIT，构建期） |

## 改动说明
- 用 occt-import-js 三角化，Z 朝上转为 Y 朝上（单位仍为 mm）
- 按 B-rep 面颜色拆分材质，金属色设为金属度 1；去重、焊接重复顶点、同材质图元合并、量化（KHR_mesh_quantization）
- 减面（meshoptimizer，目标保留 50% 顶点，误差 ≤ 0.2%）：3740 → 1884 个三角形
- 金属灰统一成网站的不锈钢色：#A5A392 → #CDD1D6；其余保留原文件颜色
- 没有删部件；原文件没有 logo、商标图形或贴图（转换脚本仍会清掉任何贴图）

## 署名
3D 模型 "Buzzer_12x9.5RM7.6" 来自 KiCad Libraries（https://gitlab.com/kicad/libraries/kicad-packages3D），© KiCad Library Team 及贡献者，CC BY-SA 4.0（https://creativecommons.org/licenses/by-sa/4.0/）。已转换为 glTF；已修改（见上）。不提供任何担保。

本目录的 `kicad-buzzer-12x9.5.glb` 是上述模型的改编作品，**以 CC BY-SA 4.0 提供**，可以在网站 `models/kicad-buzzer-12x9.5/kicad-buzzer-12x9.5.glb` 直接下载（同目录附 LICENSE.md 与本文件）。这一许可只约束模型文件本身，不延伸到使用它的场景和网站代码。
