#!/usr/bin/env node
// 生成第三方授权页 web/licenses.html（LICENSING.md 规则 8）。构建期由 tools/build_web.sh 调用，产物不进仓库。
// 读：web/package.json + package-lock.json + node_modules（npm）、core/Cargo.lock（cargo）、third_party/esp-rom-elfs（ROM）、
//     web/public/fw 里实际发布的示例固件用到的 managed_components、各素材目录的 SOURCES.md、字体清单。
// 发布的固件里出现乐鑫修改版 MIT（"ESPRESSIF MIT" / LicenseRef-Espressif-Modified-MIT）就失败退出（规则 5）。
// 用法：node tools/gen_licenses.mjs [--out web/licenses.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(root, outArg > 0 ? process.argv[outArg + 1] : 'web/licenses.html');
const web = path.join(root, 'web');
const rd = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const warn = [];

/** 从 LICENSE 正文猜 SPDX（只认我们会遇到的几种；认不出就标"见全文"，不瞎填） */
function guessSpdx(text) {
  if (/ESPRESSIF MIT|LicenseRef-Espressif-Modified-MIT/i.test(text)) return 'LicenseRef-Espressif-Modified-MIT';
  if (/Apache License[\s\S]{0,40}Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return 'ISC';
  return '见全文';
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
const fullText = (title, text) => `<details><summary>${esc(title)}</summary><pre>${esc(text.trim())}</pre></details>`;
const table = (head, rows) => `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const tr = (cells) => `<tr>${cells.map((c) => `<td${c?.mono ? ' class="mono"' : ''}>${c?.html ?? esc(c)}</td>`).join('')}</tr>`;
const mono = (s) => ({ mono: true, html: esc(s) });
const link = (href, text) => ({ html: `<a href="${esc(href)}">${esc(text ?? href)}</a>` });

const sections = [];

// ---------------------------------------------------------------- 1. 网页代码库（npm）
{
  const pkg = JSON.parse(rd(path.join(web, 'package.json')));
  const lock = exists(path.join(web, 'package-lock.json')) ? JSON.parse(rd(path.join(web, 'package-lock.json'))) : { packages: {} };
  const runtime = Object.keys(pkg.dependencies ?? {});
  const rows = [];
  const texts = [];
  for (const name of runtime) {
    const dir = path.join(web, 'node_modules', name);
    const p = exists(path.join(dir, 'package.json')) ? JSON.parse(rd(path.join(dir, 'package.json'))) : {};
    const lf = licenseFile(dir);
    const text = lf ? rd(lf) : '';
    if (!lf) warn.push(`npm ${name}：node_modules 里没有 LICENSE 文件`);
    rows.push(tr([mono(name), mono(p.version ?? pkg.dependencies[name]), mono(p.license ?? guessSpdx(text)), copyrightLines(text).join('；') || '—', p.homepage ? link(p.homepage) : '—']));
    if (text) texts.push(fullText(`${name} ${p.version ?? ''} · ${p.license ?? ''} 全文`, text));
  }
  // 构建工具：不随网站分发（Vite 会往产物里注入少量运行时辅助代码，Vite 本身 MIT）
  const devRows = [];
  for (const [k, v] of Object.entries(lock.packages ?? {})) {
    if (!k || !v.dev) continue;
    const name = k.replace(/^.*node_modules\//, '');
    const installed = exists(path.join(web, k));
    devRows.push(tr([mono(name), mono(v.version), mono(v.license ?? '—'), installed ? '' : '其他平台的可选二进制，本机未安装']));
  }
  sections.push(`<h2>网页运行时代码（npm，随网站分发）</h2>
${table(['包', '版本', '许可证', '版权', '主页'], rows)}
${texts.join('')}
<h2>网页构建工具（npm devDependencies，${devRows.length} 个，不随网站分发）</h2>
<p class="note">只在本机构建时使用。Vite（MIT）会往产物里注入少量模块预加载辅助代码。</p>
<details><summary>展开 ${devRows.length} 个构建期依赖</summary>${table(['包', '版本', '许可证', '备注'], devRows)}</details>`);
}

// ---------------------------------------------------------------- 2. 模拟器内核（cargo）
{
  const lockPath = path.join(root, 'core/Cargo.lock');
  const third = [];
  if (exists(lockPath)) {
    for (const block of rd(lockPath).split('[[package]]').slice(1)) {
      const name = block.match(/name = "([^"]+)"/)?.[1];
      const ver = block.match(/version = "([^"]+)"/)?.[1];
      const src = block.match(/source = "([^"]+)"/)?.[1];
      if (src) third.push({ name, ver, src });
    }
  } else warn.push('core/Cargo.lock 不存在');
  sections.push(`<h2>模拟器内核（Rust → WebAssembly）</h2>
${third.length ? table(['crate', '版本', '来源'], third.map((c) => tr([mono(c.name), mono(c.ver), mono(c.src)]))) : '<p class="note">内核全部是本项目自己的代码，当前没有任何第三方 crate（以 core/Cargo.lock 为准，构建时自动检查）。</p>'}`);
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
  const romThird = [
    ['Newlib', 'BSD'],
    ['Xtensa libhal', 'MIT'],
    ['TinyBasic Plus', 'MIT'],
    ['miniz', '公有领域（Public Domain）'],
    ['TJpgDec', 'TJpgDec 许可（BSD 风格）'],
    ['Zephyr USB 协议栈', 'Apache-2.0 / BSD-3-Clause'],
  ];
  sections.push(`<h2>芯片 ROM（随网站分发）</h2>
${table(['文件', '来源', '许可证', '版权'], shipped.map((f) => tr([mono(f), link('https://github.com/espressif/esp-rom-elfs', `espressif/esp-rom-elfs${rel ? ` · release ${rel}` : ''}`), mono('Apache-2.0'), copy])))}
<p class="note">ROM 里包含以下第三方组件（清单见 <a href="https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html#rom-source-code-copyrights">ESP-IDF COPYRIGHT · ROM Source Code Copyrights</a>）：</p>
${table(['组件', '许可证'], romThird.map(([a, b]) => tr([a, mono(b)])))}
${lic ? fullText('esp-rom-elfs · Apache License 2.0 全文', lic) : ''}`);
}

// ---------------------------------------------------------------- 4. 示例固件里的组件
{
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
      if (!comps.has(key)) comps.set(key, { name: c.replace('__', '/'), ver, url, spdx, text, copy, used: [] });
      comps.get(key).used.push(ex);
    }
  }
  const bad = [...comps.values()].filter((c) => c.spdx === 'LicenseRef-Espressif-Modified-MIT');
  if (bad.length) {
    console.error(`[licenses] 发布的固件含乐鑫修改版 MIT 组件，按 LICENSING.md 规则 5 不能托管：${bad.map((c) => `${c.name}（${c.used.join('、')}）`).join('；')}`);
    process.exit(2);
  }
  const list = [...comps.values()].sort((a, b) => a.name.localeCompare(b.name));
  sections.push(`<h2>示例固件里的组件（固件随网站分发）</h2>
<p class="note">示例固件用 ESP-IDF v5.5.1 编译。ESP-IDF 本身是 Apache-2.0（其中 soc 寄存器头为 Apache-2.0 OR MIT；FreeRTOS 为 MIT，newlib、lwIP 等见 <a href="https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32s3/COPYRIGHT.html">ESP-IDF COPYRIGHT</a>）；Wi-Fi / PHY / 蓝牙 / 共存闭源库（esp32-wifi-lib、esp-phy-lib、esp32-bt-lib、esp-coex-lib）为 Apache-2.0。下面是组件管理器拉进来的组件：</p>
${list.length ? table(['组件', '版本', '许可证', '版权', '用在'], list.map((c) => tr([c.url ? link(c.url.replace(/^git:/, 'https:').replace(/\.git$/, ''), c.name) : mono(c.name), mono(c.ver), mono(c.spdx), c.copy.join('；') || '—', mono(c.used.join(' '))]))) : '<p class="note">没有找到组件管理器组件（firmware/*/managed_components 还没生成）。</p>'}
${list.filter((c) => c.text).map((c) => fullText(`${c.name} ${c.ver} · ${c.spdx} 全文`, c.text)).join('')}`);
}

// ---------------------------------------------------------------- 5. 字体
sections.push(`<h2>字体</h2>
${table(['字体', '许可证', '版权', '加载方式'], [
  tr(['Noto Sans SC', mono('OFL-1.1'), 'Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source"', link('https://fonts.google.com/noto/specimen/Noto+Sans+SC', 'Google Fonts')]),
  tr(['JetBrains Mono', mono('OFL-1.1'), 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)', link('https://fonts.google.com/specimen/JetBrains+Mono', 'Google Fonts')]),
])}
<p class="note">目前从 Google Fonts 加载，没有自托管。以后自托管 / 子集化时附 OFL.txt，子集文件名不带保留名 "Source"。许可证全文：<a href="https://openfontlicense.org/open-font-license-official-text/">SIL Open Font License 1.1</a>。</p>`);

// ---------------------------------------------------------------- 6. 素材（3D 模型、贴图、HDRI）：各目录的 SOURCES.md
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
  sections.push(`<h2>素材：3D 模型、贴图、HDRI</h2>
${found.length ? found.map((f) => fullText(`${path.relative(root, path.dirname(f))}/SOURCES.md`, rd(f))).join('') : '<p class="note">目前没有使用外部 3D 模型、贴图或 HDRI：开发板、面包板、模块、杜邦线都按真实尺寸由代码生成。3D 视图里的器件是外观示意，非乐鑫官方模型。以后引入外部素材时，来源与署名写进素材目录的 SOURCES.md，这一节自动列出。</p>'}`);
}

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>第三方授权 · 试板 TryBoard</title>
    <meta name="description" content="试板 TryBoard 使用的第三方代码、芯片 ROM、固件组件、字体与素材的来源、许可证与署名。" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Crect x=%222%22 y=%222%22 width=%2212%22 height=%2212%22 rx=%222%22 fill=%22%230D99FF%22/%3E%3C/svg%3E" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" />
    <link rel="stylesheet" href="./src/app/app.css" />
    <link rel="stylesheet" href="./src/page.css" />
  </head>
  <!-- 由 tools/gen_licenses.mjs 生成，不要手改 -->
  <body class="page">
    <header class="pg-head">
      <a class="brand" href="./home.html"><b>试板</b><span class="mono">TRYBOARD</span></a>
      <nav aria-label="站点"><a href="./home.html">作品</a><a href="./advisor.html">选型助手</a><a href="./app.html?work=blank#bench">空白实验台</a><a class="on" href="./licenses.html">第三方授权</a></nav>
    </header>
    <main class="pg-main lic">
      <h1>第三方授权</h1>
      <p>网站里用到的别人的代码、芯片 ROM、固件组件、字体和素材，以及各自的许可证与署名。构建时从依赖清单和素材目录自动生成。</p>
      ${sections.join('\n')}
      <p class="gen mono">生成于 ${new Date().toISOString().slice(0, 10)} · tools/gen_licenses.mjs</p>
    </main>
    <footer class="pg-foot">
      <span>TryBoard 试板：在浏览器里运行 ESP32 系列芯片的真实固件，compatible with Arduino。ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span>
      <span><a href="./licenses.html">第三方授权</a></span>
    </footer>
  </body>
</html>
`;
fs.writeFileSync(out, html);
for (const w of warn) console.warn(`[licenses] 注意：${w}`);
console.log(`[licenses] 写入 ${path.relative(root, out)}（${(html.length / 1024).toFixed(0)} KB）`);
