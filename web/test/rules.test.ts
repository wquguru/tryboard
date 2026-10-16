// 规则引擎 R01–R27：每条至少一个触发（正）和一个不触发（反）用例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, evaluate, problems, summary, applyFix, type Finding, type RuleInput } from '../src/catalog/rules.ts';
import { templateInput } from '../src/catalog/templates.ts';
import type { Wire } from '../src/catalog/templates.ts';

const C3 = 'c3-devkitm1';
const S3 = 's3-devkitc1-v10';
const CABLE = { partId: 'usb-c-cable' };

/** 一个零件接一根信号线 + 可选的其它线 */
function one(board: string, partId: string, pin: string, net: string, extra: Partial<RuleInput> = {}, more: Wire[] = []): RuleInput {
  return { board, parts: [CABLE, { partId }, ...(extra.parts ?? [])], wiring: [{ part: partId, pin, net }, ...more], ...withoutParts(extra) };
}
const withoutParts = (x: Partial<RuleInput>) => {
  const { parts: _p, ...rest } = x;
  return rest;
};
const LED = (board: string, gpio: number, extra: Partial<RuleInput> = {}) => one(board, 'led-kit', '长脚 +', `GPIO${gpio}`, { parts: [{ partId: 'resistor-kit' }], ...extra });

/** 某条规则触发的结论（level ≠ ok） */
const hits = (input: RuleInput, id: string): Finding[] => evaluate(input).filter((f) => f.id === id && f.level !== 'ok');
function fires(input: RuleInput, id: string, level: 'block' | 'warn', match?: RegExp): Finding {
  const h = hits(input, id);
  assert.ok(h.length > 0, `${id} 应触发；实际：${JSON.stringify(problems(input).map((f) => f.id + ':' + f.detail))}`);
  assert.equal(h[0].level, level, `${id} 级别`);
  if (match) assert.match(h[0].detail, match);
  return h[0];
}
function quiet(input: RuleInput, id: string) {
  assert.deepEqual(hits(input, id), [], `${id} 不应触发`);
}

test('规则表：27 条，id 连续，每条有标题和来源', () => {
  assert.equal(RULES.length, 27);
  RULES.forEach((r, i) => {
    assert.equal(r.id, 'R' + String(i + 1).padStart(2, '0'));
    assert.ok(r.title.length > 0 && r.source.length > 0, r.id);
  });
});

test('evaluate：每条规则都有结论，结果确定', () => {
  const inp = templateInput('weather');
  const a = evaluate(inp);
  assert.deepEqual([...new Set(a.map((f) => f.id))], RULES.map((r) => r.id));
  assert.deepEqual(evaluate(templateInput('weather')), a);
  const s = summary(a);
  assert.equal(s.block + s.warn + s.ok, a.length);
});

test('evaluate：不是开发板时报错', () => {
  assert.throws(() => evaluate({ board: 'bme280', parts: [] }));
});

test('R01 C3 flash 脚', () => {
  fires(LED(C3, 12), 'R01', 'block', /flash/);
  quiet(LED(C3, 4), 'R01');
  quiet(LED(S3, 12), 'R01');
});

test('R02 S3 flash / PSRAM SPI 脚', () => {
  fires(LED(S3, 27), 'R02', 'block');
  quiet(LED(S3, 4), 'R02');
});

test('R03 八线 PSRAM 占 GPIO33–37', () => {
  fires(LED(S3, 35), 'R03', 'block', /八线/);
  fires(LED('luat-s3', 35), 'R03', 'warn', /待核/);
  quiet(LED(S3, 4), 'R03');
});

test('R04 不存在 / 没引出的 GPIO', () => {
  fires(LED(S3, 23), 'R04', 'block', /22–25/);
  fires(LED('xiao-s3', 10), 'R04', 'block', /没有把 GPIO10 引到排针/);
  quiet(LED(S3, 4), 'R04');
});

test('R05 BOOT 脚上电被拉低', () => {
  fires(one(S3, 'hc-sr04', 'Echo', 'GPIO0', { parts: [{ partId: 'resistor-kit' }] }), 'R05', 'warn', /下载模式/);
  fires(one(C3, 'hc-sr04', 'Echo', 'GPIO9', { parts: [{ partId: 'resistor-kit' }] }), 'R05', 'warn');
  quiet(one(S3, 'hc-sr04', 'Echo', 'GPIO5', { parts: [{ partId: 'resistor-kit' }] }), 'R05');
  quiet(LED(S3, 0), 'R05');
});

test('R06 C3 GPIO8 / 2 上电应为高', () => {
  fires(one(C3, 'hc-sr04', 'Echo', 'GPIO8'), 'R06', 'warn');
  fires(one(C3, 'hc-sr04', 'Echo', 'GPIO2'), 'R06', 'warn');
  quiet(one(C3, 'hc-sr04', 'Echo', 'GPIO4'), 'R06');
  quiet(one(S3, 'hc-sr04', 'Echo', 'GPIO8'), 'R06');
});

test('R07 S3 GPIO45 上电为高', () => {
  fires(one(S3, 'dht22', 'OUT', 'GPIO45'), 'R07', 'block', /1\.8 V/);
  quiet(one(S3, 'dht22', 'OUT', 'GPIO4'), 'R07');
  quiet(one(S3, 'hc-sr04', 'Echo', 'GPIO45'), 'R07');
});

test('R08 S3 GPIO46 上电为高', () => {
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

test('R11 C3 模拟量只能放 ADC1', () => {
  fires(one(C3, 'pot', '2', 'GPIO5'), 'R11', 'block', /勘误.*与 Wi-Fi 无关/);
  fires(one(C3, 'pot', '2', 'GPIO6'), 'R11', 'block', /不是模拟输入/);
  quiet(one(C3, 'pot', '2', 'GPIO3'), 'R11');
  quiet(one(S3, 'pot', '2', 'GPIO5'), 'R11');
});

test('R12 S3 开 Wi-Fi 时 ADC2', () => {
  fires(one(S3, 'pot', '2', 'GPIO11', { firmware: { wifi: true } }), 'R12', 'warn', /ESP_ERR_TIMEOUT/);
  quiet(one(S3, 'pot', '2', 'GPIO11', { firmware: { wifi: false } }), 'R12');
  quiet(one(S3, 'pot', '2', 'GPIO5', { firmware: { wifi: true } }), 'R12');
  fires(one(S3, 'pot', '2', 'GPIO21'), 'R12', 'block', /不是模拟输入/);
});

test('R13 C3 GPIO11 是 VDD_SPI', () => {
  fires(LED(C3, 11), 'R13', 'warn', /eFuse/);
  quiet(LED(C3, 10), 'R13');
});

test('R14 片上资源：RMT / LEDC / I2C', () => {
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
  // 没接线：按数量算 PWM
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

test('R15 I2C 地址冲突 / 地址不支持', () => {
  fires({ board: S3, parts: [CABLE, { partId: 'mpu6050' }, { partId: 'ds3231' }] }, 'R15', 'block', /0x68/);
  quiet({ board: S3, parts: [CABLE, { partId: 'mpu6050', addr: 0x69 }, { partId: 'ds3231' }] }, 'R15');
  fires({ board: S3, parts: [CABLE, { partId: 'ssd1306', addr: 0x50 }] }, 'R15', 'block', /不支持地址/);
  // 两块 OLED 分在两条总线上不冲突
  const split: RuleInput = {
    board: S3,
    parts: [CABLE, { partId: 'ssd1306', key: 'o1' }, { partId: 'ssd1306', key: 'o2' }],
    wiring: [
      { part: 'o1', pin: 'SDA', net: 'GPIO8' },
      { part: 'o2', pin: 'SDA', net: 'GPIO1' },
    ],
  };
  quiet(split, 'R15');
  fires({ board: S3, parts: [CABLE, { partId: 'ssd1306', qty: 2 }] }, 'R15', 'block', /第二条 I2C/);
});

test('R16 并联上拉过小', () => {
  const five = ['bme280', 'aht20', 'ina219', 'mpu6050', 'ssd1306'].map((partId) => ({ partId }));
  fires({ board: S3, parts: [CABLE, ...five] }, 'R16', 'warn', /灌/);
  quiet({ board: S3, parts: [CABLE, ...five.slice(0, 2)] }, 'R16');
});

test('R17 5 V 信号直接进 GPIO', () => {
  const f = fires(one(S3, 'hc-sr04', 'Echo', 'GPIO5'), 'R17', 'block', /不耐 5 V/);
  assert.deepEqual(f.fix, { action: 'add', partId: 'resistor-kit' });
  const viaDivider: RuleInput = { board: S3, parts: [CABLE, { partId: 'hc-sr04' }, { partId: 'resistor-kit' }], wiring: [{ part: 'hc-sr04', pin: 'Echo', net: 'GPIO5', via: 'divider' }] };
  quiet(viaDivider, 'R17');
  // 没接线：没买分压电阻要报，买了就放行
  fires({ board: S3, parts: [CABLE, { partId: 'hc-sr04' }] }, 'R17', 'block');
  quiet({ board: S3, parts: [CABLE, { partId: 'hc-sr04' }, { partId: 'resistor-kit' }] }, 'R17');
  // I2C 模块接 5 V：建议电平转换
  const aht5v: RuleInput = { board: S3, parts: [CABLE, { partId: 'aht20' }], wiring: [{ part: 'aht20', pin: 'VCC', net: '5V' }, { part: 'aht20', pin: 'SDA', net: 'GPIO8' }] };
  assert.deepEqual(fires(aht5v, 'R17', 'block').fix, { action: 'add', partId: 'level-bss138' });
  quiet({ ...aht5v, wiring: [{ part: 'aht20', pin: 'VCC', net: '3V3' }, { part: 'aht20', pin: 'SDA', net: 'GPIO8' }] }, 'R17');
  // 电平转换模块本身（passive）不触发
  quiet({ board: S3, parts: [CABLE, { partId: 'level-bss138' }] }, 'R17');
});

test('R18 5 V WS2812 用 3.3 V 数据线', () => {
  const base = (via?: Wire['via']): RuleInput => ({
    board: S3,
    parts: [CABLE, { partId: 'ws2812-strip' }, { partId: 'psu-5v2a' }, { partId: 'dc-jack' }],
    wiring: [{ part: 'ws2812-strip', pin: 'DIN', net: 'GPIO5', via }],
  });
  assert.deepEqual(fires(base(), 'R18', 'warn', /74AHCT125/).fix, { action: 'add', partId: 'level-ahct125' });
  quiet(base('level-shifter'), 'R18');
  // 灯条接 3V3 供电：门限 2.3 V，3.3 V 数据没问题
  quiet({ board: S3, parts: [CABLE, { partId: 'ws2812-stick8' }], wiring: [{ part: 'ws2812-stick8', pin: '5V', net: '3V3' }, { part: 'ws2812-stick8', pin: 'DIN', net: 'GPIO5' }] }, 'R18');
});

test('R19 供电电压超出范围', () => {
  const servo = (net: string): RuleInput => ({
    board: S3,
    parts: [CABLE, { partId: 'sg90' }, { partId: 'psu-5v2a' }, { partId: 'dc-jack' }],
    wiring: [{ part: 'sg90', pin: '红 VCC', net }, { part: 'sg90', pin: '橙 PWM', net: 'GPIO4' }],
  });
  fires(servo('3V3'), 'R19', 'block', /4\.8–6 V/);
  quiet(servo('EXT5V'), 'R19');
  fires({ board: S3, parts: [CABLE, { partId: 'bme280' }], wiring: [{ part: 'bme280', pin: 'VCC', net: '5V' }] }, 'R19', 'block', /会损坏/);
  quiet({ board: S3, parts: [CABLE, { partId: 'bme280' }], wiring: [{ part: 'bme280', pin: 'VCC', net: '3V3' }] }, 'R19');
});

test('R20 只靠 USB 峰值超 500 mA（舵机无外接电源，可一键补）', () => {
  const noPsu: RuleInput = { board: S3, parts: [CABLE, { partId: 'sg90' }] };
  const f = fires(noPsu, 'R20', 'warn', /500 mA/);
  assert.deepEqual(f.fix, { action: 'add', partId: 'psu-5v2a' });
  const fixed = applyFix(noPsu, f.fix!);
  quiet(fixed, 'R20');
  fires({ board: S3, parts: [CABLE, { partId: 'ws2812-stick8' }] }, 'R20', 'warn');
  quiet({ board: S3, parts: [CABLE, { partId: 'ssd1306' }] }, 'R20');
  // 外接电源本身不够
  fires({ board: S3, parts: [CABLE, { partId: 'ws2812-strip' }, { partId: 'psu-5v2a' }, { partId: 'dc-jack' }] }, 'R20', 'warn', /超过电源 2000 mA/);
});

test('R21 3.3 V 稳压器负载', () => {
  const heavy = (wifi: boolean): RuleInput => ({ board: S3, parts: [CABLE, { partId: 'st7789', qty: 4 }, { partId: 'gc9a01' }], firmware: { wifi } });
  fires(heavy(true), 'R21', 'warn', /Wi-Fi/);
  quiet(heavy(false), 'R21');
});

test('R22 GPIO 直驱大电流负载', () => {
  const f = fires(one(S3, 'buzzer-active', '+', 'GPIO5'), 'R22', 'warn', /三极管/);
  assert.deepEqual(f.fix, { action: 'add', partId: 'npn-s8050' });
  quiet({ board: S3, parts: [CABLE, { partId: 'buzzer-active' }, { partId: 'npn-s8050' }], wiring: [{ part: 'buzzer-active', pin: '+', net: 'GPIO5', via: 'transistor' }] }, 'R22');
  fires({ board: S3, parts: [CABLE, { partId: 'buzzer-passive' }] }, 'R22', 'warn');
  quiet({ board: S3, parts: [CABLE, { partId: 'buzzer-passive' }, { partId: 'npn-s8050' }] }, 'R22');
  quiet(LED(S3, 5), 'R22');
});

test('R23 板载彩灯引脚与固件', () => {
  const f = fires({ board: 's3-devkitc1-v11', parts: [CABLE], firmware: { rgbGpio: 48 } }, 'R23', 'warn', /GPIO38/);
  assert.deepEqual(f.fix, { action: 'swap', partId: 's3-devkitc1-v10', replaces: 's3-devkitc1-v11' });
  quiet({ board: S3, parts: [CABLE], firmware: { rgbGpio: 48 } }, 'R23');
  quiet({ board: 's3-devkitc1-v11', parts: [CABLE] }, 'R23');
  fires({ board: 'xiao-s3', parts: [CABLE], firmware: { rgbGpio: 48 } }, 'R23', 'warn', /没有板载 WS2812/);
});

test('R24 与板载外设重复', () => {
  fires(LED('xiao-s3', 21), 'R24', 'warn', /用户 LED/);
  fires(LED(C3, 8), 'R24', 'warn', /WS2812/);
  quiet(LED('xiao-s3', 2), 'R24');
  // BOOT 键交给 strapping 规则，不在 R24 重复报
  quiet(LED(S3, 0), 'R24');
});

test('R25 芯片能力', () => {
  const f = fires({ board: C3, parts: [CABLE], needs: ['usb_otg'] }, 'R25', 'block', /USB OTG/);
  assert.equal(f.fix?.action, 'swap');
  const swapped = applyFix({ board: C3, parts: [CABLE, { partId: C3 }], needs: ['usb_otg'] }, f.fix!);
  assert.equal(swapped.board, 's3-devkitc1-v11');
  quiet(swapped, 'R25');
  quiet({ board: S3, parts: [CABLE], needs: ['usb_otg'] }, 'R25');
  fires({ board: S3, parts: [CABLE], needs: ['camera'] }, 'R25', 'warn', /摄像头排座/);
  fires({ board: S3, parts: [CABLE], needs: ['bt_classic'] }, 'R25', 'block', /经典蓝牙/);
});

test('R26 天线附近有金属 / 电池', () => {
  fires({ board: S3, parts: [CABLE], assembly: { metalCase: true } }, 'R26', 'warn', /金属/);
  fires({ board: 'xiao-s3', parts: [CABLE, { partId: 'lipo-1000' }], assembly: { nearAntenna: ['lipo-1000'] } }, 'R26', 'warn', /净空区/);
  quiet({ board: 'xiao-s3', parts: [CABLE, { partId: 'bme280' }], assembly: { nearAntenna: ['bme280'] } }, 'R26');
  quiet({ board: S3, parts: [CABLE] }, 'R26');
});

test('R27 必选件：模版必选、舵机电源、配套件、数据线', () => {
  const inp = templateInput('weather');
  quiet(inp, 'R27');
  const noBme = { ...inp, parts: inp.parts.filter((p) => p.partId !== 'bme280') };
  assert.ok(hits(noBme, 'R27').some((f) => f.fix?.partId === 'bme280' && f.level === 'block'));
  // 舵机无外接电源 → 一键补电源，再补 DC 母座
  const servo: RuleInput = { board: S3, parts: [CABLE, { partId: 'sg90' }] };
  const f = hits(servo, 'R27').find((x) => x.fix?.partId === 'psu-5v2a');
  assert.ok(f && /5 V 电源/.test(f.detail));
  const step1 = applyFix(servo, f.fix!);
  assert.deepEqual(servo.parts.map((p) => p.partId), ['usb-c-cable', 'sg90'], 'applyFix 不改原输入');
  const g = hits(step1, 'R27');
  assert.deepEqual(g.map((x) => x.fix?.partId), ['dc-jack']);
  quiet(applyFix(step1, g[0].fix!), 'R27');
  // 配套件：DS18B20 要上拉电阻
  assert.ok(hits({ board: S3, parts: [CABLE, { partId: 'ds18b20' }] }, 'R27').some((x) => x.fix?.partId === 'resistor-kit'));
  quiet({ board: S3, parts: [CABLE, { partId: 'ds18b20' }, { partId: 'resistor-kit' }] }, 'R27');
  // 锂电：板上有充电就不用 TP4056
  assert.ok(hits({ board: S3, parts: [CABLE, { partId: 'lipo-1000' }] }, 'R27').some((x) => x.fix?.partId === 'tp4056'));
  quiet({ board: 'xiao-s3', parts: [CABLE, { partId: 'lipo-1000' }] }, 'R27');
  // 面包板要杜邦线；任何作品要数据线
  assert.ok(hits({ board: S3, parts: [CABLE, { partId: 'breadboard-830' }] }, 'R27').some((x) => x.fix?.partId === 'dupont-mm'));
  assert.ok(hits({ board: S3, parts: [] }, 'R27').some((x) => x.fix?.partId === 'usb-c-cable'));
});

test('applyFix：remove / swap 非板件', () => {
  const inp: RuleInput = { board: S3, parts: [CABLE, { partId: 'sg90' }] };
  assert.deepEqual(applyFix(inp, { action: 'remove', partId: 'sg90' }).parts.map((p) => p.partId), ['usb-c-cable']);
  assert.deepEqual(applyFix(inp, { action: 'swap', partId: 'mg90s', replaces: 'sg90' }).parts.map((p) => p.partId), ['usb-c-cable', 'mg90s']);
  assert.deepEqual(inp.parts.map((p) => p.partId), ['usb-c-cable', 'sg90']);
});

test('problems：阻断排在警告前', () => {
  const p = problems({ board: C3, parts: [{ partId: 'sg90' }], needs: ['usb_otg'] });
  const firstWarn = p.findIndex((f) => f.level === 'warn');
  const lastBlock = p.map((f) => f.level).lastIndexOf('block');
  assert.ok(lastBlock >= 0 && firstWarn >= 0 && lastBlock < firstWarn);
});
