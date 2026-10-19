// Rule engine R01–R32: each rule has at least one firing and one non-firing case (R28–R32 are the P1-12 board rules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, evaluate, problems, summary, applyFix, type Finding, type RuleInput } from '../src/catalog/rules.ts';
import { templateInput } from '../src/catalog/templates.ts';
import type { Wire } from '../src/catalog/templates.ts';

const C3 = 'c3-devkitm1';
const S3 = 's3-devkitc1-v10';
const CABLE = { partId: 'usb-c-cable' };

/** One part on one signal line plus optional extra wires */
function one(board: string, partId: string, pin: string, net: string, extra: Partial<RuleInput> = {}, more: Wire[] = []): RuleInput {
  return { board, parts: [CABLE, { partId }, ...(extra.parts ?? [])], wiring: [{ part: partId, pin, net }, ...more], ...withoutParts(extra) };
}
const withoutParts = (x: Partial<RuleInput>) => {
  const { parts: _p, ...rest } = x;
  return rest;
};
const LED = (board: string, gpio: number, extra: Partial<RuleInput> = {}) => one(board, 'led-kit', '长脚 +', `GPIO${gpio}`, { parts: [{ partId: 'resistor-kit' }], ...extra }); // lint: allow-cjk

/** Findings of one rule that fired (level ≠ ok) */
const hits = (input: RuleInput, id: string): Finding[] => evaluate(input).filter((f) => f.id === id && f.level !== 'ok');
function fires(input: RuleInput, id: string, level: 'block' | 'warn', match?: RegExp): Finding {
  const h = hits(input, id);
  assert.ok(h.length > 0, `${id} should fire; got: ${JSON.stringify(problems(input).map((f) => f.id + ':' + f.detail))}`);
  assert.equal(h[0].level, level, `${id} level`);
  if (match) assert.match(h[0].detail, match);
  return h[0];
}
function quiet(input: RuleInput, id: string) {
  assert.deepEqual(hits(input, id), [], `${id} should not fire`);
}

test('rule table: 32 rules, consecutive ids, each with title and source', () => {
  assert.equal(RULES.length, 32);
  RULES.forEach((r, i) => {
    assert.equal(r.id, 'R' + String(i + 1).padStart(2, '0'));
    assert.ok(r.title.length > 0 && r.source.length > 0, r.id);
  });
});

test('evaluate: every rule has a finding and results are deterministic', () => {
  const inp = templateInput('weather');
  const a = evaluate(inp);
  assert.deepEqual([...new Set(a.map((f) => f.id))], RULES.map((r) => r.id));
  assert.deepEqual(evaluate(templateInput('weather')), a);
  const s = summary(a);
  assert.equal(s.block + s.warn + s.ok, a.length);
});

test('evaluate: throws when the board is not a board', () => {
  assert.throws(() => evaluate({ board: 'bme280', parts: [] }));
});

test('R01 C3 flash pins', () => {
  fires(LED(C3, 12), 'R01', 'block', /flash/);
  quiet(LED(C3, 4), 'R01');
  quiet(LED(S3, 12), 'R01');
});

test('R02 S3 flash / PSRAM SPI pins', () => {
  fires(LED(S3, 27), 'R02', 'block');
  quiet(LED(S3, 4), 'R02');
});

test('R03 octal PSRAM takes GPIO33–37', () => {
  fires(LED(S3, 35), 'R03', 'block', /octal/);
  fires(LED('luat-s3', 35), 'R03', 'warn', /unverified/);
  quiet(LED(S3, 4), 'R03');
});

test('R04 missing / not broken out GPIO', () => {
  fires(LED(S3, 23), 'R04', 'block', /22–25/);
  fires(LED('xiao-s3', 10), 'R04', 'block', /does not break GPIO10 out to the header/);
  quiet(LED(S3, 4), 'R04');
});

test('R05 BOOT pin pulled low at power-up', () => {
  fires(one(S3, 'hc-sr04', 'Echo', 'GPIO0', { parts: [{ partId: 'resistor-kit' }] }), 'R05', 'warn', /download mode/);
  fires(one(C3, 'hc-sr04', 'Echo', 'GPIO9', { parts: [{ partId: 'resistor-kit' }] }), 'R05', 'warn');
  quiet(one(S3, 'hc-sr04', 'Echo', 'GPIO5', { parts: [{ partId: 'resistor-kit' }] }), 'R05');
  quiet(LED(S3, 0), 'R05');
});

test('R06 C3 GPIO8 / 2 must be high at power-up', () => {
  fires(one(C3, 'hc-sr04', 'Echo', 'GPIO8'), 'R06', 'warn');
  fires(one(C3, 'hc-sr04', 'Echo', 'GPIO2'), 'R06', 'warn');
  quiet(one(C3, 'hc-sr04', 'Echo', 'GPIO4'), 'R06');
  quiet(one(S3, 'hc-sr04', 'Echo', 'GPIO8'), 'R06');
});

test('R07 S3 GPIO45 high at power-up', () => {
  fires(one(S3, 'dht22', 'OUT', 'GPIO45'), 'R07', 'block', /1\.8 V/);
  quiet(one(S3, 'dht22', 'OUT', 'GPIO4'), 'R07');
  quiet(one(S3, 'hc-sr04', 'Echo', 'GPIO45'), 'R07');
});

test('R08 S3 GPIO46 high at power-up', () => {
  fires(one(S3, 'dht22', 'OUT', 'GPIO46'), 'R08', 'warn');
  quiet(one(S3, 'dht22', 'OUT', 'GPIO5'), 'R08');
});

test('R09 USB D− / D+', () => {
  fires(LED(C3, 18), 'R09', 'warn', /USB/);
  fires(LED(S3, 20), 'R09', 'warn');
  quiet(LED(C3, 4), 'R09');
});

test('R10 UART0', () => {
  fires(LED(S3, 43), 'R10', 'warn', /UART0/);
  fires(LED(C3, 21), 'R10', 'warn');
  quiet(LED(S3, 4), 'R10');
});

test('R11 C3 analog inputs only on ADC1', () => {
  fires(one(C3, 'pot', '2', 'GPIO5'), 'R11', 'block', /erratum.*regardless of Wi-Fi/);
  fires(one(C3, 'pot', '2', 'GPIO6'), 'R11', 'block', /not an analog input/);
  quiet(one(C3, 'pot', '2', 'GPIO3'), 'R11');
  quiet(one(S3, 'pot', '2', 'GPIO5'), 'R11');
});

test('R12 S3 ADC2 with Wi-Fi on', () => {
  fires(one(S3, 'pot', '2', 'GPIO11', { firmware: { wifi: true } }), 'R12', 'warn', /ESP_ERR_TIMEOUT/);
  quiet(one(S3, 'pot', '2', 'GPIO11', { firmware: { wifi: false } }), 'R12');
  quiet(one(S3, 'pot', '2', 'GPIO5', { firmware: { wifi: true } }), 'R12');
  fires(one(S3, 'pot', '2', 'GPIO21'), 'R12', 'block', /not an analog input/);
});

test('R13 C3 GPIO11 is VDD_SPI', () => {
  fires(LED(C3, 11), 'R13', 'warn', /eFuse/);
  quiet(LED(C3, 10), 'R13');
});

test('R14 on-chip resources: RMT / LEDC / I2C', () => {
  const strips: RuleInput = {
    board: C3,
    parts: [CABLE, { partId: 'ws2812-stick8', key: 'a' }, { partId: 'ws2812-stick8', key: 'b' }, { partId: 'ws2812-stick8', key: 'c' }],
    wiring: [
      { part: 'a', pin: 'DIN', net: 'GPIO4' },
      { part: 'b', pin: 'DIN', net: 'GPIO5' },
      { part: 'c', pin: 'DIN', net: 'GPIO6' },
    ],
  };
  fires(strips, 'R14', 'block', /RMT/);
  quiet({ ...strips, board: S3 }, 'R14');
  // No wiring: count PWM by quantity
  fires({ board: C3, parts: [CABLE, { partId: 'sg90', qty: 7 }, { partId: 'psu-5v2a' }, { partId: 'dc-jack' }] }, 'R14', 'block', /LEDC/);
  quiet({ board: C3, parts: [CABLE, { partId: 'sg90', qty: 6 }, { partId: 'psu-5v2a' }, { partId: 'dc-jack' }] }, 'R14');
  const twoBuses = (board: string): RuleInput => ({
    board,
    parts: [CABLE, { partId: 'ssd1306' }, { partId: 'bme280' }],
    wiring: [
      { part: 'ssd1306', pin: 'SDA', net: 'GPIO4' },
      { part: 'ssd1306', pin: 'SCL', net: 'GPIO5' },
      { part: 'bme280', pin: 'SDA', net: 'GPIO6' },
      { part: 'bme280', pin: 'SCL', net: 'GPIO7' },
    ],
  });
  fires(twoBuses(C3), 'R14', 'block', /I2C/);
  quiet(twoBuses(S3), 'R14');
});

test('R15 I2C address conflict / unsupported address', () => {
  fires({ board: S3, parts: [CABLE, { partId: 'mpu6050' }, { partId: 'ds3231' }] }, 'R15', 'block', /0x68/);
  quiet({ board: S3, parts: [CABLE, { partId: 'mpu6050', addr: 0x69 }, { partId: 'ds3231' }] }, 'R15');
  fires({ board: S3, parts: [CABLE, { partId: 'ssd1306', addr: 0x50 }] }, 'R15', 'block', /does not support address/);
  // Two OLEDs on two buses do not conflict
  const split: RuleInput = {
    board: S3,
    parts: [CABLE, { partId: 'ssd1306', key: 'o1' }, { partId: 'ssd1306', key: 'o2' }],
    wiring: [
      { part: 'o1', pin: 'SDA', net: 'GPIO8' },
      { part: 'o2', pin: 'SDA', net: 'GPIO1' },
    ],
  };
  quiet(split, 'R15');
  fires({ board: S3, parts: [CABLE, { partId: 'ssd1306', qty: 2 }] }, 'R15', 'block', /second I2C bus/);
});

test('R16 parallel pull-ups too strong', () => {
  const five = ['bme280', 'aht20', 'ina219', 'mpu6050', 'ssd1306'].map((partId) => ({ partId }));
  fires({ board: S3, parts: [CABLE, ...five] }, 'R16', 'warn', /sinking/);
  quiet({ board: S3, parts: [CABLE, ...five.slice(0, 2)] }, 'R16');
});

test('R17 5 V signal straight into a GPIO', () => {
  const f = fires(one(S3, 'hc-sr04', 'Echo', 'GPIO5'), 'R17', 'block', /not 5 V tolerant/);
  assert.deepEqual(f.fix, { action: 'add', partId: 'resistor-kit' });
  const viaDivider: RuleInput = { board: S3, parts: [CABLE, { partId: 'hc-sr04' }, { partId: 'resistor-kit' }], wiring: [{ part: 'hc-sr04', pin: 'Echo', net: 'GPIO5', via: 'divider' }] };
  quiet(viaDivider, 'R17');
  // No wiring: report without divider resistors, pass once they are bought
  fires({ board: S3, parts: [CABLE, { partId: 'hc-sr04' }] }, 'R17', 'block');
  quiet({ board: S3, parts: [CABLE, { partId: 'hc-sr04' }, { partId: 'resistor-kit' }] }, 'R17');
  // I2C module on 5 V: suggest a level shifter
  const aht5v: RuleInput = { board: S3, parts: [CABLE, { partId: 'aht20' }], wiring: [{ part: 'aht20', pin: 'VCC', net: '5V' }, { part: 'aht20', pin: 'SDA', net: 'GPIO8' }] };
  assert.deepEqual(fires(aht5v, 'R17', 'block').fix, { action: 'add', partId: 'level-bss138' });
  quiet({ ...aht5v, wiring: [{ part: 'aht20', pin: 'VCC', net: '3V3' }, { part: 'aht20', pin: 'SDA', net: 'GPIO8' }] }, 'R17');
  // The level shifter itself (passive) does not fire
  quiet({ board: S3, parts: [CABLE, { partId: 'level-bss138' }] }, 'R17');
});

test('R18 5 V WS2812 on a 3.3 V data line', () => {
  const base = (via?: Wire['via']): RuleInput => ({
    board: S3,
    parts: [CABLE, { partId: 'ws2812-strip' }, { partId: 'psu-5v2a' }, { partId: 'dc-jack' }],
    wiring: [{ part: 'ws2812-strip', pin: 'DIN', net: 'GPIO5', via }],
  });
  assert.deepEqual(fires(base(), 'R18', 'warn', /74AHCT125/).fix, { action: 'add', partId: 'level-ahct125' });
  quiet(base('level-shifter'), 'R18');
  // Strip on 3V3: threshold 2.3 V, so 3.3 V data is fine
  quiet({ board: S3, parts: [CABLE, { partId: 'ws2812-stick8' }], wiring: [{ part: 'ws2812-stick8', pin: '5V', net: '3V3' }, { part: 'ws2812-stick8', pin: 'DIN', net: 'GPIO5' }] }, 'R18');
});

test('R19 supply voltage out of range', () => {
  const servo = (net: string): RuleInput => ({
    board: S3,
    parts: [CABLE, { partId: 'sg90' }, { partId: 'psu-5v2a' }, { partId: 'dc-jack' }],
    wiring: [{ part: 'sg90', pin: '红 VCC', net }, { part: 'sg90', pin: '橙 PWM', net: 'GPIO4' }], // lint: allow-cjk
  });
  fires(servo('3V3'), 'R19', 'block', /4\.8–6 V/);
  quiet(servo('EXT5V'), 'R19');
  fires({ board: S3, parts: [CABLE, { partId: 'bme280' }], wiring: [{ part: 'bme280', pin: 'VCC', net: '5V' }] }, 'R19', 'block', /damaged/);
  quiet({ board: S3, parts: [CABLE, { partId: 'bme280' }], wiring: [{ part: 'bme280', pin: 'VCC', net: '3V3' }] }, 'R19');
});

test('R20 USB-only peak above 500 mA (servo without external supply, one-click fix)', () => {
  const noPsu: RuleInput = { board: S3, parts: [CABLE, { partId: 'sg90' }] };
  const f = fires(noPsu, 'R20', 'warn', /500 mA/);
  assert.deepEqual(f.fix, { action: 'add', partId: 'psu-5v2a' });
  const fixed = applyFix(noPsu, f.fix!);
  quiet(fixed, 'R20');
  fires({ board: S3, parts: [CABLE, { partId: 'ws2812-stick8' }] }, 'R20', 'warn');
  quiet({ board: S3, parts: [CABLE, { partId: 'ssd1306' }] }, 'R20');
  // The external supply itself is too small
  fires({ board: S3, parts: [CABLE, { partId: 'ws2812-strip' }, { partId: 'psu-5v2a' }, { partId: 'dc-jack' }] }, 'R20', 'warn', /above the supply 2000 mA/);
});

test('R21 3.3 V regulator load', () => {
  const heavy = (wifi: boolean): RuleInput => ({ board: S3, parts: [CABLE, { partId: 'st7789', qty: 4 }, { partId: 'gc9a01' }], firmware: { wifi } });
  fires(heavy(true), 'R21', 'warn', /Wi-Fi/);
  quiet(heavy(false), 'R21');
});

test('R22 GPIO directly driving a high-current load', () => {
  const f = fires(one(S3, 'buzzer-active', '+', 'GPIO5'), 'R22', 'warn', /transistor/);
  assert.deepEqual(f.fix, { action: 'add', partId: 'npn-s8050' });
  quiet({ board: S3, parts: [CABLE, { partId: 'buzzer-active' }, { partId: 'npn-s8050' }], wiring: [{ part: 'buzzer-active', pin: '+', net: 'GPIO5', via: 'transistor' }] }, 'R22');
  fires({ board: S3, parts: [CABLE, { partId: 'buzzer-passive' }] }, 'R22', 'warn');
  quiet({ board: S3, parts: [CABLE, { partId: 'buzzer-passive' }, { partId: 'npn-s8050' }] }, 'R22');
  quiet(LED(S3, 5), 'R22');
});

test('R23 on-board RGB LED pin vs firmware', () => {
  const f = fires({ board: 's3-devkitc1-v11', parts: [CABLE], firmware: { rgbGpio: 48 } }, 'R23', 'warn', /GPIO38/);
  assert.deepEqual(f.fix, { action: 'swap', partId: 's3-devkitc1-v10', replaces: 's3-devkitc1-v11' });
  quiet({ board: S3, parts: [CABLE], firmware: { rgbGpio: 48 } }, 'R23');
  quiet({ board: 's3-devkitc1-v11', parts: [CABLE] }, 'R23');
  fires({ board: 'xiao-s3', parts: [CABLE], firmware: { rgbGpio: 48 } }, 'R23', 'warn', /no on-board WS2812/);
});

test('R24 clash with on-board devices', () => {
  fires(LED('xiao-s3', 21), 'R24', 'warn', /User LED/);
  fires(LED(C3, 8), 'R24', 'warn', /WS2812/);
  quiet(LED('xiao-s3', 2), 'R24');
  // The BOOT key belongs to the strapping rules, so R24 does not repeat it
  quiet(LED(S3, 0), 'R24');
  // The LuatOS core board has its two LEDs on GPIO10 / 11
  fires(LED('luat-s3', 10), 'R24', 'warn', /LED A/);
  quiet(LED('luat-s3', 4), 'R24');
});

test('R24 Waveshare round display board: owned display lines block, same-role SPI / I2C sharing only warns', () => {
  const WS = 'ws-s3-lcd128';
  // Display reset GPIO12 and backlight GPIO40 reused by an LED -> block
  fires(LED(WS, 12), 'R24', 'block', /On-board round display RST.*owned/);
  fires(LED(WS, 40), 'R24', 'block', /backlight/);
  // The touch version moved reset to GPIO14; GPIO12 is MISO (bus), so an LED as plain IO disrupts it too
  fires(LED('ws-s3-touch-lcd128', 14), 'R24', 'block', /RST/);
  quiet(LED(WS, 14), 'R24');
  // External SPI display SCL on the on-board SCLK: same role, warn about its own CS
  fires(one(WS, 'gc9a01', 'SCL', 'GPIO10'), 'R24', 'warn', /its own CS/);
  // External I2C module on the on-board IMU SDA: address warning; SDA onto SCL: block
  fires(one(WS, 'bme280', 'SDA', 'GPIO6'), 'R24', 'warn', /address/);
  fires(one(WS, 'bme280', 'SDA', 'GPIO7'), 'R24', 'block', /disrupts/);
  // AtomS3: GPIO38 / 39 are the on-board IMU I2C, same-role sharing only warns
  fires(one('m5-atoms3', 'bme280', 'SDA', 'GPIO38'), 'R24', 'warn', /MPU6886/);
  quiet(LED('m5-atoms3', 5), 'R24');
});

test('R25 chip capabilities', () => {
  const f = fires({ board: C3, parts: [CABLE], needs: ['usb_otg'] }, 'R25', 'block', /USB OTG/);
  assert.equal(f.fix?.action, 'swap');
  const swapped = applyFix({ board: C3, parts: [CABLE, { partId: C3 }], needs: ['usb_otg'] }, f.fix!);
  assert.equal(swapped.board, 's3-devkitc1-v11');
  quiet(swapped, 'R25');
  quiet({ board: S3, parts: [CABLE], needs: ['usb_otg'] }, 'R25');
  fires({ board: S3, parts: [CABLE], needs: ['camera'] }, 'R25', 'warn', /camera connector/);
  fires({ board: S3, parts: [CABLE], needs: ['bt_classic'] }, 'R25', 'block', /Classic Bluetooth/);
});

test('R26 metal / battery near the antenna', () => {
  fires({ board: S3, parts: [CABLE], assembly: { metalCase: true } }, 'R26', 'warn', /metal/);
  fires({ board: 'xiao-s3', parts: [CABLE, { partId: 'lipo-1000' }], assembly: { nearAntenna: ['lipo-1000'] } }, 'R26', 'warn', /keep-out/);
  quiet({ board: 'xiao-s3', parts: [CABLE, { partId: 'bme280' }], assembly: { nearAntenna: ['bme280'] } }, 'R26');
  quiet({ board: S3, parts: [CABLE] }, 'R26');
});

test('R27 required parts: template required, servo supply, companions, data cable', () => {
  const inp = templateInput('weather');
  quiet(inp, 'R27');
  const noBme = { ...inp, parts: inp.parts.filter((p) => p.partId !== 'bme280') };
  assert.ok(hits(noBme, 'R27').some((f) => f.fix?.partId === 'bme280' && f.level === 'block'));
  // Servo without external supply -> one-click add supply, then the DC jack
  const servo: RuleInput = { board: S3, parts: [CABLE, { partId: 'sg90' }] };
  const f = hits(servo, 'R27').find((x) => x.fix?.partId === 'psu-5v2a');
  assert.ok(f && /5 V supply/.test(f.detail));
  const step1 = applyFix(servo, f.fix!);
  assert.deepEqual(servo.parts.map((p) => p.partId), ['usb-c-cable', 'sg90'], 'applyFix does not change the original input');
  const g = hits(step1, 'R27');
  assert.deepEqual(g.map((x) => x.fix?.partId), ['dc-jack']);
  quiet(applyFix(step1, g[0].fix!), 'R27');
  // Companion: DS18B20 needs a pull-up resistor
  assert.ok(hits({ board: S3, parts: [CABLE, { partId: 'ds18b20' }] }, 'R27').some((x) => x.fix?.partId === 'resistor-kit'));
  quiet({ board: S3, parts: [CABLE, { partId: 'ds18b20' }, { partId: 'resistor-kit' }] }, 'R27');
  // LiPo: no TP4056 needed when the board has a charger
  assert.ok(hits({ board: S3, parts: [CABLE, { partId: 'lipo-1000' }] }, 'R27').some((x) => x.fix?.partId === 'tp4056'));
  quiet({ board: 'xiao-s3', parts: [CABLE, { partId: 'lipo-1000' }] }, 'R27');
  // A breadboard needs Dupont wires; every project needs a data cable
  assert.ok(hits({ board: S3, parts: [CABLE, { partId: 'breadboard-830' }] }, 'R27').some((x) => x.fix?.partId === 'dupont-mm'));
  assert.ok(hits({ board: S3, parts: [] }, 'R27').some((x) => x.fix?.partId === 'usb-c-cable'));
});

test('R28 strapping pins on the header (XIAO C3 D0 / D8 / D9)', () => {
  const X = 'xiao-c3';
  // A pot wiper has an undefined level at power-up; put it on D0 = GPIO2 / D8 = GPIO8 / D9 = GPIO9
  fires(one(X, 'pot', '2', 'GPIO2'), 'R28', 'warn', /D0\(GPIO2\) looks like a normal pin but is a strapping pin/);
  fires(one(X, 'pot', '2', 'GPIO9'), 'R28', 'warn', /D9\(GPIO9\).*download mode/);
  fires(one(X, 'pot', '2', 'GPIO8'), 'R28', 'warn', /D8/);
  quiet(one(X, 'pot', '2', 'GPIO3'), 'R28');
  // I2C is pulled up and high at power-up, so D8 / D9 do not fire
  quiet(one(X, 'bme280', 'SDA', 'GPIO8', {}, [{ part: 'bme280', pin: 'SCL', net: 'GPIO9' }]), 'R28');
  // Known pull-downs belong to R05 / R06, not repeated here
  const echo = one(X, 'hc-sr04', 'Echo', 'GPIO9', { parts: [{ partId: 'resistor-kit' }] });
  quiet(echo, 'R28');
  fires(echo, 'R05', 'warn');
  // XIAO S3 D0–D10 have no boot-affecting strapping pins (D2 = GPIO3 only matters after the JTAG eFuse)
  quiet(one('xiao-s3', 'pot', '2', 'GPIO3'), 'R28');
  quiet(one('xiao-s3', 'pot', '2', 'GPIO1'), 'R28');
  // S3 GPIO0
  fires(one(S3, 'pot', '2', 'GPIO0'), 'R28', 'warn', /GPIO0 is a strapping pin/);
  quiet(LED('xiao-c3', 2), 'R28');
});

test('R29 board already has a round display yet a GC9A01 is added (one-click remove, template no longer requires it)', () => {
  const inp = { ...templateInput('spin'), board: 'ws-s3-lcd128' };
  const f = fires(inp, 'R29', 'warn', /already has on-board 1\.28″ GC9A01 round display.*RST 12/);
  assert.deepEqual(f.fix, { action: 'remove', partId: 'gc9a01' });
  const fixed = applyFix(inp, f.fix!);
  quiet(fixed, 'R29');
  assert.ok(!hits(fixed, 'R27').some((x) => x.fix?.partId === 'gc9a01'), 'on-board display: R27 no longer asks to buy a GC9A01');
  quiet(templateInput('spin'), 'R29');
  quiet({ board: 'ws-s3-lcd128', parts: [CABLE] }, 'R29');
});

test('R30 firmware needs PSRAM (XIAO C3 / AtomS3 have none)', () => {
  const f = fires({ board: 'xiao-c3', parts: [CABLE], firmware: { psram: true } }, 'R30', 'block', /has none.*ESP32-C3 has no PSRAM interface/);
  assert.equal(f.fix?.action, 'swap');
  fires({ board: 'm5-atoms3', parts: [CABLE], firmware: { psram: true } }, 'R30', 'block', /has no R/);
  fires({ board: 'luat-s3', parts: [CABLE], firmware: { psram: true } }, 'R30', 'warn', /unverified/);
  quiet({ board: 'xiao-s3', parts: [CABLE], firmware: { psram: true } }, 'R30');
  quiet({ board: 'ws-s3-lcd128', parts: [CABLE], firmware: { psram: true } }, 'R30');
  quiet({ board: 'xiao-c3', parts: [CABLE] }, 'R30');
});

test('R31 not enough free GPIOs (AtomS3 has only 8)', () => {
  const many: RuleInput = { board: 'm5-atoms3', parts: [CABLE, { partId: 'gc9a01' }, { partId: 'sg90' }, { partId: 'hc-sr04' }, { partId: 'bme280' }] };
  const f = fires(many, 'R31', 'block', /only 8 free/);
  assert.deepEqual(f.fix, { action: 'swap', partId: 's3-devkitc1-v10', replaces: 'm5-atoms3' });
  quiet({ ...many, board: S3 }, 'R31');
  quiet({ board: 'm5-atoms3', parts: [CABLE, { partId: 'bme280' }, { partId: 'sg90' }] }, 'R31');
  // With wiring, count the GPIOs actually used
  quiet(templateInput('spin'), 'R31');
  // The touch round display board breaks out 6 GPIOs + BOOT (7): Xiaohuang's 7 lines just fit, adding the ultrasonic does not
  quiet({ ...templateInput('spin'), board: 'ws-s3-touch-lcd128' }, 'R31');
  fires({ board: 'ws-s3-touch-lcd128', parts: [CABLE, { partId: 'gc9a01' }, { partId: 'sg90' }, { partId: 'hc-sr04' }] }, 'R31', 'block', /only 7 free/);
  // Boards without a header table are not judged
  quiet({ ...many, board: 'luat-s3' }, 'R31');
});

test('R32 on-board display pins vs firmware (Waveshare round display touch / no-touch)', () => {
  const NT = { sclk: 10, mosi: 11, cs: 9, dc: 8, rst: 12, bl: 40 };
  const f = fires({ board: 'ws-s3-touch-lcd128', parts: [CABLE], firmware: { lcdPins: NT } }, 'R32', 'warn', /RST GPIO12, backlight GPIO40.*RST GPIO14, backlight GPIO2/);
  assert.deepEqual(f.fix, { action: 'swap', partId: 'ws-s3-lcd128', replaces: 'ws-s3-touch-lcd128' });
  quiet({ board: 'ws-s3-lcd128', parts: [CABLE], firmware: { lcdPins: NT } }, 'R32');
  quiet({ board: 'ws-s3-touch-lcd128', parts: [CABLE] }, 'R32');
  quiet({ board: S3, parts: [CABLE], firmware: { lcdPins: NT } }, 'R32');
});

test('board swap: Xiaohuang from DevKitC-1 to XIAO S3 / Waveshare round display, board-specific rules appear', () => {
  const spin = templateInput('spin');
  const ids = (i: RuleInput) => new Set(problems(i).map((f) => f.id));
  assert.ok(!ids(spin).has('R04'));
  const xiao = applyFix(spin, { action: 'swap', partId: 'xiao-s3', replaces: spin.board });
  assert.equal(xiao.board, 'xiao-s3');
  assert.ok(hits(xiao, 'R04').some((f) => /XIAO ESP32S3 does not break GPIO10 out to the header/.test(f.detail)));
  const ws = applyFix(spin, { action: 'swap', partId: 'ws-s3-lcd128', replaces: spin.board });
  assert.ok(ids(ws).has('R29') && ids(ws).has('R24'));
  assert.ok(hits(ws, 'R24').some((f) => f.level === 'block' && /GPIO12/.test(f.detail)), 'external round display RES lands on the on-board display RST');
});

test('applyFix: remove / swap non-board parts', () => {
  const inp: RuleInput = { board: S3, parts: [CABLE, { partId: 'sg90' }] };
  assert.deepEqual(applyFix(inp, { action: 'remove', partId: 'sg90' }).parts.map((p) => p.partId), ['usb-c-cable']);
  assert.deepEqual(applyFix(inp, { action: 'swap', partId: 'mg90s', replaces: 'sg90' }).parts.map((p) => p.partId), ['usb-c-cable', 'mg90s']);
  assert.deepEqual(inp.parts.map((p) => p.partId), ['usb-c-cable', 'sg90']);
});

test('problems: blocks sort before warnings', () => {
  const p = problems({ board: C3, parts: [{ partId: 'sg90' }], needs: ['usb_otg'] });
  const firstWarn = p.findIndex((f) => f.level === 'warn');
  const lastBlock = p.map((f) => f.level).lastIndexOf('block');
  assert.ok(lastBlock >= 0 && firstWarn >= 0 && lastBlock < firstWarn);
});
