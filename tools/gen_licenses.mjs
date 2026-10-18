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
// 手机（< 768px）上每一行变成一张卡（DESIGN_V2 §5「每个来源一张卡，不用横向滚表格」）：首格是卡片标题，其余格用 data-label 显示列名
const table = (head, rows) => `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => r(head)).join('')}</tbody></table></div>`;
const tr = (cells) => (head) => `<tr>${cells.map((c, i) => `<td data-label="${esc(head[i] ?? '')}"${c?.mono ? ' class="mono"' : ''}>${c?.html ?? esc(c)}</td>`).join('')}</tr>`;
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

// ---------------------------------------------------------------- 5. 字体（P2-19：自托管子集，tools/fonts/）
{
  const fd = path.join(root, 'third_party/fonts');
  const rev = exists(path.join(fd, 'REVISION')) ? rd(path.join(fd, 'REVISION')).trim() : '';
  if (!rev) warn.push('third_party/fonts 不存在（先跑 tools/fonts/fetch.sh）：字体许可全文没附上');
  const fonts = [
    { name: 'Noto Sans SC', dir: 'notosanssc', file: 'tb-sans-sc.woff2', ofl: 'OFL-NotoSansSC.txt', copy: 'Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source"', use: '正文、界面（中文）' },
    { name: 'JetBrains Mono', dir: 'jetbrainsmono', file: 'tb-mono.woff2', ofl: 'OFL-JetBrainsMono.txt', copy: 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)', use: '串口、代码、数字' },
  ];
  const src = (f) => (rev ? link(`https://github.com/google/fonts/tree/${rev}/ofl/${f.dir}`, `google/fonts@${rev.slice(0, 7)}`) : '—');
  sections.push(`<h2>字体（自托管，随网站分发）</h2>
${table(['字体', '许可证', '版权', '来源', '发布文件', '许可全文'], fonts.map((f) => tr([f.name, mono('OFL-1.1'), f.copy, src(f), { html: `<span><code>fonts/${esc(f.file)}</code>（${esc(f.use)}）</span>` }, link(`./fonts/${f.ofl}`, 'OFL.txt')])))}
<p class="note">从 google/fonts 仓库固定提交下载可变字重 TTF，构建时用 fonttools 子集化成 WOFF2（页面实际用到的字 + GB2312 一级字 3755 个；等宽字留整套西文），改过的文件名不含保留名 "Source"，OFL.txt 和字体放在同一目录。许可证说明：<a href="https://openfontlicense.org/open-font-license-official-text/">SIL Open Font License 1.1</a>。</p>
${fonts.filter((f) => exists(path.join(fd, f.ofl))).map((f) => fullText(`${f.name} · OFL-1.1 全文`, rd(path.join(fd, f.ofl)))).join('')}`);
}

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
  // assets/models/<名字>/：网站在 models/<名字>/ 发布 glb + SOURCES.md + LICENSE（web/vite.config.ts 的 tb-models 插件），这里给署名表和下载链接
  const cell = (md, k) => md.match(new RegExp(`^\\| ${k} \\| (.+) \\|$`, 'm'))?.[1] ?? '—';
  const plain = (t) => t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1').replace(/`/g, '');
  const models = found.filter((f) => path.relative(root, f).startsWith('assets/models/')).map((f) => {
    const md = rd(f);
    const name = path.basename(path.dirname(f));
    const lic = fs.readdirSync(path.dirname(f)).find((n) => /^LICENSE(\.md)?$/.test(n));
    if (!exists(path.join(path.dirname(f), `${name}.glb`))) warn.push(`${name}：有 SOURCES.md 但没有 ${name}.glb（先跑 tools/models/convert.mjs）`);
    if (!lic) warn.push(`${name}：素材目录缺 LICENSE`);
    return { name, md, lic, title: md.match(/^# (.+)$/m)?.[1] ?? name };
  });
  const modelRows = models.map((m) => tr([
    m.title,
    mono(plain(cell(m.md, '许可证')).replace(/（.*$/, '')),
    plain(cell(m.md, '作者')),
    cell(m.md, '是否修改'),
    { html: `<a href="./models/${esc(m.name)}/${esc(m.name)}.glb" download>${esc(m.name)}.glb</a> · <a href="./models/${esc(m.name)}/SOURCES.md">SOURCES.md</a>${m.lic ? ` · <a href="./models/${esc(m.name)}/${esc(m.lic)}">${esc(m.lic)}</a>` : ''}` },
  ]));
  const credits = models.map((m) => m.md.split('## 署名')[1]?.trim()).filter(Boolean);
  const others = found.filter((f) => !path.relative(root, f).startsWith('assets/models/'));
  sections.push(`<h2>素材：3D 模型、贴图、HDRI</h2>
${models.length ? `<p class="note">实验台和成品里的器件默认按真实尺寸由代码生成；打开实验台工具条上的「外部模型」后，下面这些模型替换对应的程序生成件（懒加载）。3D 视图里的开发板是外观示意，非乐鑫官方模型。</p>
${table(['模型', '许可证', '作者', '修改', '下载'], modelRows)}
${credits.map((c) => `<p class="note">${esc(c).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n\n/g, '<br>')}</p>`).join('')}
<p class="note">转换只在本机构建期进行（tools/models/）：occt-import-js（LGPL-2.1，OpenCascade 的 WebAssembly 版）读 STEP，glTF-Transform（MIT）与 meshoptimizer（MIT）减面、量化、写 glb。这些工具不随网站分发。</p>
${models.map((m) => fullText(`assets/models/${m.name}/SOURCES.md`, m.md)).join('')}` : ''}
${others.length ? others.map((f) => fullText(`${path.relative(root, path.dirname(f))}/SOURCES.md`, rd(f))).join('') : ''}
${!found.length ? '<p class="note">目前没有使用外部 3D 模型、贴图或 HDRI：开发板、面包板、模块、杜邦线都按真实尺寸由代码生成。3D 视图里的器件是外观示意，非乐鑫官方模型。以后引入外部素材时，来源与署名写进素材目录的 SOURCES.md，这一节自动列出。</p>' : ''}`);
  // 许可证原文（每种只列一次）
  const seen = new Set();
  for (const m of models) {
    if (!m.lic) continue;
    const t = rd(path.join(root, 'assets/models', m.name, m.lic));
    const k = t.trim().slice(0, 200);
    if (seen.has(k)) continue;
    seen.add(k);
    sections.push(fullText(`${m.lic === 'LICENSE.md' ? 'KiCad Libraries 许可（CC BY-SA 4.0 + 设计例外）' : 'Adafruit CAD Parts · MIT'} 全文`, t));
  }
}

// 页头导航链接的类名：与 web/src/ui/site.tsx 的 navLink 相同（licenses.css 用 @source 扫这个文件生成这些类）
const NAV_LINK = 'rounded-md px-2.5 py-[5px] text-muted hover:bg-field hover:text-fg';
const NAV = [
  ['./home.html', '作品'],
  ['./advisor.html', '选型助手'],
  ['./app.html?work=blank#bench', '空白实验台'],
];
const LOGO = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="4" width="56" height="56" rx="14" class="fill-[#0B76C8] dark:fill-[#3AA8FF]"/><g class="fill-white dark:fill-[#17181B]"><circle cx="20" cy="20" r="5"/><circle cx="32" cy="20" r="5"/><circle cx="20" cy="32" r="5"/><circle cx="32" cy="32" r="5"/><circle cx="44" cy="32" r="5"/><circle cx="20" cy="44" r="5"/><circle cx="32" cy="44" r="5"/><circle cx="44" cy="44" r="5"/></g><circle cx="44" cy="20" r="6" fill="#FFB020"/></svg>`;
const BRAND = `<a class="inline-flex flex-none items-center gap-1.5 max-md:min-h-11 max-md:gap-2" href="./home.html" aria-label="试板 TryBoard 首页">${LOGO(22).replace('<svg ', '<svg class="max-md:size-[26px]" ')}<b class="text-[14px] max-md:text-[17px]">试板</b><span class="font-mono text-[10px] tracking-[0.08em] text-muted max-md:hidden">TRYBOARD</span><span class="ml-0.5 hidden text-[13px] text-muted max-md:inline">· 授权与致谢</span></a>`;
const ICON = (d, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const SEG = 'min-h-[38px] cursor-pointer rounded-lg px-3 text-muted max-md:min-h-11 aria-checked:bg-surface aria-checked:font-medium aria-checked:text-fg aria-checked:shadow-[0_1px_3px_#0000001a] aria-checked:ring-1 aria-checked:ring-line';

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- 主题在首帧前定好（web/src/theme.ts 同一规则：localStorage tb-theme，否则跟随系统） -->
    <script>try{var t=localStorage.getItem('tb-theme')}catch(e){}document.documentElement.dataset.theme=t==='dark'||t==='light'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'</script>
    <title>授权与致谢 · 试板 TryBoard</title>
    <meta name="description" content="试板 TryBoard 使用的第三方代码、芯片 ROM、固件组件、字体与素材的来源、许可证与署名。" />
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
      <button type="button" id="themeBtn" class="theme-btn ml-auto inline-flex h-[30px] flex-none cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-surface px-2.5 text-xs text-fg transition-colors hover:border-hover-line max-md:hidden"></button>
      <button type="button" id="siteMenu" aria-label="菜单" aria-haspopup="dialog" aria-expanded="false" aria-controls="siteDrawer" class="ml-auto hidden size-11 flex-none cursor-pointer items-center justify-center rounded-[10px] text-fg hover:bg-field max-md:inline-flex">${ICON('M4 7h16M4 12h16M4 17h16')}</button>
    </header>
    <!-- 手机菜单抽屉：与 web/src/ui/site.tsx 的 MobileMenu 同一结构（这里没有 Radix，下面的小脚本管开关、Esc 和焦点） -->
    <div id="siteDrawer" role="dialog" aria-modal="true" aria-label="站点菜单" hidden class="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg text-fg animate-[tb-drop_.18s_ease-out] [&[hidden]]:hidden">
      <div class="flex h-[52px] flex-none items-center gap-2 border-b border-line-soft pr-2 pl-4">
        <a class="inline-flex flex-none items-center gap-2" href="./home.html" aria-label="试板 TryBoard 首页">${LOGO(26)}<b class="text-[17px]">试板</b><span class="font-mono text-[10px] tracking-[0.08em] text-muted">TRYBOARD</span></a>
        <button type="button" id="siteClose" aria-label="关闭菜单" class="ml-auto inline-flex size-11 cursor-pointer items-center justify-center rounded-[10px] hover:bg-field">${ICON('M6 6l12 12M18 6L6 18')}</button>
      </div>
      <nav aria-label="站点" class="flex flex-col px-4 py-2">${NAV.map(([href, text]) => `<a href="${href}" class="flex h-16 items-center justify-between border-b border-line-soft text-[20px] font-bold text-fg">${text}<span class="text-muted">${ICON('M9 6l6 6-6 6', 18)}</span></a>`).join('')}</nav>
      <p class="mx-4 my-3 rounded-xl bg-field p-3.5 text-[13px] leading-[1.6] text-muted"><b class="text-fg">在手机上</b>：能看、能调参数、能按按键。连线和拖固件用电脑更顺手。</p>
      <div class="mt-auto flex flex-col gap-1 border-t border-line-soft px-4 pt-4 pb-10">
        <div class="flex min-h-12 items-center justify-between text-[15px]">深色模式
          <div role="radiogroup" aria-label="深色模式" class="flex rounded-[10px] bg-field p-[3px] text-[13px]"><button type="button" role="radio" data-theme-pref="system" class="${SEG}">跟随系统</button><button type="button" role="radio" data-theme-pref="light" class="${SEG}">浅</button><button type="button" role="radio" data-theme-pref="dark" class="${SEG}">深</button></div>
        </div>
        <a href="./licenses.html" aria-current="page" class="flex h-11 items-center justify-between text-[15px] text-accent-ink">授权与致谢<span class="text-[12px] font-medium">当前页</span></a>
      </div>
    </div>
    <main class="lic mx-auto w-full max-w-[1200px] flex-1 px-6 pb-16 max-sm:px-4 max-sm:pb-12">
      <h1>授权与致谢</h1>
      <p>网站里用到的别人的代码、芯片 ROM、固件组件、字体和素材，以及各自的许可证与署名。构建时从依赖清单和素材目录自动生成。</p>
      ${sections.join('\n')}
      <p class="gen mono">生成于 ${new Date().toISOString().slice(0, 10)} · tools/gen_licenses.mjs</p>
    </main>
    <footer class="pg-foot flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-t border-line px-6 py-3.5 text-[11px] text-muted max-sm:px-4 max-sm:py-3">
      <span>TryBoard 试板：在浏览器里运行 ESP32 系列芯片的真实固件，compatible with Arduino。ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span>
      <span><a class="text-fg hover:text-accent-ink max-md:inline-flex max-md:min-h-11 max-md:items-center" href="./licenses.html">授权与致谢</a></span>
    </footer>
   </div>
    <script>
      // 亮 / 暗切换（与 web/src/theme.ts 相同的存储键；这一页是生成的静态页，不走打包）
      (function () {
        var b = document.getElementById('themeBtn'), r = document.documentElement;
        function sync() { var d = r.dataset.theme === 'dark'; b.textContent = d ? '☾ 暗' : '☀ 亮'; b.title = d ? '切到亮色' : '切到暗色'; b.setAttribute('aria-pressed', String(d)); }
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
console.log(`[licenses] 写入 ${path.relative(root, out)}（${(html.length / 1024).toFixed(0)} KB）`);
