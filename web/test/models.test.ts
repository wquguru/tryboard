// External 3D model asset rules (P1-09, LICENSING.md rules 4 / 8): glb ≤ 1 MB valid glTF 2.0, SOURCES.md, licence text;
// sources only from ✅ repos; every model name used by web code is in the manifest. SOURCES.md is written in Chinese.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'assets/models');
const manifest: { name: string; repo: string; commit: string; license: string }[] = JSON.parse(fs.readFileSync(path.join(root, 'tools/models/models.json'), 'utf8'));
const ALLOWED: Record<string, string> = {
  'https://gitlab.com/kicad/libraries/kicad-packages3D': 'CC-BY-SA-4.0',
  'https://github.com/adafruit/Adafruit_CAD_Parts': 'MIT',
  'https://github.com/m5stack/M5_Hardware': 'MIT',
};

test('manifest models come only from ✅ sources at pinned commits', () => {
  assert.ok(manifest.length >= 2);
  for (const m of manifest) {
    assert.equal(ALLOWED[m.repo], m.license, `${m.name}: ${m.repo} is not on the ✅ list or the licence differs`);
    assert.match(m.commit, /^[0-9a-f]{40}$/, m.name);
  }
});

for (const m of manifest) {
  test(`asset dir ${m.name}: glb + SOURCES.md + LICENSE`, () => {
    const d = path.join(dir, m.name);
    const glb = fs.readFileSync(path.join(d, `${m.name}.glb`));
    assert.ok(glb.length <= 1024 * 1024, `${m.name}.glb ${glb.length} bytes > 1 MB`);
    // glb header: magic "glTF", version 2, length = file size; no textures in JSON (no vendor logos / brand decals)
    assert.equal(glb.toString('latin1', 0, 4), 'glTF');
    assert.equal(glb.readUInt32LE(4), 2);
    assert.equal(glb.readUInt32LE(8), glb.length);
    const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
    assert.equal((json.images ?? []).length, 0, 'must not carry textures');
    assert.equal((json.textures ?? []).length, 0, 'must not carry textures');
    const src = fs.readFileSync(path.join(d, 'SOURCES.md'), 'utf8');
    assert.ok(src.includes(m.commit), 'SOURCES.md must name the commit');
    assert.ok(src.includes(m.repo), 'SOURCES.md must name the repo');
    assert.match(src, /\| 作者 \| .+ \|/); // lint: allow-cjk (SOURCES.md headings)
    assert.match(src, /## 改动说明/); // lint: allow-cjk
    assert.match(src, /## 署名/); // lint: allow-cjk
    if (m.license === 'CC-BY-SA-4.0') assert.match(src, /以 CC BY-SA 4\.0 提供/); // lint: allow-cjk
    const lic = fs.existsSync(path.join(d, 'LICENSE.md')) ? 'LICENSE.md' : 'LICENSE';
    const text = fs.readFileSync(path.join(d, lic), 'utf8');
    assert.match(text, m.license === 'MIT' ? /Permission is hereby granted/ : /CC-BY-SA 4\.0/);
  });
}

test('model names used by web code are all in the manifest', () => {
  const ts = fs.readFileSync(path.join(root, 'web/src/extmodels.ts'), 'utf8');
  const used = [...ts.matchAll(/:\s*'([a-z0-9.-]+)'/g)].map((x) => x[1]).filter((n) => /^(kicad|adafruit|m5stack)-/.test(n));
  assert.ok(used.length >= 2);
  for (const n of used) assert.ok(manifest.some((m) => m.name === n), `${n} is not in tools/models/models.json`);
});
