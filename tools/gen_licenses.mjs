#!/usr/bin/env node
// 生成授权与致谢（LICENSING.md 规则 8，DESIGN_V2 §7.3 C 版）。构建期由 tools/build_web.sh 调用，产物不进仓库：
//   web/licenses.html                    一页声明：试板本身、组件数与许可证种类、特别感谢、两个下载卡、商标
//   web/public/THIRD_PARTY_NOTICES.txt   完整声明：每个组件的版权行，每种许可证全文只附一次
//   web/public/tryboard.spdx.json        SPDX 2.3 软件物料清单（含不随网站分发的构建工具）
// 读：web/package.json + package-lock.json + node_modules（npm）、core/Cargo.lock（cargo）、third_party/esp-rom-elfs（ROM）、
//     web/public/fw 里实际发布的示例固件用到的 managed_components、各素材目录的 SOURCES.md、字体清单。
// 发布的固件里出现乐鑫修改版 MIT（"ESPRESSIF MIT" / LicenseRef-Espressif-Modified-MIT）就失败退出（规则 5）。
// 用法：node tools/gen_licenses.mjs [--out web/licenses.html] [--pub web/public]
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

/** 从 LICENSE 正文猜 SPDX（只认我们会遇到的几种；认不出就是 NOASSERTION，不瞎填） */
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
/** 组件源码头上的 SPDX-FileCopyrightText（找前几个 .c / .h 文件） */
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

// 一次收集，三处输出。每项：
//   cat 分类、name、version、license（SPDX 表达式或 NOASSERTION）、copyright[]、url、shipped（是否随网站分发）、
//   modified（改动说明，空 = 未修改）、text（许可证全文，NOTICES 去重后附）、note（NOTICES 里的补充说明）
const items = [];
const add = (it) => items.push({ copyright: [], url: '', shipped: true, modified: '', text: '', note: '', version: '', ...it });

// ---------------------------------------------------------------- 1. 网页代码库（npm）
const devTools = [];
{
  const pkg = JSON.parse(rd(path.join(web, 'package.json')));
  const lock = exists(path.join(web, 'package-lock.json')) ? JSON.parse(rd(path.join(web, 'package-lock.json'))) : { packages: {} };
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const dir = path.join(web, 'node_modules', name);
    const p = exists(path.join(dir, 'package.json')) ? JSON.parse(rd(path.join(dir, 'package.json'))) : {};
    const lf = licenseFile(dir);
    const text = lf ? rd(lf) : '';
    if (!lf) warn.push(`npm ${name}：node_modules 里没有 LICENSE 文件`);
    add({ cat: '网页代码（npm，打包进网页 JS）', name, version: p.version ?? pkg.dependencies[name], license: p.license ?? guessSpdx(text), copyright: copyrightLines(text), url: p.homepage ?? `https://www.npmjs.com/package/${name}`, text });
  }
  // 构建工具：不随网站分发（Vite 会往产物里注入少量运行时辅助代码，Vite 本身 MIT），只进 SPDX 和 NOTICES 末尾的清单
  for (const [k, v] of Object.entries(lock.packages ?? {})) {
    if (!k || !v.dev) continue;
    devTools.push({ name: k.replace(/^.*node_modules\//, ''), version: v.version ?? '', license: v.license ?? 'NOASSERTION', installed: exists(path.join(web, k)) });
  }
}

// ---------------------------------------------------------------- 2. 模拟器内核（cargo）
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
  } else warn.push('core/Cargo.lock 不存在');
  // 现在一个第三方 crate 都没有（AGENTS.md §6）；真引入了就列出来，并让页面上「不含第三方 Rust 依赖」那句改口
  for (const c of crates) add({ cat: '模拟器内核（Rust crate，编译进 wasm）', name: c.name, version: c.ver, license: 'NOASSERTION', url: c.src, note: '许可证见 crate 源码' });
}

// ---------------------------------------------------------------- 3. 芯片 ROM（esp-rom-elfs）
{
  const dir = path.join(root, 'third_party/esp-rom-elfs');
  const lic = exists(path.join(dir, 'LICENSE')) ? rd(path.join(dir, 'LICENSE')) : '';
  const readme = exists(path.join(dir, 'README.md')) ? rd(path.join(dir, 'README.md')) : '';
  if (!lic) warn.push('third_party/esp-rom-elfs/LICENSE 不存在（先跑 tools/fetch_third_party.sh）');
  const copy = readme.match(/The ROMs of ESP32 series of chips are (Copyright[^\n]+)/)?.[1] ?? 'Copyright (c) 2015-2022 Espressif Systems (Shanghai) Co. Ltd.';
  const rel = exists(dir) ? (fs.readdirSync(dir).find((n) => /^esp-rom-elfs-\d+\.tar\.gz$/.test(n)) ?? '').match(/\d+/)?.[0] : '';
  const shipped = exists(path.join(web, 'public/rom')) ? fs.readdirSync(path.join(web, 'public/rom')).filter((n) => n.endsWith('.elf')) : ['esp32c3_rev3_rom.elf', 'esp32s3_rev0_rom.elf'];
  add({
    cat: '芯片 ROM',
    name: 'esp-rom-elfs',
    version: rel ?? '',
    license: 'Apache-2.0',
    copyright: [copy],
    url: 'https://github.com/espressif/esp-rom-elfs',
    text: lic,
    note: `网站发布的文件：${shipped.join('、')}。ROM 内含的第三方组件见下一节。`,
  });
  // ROM 里的第三方组件（ESP-IDF COPYRIGHT · ROM Source Code Copyrights）：在 ROM 文件里，不另算组件数
  const romThird = [
    ['Newlib', 'NOASSERTION', 'BSD 系列许可'],
    ['Xtensa libhal', 'MIT', ''],
    ['TinyBasic Plus', 'MIT', ''],
    ['miniz', 'NOASSERTION', '公有领域（Public Domain）'],
    ['TJpgDec', 'NOASSERTION', 'TJpgDec 许可（BSD 风格）'],
    ['Zephyr USB 协议栈', 'Apache-2.0 AND BSD-3-Clause', ''],
  ];
  for (const [name, license, note] of romThird) add({ cat: '芯片 ROM 内含的组件', name, license, note, inRom: true, url: 'https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html#rom-source-code-copyrights' });
}

// ---------------------------------------------------------------- 4. 示例固件：ESP-IDF 与组件管理器拉进来的组件
{
  add({
    cat: '示例固件（ESP-IDF 工程，编译后随网站分发）',
    name: 'ESP-IDF',
    version: 'v5.5.1',
    license: 'Apache-2.0',
    copyright: ['Copyright 2015-2025 Espressif Systems (Shanghai) CO LTD'],
    url: 'https://github.com/espressif/esp-idf',
    note: 'soc 寄存器头为 Apache-2.0 OR MIT；FreeRTOS 为 MIT；newlib、lwIP 等第三方部分的版权与许可见 https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/COPYRIGHT.html 。Wi-Fi / PHY / 蓝牙 / 共存闭源库（esp32-wifi-lib、esp-phy-lib、esp32-bt-lib、esp-coex-lib）为 Apache-2.0。',
  });
  const fwDir = path.join(web, 'public/fw');
  const published = exists(fwDir) ? fs.readdirSync(fwDir).filter((n) => exists(path.join(fwDir, n, 'flash.bin'))) : [];
  if (!published.length) warn.push('web/public/fw 里没有已发布的固件（先跑 tools/build_web.sh 的复制步骤）；组件清单按 firmware/ 全部示例列');
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
      // Apache 正文里没有版权行：退到源码头上的 SPDX-FileCopyrightText
      let copy = copyrightLines(text);
      if (!copy.length) copy = spdxCopyright(dir);
      if (!comps.has(key)) comps.set(key, { name: c.replace('__', '/'), ver, url: url.replace(/^git:/, 'https:').replace(/\.git$/, ''), spdx, text, copy, used: [] });
      comps.get(key).used.push(ex);
    }
  }
  const bad = [...comps.values()].filter((c) => c.spdx === 'LicenseRef-Espressif-Modified-MIT');
  if (bad.length) {
    console.error(`[licenses] 发布的固件含乐鑫修改版 MIT 组件，按 LICENSING.md 规则 5 不能托管：${bad.map((c) => `${c.name}（${c.used.join('、')}）`).join('；')}`);
    process.exit(2);
  }
  if (!comps.size) warn.push('没有找到组件管理器组件（firmware/*/managed_components 还没生成）');
  for (const c of [...comps.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    add({ cat: '示例固件（ESP-IDF 工程，编译后随网站分发）', name: c.name, version: c.ver, license: c.spdx, copyright: c.copy, url: c.url, text: c.text, note: `用在：${c.used.join(' ')}` });
  }
}

// ---------------------------------------------------------------- 5. 字体（P2-19：自托管子集，tools/fonts/）
{
  const fd = path.join(root, 'third_party/fonts');
  const rev = exists(path.join(fd, 'REVISION')) ? rd(path.join(fd, 'REVISION')).trim() : '';
  if (!rev) warn.push('third_party/fonts 不存在（先跑 tools/fonts/fetch.sh）：字体许可全文没附上');
  const fonts = [
    { name: 'Noto Sans SC', dir: 'notosanssc', file: 'tb-sans-sc.woff2', ofl: 'OFL-NotoSansSC.txt', copy: 'Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source"' },
    { name: 'JetBrains Mono', dir: 'jetbrainsmono', file: 'tb-mono.woff2', ofl: 'OFL-JetBrainsMono.txt', copy: 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)' },
  ];
  for (const f of fonts) {
    add({
      cat: '字体（自托管，子集化）',
      name: f.name,
      version: rev ? `google/fonts@${rev.slice(0, 7)}` : '',
      license: 'OFL-1.1',
      copyright: [f.copy],
      url: rev ? `https://github.com/google/fonts/tree/${rev}/ofl/${f.dir}` : 'https://github.com/google/fonts',
      text: exists(path.join(fd, f.ofl)) ? rd(path.join(fd, f.ofl)) : '',
      modified: '用 fonttools 子集化成 WOFF2（页面实际用到的字 + GB2312 一级字 3755 个；等宽字留整套西文）；改过的文件名不含保留名 "Source"',
      note: `网站发布的文件：fonts/${f.file}，同目录附 ${f.ofl}`,
    });
  }
}

// ---------------------------------------------------------------- 6. 素材（3D 模型、贴图、HDRI）：各目录的 SOURCES.md
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
  const cell = (md, k) => md.match(new RegExp(`^\\| ${k} \\| (.+) \\|$`, 'm'))?.[1] ?? '';
  const plain = (t) => t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1').replace(/`/g, '').replace(/\*\*/g, '');
  // SOURCES.md 里写的是人看的名字，这里换成 SPDX 标识
  const toSpdx = (t) => (/CC BY-SA 4\.0/.test(t) ? 'CC-BY-SA-4.0' : /^MIT/.test(t) ? 'MIT' : 'NOASSERTION');
  for (const f of found) {
    const rel = path.relative(root, f);
    if (!rel.startsWith('assets/models/')) {
      // 目前只有 assets/models 一处；别处冒出 SOURCES.md 也不能漏，整份附进 NOTICES
      add({ cat: '其他素材', name: path.dirname(rel), license: 'NOASSERTION', text: rd(f), note: `来源与署名见 ${rel}（全文附后）` });
      continue;
    }
    const md = rd(f);
    const name = path.basename(path.dirname(f));
    const lic = fs.readdirSync(path.dirname(f)).find((n) => /^LICENSE(\.md)?$/.test(n));
    if (!exists(path.join(path.dirname(f), `${name}.glb`))) warn.push(`${name}：有 SOURCES.md 但没有 ${name}.glb（先跑 tools/models/convert.mjs）`);
    if (!lic) warn.push(`${name}：素材目录缺 LICENSE`);
    const changes = md.split('## 改动说明')[1]?.split('\n## ')[0]?.trim() ?? '';
    const credit = md.split('## 署名')[1]?.trim() ?? '';
    const license = toSpdx(plain(cell(md, '许可证')));
    const m = { name, title: md.match(/^# (.+)$/m)?.[1] ?? name, lic, license, modified: /已修改/.test(cell(md, '是否修改')) };
    models.push(m);
    add({
      cat: '3D 模型（打开「外部模型」时懒加载）',
      name: m.title,
      version: plain(cell(md, '仓库 / 提交')).split('@')[1]?.trim().slice(0, 12) ?? '',
      license,
      copyright: [plain(cell(md, '作者'))],
      url: plain(cell(md, '原始文件')),
      text: lic ? rd(path.join(path.dirname(f), lic)) : '',
      modified: m.modified ? plain(changes) : '',
      note: plain(credit) + `\n网站发布的文件：models/${name}/${name}.glb，同目录附 SOURCES.md${lic ? ` 与 ${lic}` : ''}`,
    });
  }
}

// ---------------------------------------------------------------- 输出 1：THIRD_PARTY_NOTICES.txt
const shipped = items.filter((it) => it.shipped && !it.inRom);
const hr = (c = '=') => c.repeat(78);
const texts = new Map(); // 许可证全文去重：同一份正文（忽略空白差异）只附一次，组件处写 [L1] 引用
const textRef = (it) => {
  if (!it.text) return '';
  const k = it.text.replace(/\s+/g, ' ').trim();
  if (!texts.has(k)) texts.set(k, { id: `L${texts.size + 1}`, text: it.text.trim(), license: it.license, users: [] });
  const t = texts.get(k);
  t.users.push(it.name);
  return t.id;
};
const notice = [];
notice.push(`TryBoard 试板 · THIRD-PARTY NOTICES / 第三方声明
生成于 ${today}（tools/gen_licenses.mjs，按依赖清单与素材目录自动生成）

试板的模拟器内核、网页和验收固件由试板团队编写。下面是网站随附的第三方组件：
名称、版本、许可证、版权声明、来源，以及改动说明。各许可证全文附在文末，同一份正文只附一次，
组件条目里的 [L1]、[L2] … 指向文末对应全文。

ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.
3D 视图里的开发板是外观示意，不是乐鑫官方模型。
`);
let cat = '';
for (const it of items) {
  if (it.cat !== cat) {
    cat = it.cat;
    notice.push(`\n${hr()}\n${cat}\n${hr()}\n`);
  }
  const ref = textRef(it);
  const lines = [`${it.name}${it.version ? ` ${it.version}` : ''}`];
  lines.push(`  许可证：${it.license}${ref ? ` [${ref}]` : ''}`);
  for (const c of it.copyright.filter(Boolean)) lines.push(`  ${c}`);
  if (it.url) lines.push(`  来源：${it.url}`);
  if (it.modified) lines.push(`  已修改：\n${it.modified.split('\n').map((l) => `    ${l.replace(/^- /, '· ')}`).join('\n')}`);
  if (it.note) lines.push(...it.note.split('\n').filter(Boolean).map((l) => `  ${l}`));
  notice.push(lines.join('\n') + '\n');
}
if (!crates.length) notice.push(`\n${hr()}\n模拟器内核（Rust → WebAssembly）\n${hr()}\n\n没有第三方 crate（以 core/Cargo.lock 为准，构建时自动检查）。\n`);
notice.push(`\n${hr()}\n构建工具（npm devDependencies，${devTools.length} 个，不随网站分发）\n${hr()}\n
只在本机构建时使用。Vite（MIT）会往产物里注入少量模块预加载辅助代码。
3D 模型转换（tools/models/，构建期）：occt-import-js（LGPL-2.1）、glTF-Transform（MIT）、meshoptimizer（MIT）。

${devTools.map((d) => `${d.name} ${d.version} · ${d.license}${d.installed ? '' : ' · 其他平台的可选二进制，本机未安装'}`).join('\n')}
`);
notice.push(`\n${hr()}\n许可证全文\n${hr()}\n`);
for (const t of texts.values()) notice.push(`\n${hr('-')}\n[${t.id}] ${t.license} · 适用于：${t.users.join('、')}\n${hr('-')}\n\n${t.text}\n`);
const noticeTxt = notice.join('\n').replace(/\n{3,}/g, '\n\n');

// ---------------------------------------------------------------- 输出 2：tryboard.spdx.json（SPDX 2.3）
// licenseConcluded 只能放合法 SPDX 表达式；ROM 里那几项写不成标识的，用 NOASSERTION + comment 交代
const spdxOk = (s) => (/^[A-Za-z0-9.+\-]+( (AND|OR|WITH) [A-Za-z0-9.+\-]+)*$/.test(s ?? '') ? s : /^\(.+\)$/.test(s ?? '') ? s : 'NOASSERTION');
const sid = (s, i) => `SPDXRef-Package-${i}-${String(s).replace(/[^A-Za-z0-9.\-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x'}`;
const pkgs = [];
const rels = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-TryBoard' }];
pkgs.push({ SPDXID: 'SPDXRef-TryBoard', name: 'TryBoard', versionInfo: today, supplier: 'Organization: TryBoard', downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION', comment: '试板：在浏览器中运行 ESP32 固件的模拟器（网页、wasm 内核、示例固件）' });
const romId = {};
items.forEach((it, i) => {
  const id = sid(it.name, i);
  if (it.name === 'esp-rom-elfs') romId.v = id;
  const lic = spdxOk(it.license);
  const comment = [it.cat, it.license !== lic ? `许可：${it.note || it.license}` : '', it.modified ? '已修改，见 THIRD_PARTY_NOTICES.txt' : ''].filter(Boolean).join('；');
  pkgs.push({ SPDXID: id, name: it.name, versionInfo: it.version || 'NOASSERTION', downloadLocation: /^https?:/.test(it.url) ? it.url : 'NOASSERTION', filesAnalyzed: false, licenseConcluded: lic, licenseDeclared: lic, copyrightText: it.copyright.filter(Boolean).join('\n') || 'NOASSERTION', comment });
  rels.push(it.inRom ? { spdxElementId: romId.v, relationshipType: 'CONTAINS', relatedSpdxElement: id } : { spdxElementId: 'SPDXRef-TryBoard', relationshipType: 'CONTAINS', relatedSpdxElement: id });
});
devTools.forEach((d, i) => {
  const id = sid(`dev-${d.name}`, items.length + i);
  pkgs.push({ SPDXID: id, name: d.name, versionInfo: d.version || 'NOASSERTION', downloadLocation: `https://registry.npmjs.org/${d.name}/-/${d.name.split('/').pop()}-${d.version}.tgz`, filesAnalyzed: false, licenseConcluded: spdxOk(d.license), licenseDeclared: spdxOk(d.license), copyrightText: 'NOASSERTION', comment: '构建工具，不随网站分发' });
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
// 加 BOM：静态托管给 .txt 常常不带 charset，浏览器直接打开时靠它认出 UTF-8，中文不乱码
fs.writeFileSync(path.join(pub, 'THIRD_PARTY_NOTICES.txt'), '\uFEFF' + noticeTxt);
fs.writeFileSync(path.join(pub, 'tryboard.spdx.json'), spdxJson);

// ---------------------------------------------------------------- 输出 3：licenses.html（一页声明）
const kb = (s) => `${Math.max(1, Math.round(Buffer.byteLength(s) / 1024))} KB`;
const LIC_NAME = { 'OFL-1.1': 'SIL OFL 1.1', 'CC-BY-SA-4.0': 'CC BY-SA 4.0' };
const licIds = [...new Set(shipped.flatMap((it) => it.license.replace(/[()]/g, '').split(/ (?:AND|OR|WITH) /)))].filter((l) => l !== 'NOASSERTION');
// 按用到的组件数排，多的在前
const licCount = (l) => shipped.filter((it) => it.license.includes(l)).length;
licIds.sort((a, b) => licCount(b) - licCount(a));
const ZH = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
const licList = licIds.map((l) => LIC_NAME[l] ?? l);
const licSentence = licList.length > 1 ? `${licList.slice(0, -1).join('、')} 和 ${licList.at(-1)} ${ZH[licList.length] ?? licList.length} 种许可证` : `${licList[0]} 许可证`;
if (shipped.some((it) => it.license === 'NOASSERTION')) warn.push(`有随网站分发但许可证认不出的组件：${shipped.filter((it) => it.license === 'NOASSERTION').map((it) => it.name).join('、')}`);
const has = (re) => items.some((it) => re.test(it.name));
// 特别感谢：只列真的在用的；许可证从收集到的数据里取，不手写
const licOf = (re) => [...new Set(items.filter((it) => re.test(it.name)).map((it) => LIC_NAME[it.license] ?? it.license))].join(' · ');
const ACKS = [
  { name: 'Espressif', what: '芯片 ROM 与 ESP-IDF 组件', re: /^(esp-rom-elfs|ESP-IDF)$/ },
  { name: 'three.js', what: '3D 场景渲染', re: /^three$/ },
  { name: 'React', what: '网页界面', re: /^react$/ },
  { name: 'TinyUSB', what: 'USB 键盘与串口', re: /^espressif\/tinyusb$/ },
  { name: 'Google Fonts', what: 'Noto Sans SC、JetBrains Mono', re: /^(Noto Sans SC|JetBrains Mono)$/ },
  { name: 'KiCad 与 Adafruit', what: '蜂鸣器、USB-C、舵机 3D 模型', re: /蜂鸣器|USB-C|舵机/ },
].filter((a) => has(a.re) || (warn.push(`特别感谢「${a.name}」对应的组件不在清单里，没列`), false));
const modified = models.filter((m) => m.modified);

// 页头导航链接的类名：与 web/src/ui/site.tsx 的 navLink 相同（licenses.css 用 @source 扫这个文件生成这些类）
const NAV_LINK = 'rounded-md px-2.5 py-[5px] text-muted hover:bg-field hover:text-fg';
// 与 web/src/ui/links.ts 的 SITE_NAV 相同（不带 .html 后缀，DESIGN_V2 §7.2）
const NAV = [
  ['./', '作品'],
  ['./select', '选板'],
  ['./app?work=blank#bench', '实验台'],
];
const LOGO = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="4" width="56" height="56" rx="14" class="fill-[#0B76C8] dark:fill-[#3AA8FF]"/><g class="fill-white dark:fill-[#17181B]"><circle cx="20" cy="20" r="5"/><circle cx="32" cy="20" r="5"/><circle cx="20" cy="32" r="5"/><circle cx="32" cy="32" r="5"/><circle cx="44" cy="32" r="5"/><circle cx="20" cy="44" r="5"/><circle cx="32" cy="44" r="5"/><circle cx="44" cy="44" r="5"/></g><circle cx="44" cy="20" r="6" fill="#FFB020"/></svg>`;
const BRAND = `<a class="inline-flex flex-none items-center gap-1.5 max-md:min-h-11 max-md:gap-2" href="./" aria-label="试板 TryBoard 首页">${LOGO(22).replace('<svg ', '<svg class="max-md:size-[26px]" ')}<b class="text-[14px] max-md:text-[17px]">试板</b><span class="font-mono text-[10px] tracking-[0.08em] text-muted max-md:hidden">TRYBOARD</span><span class="ml-0.5 hidden text-[13px] text-muted max-md:inline">· 授权与致谢</span></a>`;
const ICON = (d, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const SEG = 'min-h-[38px] cursor-pointer rounded-lg px-3 text-muted max-md:min-h-11 aria-checked:bg-surface aria-checked:font-medium aria-checked:text-fg aria-checked:shadow-[0_1px_3px_#0000001a] aria-checked:ring-1 aria-checked:ring-line';
const DL = (href, title, sub) => `<a href="${href}" download class="flex min-h-16 items-center gap-3 rounded-[10px] border border-line px-4 text-fg no-underline! transition-colors hover:border-hover-line hover:bg-field"><span class="min-w-0 flex-1"><b class="block text-[13px]">${esc(title)}</b><span class="font-mono text-[11px] text-muted">${esc(sub)}</span></span><span class="text-accent-ink">${ICON('M12 4v12M6 10l6 6 6-6M5 20h14', 18)}</span></a>`;

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- 主题在首帧前定好（web/src/theme.ts 同一规则：localStorage tb-theme，否则跟随系统） -->
    <script>try{var t=localStorage.getItem('tb-theme')}catch(e){}document.documentElement.dataset.theme=t==='dark'||t==='light'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'</script>
    <title>授权与致谢 · 试板 TryBoard</title>
    <meta name="description" content="试板 TryBoard 使用的开源软件、芯片 ROM、固件组件、字体和 3D 素材及其许可证；可下载完整第三方声明与 SPDX 物料清单。" />
    <!-- 分享卡片（DESIGN_V2 §8.5）：og.png 构建时由 tools/webtest/og.mjs 渲染；上线定域名后 og:image 改绝对地址 -->
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="试板 TryBoard" />
    <meta property="og:title" content="授权与致谢 · 试板 TryBoard" />
    <meta property="og:description" content="试板 TryBoard 使用的开源软件、芯片 ROM、固件组件、字体和 3D 素材及其许可证；可下载完整第三方声明与 SPDX 物料清单。" />
    <meta property="og:image" content="./og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />
    <!-- 自托管字体（P2-19，tools/fonts/subset.py 生成，OFL-1.1） -->
    <link rel="stylesheet" href="/fonts/fonts.css" />
    <!-- 样式：src/licenses/licenses.css（Tailwind，与 React 页面同一套主题；页头 / 页脚类名与 src/ui/site.tsx 相同） -->
    <link rel="stylesheet" href="./src/licenses/licenses.css" />
  </head>
  <!-- 由 tools/gen_licenses.mjs 生成，不要手改 -->
  <body>
   <div class="flex min-h-screen flex-col text-[13px] leading-[1.6]">
    <header class="pg-head sticky top-0 z-[5] flex items-center gap-6 border-b border-line bg-head-bg px-6 py-3.5 backdrop-blur max-md:h-[52px] max-md:gap-2 max-md:py-0 max-md:pr-2 max-md:pl-4">
      ${BRAND}
      <nav aria-label="站点" class="flex flex-wrap gap-0.5 max-md:hidden">${NAV.map(([href, text]) => `<a href="${href}" class="${NAV_LINK}">${text}</a>`).join('')}</nav>
      <button type="button" id="themeBtn" class="theme-btn ml-auto inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-md border border-line bg-surface text-fg transition-colors hover:border-hover-line max-md:hidden"></button>
      <button type="button" id="siteMenu" aria-label="菜单" aria-haspopup="dialog" aria-expanded="false" aria-controls="siteDrawer" class="ml-auto hidden size-11 flex-none cursor-pointer items-center justify-center rounded-[10px] text-fg hover:bg-field max-md:inline-flex">${ICON('M4 7h16M4 12h16M4 17h16')}</button>
    </header>
    <!-- 手机菜单抽屉：与 web/src/ui/site.tsx 的 MobileMenu 同一结构（这里没有 Radix，下面的小脚本管开关、Esc 和焦点） -->
    <div id="siteDrawer" role="dialog" aria-modal="true" aria-label="站点菜单" hidden class="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg text-fg animate-[tb-drop_.18s_ease-out] [&[hidden]]:hidden">
      <div class="flex h-[52px] flex-none items-center gap-2 border-b border-line-soft pr-2 pl-4">
        <a class="inline-flex flex-none items-center gap-2" href="./" aria-label="试板 TryBoard 首页">${LOGO(26)}<b class="text-[17px]">试板</b><span class="font-mono text-[10px] tracking-[0.08em] text-muted">TRYBOARD</span></a>
        <button type="button" id="siteClose" aria-label="关闭菜单" class="ml-auto inline-flex size-11 cursor-pointer items-center justify-center rounded-[10px] hover:bg-field">${ICON('M6 6l12 12M18 6L6 18')}</button>
      </div>
      <nav aria-label="站点" class="flex flex-col px-4 py-2">${NAV.map(([href, text]) => `<a href="${href}" class="flex h-16 items-center justify-between border-b border-line-soft text-[20px] font-bold text-fg">${text}<span class="text-muted">${ICON('M9 6l6 6-6 6', 18)}</span></a>`).join('')}</nav>
      <p class="mx-4 my-3 rounded-xl bg-field p-3.5 text-[13px] leading-[1.6] text-muted">手机上可查看、调参数和按按键；连线和换固件建议用电脑。</p>
      <div class="mt-auto flex flex-col gap-1 border-t border-line-soft px-4 pt-4 pb-10">
        <div class="flex min-h-12 items-center justify-between text-[15px]">深色模式
          <div role="radiogroup" aria-label="深色模式" class="flex rounded-[10px] bg-field p-[3px] text-[13px]"><button type="button" role="radio" data-theme-pref="system" class="${SEG}">跟随系统</button><button type="button" role="radio" data-theme-pref="light" class="${SEG}">浅</button><button type="button" role="radio" data-theme-pref="dark" class="${SEG}">深</button></div>
        </div>
        <a href="./licenses" aria-current="page" class="flex h-11 items-center justify-between text-[15px] text-accent-ink">授权与致谢<span class="text-[12px] font-medium">当前页</span></a>
      </div>
    </div>
    <main class="lic mx-auto w-full max-w-[808px] flex-1 px-6 pt-14 pb-16 max-md:px-4 max-md:pt-8 max-md:pb-12">
      <h1>授权与致谢</h1>
      <p class="mt-1.5 text-[12px] text-muted">更新于 ${today}</p>

      <h2>试板本身</h2>
      <p>模拟器内核、网页和验收固件由试板团队编写，${crates.length ? `内核用到 ${crates.length} 个第三方 Rust crate，列在完整清单里。` : '不含第三方 Rust 依赖。'}</p>

      <h2>第三方组件</h2>
      <p>网站随附 <b id="licCount">${shipped.length}</b> 个第三方组件，使用 ${esc(licSentence)}。完整的名称、版本、版权声明和许可证全文见下方文件。</p>

      <h2>特别感谢</h2>
      <div class="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        ${ACKS.map((a) => `<div class="min-w-0 rounded-[10px] border border-line px-3.5 py-3"><b class="text-[13px]">${esc(a.name)}</b><div class="mt-0.5 text-[12px] leading-[1.6] text-muted">${esc(a.what)}</div><div class="mt-1.5 font-mono text-[10.5px] text-muted">${esc(licOf(a.re))}</div></div>`).join('\n        ')}
      </div>

      <h2>完整清单</h2>
      <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        ${DL('./THIRD_PARTY_NOTICES.txt', '第三方声明', `THIRD_PARTY_NOTICES.txt · ${kb(noticeTxt)}`)}
        ${DL('./tryboard.spdx.json', '软件物料清单', `tryboard.spdx.json · ${kb(spdxJson)} · 含构建工具`)}
      </div>
      <p class="note">两份文件在每次构建时从依赖清单和素材目录自动生成。${modified.length ? `修改过的 3D 模型按原许可证提供下载：${modified.map((m) => `<a href="./models/${esc(m.name)}/${esc(m.name)}.glb" download>${esc(m.title.replace(/（.*$/, ''))}</a>（${esc(LIC_NAME[m.license] ?? m.license)}，<a href="./models/${esc(m.name)}/SOURCES.md">来源与改动</a>）`).join('、')}。` : ''}</p>

      <h2>商标</h2>
      <p lang="en">ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</p>
      <p class="note">3D 视图里的开发板是外观示意，不是乐鑫官方模型。</p>
    </main>
    <footer class="pg-foot flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-t border-line px-6 py-3.5 text-[11px] text-muted max-sm:px-4 max-sm:py-3">
      <span>试板 TryBoard · 在浏览器中运行 ESP32 固件，兼容 Arduino。<span lang="en">ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span></span>
      <span><a class="text-fg hover:text-accent-ink max-md:inline-flex max-md:min-h-11 max-md:items-center" href="./licenses">授权与致谢</a></span>
    </footer>
   </div>
    <script>
      // 亮 / 暗切换（与 web/src/theme.ts 相同的存储键；这一页是生成的静态页，不走打包）
      (function () {
        // 图标与 web/src/app/icons.tsx 的 sun / moon 相同（全站主题键只放图标，DESIGN_V2 §6.3）
        var SUN = ${JSON.stringify(ICON('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4', 16))}, MOON = ${JSON.stringify(ICON('M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z', 16))};
        var b = document.getElementById('themeBtn'), r = document.documentElement;
        function sync() { var d = r.dataset.theme === 'dark'; b.innerHTML = d ? MOON : SUN; b.title = d ? '切到亮色' : '切到暗色'; b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(d)); }
        b.onclick = function () { var t = r.dataset.theme === 'dark' ? 'light' : 'dark'; r.dataset.theme = t; try { localStorage.setItem('tb-theme', t); } catch (e) {} sync(); };
        sync();
        // 手机菜单：开 / 关、Esc 关、焦点进出；三段主题（跟随系统 = 删掉存储键）
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
for (const w of warn) console.warn(`[licenses] 注意：${w}`);
console.log(`[licenses] 写入 ${path.relative(root, out)}（${(html.length / 1024).toFixed(0)} KB）、THIRD_PARTY_NOTICES.txt（${kb(noticeTxt)}）、tryboard.spdx.json（${kb(spdxJson)}，${pkgs.length} 个包）：随网站分发 ${shipped.length} 个组件，许可证 ${licIds.join(' / ')}`);
