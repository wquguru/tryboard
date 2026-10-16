#!/usr/bin/env node
// STEP → glTF（.glb）转换管线（P1-09）。只在本机构建期跑，产物 assets/models/<名字>/<名字>.glb 进 git，原始 STEP 不进。
// 步骤：occt-import-js（OpenCascade 的 wasm 版，LGPL-2.1，只在这里用、不进网站）三角化 →
//       按 B-rep 面颜色拆成图元、Z 朝上转 Y 朝上（单位保持 mm）→ glTF-Transform（MIT）去重、焊点、减面、合并、量化 → .glb
// 同时按 models.json 写每个素材目录的 SOURCES.md（来源、提交、作者、许可证、改动），licenses.html 从那里自动带署名。
// 用法：node tools/models/fetch.mjs && node tools/models/convert.mjs [名字 ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, join, prune, quantize, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import occtInit from 'occt-import-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const MAX_GLB = 1024 * 1024;
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'models.json'), 'utf8'));
const want = process.argv.slice(2);
const occt = await occtInit();
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions([KHRMeshQuantization]);
const pkgVer = (n) => JSON.parse(fs.readFileSync(path.join(here, 'node_modules', n, 'package.json'), 'utf8')).version;
const TOOLS = `occt-import-js ${pkgVer('occt-import-js')}（LGPL-2.1，构建期）、@gltf-transform/core ${pkgVer('@gltf-transform/core')}（MIT，构建期）、meshoptimizer ${pkgVer('meshoptimizer')}（MIT，构建期）`;

const hex = (c) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const lin = (h) => [1, 3, 5].map((i) => ((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))(parseInt(h.slice(i, i + 2), 16) / 255));
/** KiCad 3D 库的标准材质色（金针、亮金属）认成金属；其余当塑料 */
function pbr(h) {
  const [r, g, b] = lin(h);
  const gold = r > 0.3 && r > g * 1.25 && g > b * 1.6;
  const grey = Math.abs(r - g) < 0.06 && Math.abs(g - b) < 0.12 && r > 0.25;
  // 亮金属统一成网站的不锈钢色（KiCad 的金属灰偏黄，在实验台的低环境光下发暗发绿）
  return gold ? { metallic: 1, roughness: 0.32 } : grey ? { metallic: 1, roughness: 0.3, color: '#CDD1D6' } : { metallic: 0, roughness: 0.62 };
}

for (const m of manifest) {
  if (want.length && !want.includes(m.name)) continue;
  const dir = path.join(root, 'assets/models', m.name);
  const step = path.join(dir, 'src', path.basename(m.path));
  if (!fs.existsSync(step)) throw new Error(`${m.name}：缺 ${path.relative(root, step)}，先跑 node tools/models/fetch.mjs`);
  const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync(step)), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: m.deflection ?? 0.002,
    angularDeflection: 0.4,
  });
  if (!r.success) throw new Error(`${m.name}：occt 读 STEP 失败`);

  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene(m.name);
  const top = doc.createNode(m.name);
  // STEP 是 Z 朝上，three.js / glTF 是 Y 朝上：绕 X 转 -90°
  if ((m.up ?? 'z') === 'z') top.setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  scene.addChild(top);
  const mats = new Map();
  const recolored = new Set();
  const material = (h, name) => {
    const key = `${name ?? ''}${h}`;
    if (!mats.has(key)) {
      const p = m.metal?.[name] !== undefined ? { metallic: m.metal[name] ? 1 : 0, roughness: m.metal[name] ? 0.3 : 0.55 } : pbr(h);
      if (p.color) recolored.add(`${h} → ${p.color}`);
      mats.set(key, doc.createMaterial(name ?? h).setBaseColorFactor([...lin(p.color ?? h), 1]).setMetallicFactor(p.metallic).setRoughnessFactor(p.roughness));
    }
    return mats.get(key);
  };
  const drop = (m.drop ?? []).map((s) => new RegExp(s));
  let trisIn = 0, dropped = 0;
  const walk = (on, parent) => {
    const nodeName = on.name || '';
    if (drop.some((re) => re.test(nodeName))) {
      dropped++;
      return;
    }
    const gn = doc.createNode(nodeName);
    parent.addChild(gn);
    if (on.meshes.length) {
      const mesh = doc.createMesh(nodeName);
      const override = m.colors?.[nodeName];
      for (const mi of on.meshes) {
        const om = r.meshes[mi];
        const pos = om.attributes.position.array, nor = om.attributes.normal?.array, idx = om.index.array;
        trisIn += idx.length / 3;
        // 同一实体里不同 B-rep 面可能是不同颜色（金针 / 黑塑料）：按面颜色分图元
        const groups = new Map();
        const faces = om.brep_faces?.length ? om.brep_faces : [{ first: 0, last: idx.length / 3 - 1, color: null }];
        for (const f of faces) {
          const h = override ?? hex(f.color ?? om.color ?? [0.6, 0.6, 0.6]);
          if (!groups.has(h)) groups.set(h, []);
          for (let t = f.first; t <= f.last; t++) groups.get(h).push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
        }
        for (const [h, ids] of groups) {
          // 每组只留用到的顶点
          const remap = new Map();
          const p = [], n = [], ix = [];
          for (const v of ids) {
            if (!remap.has(v)) {
              remap.set(v, remap.size);
              p.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
              if (nor) n.push(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
            }
            ix.push(remap.get(v));
          }
          const prim = doc.createPrimitive()
            .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buf))
            .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(ix)).setBuffer(buf))
            .setMaterial(material(h, override ? nodeName : undefined));
          if (nor) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(n)).setBuffer(buf));
          mesh.addPrimitive(prim);
        }
      }
      gn.setMesh(mesh);
    }
    for (const c of on.children) walk(c, gn);
  };
  walk(r.root, top);

  await doc.transform(
    dedup(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: m.simplify ?? 1, error: 0.002 }),
    join({ keepNamed: true }),
    prune(),
    quantize({ quantizePosition: 14, quantizeNormal: 10 }),
  );
  // STEP 里没有贴图；保险起见把任何贴图都去掉（不带厂商 logo / 品牌贴图）
  for (const t of doc.getRoot().listTextures()) t.dispose();
  const trisOut = doc.getRoot().listMeshes().reduce((s, me) => s + me.listPrimitives().reduce((a, pr) => a + (pr.getIndices()?.getCount() ?? 0) / 3, 0), 0);
  doc.getRoot().getAsset().generator = 'TryBoard tools/models/convert.mjs';
  doc.getRoot().getAsset().copyright = m.copyright ?? `${m.author} · ${m.license}`;
  const glb = await io.writeBinary(doc);
  if (glb.byteLength > MAX_GLB) throw new Error(`${m.name}：glb ${(glb.byteLength / 1024).toFixed(0)} KB 超过 1 MB，调大减面`);
  const out = path.join(dir, `${m.name}.glb`);
  fs.writeFileSync(out, glb);

  // ---------------------------------------------------------------- SOURCES.md
  const bysa = m.license === 'CC-BY-SA-4.0';
  const modified = (m.simplify ?? 1) < 1 || dropped > 0 || m.colors || recolored.size > 0;
  const changes = [
    '用 occt-import-js 三角化，Z 朝上转为 Y 朝上（单位仍为 mm）',
    '按 B-rep 面颜色拆分材质，金属色设为金属度 1；去重、焊接重复顶点、同材质图元合并、量化（KHR_mesh_quantization）',
    (m.simplify ?? 1) < 1 ? `减面（meshoptimizer，目标保留 ${Math.round((m.simplify ?? 1) * 100)}% 顶点，误差 ≤ 0.2%）：${trisIn} → ${trisOut} 个三角形` : `未减面：${trisIn} → ${trisOut} 个三角形（只去重 / 焊接）`,
    m.colors ? `原文件没有颜色，按部件指定颜色：${Object.entries(m.colors).map(([k, v]) => `${k} ${v}`).join('、')}` : recolored.size ? `金属灰统一成网站的不锈钢色：${[...recolored].join('、')}；其余保留原文件颜色` : '保留原文件颜色',
    dropped ? `删掉 ${dropped} 个部件（${m.drop.join('、')}）` : '没有删部件；原文件没有 logo、商标图形或贴图（转换脚本仍会清掉任何贴图）',
  ];
  const srcUrl = m.source === 'kicad' ? `${m.repo}/-/blob/${m.commit}/${encodeURI(m.path)}` : `${m.repo}/blob/${m.commit}/${encodeURI(m.path)}`;
  const md = `# ${m.title}

| 项 | 内容 |
|---|---|
| 文件 | \`${m.name}.glb\`（${(glb.byteLength / 1024).toFixed(1)} KB） |
| 原始文件 | ${srcUrl} |
| 仓库 / 提交 | ${m.repo} @ \`${m.commit}\` |
| 作者 | ${m.author} |
| 许可证 | ${bysa ? '[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)（KiCad 库许可，含设计例外，见同目录 LICENSE.md）' : `MIT（${m.copyright}，全文见同目录 LICENSE）`} |
| 是否修改 | ${modified ? '已修改' : '仅转换格式'} |
| 网站里用在 | ${m.use} |
| 转换工具 | ${TOOLS} |

## 改动说明
${changes.map((c) => `- ${c}`).join('\n')}

## 署名
${bysa
    ? `3D 模型 "${path.basename(m.path, '.step')}" 来自 KiCad Libraries（${m.repo}），© ${m.author}，CC BY-SA 4.0（https://creativecommons.org/licenses/by-sa/4.0/）。已转换为 glTF；${modified ? '已修改（见上）' : '未修改'}。不提供任何担保。

本目录的 \`${m.name}.glb\` 是上述模型的${modified ? '改编作品' : '格式转换'}，**以 CC BY-SA 4.0 提供**，可以在网站 \`models/${m.name}/${m.name}.glb\` 直接下载（同目录附 LICENSE.md 与本文件）。这一许可只约束模型文件本身，不延伸到使用它的场景和网站代码。`
    : `3D 模型 "${path.basename(m.path, '.step')}" 来自 Adafruit CAD Parts（${m.repo}），${m.copyright}，MIT 许可（许可与版权声明见同目录 LICENSE）。已转换为 glTF${modified ? '并修改（见上）' : ''}。不使用 Adafruit 的名称或 logo 作产品标识。`}
`;
  fs.writeFileSync(path.join(dir, 'SOURCES.md'), md);
  console.log(`[convert] ${m.name}: ${trisIn} → ${trisOut} 三角形，${(glb.byteLength / 1024).toFixed(1)} KB`);
}
