#!/usr/bin/env node
// 按 models.json 下载原始 STEP 到 assets/models/<名字>/src/（不进 git）。
// 只允许 LICENSING.md 里 ✅ 的来源（KiCad 官方 3D 库、Adafruit CAD Parts、M5Stack M5_Hardware），而且必须钉死提交，
// 这样 SOURCES.md 里写的版本就是实际转换的那一份。
// 用法：node tools/models/fetch.mjs [名字 ...]
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
  if (!src) throw new Error(`${m.name}：来源 ${m.source} 不在 LICENSING.md ✅ 名单里`);
  if (m.repo !== src.repo || m.license !== src.license) throw new Error(`${m.name}：仓库 / 许可证与 ✅ 名单不符`);
  if (!/^[0-9a-f]{40}$/.test(m.commit)) throw new Error(`${m.name}：commit 必须是完整的 40 位哈希`);
  const dir = path.join(root, 'assets/models', m.name, 'src');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(m.path));
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, await get(src.raw(m.commit, encodeURI(m.path))));
  }
  // 许可证原文随模型一起放（CC BY-SA 4.0 §3(a)(1)、MIT 的版权与许可声明）
  const lic = path.join(root, 'assets/models', m.name, src.licenseFile === 'LICENSE.md' ? 'LICENSE.md' : 'LICENSE');
  if (!fs.existsSync(lic)) fs.writeFileSync(lic, await get(src.raw(m.commit, src.licenseFile)));
  // KiCad：库目录里另有 LICENSE 说明的模型要按文件单独看（LICENSING_REVIEW 第一节剩余风险）
  if (m.source === 'kicad') {
    const libDir = path.dirname(m.path);
    for (const n of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      const r = await fetch(src.raw(m.commit, `${encodeURI(libDir)}/${n}`)).catch(() => null);
      if (r?.ok) throw new Error(`${m.name}：${libDir}/${n} 存在，另有许可说明，先人工核对`);
    }
  }
  console.log(`[fetch] ${m.name} ← ${m.path}（${(fs.statSync(file).size / 1024).toFixed(0)} KB）`);
}
