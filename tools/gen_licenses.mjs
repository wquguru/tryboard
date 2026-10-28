#!/usr/bin/env node
// Builds web/licenses.html (+ licenses.<zh|ja|ko>.html, F-12b), THIRD_PARTY_NOTICES.txt and the SPDX 2.3 SBOM (LICENSING.md rule 8, DESIGN_V2 §7.3 C) from tools/build_web.sh.
// Exits 2 if shipped firmware has Espressif modified MIT (rule 5) or an Arduino library not allowed by LICENSING.md. Usage: node tools/gen_licenses.mjs [--out web/licenses.html] [--pub web/public] [--fw web/public/fw]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, fmtDay, htmlLang, ICON, LOCS, page, translator } from './static_shell.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.indexOf(k) > 0 ? process.argv[process.argv.indexOf(k) + 1] : d);
const out = path.resolve(root, arg('--out', 'web/licenses.html'));
const pub = path.resolve(root, arg('--pub', 'web/public'));
const fwRoot = path.resolve(root, arg('--fw', 'web/public/fw'));
const web = path.join(root, 'web');
const rd = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
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
    note: `Files published on the site: ${shipped.join(', ')}. Modified (Apache-2.0 section 4(b)): the .xt.prop and .xt.lit sections were removed by tools/strip_rom.py; loadable content and symbols are unchanged. Third-party components inside the ROM are listed in the next section.`,
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
  const fwDir = fwRoot;
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

// ---------------------------------------------------------------- 4b. Example firmware: Arduino sketches (LGPL three-piece, F-08e)
// Libraries allowed in shipped bins = the ✅ rows of docs/LICENSING.md; null = read the SPDX id from the library's LICENSE file
const ARDUINO_LIBS = {
  ArduinoJson: 'MIT', U8g2_Arduino: 'BSD-2-Clause', Adafruit_SSD1306: null, 'Adafruit-GFX-Library': null, Adafruit_BME280_Library: null,
  Adafruit_MPU6050: null, Adafruit_SHT31: null, Adafruit_ILI9341: null, Adafruit_BusIO: 'MIT', 'DHT-sensor-library': 'MIT', RTClib: 'MIT',
  Adafruit_Sensor: 'Apache-2.0', 'esp8266-oled-ssd1306': 'MIT', 'Arduino-Temperature-Control-Library': 'MIT', rfid: 'Unlicense',
  FastLED: 'MIT', WiFiManager: 'MIT', pubsubclient: 'MIT', 'NimBLE-Arduino': 'Apache-2.0', M5Unified: 'MIT', M5GFX: 'MIT AND BSD-2-Clause',
  ESP32Servo: 'LGPL-2.1-or-later', 'Arduino-IRremote': 'MIT AND BSD-3-Clause',
};
// Per-file holders from LICENSING_REVIEW §16.1 / §16.2 (ESP32Servo has no LICENSE file; IRremote files name more authors than LICENSE)
const ARDUINO_LIB_COPYRIGHT = {
  ESP32Servo: ['Copyright (c) 2017 John K. Bennett (ESP32Servo)', 'ESP32PWM by Kevin Harrington (hephaestus), 2018', 'Derived from the Arduino Servo library, originally written by Michael Margolis in 2009 (LGPL-2.1-or-later)'],
  'Arduino-IRremote': [
    '(c) Copyright 2009 Ken Shirriff; (c) Copyright 2016 Rafi Khan; (c) Copyright 2020-2022 Armin Joachimsmeyer et al.',
    'Protocol files also by Daniel Wallner, Kristian Lauszus, Darryl Smith, E. Stuart Hicks, Daniel Weidmann and Bengt Martensson (MIT)',
  ],
};
const ARDUINO_LIB_NOTE = {
  'Arduino-IRremote':
    'src/digitalWriteFast.h: Watterott electronic, based on https://code.google.com/p/digitalwritefast, BSD 3-Clause License (https://opensource.org/licenses/BSD-3-Clause).\n' +
    'LocalDebugLevelStart.h, LocalDebugLevelEnd.h, LongUnion.h, TinyIR.h carry GPL-3.0-or-later headers copied from the same author\'s utility repos; they contain only macros, type and struct declarations and constants, contribute no object code of their own, and the implementation they accompany (e.g. TinyIRReceiver.hpp) is MIT.',
};
// Never shipped (LICENSING.md): OneWire / TFT_eSPI await review; a published bin using one fails the build
const ARDUINO_DENY = { OneWire: 'licence awaiting review', TFT_eSPI: 'licence awaiting review' };
{
  const fwDir = fwRoot;
  const lgpl = exists(path.join(root, 'third_party/arduino-esp32/LICENSE.md')) ? rd(path.join(root, 'third_party/arduino-esp32/LICENSE.md')) : '';
  if (!lgpl) warn.push('third_party/arduino-esp32/LICENSE.md does not exist (run tools/fetch_third_party.sh first): LGPL-2.1 text not attached');
  const published = exists(fwDir) ? fs.readdirSync(fwDir).filter((n) => n.startsWith('arduino-') && exists(path.join(fwDir, n, 'flash.bin'))) : [];
  // Nothing published yet: list every built sketch like section 4 does, but skip the ones that may never ship
  const buildDir = path.join(root, 'firmware/build');
  const infoOf = (id) => [path.join(fwDir, id, 'BUILD_INFO.txt'), path.join(buildDir, id, 'BUILD_INFO.txt')].find(exists);
  const ids = published.length ? published : exists(buildDir) ? fs.readdirSync(buildDir).filter((n) => n.startsWith('arduino-') && infoOf(n)) : [];
  let core = '';
  const libs = new Map();
  const denied = [];
  const coreUsed = [];
  for (const id of ids) {
    const f = infoOf(id);
    if (!f) {
      warn.push(`${id}: published Arduino firmware has no BUILD_INFO.txt (rebuild with tools/build_arduino.sh)`);
      continue;
    }
    const info = rd(f);
    const used = [...info.matchAll(/^library: (\S+) ([0-9a-f]{40}) (\S+)/gm)].map((m) => ({ name: m[1], sha: m[2], repo: m[3].replace(/\.git$/, '') }));
    const bad = used.filter((l) => ARDUINO_DENY[l.name] || !(l.name in ARDUINO_LIBS));
    if (bad.length) {
      if (published.length) denied.push(`${id}: ${bad.map((l) => `${l.name} (${ARDUINO_DENY[l.name] ?? 'not a ✅ row in docs/LICENSING.md'})`).join(', ')}`);
      continue;
    }
    core ||= info.match(/^core: esp32:esp32 (\S+)/m)?.[1] ?? '';
    for (const l of used) {
      const k = `${l.name}@${l.sha}`;
      if (!libs.has(k)) libs.set(k, { ...l, used: [] });
      libs.get(k).used.push(id);
    }
    coreUsed.push(id);
  }
  if (denied.length) {
    console.error(`[licenses] published Arduino firmware links libraries that LICENSING.md does not allow on the site: ${denied.join('; ')}`);
    process.exit(2);
  }
  const cat = 'Example firmware (Arduino sketches, shipped compiled with the site)';
  const relink = 'LGPL-2.1 section 6(a): each bin ships with BUILD_INFO.txt (sketch commit, arduino-esp32 release, pinned library commits, FQBN, arduino-cli version) and its sketch source (fw/<id>/src.json), so you can rebuild and relink it against a modified library.';
  if (coreUsed.length) {
    add({ cat, name: 'arduino-esp32', version: core, license: 'LGPL-2.1-or-later AND Apache-2.0', copyright: ['Copyright (c) Espressif Systems and Arduino contributors'], url: `https://github.com/espressif/arduino-esp32/tree/${core}`, text: lgpl, note: `Arduino-derived core files are LGPL-2.1, the rest Apache-2.0 (ESP-IDF libraries as listed above).\n${relink}\nUsed in: ${coreUsed.join(' ')}` });
  }
  for (const l of [...libs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, 'third_party/arduino-libs', l.name);
    const lf = licenseFile(dir);
    const ftext = lf ? rd(lf) : '';
    const lgplLib = /^LGPL/.test(ARDUINO_LIBS[l.name] ?? '');
    const text = lgplLib ? lgpl : ftext;
    if (!text) warn.push(`Arduino library ${l.name}: no license text found`);
    add({
      cat,
      name: l.name,
      version: l.sha.slice(0, 12),
      license: ARDUINO_LIBS[l.name] ?? guessSpdx(ftext),
      copyright: ARDUINO_LIB_COPYRIGHT[l.name] ?? copyrightLines(ftext),
      url: `${l.repo}/tree/${l.sha}`,
      text,
      note: `${ARDUINO_LIB_NOTE[l.name] ? `${ARDUINO_LIB_NOTE[l.name]}\n` : ''}${lgplLib ? `Library source at the pinned commit above. ${relink}\n` : ''}Used in: ${l.used.join(' ')}`,
    });
  }
}

// ---------------------------------------------------------------- 5. Fonts (P2-19: self-hosted subsets, tools/fonts/)
{
  const fd = path.join(root, 'third_party/fonts');
  const rev = exists(path.join(fd, 'REVISION')) ? rd(path.join(fd, 'REVISION')).trim() : '';
  if (!rev) warn.push('third_party/fonts does not exist (run tools/fonts/fetch.sh first): font license texts not attached');
  const fonts = [
    { name: 'Noto Sans SC', dir: 'notosanssc', file: 'tb-sans-sc-*.<hash>.woff2 (unicode-range slices)', ofl: 'OFL-NotoSansSC.txt', copy: 'Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name "Source"' },
    { name: 'JetBrains Mono', dir: 'jetbrainsmono', file: 'tb-mono.<hash>.woff2', ofl: 'OFL-JetBrainsMono.txt', copy: 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)' },
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
pkgs.push({ SPDXID: 'SPDXRef-TryBoard', name: 'TryBoard', versionInfo: today, supplier: 'Organization: TryBoard', downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'Apache-2.0', licenseDeclared: 'Apache-2.0', copyrightText: 'Copyright 2026 The TryBoard Authors', comment: 'TryBoard: a simulator that runs ESP32 firmware in the browser (web pages, wasm core, example firmware)' });
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

// ---------------------------------------------------------------- Output 3: licenses.html + licenses.<loc>.html (one-page notice per locale, F-12b)
// Only headings and explanations are translated; license names, SPDX ids, copyright lines and component names stay as published
const kb = (s) => `${Math.max(1, Math.round(Buffer.byteLength(s) / 1024))} KB`;
const LIC_NAME = { 'OFL-1.1': 'SIL OFL 1.1', 'CC-BY-SA-4.0': 'CC BY-SA 4.0' };
const licIds = [...new Set(shipped.flatMap((it) => it.license.replace(/[()]/g, '').split(/ (?:AND|OR|WITH) /)))].filter((l) => l !== 'NOASSERTION');
// Most-used license first
const licCount = (l) => shipped.filter((it) => it.license.includes(l)).length;
licIds.sort((a, b) => licCount(b) - licCount(a));
const licList = licIds.map((l) => LIC_NAME[l] ?? l);
// English keeps its "A, B and C" wording; other locales use the platform list format (Intl.ListFormat)
const listOf = (loc, xs) => (loc === 'en' ? (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]) : new Intl.ListFormat(htmlLang(loc), { type: 'conjunction' }).format(xs));
// Between translated sentences: Chinese and Japanese run on without a space
const gap = (loc) => (loc === 'zh' || loc === 'ja' ? '' : ' ');
if (shipped.some((it) => it.license === 'NOASSERTION')) warn.push(`shipped components with an unrecognised license: ${shipped.filter((it) => it.license === 'NOASSERTION').map((it) => it.name).join(', ')}`);
const has = (re) => items.some((it) => re.test(it.name));
// Special thanks lists only what is really used; licenses come from the collected data, never typed by hand
const licOf = (re) => [...new Set(items.filter((it) => re.test(it.name)).map((it) => LIC_NAME[it.license] ?? it.license))].join(' · ');
const ACKS = [
  { name: 'Espressif', what: 'Chip ROM and ESP-IDF components', re: /^(esp-rom-elfs|ESP-IDF)$/ },
  { name: 'three.js', what: '3D scene rendering', re: /^three$/ },
  { name: 'React', what: 'Web interface', re: /^react$/ },
  { name: 'TinyUSB', what: 'USB keyboard and serial', re: /^espressif\/tinyusb$/ },
  { name: 'Google Fonts', what: 'Noto Sans SC, JetBrains Mono', fixed: true, re: /^(Noto Sans SC|JetBrains Mono)$/ },
  { name: 'KiCad and Adafruit', what: 'Buzzer, USB-C and servo 3D models', re: /^(?!ESP32Servo$).*(蜂鸣器|USB-C|舵机|buzzer|servo)/i }, // lint: allow-cjk
].filter((a) => has(a.re) || (warn.push(`special-thanks entry "${a.name}" has no matching component, omitted`), false));
const modified = models.filter((m) => m.modified);
// LGPL-2.1 section 6 wants a prominent notice, so Arduino bins get their own list instead of only the NOTICES file
const arduinoItems = items.filter((it) => it.cat.startsWith('Example firmware (Arduino'));
const arduinoHtml = (T) =>
  arduinoItems.length
    ? `
      <h2 id="arduino">${esc(T('Arduino example firmware'))}</h2>
      <p>${esc(T('Some example firmware is built with the Arduino core for ESP32 and links the components below.'))}${gap(T.loc)}${T.html('The LGPL-licensed parts ({names}) are under the GNU Lesser General Public License 2.1 or later, whose full text is in the third-party notices.', { names: esc(arduinoItems.filter((it) => /LGPL/.test(it.license)).map((it) => it.name).join(', ')) })}${gap(T.loc)}${T.html('Each such bin ships with {file} (sketch commit, core release, pinned library commits, board and arduino-cli version) and its sketch source, so you can rebuild it and relink it against a modified library.', { file: '<code>BUILD_INFO.txt</code>' })}</p>
      <ul>
        ${arduinoItems.map((it) => `<li><a href="${esc(it.url)}">${esc(it.name)}</a> ${esc(it.version)} · ${esc(it.license)}${it.copyright.length ? ` · ${esc(it.copyright.join('; '))}` : ''}</li>`).join('\n        ')}
      </ul>`
    : '';

const DL = (href, title, sub) => `<a href="${href}" download class="flex min-h-16 items-center gap-3 rounded-[10px] border border-line px-4 text-fg no-underline! transition-colors hover:border-hover-line hover:bg-field"><span class="min-w-0 flex-1"><b class="block text-[13px]">${esc(title)}</b><span class="font-mono text-[11px] text-muted">${esc(sub)}</span></span><span class="text-accent-ink">${ICON('M12 4v12M6 10l6 6 6-6M5 20h14', 18)}</span></a>`;

const render = (loc) => {
  const T = translator(loc);
  const ships = licList.length > 1
    ? T.html('The site ships {count} third-party components under {n} licenses: {list}.', { count: `<b id="licCount">${shipped.length}</b>`, n: licList.length, list: esc(listOf(loc, licList)) })
    : T.html('The site ships {count} third-party components under the {name} license.', { count: `<b id="licCount">${shipped.length}</b>`, name: esc(licList[0]) });
  const models3d = modified.map((m) => `<a href="./models/${esc(m.name)}/${esc(m.name)}.glb" download>${esc(m.title.replace(/\s*[（(].*$/, ''))}</a> (${esc(LIC_NAME[m.license] ?? m.license)}, <a href="./models/${esc(m.name)}/SOURCES.md">${esc(T('sources and changes'))}</a>)`);
  return page({
    locale: loc,
    base: 'licenses',
    title: T('Licenses & credits · TryBoard'),
    description: T('Open-source software, chip ROM, firmware components, fonts and 3D assets used by TryBoard and their licenses; download the full third-party notices and the SPDX bill of materials.'),
    css: './src/licenses/licenses.css',
    label: T('Licenses & credits'),
    main: `<main class="lic mx-auto w-full max-w-[808px] flex-1 px-6 pt-14 pb-16 max-md:px-4 max-md:pt-8 max-md:pb-12">
      <h1>${esc(T('Licenses & credits'))}</h1>
      <p class="mt-1.5 text-[12px] text-muted">${T.html('Updated {date}', { date: `<time datetime="${today}">${esc(fmtDay(loc, today))}</time>` })}</p>

      <h2>${esc(T('TryBoard itself'))}</h2>
      <p>${esc(T('The simulator core, web pages and acceptance firmware are written by the TryBoard team.'))}${gap(loc)}${esc(crates.length ? T('The core uses {n} third-party Rust crates, listed in the full notices.', { n: crates.length }) : T('It has no third-party Rust dependencies.'))}</p>

      <h2>${esc(T('Third-party components'))}</h2>
      <p>${ships}${gap(loc)}${esc(T('Full names, versions, copyright notices and license texts are in the files below.'))}</p>
${arduinoHtml(T)}

      <h2>${esc(T('Special thanks'))}</h2>
      <div class="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        ${ACKS.map((a) => `<div class="min-w-0 rounded-[10px] border border-line px-3.5 py-3"><b class="text-[13px]">${esc(a.name)}</b><div class="mt-0.5 text-[12px] leading-[1.6] text-muted">${esc(a.fixed ? a.what : T(a.what))}</div><div class="mt-1.5 font-mono text-[10.5px] text-muted">${esc(licOf(a.re))}</div></div>`).join('\n        ')}
      </div>

      <h2>${esc(T('Full notices'))}</h2>
      <div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        ${DL('./THIRD_PARTY_NOTICES.txt', T('Third-party notices'), `THIRD_PARTY_NOTICES.txt · ${kb(noticeTxt)}`)}
        ${DL('./tryboard.spdx.json', T('Software bill of materials'), `tryboard.spdx.json · ${kb(spdxJson)} · ${T('incl. build tools')}`)}
      </div>
      <p class="note">${esc(T('Both files are regenerated on every build from the dependency manifests and asset directories.'))}${models3d.length ? `${gap(loc)}${T.html('Modified 3D models are available for download under their original licenses: {list}.', { list: models3d.join(', ') })}` : ''}</p>

      <h2>${esc(T('Trademarks'))}</h2>
      <p lang="en">ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</p>
      <p class="note">${esc(T('The development boards in the 3D view are visual approximations, not official Espressif models.'))}</p>
    </main>`,
  });
};
// Locale files sit next to --out: licenses.html, licenses.zh.html, ... (all share one NOTICES / SPDX pair)
const outFor = (loc) => (loc === 'en' ? out : out.replace(/\.html$/, `.${loc}.html`));
let html = '';
for (const loc of LOCS) {
  const h = render(loc);
  if (loc === 'en') html = h;
  fs.writeFileSync(outFor(loc), h);
}
for (const w of warn) console.warn(`[licenses] warning: ${w}`);
console.log(`[licenses] wrote ${LOCS.map((l) => path.relative(root, outFor(l))).join(', ')} (${(html.length / 1024).toFixed(0)} KB each), THIRD_PARTY_NOTICES.txt (${kb(noticeTxt)}), tryboard.spdx.json (${kb(spdxJson)}, ${pkgs.length} packages): ${shipped.length} shipped components, licenses ${licIds.join(' / ')}`);
