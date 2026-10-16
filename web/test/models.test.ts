// 外部 3D 模型素材目录的规矩（P1-09，LICENSING.md 规则 4 / 8）：每个模型都有 glb（≤ 1 MB、合法 glTF 2.0）、
// SOURCES.md（来源 URL、40 位提交、作者、许可证、改动、署名）和许可证原文；来源只能是 ✅ 名单里的仓库；
// 网页代码里用到的模型名都在清单里。
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

test('清单里的模型只来自 ✅ 来源、钉死提交', () => {
  assert.ok(manifest.length >= 2);
  for (const m of manifest) {
    assert.equal(ALLOWED[m.repo], m.license, `${m.name}：${m.repo} 不在 ✅ 名单或许可证不符`);
    assert.match(m.commit, /^[0-9a-f]{40}$/, m.name);
  }
});

for (const m of manifest) {
  test(`素材目录 ${m.name}：glb + SOURCES.md + LICENSE`, () => {
    const d = path.join(dir, m.name);
    const glb = fs.readFileSync(path.join(d, `${m.name}.glb`));
    assert.ok(glb.length <= 1024 * 1024, `${m.name}.glb ${glb.length} 字节 > 1 MB`);
    // glb 头：magic "glTF"、版本 2、总长与文件一致；JSON 块里没有贴图（不带厂商 logo / 品牌贴图）
    assert.equal(glb.toString('latin1', 0, 4), 'glTF');
    assert.equal(glb.readUInt32LE(4), 2);
    assert.equal(glb.readUInt32LE(8), glb.length);
    const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
    assert.equal((json.images ?? []).length, 0, '不应带贴图');
    assert.equal((json.textures ?? []).length, 0, '不应带贴图');
    const src = fs.readFileSync(path.join(d, 'SOURCES.md'), 'utf8');
    assert.ok(src.includes(m.commit), 'SOURCES.md 要写提交');
    assert.ok(src.includes(m.repo), 'SOURCES.md 要写仓库');
    assert.match(src, /\| 作者 \| .+ \|/);
    assert.match(src, /## 改动说明/);
    assert.match(src, /## 署名/);
    if (m.license === 'CC-BY-SA-4.0') assert.match(src, /以 CC BY-SA 4\.0 提供/);
    const lic = fs.existsSync(path.join(d, 'LICENSE.md')) ? 'LICENSE.md' : 'LICENSE';
    const text = fs.readFileSync(path.join(d, lic), 'utf8');
    assert.match(text, m.license === 'MIT' ? /Permission is hereby granted/ : /CC-BY-SA 4\.0/);
  });
}

test('网页代码引用的模型名都在清单里', () => {
  const ts = fs.readFileSync(path.join(root, 'web/src/extmodels.ts'), 'utf8');
  const used = [...ts.matchAll(/:\s*'([a-z0-9.-]+)'/g)].map((x) => x[1]).filter((n) => /^(kicad|adafruit|m5stack)-/.test(n));
  assert.ok(used.length >= 2);
  for (const n of used) assert.ok(manifest.some((m) => m.name === n), `${n} 不在 tools/models/models.json`);
});
