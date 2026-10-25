// Builders that place each add-on part and its wires on the bench.

import * as THREE from 'three';
import { t } from '../i18n';
import { PITCH, WIRE, MAT, contactShadow, pinHits } from './util';
import { apiId, LCD_WIRING, BB, rowZ } from './boards';
import { TP_PINS, roundLcdModule, imuModule, servoModel, buzzerModule, encoderModule, stickModule, dht11Module, sonarModule, obstacleModel, ampModule, speakerModel, micModule, keySwitch, potModel, led, resistor } from './modules';
import { wire } from './wires';
import type { PartSpec } from './spec';
import { LED_HEX, LED_OHM_DEFAULT, ledBright, ledColor, ohmText } from './ledparams';
import type { BenchCtx } from './ctx';
import { I2S_WIRING, micPins, spkPins } from '../i2spins.ts';
import { TFT_HEADER } from '../lcdspec.ts';
import type { tftModule } from './tft3d';

/** Part builders: LED, round LCD, IMU, I2C modules, servo, pot, key, buzzer. */
export function mountBuildersA(ctx: BenchCtx): void {
  const { BB_TOP, useSlot, colX, pinCands, boardHole, lift, top, addRole, addWire, jumper, registerPart, registerModulePins, tl, label } = ctx;
  ctx.buildLed = buildLed;
  ctx.buildSpiLcd = buildSpiLcd;
  ctx.buildSpiTft = buildSpiTft;
  ctx.buildImu = buildImu;
  ctx.buildI2c = buildI2c;
  ctx.buildServo = buildServo;
  ctx.buildPot = buildPot;
  ctx.buildKey = buildKey;
  ctx.buildBuzzer = buildBuzzer;
  function buildLed(grp: THREE.Group, p: Extract<PartSpec, { type: 'led' }>) {
    const root = new THREE.Group();
    const id = `led:${p.pin}`;
    registerPart(id, root);
    grp.add(root);
    const l = led(p.color ?? LED_HEX.red);
    const ohm = p.ohm ?? LED_OHM_DEFAULT;
    const col = p.col ?? 24;
    l.grp.position.set(colX(col) + 1.27, BB_TOP + 2, rowZ(7));
    root.add(l.grp);
    l.grp.name = 'led';
    const r = resistor(ohm);
    r.name = 'res';
    r.position.set(colX(col - 2), BB_TOP + 1.5, rowZ(7));
    root.add(r);
    // IO → column of the resistor's left end; LED cathode → GND
    jumper(grp, 'IO' + p.pin, new THREE.Vector3(colX(col - 4), top, rowZ(9)), WIRE.sig, `${id}:IN`, 30, 6);
    jumper(grp, 'GND', new THREE.Vector3(colX(col + 1), top, rowZ(9)), WIRE.gnd, `${id}:GND`, 24, 10);
    addRole(apiId('IO' + p.pin), t('LED ({ohm} Ω current limit)', { ohm: ohmText(ohm) }));
    addRole('GND', t('{name} GND', { name: 'LED' }));
    label(grp, tl(p.label) ?? `GPIO${p.pin} → ${ohmText(ohm)}Ω → LED`, new THREE.Vector3(colX(col - 1), 34, rowZ(2) - 6));
    ctx.leds.push({ pin: p.pin, lens: l.lens, light: l.light, now: 0, target: 0, bright: ledBright(ohm, ledColor(p.color)) });
  }

  /** Jumper to an upright module: rise over the board, then drop into row a of the same column behind the module so the screen stays clear */
  const moduleWire = (grp: THREE.Group, pin: string, hole: THREE.Vector3, color: number, other: string, peak: number, i: number) => {
    const a = boardHole(pin, hole);
    addWire(
      grp,
      [a, lift(a, 22 + i), new THREE.Vector3((a.x + hole.x) / 2, peak, Math.min(a.z, hole.z) - 6 - i * 1.5), new THREE.Vector3(hole.x, peak - 4, hole.z - 4), lift(hole, top + 15), hole],
      color,
      pin,
      other,
    );
  };

  /** Round LCD: 8 wires (GND VCC SCL SDA RES DC CS BLK); SCL/SDA here are SPI SCLK/MOSI */
  function buildSpiLcd(grp: THREE.Group, m: ReturnType<typeof roundLcdModule>, firstCol: number, tp?: Extract<PartSpec, { type: 'cst816s' }>) {
    m.grp.position.set(colX(firstCol + (m.labels.length - 1) / 2), BB_TOP, rowZ(4));
    m.grp.rotation.x = -0.12;
    registerPart('gc9a01', m.grp);
    registerModulePins('gc9a01', m.grp, m.pins.slice(0, 8), m.labels.slice(0, 8));
    grp.add(m.grp);
    // Pins match the core's wiring: S3 esp32s3::lcd_pin, C3 esp32c3::lcd_pin (same as firmware/common/round_lcd.h)
    const p = LCD_WIRING[ctx.board.spec.chip];
    const order: [string, number, string][] = [
      ['GND', WIRE.gnd, t('{name} GND', { name: 'LCD' })],
      ['3V3', WIRE.vcc, t('{name} power', { name: 'LCD' })],
      [`IO${p.sclk}`, WIRE.scl, 'SPI SCLK'],
      [`IO${p.mosi}`, WIRE.sda, 'SPI MOSI'],
      [`IO${p.rst}`, WIRE.sig, 'LCD RST'],
      [`IO${p.dc}`, 0x8f5bd6, 'LCD DC'],
      [`IO${p.cs}`, 0x3f8fd6, 'LCD CS'],
      [`IO${p.bl}`, 0xd6d6d6, t('LCD backlight')],
    ];
    order.forEach(([pinName, color, role], i) => {
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), color, `gc9a01:${m.labels[i]}`, 50 + i * 1.4, i);
      addRole(apiId(pinName), role);
    });
    if (!tp || !m.tp) return;
    // Touch layer's 4 pins: CST816S on I2C, INT pulled low while touched, RST driven by firmware
    registerPart('cst816s', m.tp);
    registerModulePins('cst816s', m.grp, m.pins.slice(8), TP_PINS);
    const tpw: [string, number, string][] = [
      [`IO${tp.sda}`, WIRE.sda, t('Touch I2C SDA')],
      [`IO${tp.scl}`, WIRE.scl, t('Touch I2C SCL')],
      [`IO${tp.int}`, 0x2fb8a8, t('Touch INT')],
      [tp.rst !== undefined ? `IO${tp.rst}` : '3V3', tp.rst !== undefined ? 0xa0a4aa : WIRE.vcc, tp.rst !== undefined ? t('Touch RST') : t('Touch RST (tied to 3V3)')],
    ];
    tpw.forEach(([pinName, color, role], k) => {
      const i = 8 + k;
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), color, `cst816s:${TP_PINS[k]}`, 50 + i * 1.4, i);
      addRole(apiId(pinName), role);
    });
  }

  /** Rectangular TFT (F-04a2): one wire per header pin in silkscreen order, SDO left open; pins come from the spec (= LCD_WIRING) */
  function buildSpiTft(grp: THREE.Group, m: ReturnType<typeof tftModule>, firstCol: number, p: Extract<PartSpec, { type: 'tft' }>) {
    m.grp.position.set(colX(firstCol + (m.labels.length - 1) / 2), BB_TOP, rowZ(4));
    m.grp.rotation.x = -0.12;
    registerPart('tft', m.grp);
    registerModulePins('tft', m.grp, m.pins, m.labels);
    grp.add(m.grp);
    const color = { sclk: WIRE.scl, mosi: WIRE.sda, rst: WIRE.sig, dc: 0x8f5bd6, cs: 0x3f8fd6, bl: 0xd6d6d6 } as const;
    const role = { sclk: 'SPI SCLK', mosi: 'SPI MOSI', rst: 'LCD RST', dc: 'LCD DC', cs: 'LCD CS', bl: t('LCD backlight') } as const;
    TFT_HEADER[p.panel].forEach(([label, r], i) => {
      if (r === 'miso') return;
      const [pinName, c, text] = r === 'gnd' ? ['GND', WIRE.gnd, t('{name} GND', { name: 'LCD' })] : r === 'vcc' ? ['3V3', WIRE.vcc, t('{name} power', { name: 'LCD' })] : [`IO${p[r]}`, color[r], role[r]];
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), c, `tft:${label}`, 50 + i * 1.4, i);
      addRole(apiId(pinName), text);
    });
  }

  /** Flat IMU: pins in row f (outer half), jumpers arch over from the board pins and land in row j of the same column */
  function buildImu(grp: THREE.Group, p: Extract<PartSpec, { type: 'mpu6050' | 'qmi8658' }>, firstCol: number) {
    const m = imuModule(p.type);
    const n = m.labels.length;
    m.grp.position.set(colX(firstCol + (n - 1) / 2), BB_TOP, rowZ(5));
    registerPart(p.type, m.grp);
    registerModulePins(p.type, m.grp, m.pins, m.labels);
    grp.add(m.grp);
    const name = p.type === 'mpu6050' ? 'MPU6050' : 'QMI8658';
    const int = 'int' in p ? p.int : undefined;
    const map: Record<string, [string, number, string] | undefined> = {
      VCC: ['3V3', WIRE.vcc, t('{name} power', { name })],
      VIN: ['3V3', WIRE.vcc, t('{name} power', { name })],
      GND: ['GND', WIRE.gnd, t('{name} GND', { name })],
      SCL: ['IO' + p.scl, WIRE.scl, 'I2C SCL'],
      SDA: ['IO' + p.sda, WIRE.sda, 'I2C SDA'],
      INT: int !== undefined ? ['IO' + int, 0x2fb8a8, `${name} INT`] : undefined,
    };
    m.labels.forEach((fn, i) => {
      const w = map[fn];
      if (!w) return;
      jumper(grp, w[0], new THREE.Vector3(colX(firstCol + i), top, rowZ(9)), w[1], `${p.type}:${fn}`, 20 + i * 1.5, 4 + i);
      addRole(apiId(w[0]), w[2]);
    });
  }

  function buildI2c(grp: THREE.Group, partId: string, name: string, m: { grp: THREE.Group; pins: THREE.Vector3[]; labels: string[] }, firstCol: number, sda: number, scl: number, height: number) {
    m.grp.position.set(colX(firstCol + 1.5), BB_TOP, rowZ(4));
    m.grp.rotation.x = -0.12; // tilted back slightly for a top-down view
    registerPart(partId, m.grp);
    registerModulePins(partId, m.grp, m.pins, m.labels);
    grp.add(m.grp);
    m.labels.forEach((fn, i) => {
      const map: Record<string, [string, number, string]> = {
        GND: ['GND', WIRE.gnd, t('{name} GND', { name })],
        VCC: ['3V3', WIRE.vcc, t('{name} power', { name })],
        VIN: ['3V3', WIRE.vcc, t('{name} power', { name })],
        SDA: ['IO' + sda, WIRE.sda, 'I2C SDA'],
        SCL: ['IO' + scl, WIRE.scl, 'I2C SCL'],
      };
      const [pinName, color, role] = map[fn];
      moduleWire(grp, pinName, new THREE.Vector3(colX(firstCol + i), top, rowZ(0)), color, `${partId}:${fn}`, height + 6 + i * 1.6, i);
      addRole(apiId(pinName), role);
    });
  }

  function buildServo(grp: THREE.Group, p: Extract<PartSpec, { type: 'servo' }>) {
    // Servo sits on the desk outside the breadboard: its own brown/red/orange lead → 3P female header on the desk → three Dupont wires to the board
    const root = new THREE.Group();
    registerPart('servo', root);
    grp.add(root);
    const m = servoModel();
    root.add(m.grp);
    useSlot(m.ext);
    // Placed straight in front, between the signal pin and 5V: short wires that don't arch over the board (BOOT key) or the BME280
    const sigX = pinCands('IO' + p.pin)[0].p.x;
    const v5X = pinCands('5V')[0].p.x;
    const sx = (sigX + v5X) / 2 + 8, sz = rowZ(9) + 44;
    m.grp.position.set(sx, 0, sz);
    m.grp.rotation.y = Math.PI;
    // 3P female header: black plastic, opening up
    const plug = new THREE.Vector3(sx - 8, 0, rowZ(9) + 26);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(7.6, 12, 2.6), MAT.plug);
    housing.position.set(plug.x + PITCH, 6, plug.z);
    housing.castShadow = true;
    root.add(housing);
    // Servo lead: three wires side by side, out of the case side, along the desk to the header bottom
    [0x6b4423, 0xd33a2c, 0xf28c28].forEach((c, i) => {
      const dz = (i - 1) * 1.0;
      const pts = [
        new THREE.Vector3(sx + 10, 4, sz + dz * 0.2),
        new THREE.Vector3(sx + 14, 1, sz - 4 + dz),
        new THREE.Vector3(plug.x + 14, 0.6, plug.z + 8 + dz),
        new THREE.Vector3(plug.x + PITCH * (2 - i) + 0.0, 0.6, plug.z + 4),
        new THREE.Vector3(plug.x + PITCH * (2 - i), 0.6, plug.z + 1.3),
      ];
      const t = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.5, 8), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));
      t.castShadow = true;
      root.add(t);
    });
    const pinLocal = [0, 1, 2].map((i) => new THREE.Vector3(plug.x + PITCH * (2 - i), 12, plug.z));
    // Header holes: GND (brown), VCC (red), PWM (orange)
    const labels = ['GND', 'VCC', 'PWM'];
    const recs = labels.map((l, i) => ({ id: `servo:${l}`, label: l, anchor: pinLocal[i].clone(), parent: root }));
    pinHits(root, recs, pinLocal.map((v) => v.clone().setY(9)), [2.4, 7, 3.2], ctx.modulePins);
    const cols: [string, number, string, string][] = [
      ['IO' + p.pin, WIRE.sig, 'PWM', t('SG90 signal')],
      ['5V', WIRE.vcc, 'VCC', t('{name} power', { name: 'SG90' })],
      ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'SG90' })],
    ];
    cols.forEach(([pin, color, end, role], i) => {
      const b = pinLocal[labels.indexOf(end)].clone();
      const a = boardHole(pin, b);
      // Rise just above neighbouring plugs (breadboard + 11 mm), then arch low toward the servo: a high arch hides BOOT and BME280 from the default camera
      addWire(grp, [a, lift(a, top + 13 + i), new THREE.Vector3((a.x + b.x) / 2, top + 15 + i * 2, (a.z + b.z) / 2 + 8), lift(b, 20), b], color, pin, `servo:${end}`);
      addRole(apiId(pin), role);
    });
    label(grp, tl(p.label) ?? t('SG90 servo · signal IO{pin} · 50 Hz', { pin: p.pin }), new THREE.Vector3(sx, 38, sz + 12));
    ctx.servos.push({ pin: p.pin, horn: m.horn, freq: p.freq ?? 50, angle: 90, target: 90 });
  }

  function buildPot(grp: THREE.Group, p: Extract<PartSpec, { type: 'pot' }>) {
    const m = potModel();
    const col = 19;
    m.grp.position.set(colX(col), BB_TOP + 1, rowZ(8));
    registerPart('pot', m.grp);
    grp.add(m.grp);
    // Left end → 3V3, wiper → IO, right end → GND (taken from row j of the same column)
    const ends: [number, string, number, string, string][] = [
      [col - 1, '3V3', WIRE.vcc, 'VCC', t('Potentiometer power')],
      [col, 'IO' + p.pin, WIRE.sig, 'OUT', t('Potentiometer wiper (ADC)')],
      [col + 1, 'GND', WIRE.gnd, 'GND', t('Potentiometer GND')],
    ];
    for (const [c, pin, color, end, role] of ends) {
      jumper(grp, pin, new THREE.Vector3(colX(c), top, rowZ(9)), color, `pot:${end}`, 20 + (c - col) * 2, 6);
      addRole(apiId(pin), role);
    }
    label(grp, tl(p.label) ?? t('Potentiometer · wiper on IO{pin} (ADC) · drag the knob', { pin: p.pin }), new THREE.Vector3(colX(col), 36, rowZ(9) + 6));
    ctx.pots.push({ pin: p.pin, knob: m.knob, hit: m.hit, v: 0.36 });
    m.knob.rotation.y = -(0.36 - 0.5) * 1.5 * Math.PI;
  }

  function buildKey(grp: THREE.Group, p: Extract<PartSpec, { type: 'key' }>, col: number) {
    const id = `key:${p.pin}`;
    const m = keySwitch(p.cap ?? String(ctx.keys.length + 1));
    // Spans the centre groove: four legs in rows e / f
    m.grp.position.set(colX(col) + 1.27, BB_TOP, 0);
    registerPart(id, m.grp);
    grp.add(m.grp);
    // Both wires enter from the back rows (a / b) so they don't block the keycap
    jumper(grp, 'IO' + p.pin, new THREE.Vector3(colX(col), top, rowZ(1)), WIRE.sig, `${id}:IN`, 24, -4);
    jumper(grp, 'GND', new THREE.Vector3(colX(col + 1), top, rowZ(0)), WIRE.gnd, `${id}:GND`, 16, -8);
    addRole(apiId('IO' + p.pin), t('Key {cap} (press = GND, internal pull-up)', { cap: p.cap ?? '' }));
    addRole('GND', t('Key GND'));
    if (p.label) label(grp, t(p.label), new THREE.Vector3(colX(col) + 1.27, 9, rowZ(9) + 13));
    m.key.userData.keyPin = p.pin;
    ctx.keys.push({ pin: p.pin, key: m.key });
  }

  function buildBuzzer(grp: THREE.Group, p: Extract<PartSpec, { type: 'buzzer' }>) {
    // Module lies on the desk in front of the breadboard near the I/O pin; three Dupont wires (female on the module header) to board 3V3 / GPIO / GND
    const root = new THREE.Group();
    registerPart('buzzer', root);
    grp.add(root);
    const m = buzzerModule();
    const sig = pinCands('IO' + p.pin)[0].p;
    const bx = sig.x - 18, bz = Math.sign(sig.z || 1) * (BB.D / 2 + 15);
    m.grp.position.set(bx, 0, bz);
    // Header faces the board
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    useSlot(m.ext);
    // Contact shadow is not parented to the pickable part: the selection outline would trace the shadow card's big box too
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    m.grp.updateMatrixWorld(true);
    const local = m.plugAt.map((v) => v.clone());
    // Pin pick boxes wrap the Dupont plugs (flat module, so the header sits higher than on upright modules)
    const recs = m.labels.map((l, i) => ({ id: `buzzer:${l}`, label: l, anchor: local[i].clone(), parent: m.grp }));
    pinHits(m.grp, recs, local.map((v) => v.clone().setY(v.y + 4)), [2.4, 9, 2.8], ctx.modulePins);
    const ends: [string, number, string, string][] = [
      ['3V3', WIRE.vcc, 'VCC', t('Buzzer module power')],
      ['IO' + p.pin, WIRE.sig, 'I/O', t('Buzzer (LEDC square wave)')],
      ['GND', WIRE.gnd, 'GND', t('Buzzer module GND')],
    ];
    ends.forEach(([pin, color, end, role], i) => {
      const b = local[m.labels.indexOf(end)].clone().applyMatrix4(m.grp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 12 + i * 1.5;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 2, (a.z + b.z) / 2 + Math.sign(bz) * 4), lift(b, h - 2), b], color, pin, `buzzer:${end}`);
      addRole(apiId(pin), role);
    });
    label(grp, tl(p.label) ?? t('Passive buzzer · I/O on IO{pin}', { pin: p.pin }), new THREE.Vector3(bx, 6, bz + Math.sign(bz) * 20));
    ctx.buzzers.push({ pin: p.pin, membrane: m.membrane, waves: m.waves, waveMat: m.waveMat, on: false });
  }

  /** Modules lying on the desk in front of the breadboard (buzzer / encoder): Dupont wires from board pins to female plugs on the module header */
}

/** Part builders: flat-cable modules, encoder, WS2812 stick, DHT11, sonar, I2S amp and mic. */
export function mountBuildersB(ctx: BenchCtx): void {
  const { pinCands, boardHole, lift, top, addRole, addWire, registerPart, tl, label, stripLast, paintStrip } = ctx;
  ctx.buildEncoder = buildEncoder;
  ctx.buildStrip = buildStrip;
  ctx.buildDht = buildDht;
  ctx.buildSonar = buildSonar;
  ctx.placeObstacle = placeObstacle;
  ctx.rayDistance = rayDistance;
  ctx.buildAmp = buildAmp;
  ctx.buildMic = buildMic;
  function tableWires(grp: THREE.Group, mgrp: THREE.Group, plugAt: THREE.Vector3[], labels: string[], partId: string, ends: [string, number, string, string][], bz: number) {
    mgrp.updateMatrixWorld(true);
    const local = plugAt.map((v) => v.clone());
    const recs = labels.map((l, i) => ({ id: `${partId}:${l}`, label: l, anchor: local[i].clone(), parent: mgrp }));
    pinHits(mgrp, recs, local.map((v) => v.clone().setY(v.y + 4)), [2.4, 9, 2.8], ctx.modulePins);
    ends.forEach(([pin, color, end, role], i) => {
      const b = local[labels.indexOf(end)].clone().applyMatrix4(mgrp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 12 + i * 1.5;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 2, (a.z + b.z) / 2 + Math.sign(bz) * 4), lift(b, h - 2), b], color, pin, `${partId}:${end}`);
      addRole(apiId(pin), role);
    });
  }

  /** Modules lying on the desk: three or more Dupont wires (female on the module header) to the board. ends = [board pin, colour, module pin, role] */
  function flatWires(grp: THREE.Group, partId: string, m: { grp: THREE.Group; plugAt: THREE.Vector3[]; labels: string[] }, ends: [string, number, string, string][], side: number) {
    m.grp.updateMatrixWorld(true);
    const recs = m.labels.map((l, i) => ({ id: `${partId}:${l}`, label: l, anchor: m.plugAt[i].clone(), parent: m.grp }));
    pinHits(m.grp, recs, m.plugAt.map((v) => v.clone().setY(v.y + 4)), [2.4, 9, 2.8], ctx.modulePins);
    ends.forEach(([pin, color, end, role], i) => {
      const b = m.plugAt[m.labels.indexOf(end)].clone().applyMatrix4(m.grp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 12 + i * 1.5;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 2, (a.z + b.z) / 2 + side * 4), lift(b, h - 2), b], color, pin, `${partId}:${end}`);
      addRole(apiId(pin), role);
    });
  }

  function buildEncoder(grp: THREE.Group, p: Extract<PartSpec, { type: 'encoder' }>) {
    const root = new THREE.Group();
    registerPart('encoder', root);
    grp.add(root);
    const m = encoderModule();
    // On the desk in front of the phase-A pin (a bit away from the board's BOOT key)
    const sig = pinCands('IO' + p.a)[0].p;
    const bx = sig.x + 6, bz = Math.sign(sig.z || 1) * (BB.D / 2 + 22);
    m.grp.position.set(bx, 0, bz);
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    const ends: [string, number, string, string][] = [
      ['GND', WIRE.gnd, 'GND', t('Encoder GND')],
      ['3V3', WIRE.vcc, '+', t('Encoder power (pull-ups to 3V3)')],
      ...(p.sw !== undefined ? [['IO' + p.sw, 0x8a5cf6, 'SW', t('Encoder switch (press = GND)')] as [string, number, string, string]] : []),
      ['IO' + p.b, WIRE.sda, 'DT', t('Encoder phase B (DT)')],
      ['IO' + p.a, WIRE.scl, 'CLK', t('Encoder phase A (CLK)')],
    ];
    tableWires(grp, m.grp, m.plugAt, m.labels, 'encoder', ends, bz);
    // Callout outside the module and low, so it doesn't cover the knob
    label(grp, tl(p.label) ?? t('EC11 encoder · CLK IO{a} DT IO{b}{sw} · drag or scroll the knob', { a: p.a, b: p.b, sw: p.sw !== undefined ? ` SW IO${p.sw}` : '' }), new THREE.Vector3(bx + 46, 4, bz + Math.sign(bz) * 6));
    ctx.encoder = { knob: m.knob, hit: m.hit, pos: 0, pushed: false, y0: m.knobY };
  }

  function buildStrip(grp: THREE.Group, p: Extract<PartSpec, { type: 'ws2812' }>) {
    const root = new THREE.Group();
    registerPart('ws2812', root);
    grp.add(root);
    const n = p.n ?? 8;
    const m = stickModule(n);
    // On the desk in front of the DIN pin, one row further out than the encoder (no overlap when on the same side)
    const sig = pinCands('IO' + p.pin)[0].p;
    const side = Math.sign(sig.z || 1);
    const bx = sig.x + 6, bz = side * (BB.D / 2 + 56);
    m.grp.position.set(bx, 0, bz);
    if (side < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    flatWires(grp, 'ws2812', m, [
      ['5V', WIRE.vcc, '5V', t('Strip power (5 V)')],
      ['IO' + p.pin, WIRE.sig, 'DIN', t('Strip data (shifted to 5 V via 74AHCT125)')],
      ['GND', WIRE.gnd, 'GND', t('Strip GND')],
    ], side);
    label(grp, tl(p.label) ?? t('WS2812 × {n} · DIN IO{pin} (RMT)', { n, pin: p.pin }), new THREE.Vector3(bx, 4, bz + side * 12));
    const st = { pin: p.pin, lenses: m.lenses, light: m.light };
    ctx.strips.push(st);
    const had = stripLast.get(p.pin);
    if (had) paintStrip(st, had);
  }

  function buildDht(grp: THREE.Group, p: Extract<PartSpec, { type: 'dht11' }>) {
    const root = new THREE.Group();
    registerPart('dht11', root);
    grp.add(root);
    const m = dht11Module();
    const sig = pinCands('IO' + p.pin)[0].p;
    const bx = sig.x - 6, bz = Math.sign(sig.z || 1) * (BB.D / 2 + 17);
    m.grp.position.set(bx, 0, bz);
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    const ends: [string, number, string, string][] = [
      ['3V3', WIRE.vcc, 'VCC', t('DHT11 power (3.3 V)')],
      ['IO' + p.pin, WIRE.sig, 'DATA', t('DHT11 data (open drain, single wire)')],
      ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'DHT11' })],
    ];
    tableWires(grp, m.grp, m.plugAt, m.labels, 'dht11', ends, bz);
    label(grp, tl(p.label) ?? t('DHT11 · DATA IO{pin} · temperature / humidity from the sliders', { pin: p.pin }), new THREE.Vector3(bx, 6, bz + Math.sign(bz) * 22));
  }

  function buildSonar(grp: THREE.Group, p: Extract<PartSpec, { type: 'hcsr04' }>) {
    const root = new THREE.Group();
    registerPart('hcsr04', root);
    grp.add(root);
    const m = sonarModule();
    // Stands on the desk front-right of the breadboard, transducers toward +x: obstacle to its right, all visible from the default camera
    const sx = 40, sz = BB.D / 2 + 34;
    m.grp.position.set(sx, 0, sz);
    m.grp.rotation.y = Math.PI / 2;
    root.add(m.grp);
    const shadow = contactShadow(18, 48, 0.3);
    shadow.position.set(sx - 3, shadow.position.y, sz);
    grp.add(shadow);
    m.grp.updateMatrixWorld(true);
    const local = m.plugAt.map((v) => v.clone());
    const recs = m.labels.map((l, i) => ({ id: `hcsr04:${l}`, label: l, anchor: local[i].clone(), parent: m.grp }));
    pinHits(m.grp, recs, local.map((v) => v.clone()), [2.4, 3, 6], ctx.modulePins);
    const div = p.divider !== false;
    const ends: [string, number, string, string][] = [
      ['5V', WIRE.vcc, 'VCC', t('HC-SR04 power (5 V)')],
      ['IO' + p.trig, WIRE.sig, 'Trig', t('HC-SR04 Trig (≥10 µs high pulse)')],
      ['IO' + p.echo, 0x2f8fd8, 'Echo', div ? t('HC-SR04 Echo (via 1k/2k divider)') : t('HC-SR04 Echo (5 V direct, can damage GPIO)')],
      ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'HC-SR04' })],
    ];
    ends.forEach(([pin, color, end, role], i) => {
      const b = local[m.labels.indexOf(end)].clone().applyMatrix4(m.grp.matrixWorld);
      const a = boardHole(pin, b);
      const h = top + 14 + i * 1.8;
      addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 3, (a.z + b.z) / 2 + 6), lift(b, h - 4), b], color, pin, `hcsr04:${end}`);
      addRole(apiId(pin), role);
    });
    // Echo divider: two small resistors drawn beside where the Echo wire lands (illustrative)
    if (div) {
      const e = local[m.labels.indexOf('Echo')].clone().applyMatrix4(m.grp.matrixWorld);
      for (const k of [0, 1]) {
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 3.4, 12).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: k ? 0xd8b26a : 0x6fa8dc, roughness: 0.5 }));
        r.position.set(e.x - 12 - k * 5, 1, e.z + 4);
        r.raycast = () => {};
        root.add(r);
      }
    }
    const sonarVars = { trig: p.trig, echo: p.echo };
    const sonarText = div
      ? t('HC-SR04 · Trig IO{trig} · Echo IO{echo} (1k/2k divider) · drag the obstacle', sonarVars)
      : t('HC-SR04 · Trig IO{trig} · Echo IO{echo} (5 V direct, can damage GPIO) · drag the obstacle', sonarVars);
    label(grp, tl(p.label) ?? sonarText, new THREE.Vector3(sx, 4, sz + 34));
    const ob = obstacleModel();
    registerPart('obstacle', ob.grp);
    grp.add(ob.grp);
    const origin = new THREE.Vector3(sx + m.face, m.y, sz);
    ctx.sonar = { origin, dir: new THREE.Vector3(1, 0, 0), face: m.face, obstacle: ob.grp, panel: ob.panel, waves: m.waves, waveMat: m.waveMat, pingT: -1e9, cm: p.cm ?? 25 };
    placeObstacle(p.cm ?? 25);
  }

  /** Put the obstacle cm in front of the transducers (3D placement caps at 100 cm, farther only in the reading); negative = remove */
  function placeObstacle(cm: number) {
    if (!ctx.sonar) return;
    ctx.sonar.cm = cm;
    const vis = cm >= 0;
    ctx.sonar.obstacle.visible = vis;
    const mm = Math.min(Math.max(cm, 2), 100) * 10;
    ctx.sonar.obstacle.position.set(ctx.sonar.origin.x + mm + 2, 0, ctx.sonar.origin.z);
    ctx.sonar.obstacle.updateMatrixWorld(true);
  }
  /** Raycast from the transmitter along the sensor's facing to the obstacle (cm, -1 on miss) */
  function rayDistance(): number {
    if (!ctx.sonar || !ctx.sonar.obstacle.visible) return -1;
    const rc = new THREE.Raycaster(ctx.sonar.origin, ctx.sonar.dir, 0, 4000);
    const hit = rc.intersectObject(ctx.sonar.panel)[0];
    return hit ? Math.round(hit.distance) / 10 : -1;
  }

  function buildAmp(grp: THREE.Group, p: Extract<PartSpec, { type: 'max98357a' }>) {
    // Amp module lies on the desk outside the breadboard near the three I2S pins; the speaker sits further out, red/black wires to the terminal
    const w = spkPins(I2S_WIRING[ctx.board.spec.chip].spk, p);
    const root = new THREE.Group();
    registerPart('max98357a', root);
    grp.add(root);
    const m = ampModule();
    const sig = pinCands('IO' + w.din)[0].p;
    const side = Math.sign(sig.z || 1);
    const bx = sig.x - 6, bz = side * (BB.D / 2 + 16);
    m.grp.position.set(bx, 0, bz);
    // Header faces the board (the module header is at -z)
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    flatWires(grp, 'max98357a', m, [
      ['5V', WIRE.vcc, 'Vin', t('Amp power (5 V)')],
      ['GND', WIRE.gnd, 'GND', t('Amp GND')],
      ['IO' + w.bclk, WIRE.scl, 'BCLK', t('I2S BCLK (bit clock)')],
      ['IO' + w.lrc, WIRE.sda, 'LRC', t('I2S WS (word select)')],
      ['IO' + w.din, WIRE.sig, 'DIN', t('I2S data (to speaker)')],
    ], side);
    // Speaker: further out, solder tabs facing the amp
    const sp = speakerModel();
    const sx = bx, sz = bz + side * 38;
    sp.grp.position.set(sx, 0, sz);
    if (side < 0) sp.grp.rotation.y = Math.PI;
    root.add(sp.grp);
    const sh2 = contactShadow(40, 40, 0.35);
    sh2.position.set(sx, sh2.position.y, sz);
    grp.add(sh2);
    root.updateMatrixWorld(true);
    [WIRE.vcc, WIRE.gnd].forEach((c, i) => {
      const a = m.screwAt[i].clone().applyMatrix4(m.grp.matrixWorld);
      const b = sp.tabAt[i].clone().applyMatrix4(sp.grp.matrixWorld);
      const mid = new THREE.Vector3((a.x + b.x) / 2, 7, (a.z + b.z) / 2);
      const w2 = wire([a, a.clone().add(new THREE.Vector3(0, 1, side * 3)), mid, b.clone().add(new THREE.Vector3(0, 1.5, -side * 3)), b], c, `wire:max98357a:${i ? '-' : '+'}~speaker`, [`max98357a:${i ? '-' : '+'}`, 'speaker']);
      root.add(w2.grp);
    });
    label(grp, tl(p.label) ?? t('MAX98357A amp and 4 Ω speaker · BCLK IO{bclk} LRC IO{lrc} DIN IO{din}', { bclk: w.bclk, lrc: w.lrc, din: w.din }), new THREE.Vector3(sx + 62, 8, sz));
    ctx.speakers.push({ cone: sp.cone, waves: sp.waves, waveMat: sp.waveMat });
  }

  function buildMic(grp: THREE.Group, p: Extract<PartSpec, { type: 'inmp441' }>) {
    const w = micPins(I2S_WIRING[ctx.board.spec.chip].mic, p);
    const root = new THREE.Group();
    registerPart('inmp441', root);
    grp.add(root);
    const m = micModule();
    const sig = pinCands('IO' + w.sd)[0].p;
    const side = Math.sign(sig.z || 1);
    // Offset when on the same side as the speaker so they don't overlap
    const shareSide = ctx.lastScene.parts.some((q) => q.type === 'max98357a') && Math.sign(pinCands('IO' + spkPins(I2S_WIRING[ctx.board.spec.chip].spk, ctx.lastScene.parts.find((q) => q.type === 'max98357a') ?? {}).din)[0].p.z || 1) === side;
    const bx = sig.x + (shareSide ? 30 : -4), bz = side * (BB.D / 2 + 14);
    m.grp.position.set(bx, 0, bz);
    if (bz < 0) m.grp.rotation.y = Math.PI;
    root.add(m.grp);
    const shadow = contactShadow(m.size[0], m.size[1], 0.3);
    shadow.position.set(bx, shadow.position.y, bz);
    grp.add(shadow);
    flatWires(grp, 'inmp441', m, [
      ['3V3', WIRE.vcc, 'VDD', t('Mic power')],
      ['GND', WIRE.gnd, 'GND', t('Mic GND')],
      ['GND', WIRE.gnd, 'L/R', t('L/R to GND = left channel')],
      ['IO' + w.sck, WIRE.scl, 'SCK', t('I2S SCK (bit clock)')],
      ['IO' + w.ws, WIRE.sda, 'WS', t('I2S WS (word select)')],
      ['IO' + w.sd, WIRE.sig, 'SD', t('I2S data (from mic)')],
    ], side);
    label(grp, tl(p.label) ?? t('INMP441 mic · SCK IO{sck} WS IO{ws} SD IO{sd} · L/R to GND', { sck: w.sck, ws: w.ws, sd: w.sd }), new THREE.Vector3(bx, 22, bz + side * 16));
    ctx.mics.push({ ring: m.ring, ringMat: m.ringMat });
  }
}
