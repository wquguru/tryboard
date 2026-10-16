// 参数化外壳（P1-08）：布局 / 警告、Manifold 出网格、STL / 3MF 导出能被 three.js 读回
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'manifold-3d';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { DEFAULT_PARAMS, buildCaseMeshes, caseLayout, caseSel, printLayout } from '../src/app/enclosure.ts';
import { crc32, to3mf, toStl } from '../src/app/meshio.ts';

const M = await Module();
M.setup();

const sel = (board = 's3-devkitc1-v10') => caseSel(board, ['bme280', 'ssd1306', 'sg90', 'gc9a01']);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('气象站默认参数：装得下，没有警告；内腔 28 mm ≥ 舵机 27 mm', () => {
  const L = caseLayout('weather', DEFAULT_PARAMS.weather, sel());
  assert.deepEqual(L.warnings, []);
  assert.equal(L.inner, 28);
  assert.equal(L.need, 27);
  assert.deepEqual(L.outer, [50, 70, 32]);
  for (const id of ['shell', 'board', 'bme', 'servo', 'oled', 'front']) assert.ok(L.slots[id], `槽位 ${id}`);
  assert.deepEqual(Object.keys(L.slots.bme).sort(), ['A', 'B']);
  // 贴芯片那个位置比通风口旁近得多（尺子读数的来源）
  const dA = dist(L.slots.bme.A.center, L.chip!), dB = dist(L.slots.bme.B.center, L.chip!);
  assert.ok(dB < 8 && dA > 25, `B ${dB.toFixed(1)} mm / A ${dA.toFixed(1)} mm`);
});

test('太矮：高度降到 30 mm 就装不下舵机，警告给出最低高度', () => {
  const L = caseLayout('weather', { ...DEFAULT_PARAMS.weather, height: 30 }, sel());
  const w = L.warnings.find((x) => x.id === 'servo-height');
  assert.ok(w && /太矮/.test(w.text), JSON.stringify(L.warnings));
  assert.equal(L.minHeight, 31);
  assert.deepEqual(caseLayout('weather', { ...DEFAULT_PARAMS.weather, height: 31 }, sel()).warnings, []);
  // 换金属齿舵机（28.5 mm 高）30 mm 就够了
  assert.deepEqual(caseLayout('weather', { ...DEFAULT_PARAMS.weather, height: 30 }, caseSel('s3-devkitc1-v10', ['mg90s'])).warnings, []);
});

test('透镜小人：DevKitC-1 平放进不了 Ø50 底座，加高到能竖放或换 XIAO 就好', () => {
  const L = caseLayout('lens', DEFAULT_PARAMS.lens, sel());
  assert.ok(L.warnings.some((w) => w.id === 'board-fit'));
  assert.deepEqual(caseLayout('lens', { ...DEFAULT_PARAMS.lens, height: 75 }, sel()).warnings, []);
  assert.deepEqual(caseLayout('lens', DEFAULT_PARAMS.lens, sel('xiao-s3')).warnings, []);
});

test('小黄：底座太矮装不下舵机', () => {
  assert.deepEqual(caseLayout('spin', DEFAULT_PARAMS.spin, sel()).warnings, []);
  assert.ok(caseLayout('spin', { ...DEFAULT_PARAMS.spin, height: 24 }, sel()).warnings.some((w) => w.id === 'servo-height'));
});

test('USB 小键盘（P2-12）：默认 22 mm 装得下 DevKitC-1 + 按键，没有警告；压到 14 mm 报按键太高', () => {
  const L = caseLayout('usbkey', DEFAULT_PARAMS.usbkey, sel());
  assert.deepEqual(L.warnings, []);
  assert.deepEqual(L.outer, [44, 80, 22]);
  assert.ok(L.slots.board.U && L.slots.board.R && L.slots.keys[''] && L.slots.caps[''].prims.length === 4);
  // 装反的开发板：USB 口那块（第 3 个 prim）在另一端
  const uy = L.slots.board.U.prims[2].at[1], ry = L.slots.board.R.prims[2].at[1];
  assert.ok(uy < 0 && ry > uy, `${uy} → ${ry}`);
  const low = caseLayout('usbkey', { ...DEFAULT_PARAMS.usbkey, height: 14 }, sel());
  assert.ok(low.warnings.some((w) => w.id === 'key-height'), JSON.stringify(low.warnings));
  assert.ok(low.minHeight > 14 && low.minHeight <= 22, String(low.minHeight));
});

for (const t of ['weather', 'spin', 'lens', 'usbkey']) {
  test(`${t}：Manifold 布尔出的网格是封闭实体，导出 STL / 3MF 能读回`, () => {
    const L = caseLayout(t, { ...DEFAULT_PARAMS[t], height: t === 'lens' ? 75 : DEFAULT_PARAMS[t].height }, sel());
    const m = buildCaseMeshes(M, L);
    assert.ok(m.volume.bottom > 1000 && m.volume.lid > 500, JSON.stringify(m.volume));
    // 每条边恰好被两个三角形共用（封闭流形，切片软件不会报破面）
    for (const d of [m.bottom, m.lid]) {
      const edges = new Map<string, number>();
      for (let i = 0; i < d.idx.length; i += 3)
        for (let k = 0; k < 3; k++) {
          const a = d.idx[i + k], b = d.idx[i + ((k + 1) % 3)];
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      assert.ok([...edges.values()].every((c) => c === 2), '非流形边');
    }
    const objs = printLayout(L, m);
    const tris = objs.reduce((a, o) => a + o.mesh.idx.length / 3, 0);
    // STL：three.js STLLoader 读回，三角形数、包围盒一致
    const stl = toStl(objs);
    assert.equal(stl.length, 84 + tris * 50);
    const g = new STLLoader().parse(stl.buffer as ArrayBuffer);
    assert.equal(g.getAttribute('position').count, tris * 3);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    assert.ok(Math.abs(bb.min.z) < 1e-3, `贴床 z=${bb.min.z}`);
    let xmax = -Infinity;
    for (const o of objs) for (let i = 0; i < o.mesh.pos.length; i += 3) xmax = Math.max(xmax, o.mesh.pos[i]);
    assert.ok(Math.abs(bb.max.x - xmax) < 1e-3);
    // 3MF：zip 能解开、CRC 对、模型 XML 里顶点 / 三角形数对
    const z = to3mf(objs, t);
    const files = unzipSync(z);
    assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const xml = strFromU8(files['3D/3dmodel.model']);
    assert.equal((xml.match(/<triangle /g) ?? []).length, tris);
    assert.equal((xml.match(/<vertex /g) ?? []).length, objs.reduce((a, o) => a + o.mesh.pos.length / 3, 0));
    assert.equal((xml.match(/<object /g) ?? []).length, 2);
    assert.match(xml, /unit="millimeter"/);
  });
}

test('CRC32 与标准值一致', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
