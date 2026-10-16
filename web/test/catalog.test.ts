// 元件库 schema、核价提醒、采购模版（P0-06 / P0-07 的数据部分）。node --test 直接跑 .ts（Node 24 类型擦除）。
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

// P2-09 起加了三个新作品的外壳，上限从 60 放到 70（docs/DECISIONS.md 2026-10-16 P2-09）
test('元件库 40–70 件，id 唯一', () => {
  assert.ok(PARTS.length >= 40 && PARTS.length <= 70, `现在 ${PARTS.length} 件`);
  assert.equal(new Set(PARTS.map((p) => p.id)).size, PARTS.length);
  assert.equal(Object.keys(PART_BY_ID).length, PARTS.length);
  assert.ok(BOARDS.length >= 4);
});

test('schema 校验：整个库无错', () => {
  assert.deepEqual(validateCatalog(), []);
});

test('schema 校验：必填字段缺失会报错', () => {
  const p = clone(getPart('bme280'));
  p.name = '';
  p.currentMa.source = '';
  const e = validatePart(p);
  assert.ok(e.some((x) => x.startsWith('name')));
  assert.ok(e.some((x) => x.startsWith('currentMa.source')));
});

test('schema 校验：price.lo ≤ price.hi', () => {
  const p = clone(getPart('sg90'));
  p.price.lo = 20;
  p.price.hi = 10;
  assert.ok(validatePart(p).some((x) => /price\.lo 20 大于 price\.hi 10/.test(x)));
});

test('schema 校验：checkedAt 格式', () => {
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

test('schema 校验：值为 null 的字段必须在 todo / na 里交代', () => {
  const p = clone(getPart('hc-sr04'));
  p.sizeMm = null;
  assert.ok(validatePart(p).some((x) => x.startsWith('sizeMm 为 null')));
  p.todo = ['sizeMm：随卖家'];
  assert.deepEqual(validatePart(p), []);
  // 前缀覆盖：'board.ldo' 覆盖 ldo.model 与 ldo.maxMa
  const b = getPart('xiao-s3');
  assert.ok(nullFields(b).includes('board.ldo.maxMa'));
  assert.deepEqual(validatePart(b), []);
});

test('schema 校验：没有来源却给了供电范围 / 非估算电流，要报', () => {
  const p = clone(getPart('pot'));
  p.todo = p.todo.filter((t) => !t.startsWith('voltage.supply'));
  assert.ok(validatePart(p).some((x) => x.includes('voltage.supply')));
  const q = clone(getPart('pot'));
  q.currentMa.est = false;
  assert.ok(validatePart(q).some((x) => x.includes('非估算')));
});

test('schema 校验：外链只能是搜索页、不带推广参数', () => {
  const p = clone(getPart('sg90'));
  p.searchUrl.taobao = 'https://item.taobao.com/item.htm?id=1';
  assert.ok(validatePart(p).some((x) => x.includes('淘宝搜索页')));
  const q = clone(getPart('sg90'));
  q.searchUrl.szlcsc += '&aff=xx';
  assert.ok(validatePart(q).some((x) => x.includes('推广参数')));
});

test('schema 校验：requires 指向的件必须存在', () => {
  const p = clone(getPart('ds18b20'));
  p.requires = [{ partId: 'no-such-part', why: 'x' }];
  assert.ok(validatePart(p).some((x) => x.includes('no-such-part')));
});

test('价格全部标为未核（verified = false）且写明估计', () => {
  for (const p of PARTS) {
    assert.equal(p.price.verified, false, p.id);
    assert.match(p.price.source, /估/);
  }
});

test('level-bss138 是 passive（5 V 侧不接 GPIO，不该触发 R17）', () => {
  assert.equal(getPart('level-bss138').kind, 'passive');
});

test('stalePrices：120 天内不提醒，超过才提醒', () => {
  assert.deepEqual(stalePrices('2026-10-16'), []);
  // checkedAt 2026-10 按 10-01 算：+120 天 = 2027-01-29 还不算超，2027-01-30 超
  assert.deepEqual(stalePrices('2027-01-29'), []);
  const s = stalePrices('2027-01-30');
  assert.equal(s.length, PARTS.length);
  assert.equal(s[0].ageDays, 121);
  assert.equal(stalePrices('2027-01-30', 200).length, 0);
  assert.equal(stalePrices(new Date(Date.UTC(2027, 5, 1))).length, PARTS.length);
});

test('stalePrices：日期格式坏的件也提醒', () => {
  const p = clone(getPart('sg90'));
  p.price.checkedAt = '十月';
  const s = stalePrices('2026-10-16', 120, [p]);
  assert.equal(s.length, 1);
  assert.equal(s[0].ageDays, null);
  assert.throws(() => stalePrices('2026/10/16'));
});

test('todoList 列出待核字段', () => {
  const t = todoList();
  assert.ok(t.length > 0);
  assert.ok(t.find((x) => x.id === 'luat-s3')!.todo.some((s) => s.startsWith('board.psram')));
});

// ───────── 开发板库（P1-12） ─────────
test('开发板库：首批板子都在，每块有来源 URL、芯片、USB / PSRAM 结论或待核', () => {
  for (const id of ['luat-s3', 'xiao-s3', 'xiao-c3', 'm5-atoms3', 'ws-s3-lcd128', 'ws-s3-touch-lcd128', 's3-devkitc1-v10', 's3-devkitc1-v11', 'c3-devkitm1']) {
    const b = getPart(id);
    assert.equal(b.kind, 'board', id);
    assert.ok(b.board!.urls.length > 0 && b.board!.urls.every((u) => u.startsWith('https://')), `${id} 来源 URL`);
  }
  // 关键事实（官方资料）
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

test('schema 校验：开发板缺来源 URL / 板载占用写错 / 屏引脚对不上 都会报错', () => {
  const p = clone(getPart('ws-s3-lcd128'));
  p.board!.urls = [];
  p.board!.onboard[0].kind = 'nope' as never;
  p.board!.builtin = [{ partId: 'no-such-part', what: 'x' }];
  p.board!.lcd!.rst = 33;
  p.board!.onboard.push({ gpio: 0, what: '重复', kind: 'other' });
  const e = validatePart(p);
  for (const re of [/board\.urls 至少/, /onboard kind 未知/, /builtin 指向不存在/, /board\.lcd\.rst = GPIO33/, /同一个 GPIO 写了两次：0/]) assert.ok(e.some((x) => re.test(x)), `${re}：${e.join(' | ')}`);
  const q = clone(getPart('xiao-s3'));
  q.board!.urls = ['http://example.com'];
  assert.ok(validatePart(q).some((x) => /只能是 https/.test(x)));
});

// ───────── 采购模版 ─────────
test('模版：八个、必选件都在库里，数量为正', () => {
  assert.deepEqual(PROCURE_TEMPLATES.map((t) => t.id), ['weather', 'spin', 'lens', 'lamp', 'ruler', 'tilt', 'usbkey', 'blank']);
  for (const t of PROCURE_TEMPLATES) {
    assert.ok(PART_BY_ID[t.board]?.kind === 'board', t.id);
    for (const l of [...t.required, ...t.suggested]) {
      assert.ok(PART_BY_ID[l.partId], `${t.id}: ${l.partId}`);
      assert.ok(l.qty > 0 && l.why.length > 0);
    }
    assert.ok(t.required.some((l) => l.partId === 'usb-c-cable'), `${t.id} 必带数据线`);
  }
});

test('模版：templatePicks 包含全部必选，按勾选带建议项', () => {
  for (const t of PROCURE_TEMPLATES) {
    const ids = templatePicks(t.id).map((p) => p.partId);
    for (const r of t.required) assert.ok(ids.includes(r.partId), `${t.id} 缺 ${r.partId}`);
    for (const s of t.suggested) assert.equal(ids.includes(s.partId), s.checked || t.required.some((r) => r.partId === s.partId), `${t.id} ${s.partId}`);
    const all = templatePicks(t.id, { includeAll: true }).map((p) => p.partId);
    for (const s of t.suggested) assert.ok(all.includes(s.partId));
  }
});

test('模版：气象站带出正确清单', () => {
  const ids = templatePicks('weather').map((p) => p.partId);
  for (const id of ['s3-devkitc1-v10', 'bme280', 'ssd1306', 'sg90', 'psu-5v2a', 'dc-jack', 'usb-c-cable', 'enclosure-weather']) assert.ok(ids.includes(id), id);
  assert.ok(ids.includes('buzzer-module'), '气象站固件用 GPIO5 蜂鸣器报警，默认勾选');
  assert.ok(!isRequired('weather', 'buzzer-module'), '蜂鸣器是建议件，可以去掉');
});

test('模版：必选件不能去掉，建议件可以', () => {
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

test('模版：去掉 BME280 出现阻断提示（P0-07 验收的规则部分）', () => {
  const inp = templateInput('weather');
  inp.parts = inp.parts.filter((p) => p.partId !== 'bme280');
  const f = problems(inp).find((x) => x.id === 'R27' && x.fix?.partId === 'bme280');
  assert.ok(f);
  assert.equal(f.level, 'block');
});

test('模版：各作品默认清单 + 接线无阻断、无警告', () => {
  for (const id of ['weather', 'spin', 'lens', 'usbkey', 'lamp', 'ruler', 'tilt', 'blank']) assert.deepEqual(problems(templateInput(id)), [], id);
});

test('模版：台灯去掉外接电源 → 只靠 USB 的警告（灯条满白 480 mA）', () => {
  const inp = templateInput('lamp');
  inp.parts = inp.parts.filter((p) => p.partId !== 'psu-5v2a' && p.partId !== 'dc-jack');
  inp.wiring = inp.wiring.filter((w) => w.part !== 'dc-jack').map((w) => (w.net === 'EXT5V' ? { ...w, net: '5V' } : w));
  assert.ok(problems(inp).some((x) => x.id === 'R20' && x.level === 'warn'));
});

test('模版：尺子的 Echo 不分压 → 5 V 进 GPIO 的提醒', () => {
  const inp = templateInput('ruler');
  inp.wiring = inp.wiring.map((w) => (w.part === 'hc-sr04' && w.pin === 'Echo' ? { part: w.part, pin: w.pin, net: w.net } : w));
  assert.ok(problems(inp).some((x) => x.id === 'R17'));
});

test('模版：接线引用的针脚都在元件库里', () => {
  for (const t of PROCURE_TEMPLATES) {
    for (const w of t.wiring) {
      const p = getPart(w.part);
      assert.ok(p.pins?.some((x) => x.label === w.pin), `${t.id}: ${w.part}.${w.pin}`);
      assert.match(w.net, /^(GPIO\d+|3V3|5V|GND|EXT5V|EXT3V3)$/);
    }
  }
});

test('toScene 与 firmware/examples.json 的 scene 一致', () => {
  for (const id of ['weather', 'spin', 'lens', 'usbkey', 'lamp', 'ruler', 'tilt']) {
    const ex = examples.find((e) => e.id === id)!;
    const inp = templateInput(id);
    assert.deepEqual(toScene(inp.parts, inp.wiring), ex.scene.parts, id);
  }
});

test('模版圆屏 / 舵机接线与 examples.json 的 pins 一致', () => {
  const map: Record<string, [string, string]> = { lcd_sclk: ['gc9a01', 'SCL'], lcd_mosi: ['gc9a01', 'SDA'], lcd_cs: ['gc9a01', 'CS'], lcd_dc: ['gc9a01', 'DC'], lcd_rst: ['gc9a01', 'RES'], lcd_bl: ['gc9a01', 'BLK'], servo: ['sg90', '橙 PWM'], buzzer: ['buzzer-module', 'I/O'], strip: ['ws2812-stick8', 'DIN'], a: ['encoder', 'CLK'], b: ['encoder', 'DT'], sw: ['encoder', 'SW'], trig: ['hc-sr04', 'Trig'], echo: ['hc-sr04', 'Echo'] };
  for (const id of ['weather', 'spin', 'lens', 'lamp', 'ruler', 'tilt']) {
    const ex = examples.find((e) => e.id === id)!;
    const t = PROCURE_TEMPLATES.find((x) => x.id === id)!;
    for (const [k, gpio] of Object.entries(ex.pins ?? {})) {
      const [part, pin] = map[k];
      assert.ok(t.wiring.some((w) => w.part === part && w.pin === pin && w.net === `GPIO${gpio}`), `${id}: ${k}=GPIO${gpio}`);
    }
  }
});

test('toScene：LED 按接线出场景，没接线的不出', () => {
  assert.deepEqual(toScene([{ partId: 'led-kit' }], [{ part: 'led-kit', pin: '长脚 +', net: 'GPIO5' }]), [{ type: 'led', pin: 5 }]);
  assert.deepEqual(toScene([{ partId: 'led-kit' }], []), []);
  // 改了地址的 OLED 用新地址
  assert.deepEqual(toScene([{ partId: 'ssd1306', addr: 0x3d }], [{ part: 'ssd1306', pin: 'SDA', net: 'GPIO8' }, { part: 'ssd1306', pin: 'SCL', net: 'GPIO9' }]), [{ type: 'oled', addr: 0x3d, sda: 8, scl: 9 }]);
});

test('bomTotal：区间合计 = 逐行之和，lo ≤ hi；板子不在清单里也算上', () => {
  const picks = templatePicks('weather');
  const b = bomTotal(picks);
  const lo = picks.reduce((s, p) => s + getPart(p.partId).price.lo * (p.qty ?? 1), 0);
  assert.equal(b.lo, Math.round(lo * 100) / 100);
  assert.ok(b.lo <= b.hi);
  const noBoard = picks.filter((p) => p.partId !== 's3-devkitc1-v10');
  assert.deepEqual(bomTotal(noBoard, 's3-devkitc1-v10').lo, b.lo);
  assert.equal(bomTotal([{ partId: 'button', qty: 4 }]).hi, 2);
});
