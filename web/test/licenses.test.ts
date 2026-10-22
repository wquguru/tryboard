// F-08e: tools/gen_licenses.mjs lists shipped Arduino bins with their LGPL / MIT notices and refuses libraries LICENSING.md keeps off the site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../tools/gen_licenses.mjs', import.meta.url));
const SERVO = 'library: ESP32Servo f7282217605d8bd9a4f3070cf9901d10d13ede1d https://github.com/madhephaestus/ESP32Servo source x';
const IR = 'library: Arduino-IRremote 498dc591b255d8ba2e239c875804bdab2ab0fe91 https://github.com/Arduino-IRremote/Arduino-IRremote source x';

/** Runs the generator against a fake published fw/ holding the given Arduino bins (id -> library lines). */
function gen(bins: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'tb-lic-'));
  try {
    for (const [id, libs] of Object.entries(bins)) {
      mkdirSync(join(dir, 'fw', id), { recursive: true });
      writeFileSync(join(dir, 'fw', id, 'flash.bin'), '');
      writeFileSync(join(dir, 'fw', id, 'BUILD_INFO.txt'), ['core: esp32:esp32 3.3.2 (arduino-esp32 release tag 3.3.2)', ...libs, ''].join('\n'));
    }
    const r = spawnSync(process.execPath, [script, '--out', join(dir, 'licenses.html'), '--pub', dir, '--fw', join(dir, 'fw')], { encoding: 'utf8' });
    const read = (f: string) => (r.status === 0 ? readFileSync(join(dir, f), 'utf8') : '');
    return { status: r.status, stderr: r.stderr, html: read('licenses.html'), notices: read('THIRD_PARTY_NOTICES.txt') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ESP32Servo ships with LGPL-2.1 and its copyright / derivation notes', () => {
  const r = gen({ 'arduino-lib-esp32servo': [SERVO] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.html, /id="arduino"/);
  assert.match(r.html, /ESP32Servo<\/a> f7282217605d · LGPL-2\.1-or-later/);
  assert.match(r.notices, /John K\. Bennett/);
  assert.match(r.notices, /Kevin Harrington/);
  assert.match(r.notices, /Michael Margolis in 2009/);
  assert.match(r.notices, /madhephaestus\/ESP32Servo\/tree\/f7282217605d8bd9a4f3070cf9901d10d13ede1d/);
});

test('IRremote ships with MIT, all holders, the BSD-3 file and the GPL-header note (LICENSING_REVIEW §16.5)', () => {
  const r = gen({ 'arduino-lib-irremote': [IR] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.html, /Arduino-IRremote<\/a> 498dc591b255 · MIT AND BSD-3-Clause/);
  for (const who of ['Ken Shirriff', 'Rafi Khan', 'Armin Joachimsmeyer', 'Bengt Martensson']) assert.match(r.notices, new RegExp(who));
  assert.match(r.notices, /digitalWriteFast\.h: .*BSD 3-Clause/);
  assert.match(r.notices, /TinyIR\.h carry GPL-3\.0-or-later headers .* is MIT\./);
  assert.match(r.notices, /Arduino-IRremote\/tree\/498dc591b255d8ba2e239c875804bdab2ab0fe91/);
});

test('a published bin linking a library not cleared in LICENSING.md fails the build', () => {
  const r = gen({ 'arduino-lib-dallas': ['library: OneWire 800f26f3ee6eb446a72e013785cac3700e54cc13 https://github.com/PaulStoffregen/OneWire source x'] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /arduino-lib-dallas: OneWire/);
});

test('ESP32Servo and IRremote examples are in the shipped example list', () => {
  const ex: { id: string }[] = JSON.parse(readFileSync(new URL('../../firmware/examples.json', import.meta.url), 'utf8'));
  const ids = ex.map((e) => e.id);
  assert.ok(ids.includes('arduino-lib-esp32servo'));
  assert.ok(ids.includes('arduino-lib-irremote'));
});
