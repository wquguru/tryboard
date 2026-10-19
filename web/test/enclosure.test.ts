// Parametric enclosure (P1-08): layout / warnings, Manifold meshes, STL / 3MF exports read back by three.js
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

test('weather station defaults: everything fits, no warnings; cavity 28 mm ≥ servo 27 mm', () => {
  const L = caseLayout('weather', DEFAULT_PARAMS.weather, sel());
  assert.deepEqual(L.warnings, []);
  assert.equal(L.inner, 28);
  assert.equal(L.need, 27);
  assert.deepEqual(L.outer, [50, 70, 32]);
  for (const id of ['shell', 'board', 'bme', 'servo', 'oled', 'front']) assert.ok(L.slots[id], `slot ${id}`);
  assert.deepEqual(Object.keys(L.slots.bme).sort(), ['A', 'B']);
  // The slot against the chip is much closer than the one by the vent (source of the ruler reading)
  const dA = dist(L.slots.bme.A.center, L.chip!), dB = dist(L.slots.bme.B.center, L.chip!);
  assert.ok(dB < 8 && dA > 25, `B ${dB.toFixed(1)} mm / A ${dA.toFixed(1)} mm`);
});

test('too low: at 30 mm the servo no longer fits and the warning gives the minimum height', () => {
  const L = caseLayout('weather', { ...DEFAULT_PARAMS.weather, height: 30 }, sel());
  const w = L.warnings.find((x) => x.id === 'servo-height');
  assert.ok(w && /Too short/.test(w.text), JSON.stringify(L.warnings));
  assert.equal(L.minHeight, 31);
  assert.deepEqual(caseLayout('weather', { ...DEFAULT_PARAMS.weather, height: 31 }, sel()).warnings, []);
  // A metal-gear servo (28.5 mm tall) fits in 30 mm
  assert.deepEqual(caseLayout('weather', { ...DEFAULT_PARAMS.weather, height: 30 }, caseSel('s3-devkitc1-v10', ['mg90s'])).warnings, []);
});

test('lens figure: a flat DevKitC-1 does not fit the Ø50 base; raising it to stand upright or using a XIAO fixes it', () => {
  const L = caseLayout('lens', DEFAULT_PARAMS.lens, sel());
  assert.ok(L.warnings.some((w) => w.id === 'board-fit'));
  assert.deepEqual(caseLayout('lens', { ...DEFAULT_PARAMS.lens, height: 75 }, sel()).warnings, []);
  assert.deepEqual(caseLayout('lens', DEFAULT_PARAMS.lens, sel('xiao-s3')).warnings, []);
});

test('spin: base too low for the servo', () => {
  assert.deepEqual(caseLayout('spin', DEFAULT_PARAMS.spin, sel()).warnings, []);
  assert.ok(caseLayout('spin', { ...DEFAULT_PARAMS.spin, height: 24 }, sel()).warnings.some((w) => w.id === 'servo-height'));
});

test('USB keypad (P2-12): default 22 mm fits DevKitC-1 + keys without warnings; 14 mm reports keys too tall', () => {
  const L = caseLayout('usbkey', DEFAULT_PARAMS.usbkey, sel());
  assert.deepEqual(L.warnings, []);
  assert.deepEqual(L.outer, [44, 80, 22]);
  assert.ok(L.slots.board.U && L.slots.board.R && L.slots.keys[''] && L.slots.caps[''].prims.length === 4);
  // Board mounted reversed: the USB port block (3rd prim) is at the other end
  const uy = L.slots.board.U.prims[2].at[1], ry = L.slots.board.R.prims[2].at[1];
  assert.ok(uy < 0 && ry > uy, `${uy} → ${ry}`);
  const low = caseLayout('usbkey', { ...DEFAULT_PARAMS.usbkey, height: 14 }, sel());
  assert.ok(low.warnings.some((w) => w.id === 'key-height'), JSON.stringify(low.warnings));
  assert.ok(low.minHeight > 14 && low.minHeight <= 22, String(low.minHeight));
});

for (const t of ['weather', 'spin', 'lens', 'usbkey']) {
  test(`${t}: Manifold boolean mesh is a closed solid; STL / 3MF exports read back`, () => {
    const L = caseLayout(t, { ...DEFAULT_PARAMS[t], height: t === 'lens' ? 75 : DEFAULT_PARAMS[t].height }, sel());
    const m = buildCaseMeshes(M, L);
    assert.ok(m.volume.bottom > 1000 && m.volume.lid > 500, JSON.stringify(m.volume));
    // Every edge is shared by exactly two triangles (closed manifold, slicers report no holes)
    for (const d of [m.bottom, m.lid]) {
      const edges = new Map<string, number>();
      for (let i = 0; i < d.idx.length; i += 3)
        for (let k = 0; k < 3; k++) {
          const a = d.idx[i + k], b = d.idx[i + ((k + 1) % 3)];
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      assert.ok([...edges.values()].every((c) => c === 2), 'non-manifold edge');
    }
    const objs = printLayout(L, m);
    const tris = objs.reduce((a, o) => a + o.mesh.idx.length / 3, 0);
    // STL: read back with three.js STLLoader; same triangle count and bounding box
    const stl = toStl(objs);
    assert.equal(stl.length, 84 + tris * 50);
    const g = new STLLoader().parse(stl.buffer as ArrayBuffer);
    assert.equal(g.getAttribute('position').count, tris * 3);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    assert.ok(Math.abs(bb.min.z) < 1e-3, `on the bed z=${bb.min.z}`);
    let xmax = -Infinity;
    for (const o of objs) for (let i = 0; i < o.mesh.pos.length; i += 3) xmax = Math.max(xmax, o.mesh.pos[i]);
    assert.ok(Math.abs(bb.max.x - xmax) < 1e-3);
    // 3MF: zip opens, CRC matches, vertex / triangle counts in the model XML match
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

test('CRC32 matches the standard value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
