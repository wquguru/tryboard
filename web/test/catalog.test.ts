// Part library schema, price reminders and shopping templates (data side of P0-06 / P0-07). node --test runs .ts directly (Node 24 type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PARTS, PART_BY_ID, BOARDS, getPart, type Part } from '../src/catalog/parts.ts';
import { validateCatalog, validatePart, stalePrices, nullFields, todoList } from '../src/catalog/schema.ts';
import { PROCURE_TEMPLATES, templatePicks, templateInput, toScene, bomTotal, isRequired, removePick } from '../src/catalog/templates.ts';
import { problems } from '../src/catalog/rules.ts';

const examples: { id: string; scene: { parts: unknown[] }; pins?: Record<string, number> }[] = JSON.parse(
  readFileSync(new URL('../../firmware/examples.json', import.meta.url), 'utf8'),
);

const clone = (p: Part): Part => structuredClone(p);

// P2-09 added enclosures for three new projects, so the cap went from 60 to 70 (docs/DECISIONS.md 2026-10-16 P2-09)
// F-04a2 added the ILI9341 / ST7789 240×320 modules: cap 70 → 80 (docs/DECISIONS.md 2026-10-20 F-04a2)
test('part library has 40–80 parts with unique ids', () => {
  assert.ok(PARTS.length >= 40 && PARTS.length <= 80, `now ${PARTS.length} parts`);
  assert.equal(new Set(PARTS.map((p) => p.id)).size, PARTS.length);
  assert.equal(Object.keys(PART_BY_ID).length, PARTS.length);
  assert.ok(BOARDS.length >= 4);
});

test('schema: whole library is clean', () => {
  assert.deepEqual(validateCatalog(), []);
});

test('schema: missing required fields are reported', () => {
  const p = clone(getPart('bme280'));
  p.name = '';
  p.currentMa.source = '';
  const e = validatePart(p);
  assert.ok(e.some((x) => x.startsWith('name')));
  assert.ok(e.some((x) => x.startsWith('currentMa.source')));
});

test('schema: price.lo ≤ price.hi', () => {
  const p = clone(getPart('sg90'));
  p.price.lo = 20;
  p.price.hi = 10;
  assert.ok(validatePart(p).some((x) => /price\.lo 20 is above price\.hi 10/.test(x)));
});

test('schema: checkedAt format', () => {
  for (const bad of ['2026/10', '2026-13', '26-10', '2026-10-32', '']) {
    const p = clone(getPart('sg90'));
    p.price.checkedAt = bad;
    assert.ok(validatePart(p).some((x) => x.includes('checkedAt')), bad);
  }
  for (const good of ['2026-10', '2026-10-16']) {
    const p = clone(getPart('sg90'));
    p.price.checkedAt = good;
    assert.deepEqual(validatePart(p), [], good);
  }
});

test('schema: null fields must be explained in todo / na', () => {
  const p = clone(getPart('hc-sr04'));
  p.sizeMm = null;
  assert.ok(validatePart(p).some((x) => x.startsWith('sizeMm is null')));
  p.todo = ['sizeMm: varies by seller'];
  assert.deepEqual(validatePart(p), []);
  // Fullwidth colon is still accepted for older entries
  p.todo = ['sizeMm：x']; // lint: allow-cjk
  assert.deepEqual(validatePart(p), []);
  // Prefix cover: 'board.ldo' covers ldo.model and ldo.maxMa
  const b = getPart('xiao-s3');
  assert.ok(nullFields(b).includes('board.ldo.maxMa'));
  assert.deepEqual(validatePart(b), []);
});

test('schema: supply range or non-estimated current without a source is reported', () => {
  const p = clone(getPart('pot'));
  p.todo = p.todo.filter((t) => !t.startsWith('voltage.supply'));
  assert.ok(validatePart(p).some((x) => x.includes('voltage.supply')));
  const q = clone(getPart('pot'));
  q.currentMa.est = false;
  assert.ok(validatePart(q).some((x) => x.includes('not an estimate')));
});

test('schema: external links must be search pages without affiliate parameters', () => {
  const p = clone(getPart('sg90'));
  p.searchUrl.taobao = 'https://item.taobao.com/item.htm?id=1';
  assert.ok(validatePart(p).some((x) => x.includes('Taobao search page')));
  const q = clone(getPart('sg90'));
  q.searchUrl.szlcsc += '&aff=xx';
  assert.ok(validatePart(q).some((x) => x.includes('affiliate parameter')));
});

test('schema: requires must point to existing parts', () => {
  const p = clone(getPart('ds18b20'));
  p.requires = [{ partId: 'no-such-part', why: 'x' }];
  assert.ok(validatePart(p).some((x) => x.includes('no-such-part')));
});

test('all prices are marked unverified (verified = false) and say they are estimates', () => {
  for (const p of PARTS) {
    assert.equal(p.price.verified, false, p.id);
    assert.match(p.price.source, /estimat/i);
  }
});

test('level-bss138 is passive (its 5 V side does not touch a GPIO, so no R17)', () => {
  assert.equal(getPart('level-bss138').kind, 'passive');
});

test('stalePrices: no reminder within 120 days, reminder after', () => {
  assert.deepEqual(stalePrices('2026-10-16'), []);
  // checkedAt 2026-10 counts as 10-01: +120 days = 2027-01-29 is still fine, 2027-01-30 is stale
  assert.deepEqual(stalePrices('2027-01-29'), []);
  const s = stalePrices('2027-01-30');
  assert.equal(s.length, PARTS.length);
  assert.equal(s[0].ageDays, 121);
  assert.equal(stalePrices('2027-01-30', 200).length, 0);
  assert.equal(stalePrices(new Date(Date.UTC(2027, 5, 1))).length, PARTS.length);
});

test('stalePrices: parts with a malformed date are reminded too', () => {
  const p = clone(getPart('sg90'));
  p.price.checkedAt = '十月'; // lint: allow-cjk
  const s = stalePrices('2026-10-16', 120, [p]);
  assert.equal(s.length, 1);
  assert.equal(s[0].ageDays, null);
  assert.throws(() => stalePrices('2026/10/16'));
});

test('todoList lists fields to verify', () => {
  const t = todoList();
  assert.ok(t.length > 0);
  assert.ok(t.find((x) => x.id === 'luat-s3')!.todo.some((s) => s.startsWith('board.psram')));
});

// ───────── Board library (P1-12) ─────────
test('board library: first batch present, each with source URL, chip, USB / PSRAM verdict or todo', () => {
  for (const id of ['luat-s3', 'xiao-s3', 'xiao-c3', 'm5-atoms3', 'ws-s3-lcd128', 'ws-s3-touch-lcd128', 's3-devkitc1-v10', 's3-devkitc1-v11', 'c3-devkitm1']) {
    const b = getPart(id);
    assert.equal(b.kind, 'board', id);
    assert.ok(b.board!.urls.length > 0 && b.board!.urls.every((u) => u.startsWith('https://')), `${id} source URL`);
  }
  // Key facts (official docs)
  assert.equal(getPart('s3-devkitc1-v10').board!.rgbGpio, 48);
  assert.equal(getPart('s3-devkitc1-v11').board!.rgbGpio, 38);
  assert.deepEqual(getPart('xiao-c3').pins!.filter((p) => [2, 8, 9].includes(p.gpio!)).map((p) => p.label), ['D0(GPIO2)', 'D8(GPIO8)', 'D9(GPIO9)']);
  assert.equal(getPart('xiao-c3').board!.psramMB, 0);
  assert.equal(getPart('xiao-s3').board!.psram, 'octal');
  assert.equal(getPart('m5-atoms3').pins!.filter((p) => p.gpio !== undefined).length, 8);
  assert.equal(getPart('m5-atoms3').board!.psram, 'none');
  const ws = getPart('ws-s3-lcd128').board!;
  assert.deepEqual(ws.lcd, { sclk: 10, mosi: 11, cs: 9, dc: 8, rst: 12, bl: 40 });
  assert.equal(getPart('ws-s3-touch-lcd128').board!.lcd!.rst, 14);
  assert.equal(ws.psram, 'quad');
  assert.deepEqual(ws.builtin?.map((x) => x.partId), ['gc9a01']);
});

test('schema: board without source URL / bad onboard use / mismatched display pins are reported', () => {
  const p = clone(getPart('ws-s3-lcd128'));
  p.board!.urls = [];
  p.board!.onboard[0].kind = 'nope' as never;
  p.board!.builtin = [{ partId: 'no-such-part', what: 'x' }];
  p.board!.lcd!.rst = 33;
  p.board!.onboard.push({ gpio: 0, what: 'duplicate', kind: 'other' });
  const e = validatePart(p);
  for (const re of [/board\.urls needs at least/, /unknown board\.onboard kind/, /builtin points to a missing/, /board\.lcd\.rst = GPIO33/, /same GPIO twice: 0/]) assert.ok(e.some((x) => re.test(x)), `${re}: ${e.join(' | ')}`);
  const q = clone(getPart('xiao-s3'));
  q.board!.urls = ['http://example.com'];
  assert.ok(validatePart(q).some((x) => /must be https/.test(x)));
});

// ───────── Shopping templates ─────────
test('templates: eight of them, required parts in the library, positive quantities', () => {
  assert.deepEqual(PROCURE_TEMPLATES.map((t) => t.id), ['weather', 'spin', 'lens', 'lamp', 'ruler', 'tilt', 'door', 'irlamp', 'cloud', 'usbkey', 'blank']);
  for (const t of PROCURE_TEMPLATES) {
    assert.ok(PART_BY_ID[t.board]?.kind === 'board', t.id);
    for (const l of [...t.required, ...t.suggested]) {
      assert.ok(PART_BY_ID[l.partId], `${t.id}: ${l.partId}`);
      assert.ok(l.qty > 0 && l.why.length > 0);
    }
    assert.ok(t.required.some((l) => l.partId === 'usb-c-cable'), `${t.id} must include a data cable`);
  }
});

test('templates: templatePicks has every required part and checked suggestions', () => {
  for (const t of PROCURE_TEMPLATES) {
    const ids = templatePicks(t.id).map((p) => p.partId);
    for (const r of t.required) assert.ok(ids.includes(r.partId), `${t.id} missing ${r.partId}`);
    for (const s of t.suggested) assert.equal(ids.includes(s.partId), s.checked || t.required.some((r) => r.partId === s.partId), `${t.id} ${s.partId}`);
    const all = templatePicks(t.id, { includeAll: true }).map((p) => p.partId);
    for (const s of t.suggested) assert.ok(all.includes(s.partId));
  }
});

test('templates: weather station gives the right list', () => {
  const ids = templatePicks('weather').map((p) => p.partId);
  for (const id of ['s3-devkitc1-v10', 'bme280', 'ssd1306', 'sg90', 'psu-5v2a', 'dc-jack', 'usb-c-cable', 'enclosure-weather']) assert.ok(ids.includes(id), id);
  assert.ok(ids.includes('buzzer-module'), 'weather station firmware alarms on a GPIO5 buzzer, checked by default');
  assert.ok(!isRequired('weather', 'buzzer-module'), 'the buzzer is a suggestion and can be removed');
});

test('templates: required parts cannot be removed, suggestions can', () => {
  assert.ok(isRequired('weather', 'bme280'));
  assert.ok(!isRequired('weather', 'breadboard-830'));
  const picks = templatePicks('weather');
  const r = removePick('weather', picks, 'bme280');
  assert.ok(r.refused && r.refused.includes('BME280'));
  assert.equal(r.picks, picks);
  const ok = removePick('weather', picks, 'breadboard-830');
  assert.equal(ok.refused, undefined);
  assert.ok(!ok.picks.some((p) => p.partId === 'breadboard-830'));
});

test('templates: removing BME280 raises a blocker (rule part of P0-07 acceptance)', () => {
  const inp = templateInput('weather');
  inp.parts = inp.parts.filter((p) => p.partId !== 'bme280');
  const f = problems(inp).find((x) => x.id === 'R27' && x.fix?.partId === 'bme280');
  assert.ok(f);
  assert.equal(f.level, 'block');
});

test('templates: each project default list + wiring has no blockers or warnings', () => {
  for (const id of ['weather', 'spin', 'lens', 'usbkey', 'lamp', 'ruler', 'tilt', 'door', 'irlamp', 'cloud', 'blank']) assert.deepEqual(problems(templateInput(id)), [], id);
});

test('templates: lamp without external supply -> USB-only warning (480 mA strip at full white)', () => {
  const inp = templateInput('lamp');
  inp.parts = inp.parts.filter((p) => p.partId !== 'psu-5v2a' && p.partId !== 'dc-jack');
  inp.wiring = inp.wiring.filter((w) => w.part !== 'dc-jack').map((w) => (w.net === 'EXT5V' ? { ...w, net: '5V' } : w));
  assert.ok(problems(inp).some((x) => x.id === 'R20' && x.level === 'warn'));
});

test('templates: ruler Echo without divider -> 5 V into GPIO warning', () => {
  const inp = templateInput('ruler');
  inp.wiring = inp.wiring.map((w) => (w.part === 'hc-sr04' && w.pin === 'Echo' ? { part: w.part, pin: w.pin, net: w.net } : w));
  assert.ok(problems(inp).some((x) => x.id === 'R17'));
});

test('templates: every wired pin exists in the part library', () => {
  for (const t of PROCURE_TEMPLATES) {
    for (const w of t.wiring) {
      const p = getPart(w.part);
      assert.ok(p.pins?.some((x) => x.label === w.pin), `${t.id}: ${w.part}.${w.pin}`);
      assert.match(w.net, /^(GPIO\d+|3V3|5V|GND|EXT5V|EXT3V3)$/);
    }
  }
});

test('toScene matches the scene in firmware/examples.json', () => {
  const exId: Record<string, string> = { door: 'c3-door', irlamp: 's3-irlamp', cloud: 'c3-cloud' };
  for (const id of ['weather', 'spin', 'lens', 'usbkey', 'lamp', 'ruler', 'tilt', 'door', 'irlamp', 'cloud']) {
    const ex = examples.find((e) => e.id === (exId[id] ?? id))!;
    const inp = templateInput(id);
    assert.deepEqual(toScene(inp.parts, inp.wiring), ex.scene.parts, id);
  }
});

test('template round display / servo wiring matches examples.json pins', () => {
  const map: Record<string, [string, string]> = { lcd_sclk: ['gc9a01', 'SCL'], lcd_mosi: ['gc9a01', 'SDA'], lcd_cs: ['gc9a01', 'CS'], lcd_dc: ['gc9a01', 'DC'], lcd_rst: ['gc9a01', 'RES'], lcd_bl: ['gc9a01', 'BLK'], servo: ['sg90', '橙 PWM'], buzzer: ['buzzer-module', 'I/O'], strip: ['ws2812-stick8', 'DIN'], a: ['encoder', 'CLK'], b: ['encoder', 'DT'], sw: ['encoder', 'SW'], trig: ['hc-sr04', 'Trig'], echo: ['hc-sr04', 'Echo'] }; // lint: allow-cjk
  const exId: Record<string, string> = { door: 'c3-door', irlamp: 's3-irlamp', cloud: 'c3-cloud' };
  for (const id of ['weather', 'spin', 'lens', 'lamp', 'ruler', 'tilt', 'door', 'irlamp', 'cloud']) {
    const ex = examples.find((e) => e.id === (exId[id] ?? id))!;
    const t = PROCURE_TEMPLATES.find((x) => x.id === id)!;
    for (const [k, gpio] of Object.entries(ex.pins ?? {})) {
      const [part, pin] = map[k];
      assert.ok(t.wiring.some((w) => w.part === part && w.pin === pin && w.net === `GPIO${gpio}`), `${id}: ${k}=GPIO${gpio}`);
    }
  }
});

test('toScene: wired LEDs show up in the scene, unwired ones do not', () => {
  assert.deepEqual(toScene([{ partId: 'led-kit' }], [{ part: 'led-kit', pin: '长脚 +', net: 'GPIO5' }]), [{ type: 'led', pin: 5 }]); // lint: allow-cjk
  assert.deepEqual(toScene([{ partId: 'led-kit' }], []), []);
  // An OLED with a changed address uses the new address
  assert.deepEqual(toScene([{ partId: 'ssd1306', addr: 0x3d }], [{ part: 'ssd1306', pin: 'SDA', net: 'GPIO8' }, { part: 'ssd1306', pin: 'SCL', net: 'GPIO9' }]), [{ type: 'oled', addr: 0x3d, sda: 8, scl: 9 }]);
});

test('bomTotal: range total = sum of lines, lo ≤ hi; the board counts even when not in the list', () => {
  const picks = templatePicks('weather');
  const b = bomTotal(picks);
  const lo = picks.reduce((s, p) => s + getPart(p.partId).price.lo * (p.qty ?? 1), 0);
  assert.equal(b.lo, Math.round(lo * 100) / 100);
  assert.ok(b.lo <= b.hi);
  const noBoard = picks.filter((p) => p.partId !== 's3-devkitc1-v10');
  assert.deepEqual(bomTotal(noBoard, 's3-devkitc1-v10').lo, b.lo);
  assert.equal(bomTotal([{ partId: 'button', qty: 4 }]).hi, 2);
});
