#!/usr/bin/env node
// STEP -> .glb at build time (P1-09): occt-import-js (LGPL-2.1, never shipped) then glTF-Transform; also writes SOURCES.md for licenses.html.
// Usage: node tools/models/fetch.mjs && node tools/models/convert.mjs [name ...]
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
const TOOLS = `occt-import-js ${pkgVer('occt-import-js')} (LGPL-2.1, build time), @gltf-transform/core ${pkgVer('@gltf-transform/core')} (MIT, build time), meshoptimizer ${pkgVer('meshoptimizer')} (MIT, build time)`;

const hex = (c) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const lin = (h) => [1, 3, 5].map((i) => ((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))(parseInt(h.slice(i, i + 2), 16) / 255));
/** KiCad 3D library standard colours for gold pins and bright metal become metal; everything else is plastic */
function pbr(h) {
  const [r, g, b] = lin(h);
  const gold = r > 0.3 && r > g * 1.25 && g > b * 1.6;
  const grey = Math.abs(r - g) < 0.06 && Math.abs(g - b) < 0.12 && r > 0.25;
  // Bright metal becomes the site's steel colour: KiCad's yellowish grey looks dark green under the bench's low ambient light
  return gold ? { metallic: 1, roughness: 0.32 } : grey ? { metallic: 1, roughness: 0.3, color: '#CDD1D6' } : { metallic: 0, roughness: 0.62 };
}

for (const m of manifest) {
  if (want.length && !want.includes(m.name)) continue;
  const dir = path.join(root, 'assets/models', m.name);
  const step = path.join(dir, 'src', path.basename(m.path));
  if (!fs.existsSync(step)) throw new Error(`${m.name}: missing ${path.relative(root, step)}, run node tools/models/fetch.mjs first`);
  const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync(step)), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: m.deflection ?? 0.002,
    angularDeflection: 0.4,
  });
  if (!r.success) throw new Error(`${m.name}: occt failed to read the STEP file`);

  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene(m.name);
  const top = doc.createNode(m.name);
  // STEP is Z-up, three.js / glTF is Y-up: rotate -90° about X
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
        // Faces of one solid can differ in colour (gold pins / black plastic), so split primitives by face colour
        const groups = new Map();
        const faces = om.brep_faces?.length ? om.brep_faces : [{ first: 0, last: idx.length / 3 - 1, color: null }];
        for (const f of faces) {
          const h = override ?? hex(f.color ?? om.color ?? [0.6, 0.6, 0.6]);
          if (!groups.has(h)) groups.set(h, []);
          for (let t = f.first; t <= f.last; t++) groups.get(h).push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
        }
        for (const [h, ids] of groups) {
          // Keep only the vertices each group uses
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
  // STEP has no textures; drop any anyway so no vendor logo or branding texture can ship
  for (const t of doc.getRoot().listTextures()) t.dispose();
  const trisOut = doc.getRoot().listMeshes().reduce((s, me) => s + me.listPrimitives().reduce((a, pr) => a + (pr.getIndices()?.getCount() ?? 0) / 3, 0), 0);
  doc.getRoot().getAsset().generator = 'TryBoard tools/models/convert.mjs';
  doc.getRoot().getAsset().copyright = m.copyright ?? `${m.author} · ${m.license}`;
  const glb = await io.writeBinary(doc);
  if (glb.byteLength > MAX_GLB) throw new Error(`${m.name}: glb ${(glb.byteLength / 1024).toFixed(0)} KB exceeds 1 MB, simplify more`);
  const out = path.join(dir, `${m.name}.glb`);
  fs.writeFileSync(out, glb);

  // ---------------------------------------------------------------- SOURCES.md
  const bysa = m.license === 'CC-BY-SA-4.0';
  const modified = (m.simplify ?? 1) < 1 || dropped > 0 || m.colors || recolored.size > 0;
  const changes = [
    'Triangulated with occt-import-js, converted from Z-up to Y-up (units still mm)',
    'Materials split by B-rep face colour, metal colours set to metallic 1; deduplicated, duplicate vertices welded, same-material primitives joined, quantized (KHR_mesh_quantization)',
    (m.simplify ?? 1) < 1 ? `Simplified (meshoptimizer, target ${Math.round((m.simplify ?? 1) * 100)}% of vertices, error ≤ 0.2%): ${trisIn} → ${trisOut} triangles` : `Not simplified: ${trisIn} → ${trisOut} triangles (dedup / weld only)`,
    m.colors ? `The original has no colours; colours assigned per part: ${Object.entries(m.colors).map(([k, v]) => `${k} ${v}`).join(', ')}` : recolored.size ? `Metal grey changed to the site's steel colour: ${[...recolored].join(', ')}; other colours kept from the original` : 'Original colours kept',
    dropped ? `Removed ${dropped} parts (${m.drop.join(', ')})` : 'No parts removed; the original has no logos, trademark graphics or textures (the converter still strips any texture)',
  ];
  const srcUrl = m.source === 'kicad' ? `${m.repo}/-/blob/${m.commit}/${encodeURI(m.path)}` : `${m.repo}/blob/${m.commit}/${encodeURI(m.path)}`;
  const md = `# ${m.title}

| Field | Value |
|---|---|
| File | \`${m.name}.glb\` (${(glb.byteLength / 1024).toFixed(1)} KB) |
| Original file | ${srcUrl} |
| Repository / commit | ${m.repo} @ \`${m.commit}\` |
| Author | ${m.author} |
| License | ${bysa ? '[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (KiCad library license with design exception, see LICENSE.md in this directory)' : `MIT (${m.copyright}, full text in LICENSE in this directory)`} |
| Modified | ${modified ? 'Yes' : 'No, format conversion only'} |
| Used on the site in | ${m.use} |
| Conversion tools | ${TOOLS} |

## Changes
${changes.map((c) => `- ${c}`).join('\n')}

## Attribution
${bysa
    ? `3D model "${path.basename(m.path, '.step')}" from KiCad Libraries (${m.repo}), © ${m.author}, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Converted to glTF; ${modified ? 'modified (see above)' : 'not modified'}. No warranties are given.

\`${m.name}.glb\` in this directory is ${modified ? 'an adaptation' : 'a format conversion'} of the model above, **offered under CC BY-SA 4.0**, and can be downloaded directly from the site at \`models/${m.name}/${m.name}.glb\` (with LICENSE.md and this file alongside). This license covers only the model file itself, not the scenes or site code that use it.`
    : `3D model "${path.basename(m.path, '.step')}" from Adafruit CAD Parts (${m.repo}), ${m.copyright}, MIT license (license and copyright notice in LICENSE in this directory). Converted to glTF${modified ? ' and modified (see above)' : ''}. The Adafruit name and logo are not used to identify the product.`}
`;
  fs.writeFileSync(path.join(dir, 'SOURCES.md'), md);
  console.log(`[convert] ${m.name}: ${trisIn} → ${trisOut} triangles, ${(glb.byteLength / 1024).toFixed(1)} KB`);
}
