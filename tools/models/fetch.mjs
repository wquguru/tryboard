#!/usr/bin/env node
// Downloads models.json STEP files to assets/models/<name>/src/, only from LICENSING.md ✅ sources at a pinned commit so SOURCES.md is exact.
// Usage: node tools/models/fetch.mjs [name ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const ALLOWED = {
  kicad: { repo: 'https://gitlab.com/kicad/libraries/kicad-packages3D', raw: (c, p) => `https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/${c}/${p}`, license: 'CC-BY-SA-4.0', licenseFile: 'LICENSE.md' },
  adafruit: { repo: 'https://github.com/adafruit/Adafruit_CAD_Parts', raw: (c, p) => `https://raw.githubusercontent.com/adafruit/Adafruit_CAD_Parts/${c}/${p}`, license: 'MIT', licenseFile: 'LICENSE' },
  m5stack: { repo: 'https://github.com/m5stack/M5_Hardware', raw: (c, p) => `https://raw.githubusercontent.com/m5stack/M5_Hardware/${c}/${p}`, license: 'MIT', licenseFile: 'LICENSE' },
};

const manifest = () => JSON.parse(fs.readFileSync(path.join(here, 'models.json'), 'utf8'));

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === 3) throw new Error(`${url}: ${e.message}`);
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
    }
  }
}

const want = process.argv.slice(2);
for (const m of manifest()) {
  if (want.length && !want.includes(m.name)) continue;
  const src = ALLOWED[m.source];
  if (!src) throw new Error(`${m.name}: source ${m.source} is not on the LICENSING.md ✅ list`);
  if (m.repo !== src.repo || m.license !== src.license) throw new Error(`${m.name}: repository / license does not match the ✅ list`);
  if (!/^[0-9a-f]{40}$/.test(m.commit)) throw new Error(`${m.name}: commit must be a full 40-character hash`);
  const dir = path.join(root, 'assets/models', m.name, 'src');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(m.path));
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, await get(src.raw(m.commit, encodeURI(m.path))));
  }
  // License text travels with the model (CC BY-SA 4.0 §3(a)(1); MIT copyright and permission notice)
  const lic = path.join(root, 'assets/models', m.name, src.licenseFile === 'LICENSE.md' ? 'LICENSE.md' : 'LICENSE');
  if (!fs.existsSync(lic)) fs.writeFileSync(lic, await get(src.raw(m.commit, src.licenseFile)));
  // KiCad: a library directory with its own LICENSE needs per-file review (LICENSING_REVIEW section 1, residual risk)
  if (m.source === 'kicad') {
    const libDir = path.dirname(m.path);
    for (const n of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      const r = await fetch(src.raw(m.commit, `${encodeURI(libDir)}/${n}`)).catch(() => null);
      if (r?.ok) throw new Error(`${m.name}: ${libDir}/${n} exists with separate license terms, review it by hand first`);
    }
  }
  console.log(`[fetch] ${m.name} ← ${m.path} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}
