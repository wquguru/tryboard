#!/usr/bin/env node
// Builds web/licenses.html, THIRD_PARTY_NOTICES.txt and the SPDX 2.3 SBOM (LICENSING.md rule 8, DESIGN_V2 §7.3 C) from tools/build_web.sh.
// Exits 2 if shipped firmware has Espressif modified MIT (rule 5). Usage: node tools/gen_licenses.mjs [--out web/licenses.html] [--pub web/public]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.indexOf(k) > 0 ? process.argv[process.argv.indexOf(k) + 1] : d);
const out = path.resolve(root, arg('--out', 'web/licenses.html'));
const pub = path.resolve(root, arg('--pub', 'web/public'));
const web = path.join(root, 'web');
const rd = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const warn = [];
const today = new Date().toISOString().slice(0, 10);

/** Only the licenses we actually meet; anything else is NOASSERTION rather than a guess. */
function guessSpdx(text) {
  if (/ESPRESSIF MIT|LicenseRef-Espressif-Modified-MIT/i.test(text)) return 'LicenseRef-Espressif-Modified-MIT';
  if (/Apache License[\s\S]{0,40}Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return 'ISC';
  return 'NOASSERTION';
}
const licenseFile = (dir) => {
  if (!exists(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(txt|md))?$/i.test(n));
  return f ? path.join(dir, f) : null;
};
const copyrightLines = (text) => [...new Set(text.split('\n').map((l) => l.trim()).filter((l) => /^(\/\/\s*|#\s*|\*\s*)?copyright\s*(\(c\)|©|\d)/i.test(l)).map((l) => l.replace(/^(\/\/|#|\*)\s*/, '')))].slice(0, 3);
/** Apache LICENSE files carry no copyright line, so read SPDX-FileCopyrightText from the first few .c / .h files. */
function spdxCopyright(dir) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 3 || files.length > 20) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !/^(test|test_apps|examples?)$/.test(e.name)) walk(path.join(d, e.name), depth + 1);
      else if (/\.(c|h)$/.test(e.name)) files.push(path.join(d, e.name));
    }
  };
  walk(dir, 0);
  const got = new Set();
  for (const f of files) for (const m of rd(f).slice(0, 2000).matchAll(/SPDX-FileCopyrightText:\s*(.+)/g)) got.add('Copyright ' + m[1].replace(/\s*\*\/\s*$/, '').trim());
  return [...got].slice(0, 2);
}

// Collected once, rendered three ways. shipped = distributed with the site; modified = change notes (empty = unmodified);
// text = full license text (deduplicated in NOTICES); note = extra NOTICES remark.
const items = [];
const add = (it) => items.push({ copyright: [], url: '', shipped: true, modified: '', text: '', note: '', version: '', ...it });

// ---------------------------------------------------------------- 1. Web code (npm)
const devTools = [];
{
  const pkg = JSON.parse(rd(path.join(web, 'package.json')));
  const lock = exists(path.join(web, 'package-lock.json')) ? JSON.parse(rd(path.join(web, 'package-lock.json'))) : { packages: {} };
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const dir = path.join(web, 'node_modules', name);
    const p = exists(path.join(dir, 'package.json')) ? JSON.parse(rd(path.join(dir, 'package.json'))) : {};
    const lf = licenseFile(dir);
    const text = lf ? rd(lf) : '';
    if (!lf) warn.push(`npm ${name}: no LICENSE file in node_modules`);
    add({ cat: 'Web code (npm, bundled into the site JS)', name, version: p.version ?? pkg.dependencies[name], license: p.license ?? guessSpdx(text), copyright: copyrightLines(text), url: p.homepage ?? `https://www.npmjs.com/package/${name}`, text });
  }
  // Build tools are not shipped (Vite injects a little runtime helper code, Vite itself is MIT): SPDX and the NOTICES tail only
  for (const [k, v] of Object.entries(lock.packages ?? {})) {
    if (!k || !v.dev) continue;
    devTools.push({ name: k.replace(/^.*node_modules\//, ''), version: v.version ?? '', license: v.license ?? 'NOASSERTION', installed: exists(path.join(web, k)) });
  }
}

// ---------------------------------------------------------------- 2. Simulator core (cargo)
const crates = [];
{
  const lockPath = path.join(root, 'core/Cargo.lock');
  if (exists(lockPath)) {
    for (const block of rd(lockPath).split('[[package]]').slice(1)) {
      const name = block.match(/name = "([^"]+)"/)?.[1];
      const ver = block.match(/version = "([^"]+)"/)?.[1];
      const src = block.match(/source = "([^"]+)"/)?.[1];
      if (src) crates.push({ name, ver, src });
    }
  } else warn.push('core/Cargo.lock does not exist');
  // No third-party crates today (AGENTS.md §6); if one appears it is listed and the "no third-party Rust" sentence changes
  for (const c of crates) add({ cat: 'Simulator core (Rust crates, compiled into wasm)', name: c.name, version: c.ver, license: 'NOASSERTION', url: c.src, note: 'License: see the crate source' });
}

// ---------------------------------------------------------------- 3. Chip ROM (esp-rom-elfs)
{
  const dir = path.join(root, 'third_party/esp-rom-elfs');
  const lic = exists(path.join(dir, 'LICENSE')) ? rd(path.join(dir, 'LICENSE')) : '';
  const readme = exists(path.join(dir, 'README.md')) ? rd(path.join(dir, 'README.md')) : '';
  if (!lic) warn.push('third_party/esp-rom-elfs/LICENSE does not exist (run tools/fetch_third_party.sh first)');
  const copy = readme.match(/The ROMs of ESP32 series of chips are (Copyright[^\n]+)/)?.[1] ?? 'Copyright (c) 2015-2022 Espressif Systems (Shanghai) Co. Ltd.';
  const rel = exists(dir) ? (fs.readdirSync(dir).find((n) => /^esp-rom-elfs-\d+\.tar\.gz$/.test(n)) ?? '').match(/\d+/)?.[0] : '';
  const shipped = exists(path.join(web, 'public/rom')) ? fs.readdirSync(path.join(web, 'public/rom')).filter((n) => n.endsWith('.elf')) : ['esp32_rev300_rom.elf', 'esp32c3_rev3_rom.elf', 'esp32s3_rev0_rom.elf'];
  add({
    cat: 'Chip ROM',
    name: 'esp-rom-elfs',
    version: rel ?? '',
    license: 'Apache-2.0',
    copyright: [copy],
    url: 'https://github.com/espressif/esp-rom-elfs',
    text: lic,
    note: `Files published on the site: ${shipped.join(', ')}. Third-party components inside the ROM are listed in the next section.`,
  });
  // Third-party code inside the ROM (ESP-IDF COPYRIGHT, ROM Source Code Copyrights): part of the ROM files, not counted separately
  const romThird = [
    ['Newlib', 'NOASSERTION', 'BSD-family licenses'],
    ['Xtensa libhal', 'MIT', ''],
    ['TinyBasic Plus', 'MIT', ''],
    ['miniz', 'NOASSERTION', 'Public domain'],
    ['TJpgDec', 'NOASSERTION', 'TJpgDec license (BSD-style)'],
    ['Zephyr USB stack', 'Apache-2.0 AND BSD-3-Clause', ''],
  ];
  for (const [name, license, note] of romThird) add({ cat: 'Components inside the chip ROM', name, license, note, inRom: true, url: 'https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html#rom-source-code-copyrights' });
  // C-01: the core embeds masked instruction signatures derived from libbtdm (not the library), attributed per Apache-2.0 §4;
  // whether that is a derivative work awaits human review (LICENSING)
  add({
    cat: 'Simulator core (Rust crates, compiled into wasm)',
    name: 'esp32c3-bt-lib (BLE controller library signatures)',
    version: 'IDF 5.1–5.5.1',
    license: 'Apache-2.0',
    copyright: ['Copyright Espressif Systems (Shanghai) Co. Ltd.'],
    url: 'https://github.com/espressif/esp32c3-bt-lib',
    text: lic,
    modified: 'Only the first few instructions of 8 functions in libbtdm_app*.a are taken, with relocation fields zeroed, as masked signatures (core/crates/soc/src/ble/sigs.rs) used to locate those functions in user firmware; no library binary is included',
  });
}

// ---------------------------------------------------------------- 4. Example firmware: ESP-IDF and component-manager components
{
  add({
    cat: 'Example firmware (ESP-IDF projects, shipped compiled with the site)',
    name: 'ESP-IDF',
    version: 'v5.5.1',
    license: 'Apache-2.0',
    copyright: ['Copyright 2015-2025 Espressif Systems (Shanghai) CO LTD'],
    url: 'https://github.com/espressif/esp-idf',
    note: 'soc register headers are Apache-2.0 OR MIT; FreeRTOS is MIT; copyrights and licenses of third-party parts such as newlib and lwIP: https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/COPYRIGHT.html . The closed-source Wi-Fi / PHY / Bluetooth / coexistence libraries (esp32-wifi-lib, esp-phy-lib, esp32-bt-lib, esp-coex-lib) are Apache-2.0.',
  });
  const fwDir = path.join(web, 'public/fw');
  const published = exists(fwDir) ? fs.readdirSync(fwDir).filter((n) => exists(path.join(fwDir, n, 'flash.bin'))) : [];
  if (!published.length) warn.push('no published firmware in web/public/fw (run the copy step of tools/build_web.sh first); listing components of every example in firmware/');
  const exList = published.length ? published : fs.readdirSync(path.join(root, 'firmware')).filter((n) => exists(path.join(root, 'firmware', n, 'main')));
  const comps = new Map();
  for (const ex of exList) {
    const mc = path.join(root, 'firmware', ex, 'managed_components');
    if (!exists(mc)) continue;
    for (const c of fs.readdirSync(mc)) {
      const dir = path.join(mc, c);
      const yml = exists(path.join(dir, 'idf_component.yml')) ? rd(path.join(dir, 'idf_component.yml')) : '';
      const ver = yml.match(/^version:\s*['"]?([^'"\n]+)/m)?.[1] ?? '?';
      const url = yml.match(/^url:\s*(\S+)/m)?.[1] ?? yml.match(/^repository:\s*(\S+)/m)?.[1] ?? '';
      const lf = licenseFile(dir);
      const text = lf ? rd(lf) : '';
      const spdx = yml.match(/^license:\s*['"]?([^'"\n]+)/m)?.[1] ?? guessSpdx(text);
      const key = `${c}@${ver}`;
      // Apache texts have no copyright line: fall back to SPDX-FileCopyrightText in the sources
      let copy = copyrightLines(text);
      if (!copy.length) copy = spdxCopyright(dir);
      if (!comps.has(key)) comps.set(key, { name: c.replace('__', '/'), ver, url: url.replace(/^git:/, 'https:').replace(/\.git$/, ''), spdx, text, copy, used: [] });
      comps.get(key).used.push(ex);
    }
  }
  const bad = [...comps.values()].filter((c) => c.spdx === 'LicenseRef-Espressif-Modified-MIT');
  if (bad.length) {
    console.error(`[licenses] published firmware contains Espressif modified-MIT components, which LICENSING.md rule 5 forbids hosting: ${bad.map((c) => `${c.name} (${c.used.join(', ')})`).join('; ')}`);
    process.exit(2);
  }
  if (!comps.size) warn.push('no component-manager components found (firmware/*/managed_components not generated yet)');
  for (const c of [...comps.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    add({ cat: 'Example firmware (ESP-IDF projects, shipped compiled with the site)', name: c.name, version: c.ver, license: c.spdx, copyright: c.copy, url: c.url, text: c.text, note: `Used in: ${c.used.join(' ')}` });
  }
}

// ---------------------------------------------------------------- 5. Fonts (P2-19: self-hosted subsets, tools/fonts/)
{
  const fd = path.join(root, 'third_party/fonts');
  const rev = exists(path.join(fd, 'REVISION')) ? rd(path.join(fd, 'REVISION')).trim() : '';
  if (!rev) warn.push('third_party/fonts does not exist (run tools/fonts/fetch.sh first): font license texts not attached');
  const fonts = [
    { name: 'Noto Sans SC', dir: 'notosanssc', file: 'tb-sans-sc-*.woff2 (unicode-range slices)', ofl: 'OFL-NotoSansSC.txt', copy: 'Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source"' },
    { name: 'JetBrains Mono', dir: 'jetbrainsmono', file: 'tb-mono.woff2', ofl: 'OFL-JetBrainsMono.txt', copy: 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)' },
  ];
  for (const f of fonts) {
    add({
      cat: 'Fonts (self-hosted, subset)',
      name: f.name,
      version: rev ? `google/fonts@${rev.slice(0, 7)}` : '',
      license: 'OFL-1.1',
      copyright: [f.copy],
      url: rev ? `https://github.com/google/fonts/tree/${rev}/ofl/${f.dir}` : 'https://github.com/google/fonts',
      text: exists(path.join(fd, f.ofl)) ? rd(path.join(fd, f.ofl)) : '',
      modified: 'Subset to WOFF2 with fonttools (characters used by the pages + the 3755 GB2312 level-1 hanzi, weight axis narrowed to 400-700 and split into unicode-range slices; the monospace font keeps its full Latin set); renamed files do not use the Reserved Font Name "Source"',
      note: `File published on the site: fonts/${f.file}, with ${f.ofl} alongside`,
    });
  }
}

// ---------------------------------------------------------------- 6. Assets (3D models, textures, HDRI): each directory's SOURCES.md
const models = [];
{
  const found = [];
  const skip = new Set(['node_modules', 'dist', '.git', 'target', 'build', 'managed_components', 'third_party', 'Reviews']);
  const walk = (d, depth) => {
    if (depth > 6 || !exists(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !skip.has(e.name) && !e.isSymbolicLink()) walk(path.join(d, e.name), depth + 1);
      else if (e.isFile() && e.name === 'SOURCES.md') found.push(path.join(d, e.name));
    }
  };
  for (const d of ['web', 'assets']) walk(path.join(root, d), 0);
  // SOURCES.md written before U-07 uses Chinese headings; accept both until every model is reconverted
  const cell = (md, k) => md.match(new RegExp(`^\\| (?:${k}) \\| (.+) \\|$`, 'm'))?.[1] ?? '';
  const section = (md, k) => md.split(new RegExp(`## (?:${k})`))[1];
  const plain = (t) => t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1').replace(/`/g, '').replace(/\*\*/g, '');
  // SOURCES.md carries human-readable license names; map them to SPDX ids
  const toSpdx = (t) => (/CC BY-SA 4\.0/.test(t) ? 'CC-BY-SA-4.0' : /^MIT/.test(t) ? 'MIT' : 'NOASSERTION');
  for (const f of found) {
    const rel = path.relative(root, f);
    if (!rel.startsWith('assets/models/')) {
      // Only assets/models exists today; a SOURCES.md elsewhere must not be missed, so attach it whole to NOTICES
      add({ cat: 'Other assets', name: path.dirname(rel), license: 'NOASSERTION', text: rd(f), note: `Sources and attribution: ${rel} (full text attached below)` });
      continue;
    }
    const md = rd(f);
    const name = path.basename(path.dirname(f));
    const lic = fs.readdirSync(path.dirname(f)).find((n) => /^LICENSE(\.md)?$/.test(n));
    if (!exists(path.join(path.dirname(f), `${name}.glb`))) warn.push(`${name}: has SOURCES.md but no ${name}.glb (run tools/models/convert.mjs first)`);
    if (!lic) warn.push(`${name}: asset directory has no LICENSE`);
    const changes = section(md, '改动说明|Changes')?.split('\n## ')[0]?.trim() ?? ''; // lint: allow-cjk
    const credit = section(md, '署名|Attribution')?.trim() ?? ''; // lint: allow-cjk
    const license = toSpdx(plain(cell(md, '许可证|License'))); // lint: allow-cjk
    const m = { name, title: md.match(/^# (.+)$/m)?.[1] ?? name, lic, license, modified: /已修改|^Yes/.test(cell(md, '是否修改|Modified')) }; // lint: allow-cjk
    models.push(m);
    add({
      cat: '3D models (lazy-loaded when "External models" is turned on)',
      name: m.title,
      version: plain(cell(md, '仓库 / 提交|Repository / commit')).split('@')[1]?.trim().slice(0, 12) ?? '', // lint: allow-cjk
      license,
      copyright: [plain(cell(md, '作者|Author'))], // lint: allow-cjk
      url: plain(cell(md, '原始文件|Original file')), // lint: allow-cjk
      text: lic ? rd(path.join(path.dirname(f), lic)) : '',
      modified: m.modified ? plain(changes) : '',
      note: plain(credit) + `\nFile published on the site: models/${name}/${name}.glb, with SOURCES.md${lic ? ` and ${lic}` : ''} alongside`,
    });
  }
}

// ---------------------------------------------------------------- Output 1: THIRD_PARTY_NOTICES.txt
const shipped = items.filter((it) => it.shipped && !it.inRom);
const hr = (c = '=') => c.repeat(78);
const texts = new Map(); // identical license texts (whitespace-insensitive) are attached once and referenced as [L1]
const textRef = (it) => {
  if (!it.text) return '';
  const k = it.text.replace(/\s+/g, ' ').trim();
  if (!texts.has(k)) texts.set(k, { id: `L${texts.size + 1}`, text: it.text.trim(), license: it.license, users: [] });
  const t = texts.get(k);
  t.users.push(it.name);
  return t.id;
};
const notice = [];
notice.push(`TryBoard · THIRD-PARTY NOTICES
Generated ${today} (tools/gen_licenses.mjs, from the dependency manifests and asset directories)

The TryBoard simulator core, web pages and acceptance firmware are written by the TryBoard team. Below are the
third-party components shipped with the site: name, version, license, copyright notices, source and change notes.
Full license texts are attached at the end, each identical text only once; [L1], [L2] … in an entry point to them.

ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.
The development boards in the 3D view are visual approximations, not official Espressif models.
`);
let cat = '';
for (const it of items) {
  if (it.cat !== cat) {
    cat = it.cat;
    notice.push(`\n${hr()}\n${cat}\n${hr()}\n`);
  }
  const ref = textRef(it);
  const lines = [`${it.name}${it.version ? ` ${it.version}` : ''}`];
  lines.push(`  License: ${it.license}${ref ? ` [${ref}]` : ''}`);
  for (const c of it.copyright.filter(Boolean)) lines.push(`  ${c}`);
  if (it.url) lines.push(`  Source: ${it.url}`);
  if (it.modified) lines.push(`  Modified:\n${it.modified.split('\n').map((l) => `    ${l.replace(/^- /, '· ')}`).join('\n')}`);
  if (it.note) lines.push(...it.note.split('\n').filter(Boolean).map((l) => `  ${l}`));
  notice.push(lines.join('\n') + '\n');
}
if (!crates.length) notice.push(`\n${hr()}\nSimulator core (Rust → WebAssembly)\n${hr()}\n\nNo third-party crates (per core/Cargo.lock, checked on every build).\n`);
notice.push(`\n${hr()}\nBuild tools (npm devDependencies, ${devTools.length}, not shipped with the site)\n${hr()}\n
Used only for local builds. Vite (MIT) injects a small module-preload helper into the output.
3D model conversion (tools/models/, build time): occt-import-js (LGPL-2.1), glTF-Transform (MIT), meshoptimizer (MIT).

${devTools.map((d) => `${d.name} ${d.version} · ${d.license}${d.installed ? '' : ' · optional binary for another platform, not installed here'}`).join('\n')}
`);
notice.push(`\n${hr()}\nFull license texts\n${hr()}\n`);
for (const t of texts.values()) notice.push(`\n${hr('-')}\n[${t.id}] ${t.license} · applies to: ${t.users.join(', ')}\n${hr('-')}\n\n${t.text}\n`);
const noticeTxt = notice.join('\n').replace(/\n{3,}/g, '\n\n');

// ---------------------------------------------------------------- Output 2: tryboard.spdx.json (SPDX 2.3)
// licenseConcluded must be a valid SPDX expression; ROM entries that have no id get NOASSERTION plus a comment
const spdxOk = (s) => (/^[A-Za-z0-9.+\-]+( (AND|OR|WITH) [A-Za-z0-9.+\-]+)*$/.test(s ?? '') ? s : /^\(.+\)$/.test(s ?? '') ? s : 'NOASSERTION');
const sid = (s, i) => `SPDXRef-Package-${i}-${String(s).replace(/[^A-Za-z0-9.\-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x'}`;
const pkgs = [];
const rels = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-TryBoard' }];
pkgs.push({ SPDXID: 'SPDXRef-TryBoard', name: 'TryBoard', versionInfo: today, supplier: 'Organization: TryBoard', downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', comment: 'TryBoard: a simulator that runs ESP32 firmware in the browser (web pages, wasm core, example firmware)' });
const romId = {};
items.forEach((it, i) => {
  const id = sid(it.name, i);
  if (it.name === 'esp-rom-elfs') romId.v = id;
  const lic = spdxOk(it.license);
  const comment = [it.cat, it.license !== lic ? `License: ${it.note || it.license}` : '', it.modified ? 'Modified, see THIRD_PARTY_NOTICES.txt' : ''].filter(Boolean).join('; ');
  pkgs.push({ SPDXID: id, name: it.name, versionInfo: it.version || 'NOASSERTION', downloadLocation: /^https?:/.test(it.url) ? it.url : 'NOASSERTION', filesAnalyzed: false, licenseConcluded: lic, licenseDeclared: lic, copyrightText: it.copyright.filter(Boolean).join('\n') || 'NOASSERTION', comment });
  rels.push(it.inRom ? { spdxElementId: romId.v, relationshipType: 'CONTAINS', relatedSpdxElement: id } : { spdxElementId: 'SPDXRef-TryBoard', relationshipType: 'CONTAINS', relatedSpdxElement: id });
});
devTools.forEach((d, i) => {
  const id = sid(`dev-${d.name}`, items.length + i);
  pkgs.push({ SPDXID: id, name: d.name, versionInfo: d.version || 'NOASSERTION', downloadLocation: `https://registry.npmjs.org/${d.name}/-/${d.name.split('/').pop()}-${d.version}.tgz`, filesAnalyzed: false, licenseConcluded: spdxOk(d.license), licenseDeclared: spdxOk(d.license), copyrightText: 'NOASSERTION', comment: 'Build tool, not shipped with the site' });
  rels.push({ spdxElementId: id, relationshipType: 'DEV_DEPENDENCY_OF', relatedSpdxElement: 'SPDXRef-TryBoard' });
});
const spdx = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `TryBoard-${today}`,
  documentNamespace: `https://spdx.org/spdxdocs/tryboard-${today}-${crypto.randomUUID()}`,
  creationInfo: { created: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), creators: ['Tool: tryboard-gen_licenses.mjs', 'Organization: TryBoard'] },
  packages: pkgs,
  relationships: rels,
};
const spdxJson = JSON.stringify(spdx, null, 2) + '\n';

fs.mkdirSync(pub, { recursive: true });
// BOM: static hosts often serve .txt without a charset, and the BOM lets browsers detect UTF-8 for non-ASCII names
fs.writeFileSync(path.join(pub, 'THIRD_PARTY_NOTICES.txt'), '﻿' + noticeTxt);
fs.writeFileSync(path.join(pub, 'tryboard.spdx.json'), spdxJson);

// ---------------------------------------------------------------- Output 3: licenses.html (one-page notice)
const kb = (s) => `${Math.max(1, Math.round(Buffer.byteLength(s) / 1024))} KB`;
const LIC_NAME = { 'OFL-1.1': 'SIL OFL 1.1', 'CC-BY-SA-4.0': 'CC BY-SA 4.0' };
const licIds = [...new Set(shipped.flatMap((it) => it.license.replace(/[()]/g, '').split(/ (?:AND|OR|WITH) /)))].filter((l) => l !== 'NOASSERTION');
// Most-used license first
const licCount = (l) => shipped.filter((it) => it.license.includes(l)).length;
licIds.sort((a, b) => licCount(b) - licCount(a));
const licList = licIds.map((l) => LIC_NAME[l] ?? l);
const licSentence = licList.length > 1 ? `${licList.length} licenses: ${licList.slice(0, -1).join(', ')} and ${licList.at(-1)}` : `the ${licList[0]} license`;
if (shipped.some((it) => it.license === 'NOASSERTION')) warn.push(`shipped components with an unrecognised license: ${shipped.filter((it) => it.license === 'NOASSERTION').map((it) => it.name).join(', ')}`);
const has = (re) => items.some((it) => re.test(it.name));
// Special thanks lists only what is really used; licenses come from the collected data, never typed by hand
const licOf = (re) => [...new Set(items.filter((it) => re.test(it.name)).map((it) => LIC_NAME[it.license] ?? it.license))].join(' · ');
const ACKS = [
  { name: 'Espressif', what: 'Chip ROM and ESP-IDF components', re: /^(esp-rom-elfs|ESP-IDF)$/ },
  { name: 'three.js', what: '3D scene rendering', re: /^three$/ },
  { name: 'React', what: 'Web interface', re: /^react$/ },
  { name: 'TinyUSB', what: 'USB keyboard and serial', re: /^espressif\/tinyusb$/ },
  { name: 'Google Fonts', what: 'Noto Sans SC, JetBrains Mono', re: /^(Noto Sans SC|JetBrains Mono)$/ },
  { name: 'KiCad and Adafruit', what: 'Buzzer, USB-C and servo 3D models', re: /蜂鸣器|USB-C|舵机|buzzer|servo/i }, // lint: allow-cjk
].filter((a) => has(a.re) || (warn.push(`special-thanks entry "${a.name}" has no matching component, omitted`), false));
const modified = models.filter((m) => m.modified);

// Header nav link classes match navLink in web/src/ui/site.tsx (licenses.css @source-scans this file to emit them)
const NAV_LINK = 'rounded-md px-2.5 py-[5px] text-muted hover:bg-field hover:text-fg';
// Same as SITE_NAV in web/src/ui/links.ts (no .html suffix, DESIGN_V2 §7.2)
const NAV = [
  ['./', 'Projects'],
  ['./select', 'Pick a board'],
  ['./app?work=blank#bench', 'Lab'],
];
const LOGO = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="4" width="56" height="56" rx="14" class="fill-[#0B76C8] dark:fill-[#3AA8FF]"/><g class="fill-white dark:fill-[#17181B]"><circle cx="20" cy="20" r="5"/><circle cx="32" cy="20" r="5"/><circle cx="20" cy="32" r="5"/><circle cx="32" cy="32" r="5"/><circle cx="44" cy="32" r="5"/><circle cx="20" cy="44" r="5"/><circle cx="32" cy="44" r="5"/><circle cx="44" cy="44" r="5"/></g><circle cx="44" cy="20" r="6" fill="#FFB020"/></svg>`;
const BRAND = `<a class="inline-flex flex-none items-center gap-1.5 max-md:min-h-11 max-md:gap-2" href="./" aria-label="TryBoard home">${LOGO(22).replace('<svg ', '<svg class="max-md:size-[26px]" ')}<b class="text-[14px] max-md:text-[17px]">TryBoard</b><span class="font-mono text-[10px] tracking-[0.08em] text-muted max-md:hidden">TRYBOARD</span><span class="ml-0.5 hidden text-[13px] text-muted max-md:inline">· Licenses &amp; credits</span></a>`;
const ICON = (d, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const SEG = 'min-h-[38px] cursor-pointer rounded-lg px-3 text-muted max-md:min-h-11 aria-checked:bg-surface aria-checked:font-medium aria-checked:text-fg aria-checked:shadow-[0_1px_3px_#0000001a] aria-checked:ring-1 aria-checked:ring-line';
const DL = (href, title, sub) => `<a href="${href}" download class="flex min-h-16 items-center gap-3 rounded-[10px] border border-line px-4 text-fg no-underline! transition-colors hover:border-hover-line hover:bg-field"><span class="min-w-0 flex-1"><b class="block text-[13px]">${esc(title)}</b><span class="font-mono text-[11px] text-muted">${esc(sub)}</span></span><span class="text-accent-ink">${ICON('M12 4v12M6 10l6 6 6-6M5 20h14', 18)}</span></a>`;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- Theme is set before first paint (same rule as web/src/theme.ts: localStorage tb-theme, else the system setting) -->
    <script>try{var t=localStorage.getItem('tb-theme')}catch(e){}document.documentElement.dataset.theme=t==='dark'||t==='light'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'</script>
    <title>Licenses &amp; credits · TryBoard</title>
    <meta name="description" content="Open-source software, chip ROM, firmware components, fonts and 3D assets used by TryBoard and their licenses; download the full third-party notices and the SPDX bill of materials." />
    <!-- Share card (DESIGN_V2 §8.5): og.png is rendered at build time by tools/webtest/og.mjs; make og:image absolute once the domain is set -->
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="TryBoard" />
    <meta property="og:title" content="Licenses &amp; credits · TryBoard" />
    <meta property="og:description" content="Open-source software, chip ROM, firmware components, fonts and 3D assets used by TryBoard and their licenses; download the full third-party notices and the SPDX bill of materials." />
    <meta property="og:image" content="./og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />
    <!-- Self-hosted fonts (P2-19, generated by tools/fonts/subset.py, OFL-1.1) -->
    <link rel="stylesheet" href="/fonts/fonts.css" />
    <!-- Styles: src/licenses/licenses.css (Tailwind, same theme as the React pages; header / footer classes match src/ui/site.tsx) -->
    <link rel="stylesheet" href="./src/licenses/licenses.css" />
  </head>
  <!-- Generated by tools/gen_licenses.mjs; do not edit by hand -->
  <body>
   <div class="flex min-h-screen flex-col text-[13px] leading-[1.6]">
    <header class="pg-head sticky top-0 z-[5] flex items-center gap-6 border-b border-line bg-head-bg px-6 py-3.5 backdrop-blur max-md:h-[52px] max-md:gap-2 max-md:py-0 max-md:pr-2 max-md:pl-4">
      ${BRAND}
      <nav aria-label="Site" class="flex flex-wrap gap-0.5 max-md:hidden">${NAV.map(([href, text]) => `<a href="${href}" class="${NAV_LINK}">${text}</a>`).join('')}</nav>
      <button type="button" id="themeBtn" class="theme-btn ml-auto inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-md border border-line bg-surface text-fg transition-colors hover:border-hover-line max-md:hidden"></button>
      <button type="button" id="siteMenu" aria-label="Menu" aria-haspopup="dialog" aria-expanded="false" aria-controls="siteDrawer" class="ml-auto hidden size-11 flex-none cursor-pointer items-center justify-center rounded-[10px] text-fg hover:bg-field max-md:inline-flex">${ICON('M4 7h16M4 12h16M4 17h16')}</button>
    </header>
    <!-- Mobile menu drawer: same structure as MobileMenu in web/src/ui/site.tsx (no Radix here; the script below handles open / close, Esc and focus) -->
    <div id="siteDrawer" role="dialog" aria-modal="true" aria-label="Site menu" hidden class="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg text-fg animate-[tb-drop_.18s_ease-out] [&[hidden]]:hidden">
      <div class="flex h-[52px] flex-none items-center gap-2 border-b border-line-soft pr-2 pl-4">
        <a class="inline-flex flex-none items-center gap-2" href="./" aria-label="TryBoard home">${LOGO(26)}<b class="text-[17px]">TryBoard</b><span class="font-mono text-[10px] tracking-[0.08em] text-muted">TRYBOARD</span></a>
        <button type="button" id="siteClose" aria-label="Close menu" class="ml-auto inline-flex size-11 cursor-pointer items-center justify-center rounded-[10px] hover:bg-field">${ICON('M6 6l12 12M18 6L6 18')}</button>
      </div>
      <nav aria-label="Site" class="flex flex-col px-4 py-2">${NAV.map(([href, text]) => `<a href="${href}" class="flex h-16 items-center justify-between border-b border-line-soft text-[20px] font-bold text-fg">${text}<span class="text-muted">${ICON('M9 6l6 6-6 6', 18)}</span></a>`).join('')}</nav>
      <p class="mx-4 my-3 rounded-xl bg-field p-3.5 text-[13px] leading-[1.6] text-muted">On a phone you can view, tweak parameters and press buttons; wiring and changing firmware work best on a computer.</p>
      <div class="mt-auto flex flex-col gap-1 border-t border-line-soft px-4 pt-4 pb-10">
        <div class="flex min-h-12 items-center justify-between text-[15px]">Dark mode
          <div role="radiogroup" aria-label="Dark mode" class="flex rounded-[10px] bg-field p-[3px] text-[13px]"><button type="button" role="radio" data-theme-pref="system" class="${SEG}">System</button><button type="button" role="radio" data-theme-pref="light" class="${SEG}">Light</button><button type="button" role="radio" data-theme-pref="dark" class="${SEG}">Dark</button></div>
        </div>
        <a href="./licenses" aria-current="page" class="flex h-11 items-center justify-between text-[15px] text-accent-ink">Licenses &amp; credits<span class="text-[12px] font-medium">Current page</span></a>
      </div>
    </div>
    <main class="lic mx-auto w-full max-w-[808px] flex-1 px-6 pt-14 pb-16 max-md:px-4 max-md:pt-8 max-md:pb-12">
      <h1>Licenses &amp; credits</h1>
      <p class="mt-1.5 text-[12px] text-muted">Updated ${today}</p>
      <p class="note">This page is generated in English only.</p>

      <h2>TryBoard itself</h2>
      <p>The simulator core, web pages and acceptance firmware are written by the TryBoard team. ${crates.length ? `The core uses ${crates.length} third-party Rust crates, listed in the full notices.` : 'It has no third-party Rust dependencies.'}</p>

      <h2>Third-party components</h2>
      <p>The site ships <b id="licCount">${shipped.length}</b> third-party components under ${esc(licSentence)}. Full names, versions, copyright notices and license texts are in the files below.</p>

      <h2>Special thanks</h2>
      <div class="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        ${ACKS.map((a) => `<div class="min-w-0 rounded-[10px] border border-line px-3.5 py-3"><b class="text-[13px]">${esc(a.name)}</b><div class="mt-0.5 text-[12px] leading-[1.6] text-muted">${esc(a.what)}</div><div class="mt-1.5 font-mono text-[10.5px] text-muted">${esc(licOf(a.re))}</div></div>`).join('\n        ')}
      </div>

      <h2>Full notices</h2>
      <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        ${DL('./THIRD_PARTY_NOTICES.txt', 'Third-party notices', `THIRD_PARTY_NOTICES.txt · ${kb(noticeTxt)}`)}
        ${DL('./tryboard.spdx.json', 'Software bill of materials', `tryboard.spdx.json · ${kb(spdxJson)} · incl. build tools`)}
      </div>
      <p class="note">Both files are regenerated on every build from the dependency manifests and asset directories.${modified.length ? ` Modified 3D models are available for download under their original licenses: ${modified.map((m) => `<a href="./models/${esc(m.name)}/${esc(m.name)}.glb" download>${esc(m.title.replace(/\s*[（(].*$/, ''))}</a> (${esc(LIC_NAME[m.license] ?? m.license)}, <a href="./models/${esc(m.name)}/SOURCES.md">sources and changes</a>)`).join(', ')}.` : ''}</p>

      <h2>Trademarks</h2>
      <p>ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</p>
      <p class="note">The development boards in the 3D view are visual approximations, not official Espressif models.</p>
    </main>
    <footer class="pg-foot flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-t border-line px-6 py-3.5 text-[11px] text-muted max-sm:px-4 max-sm:py-3">
      <span>TryBoard · Run ESP32 firmware in the browser, Arduino-compatible. ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span>
      <span><a class="text-fg hover:text-accent-ink max-md:inline-flex max-md:min-h-11 max-md:items-center" href="./licenses">Licenses &amp; credits</a></span>
    </footer>
   </div>
    <script>
      // Light / dark toggle (same storage key as web/src/theme.ts; this static page is not bundled)
      (function () {
        // Icons match sun / moon in web/src/app/icons.tsx (site-wide theme key shows only the icon, DESIGN_V2 §6.3)
        var SUN = ${JSON.stringify(ICON('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4', 16))}, MOON = ${JSON.stringify(ICON('M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z', 16))};
        var b = document.getElementById('themeBtn'), r = document.documentElement;
        function sync() { var d = r.dataset.theme === 'dark'; b.innerHTML = d ? MOON : SUN; b.title = d ? 'Switch to light' : 'Switch to dark'; b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(d)); }
        b.onclick = function () { var t = r.dataset.theme === 'dark' ? 'light' : 'dark'; r.dataset.theme = t; try { localStorage.setItem('tb-theme', t); } catch (e) {} sync(); };
        sync();
        // Mobile menu: open / close, Esc, focus in and out; three-way theme ("System" removes the storage key)
        var d = document.getElementById('siteDrawer'), m = document.getElementById('siteMenu'), x = document.getElementById('siteClose');
        var segs = d.querySelectorAll('[data-theme-pref]');
        function pref() { var t; try { t = localStorage.getItem('tb-theme'); } catch (e) {} return t === 'dark' || t === 'light' ? t : 'system'; }
        function syncSeg() { var p = pref(); segs.forEach(function (s) { s.setAttribute('aria-checked', String(s.dataset.themePref === p)); }); }
        segs.forEach(function (s) { s.onclick = function () { var p = s.dataset.themePref; try { p === 'system' ? localStorage.removeItem('tb-theme') : localStorage.setItem('tb-theme', p); } catch (e) {} r.dataset.theme = p === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p; syncSeg(); sync(); }; });
        function open(on) { d.hidden = !on; m.setAttribute('aria-expanded', String(on)); document.body.style.overflow = on ? 'hidden' : ''; (on ? x : m).focus(); }
        m.onclick = function () { syncSeg(); open(true); };
        x.onclick = function () { open(false); };
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !d.hidden) open(false); });
        syncSeg();
      })();
    </script>
  </body>
</html>
`;
fs.writeFileSync(out, html);
for (const w of warn) console.warn(`[licenses] warning: ${w}`);
console.log(`[licenses] wrote ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB), THIRD_PARTY_NOTICES.txt (${kb(noticeTxt)}), tryboard.spdx.json (${kb(spdxJson)}, ${pkgs.length} packages): ${shipped.length} shipped components, licenses ${licIds.join(' / ')}`);
