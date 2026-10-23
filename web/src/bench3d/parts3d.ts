// F-04a: procedural 3D models (real outline sizes in mm) of the tutorial parts: DS18B20, HC-SR501, relay, LDR, RC522, IR pair (F-08f), AHT20 / INA219 / DS3231 (G-09).
// Kept out of modules.ts (shared with the M5 work); build.ts wires them like the DHT11 module.
import * as THREE from 'three';
import { t } from '../i18n';
import { PITCH, MAT, WIRE, canvasTexture, modulePcb, contactShadow, pinHits } from './util';
import { apiId, BB } from './boards';
import { isI2cMod, type PartSpec } from './spec';
import type { BenchCtx } from './ctx';

export interface FlatModule {
  grp: THREE.Group;
  /** Header pin tips (module local), same order as labels */
  plugAt: THREE.Vector3[];
  labels: string[];
  size: readonly [number, number];
  pcbTop: number;
}

/** Status lamps lit from the pin level (not output enable: the PIR drives its own pin) */
interface Lamp {
  pin: number;
  mat: THREE.MeshStandardMaterial;
  on: number;
  invert?: boolean;
}
const lamps: Lamp[] = [];
let card: THREE.Object3D | null = null;

export function resetPartLamps() {
  lamps.length = 0;
  card = null;
}

/** Called from bench.setGpio with the pin level bit reader */
export function paintPartLamps(bit: (pin: number) => number) {
  for (const l of lamps) {
    const v = bit(l.pin) ^ (l.invert ? 1 : 0);
    l.mat.emissiveIntensity = v ? l.on : 0;
  }
}

/** RC522: show a card over the antenna while one is presented (bench control, not a sim readback) */
export function showRc522Card(uid: string | null) {
  if (card) card.visible = !!uid;
}

const S = 24; // canvas px per mm

/** Flat PCB lying on the desk with a straight header along the back edge (pins up, like the DHT11 module) */
function flatPcb(W: number, H: number, color: string, edge: number, labels: string[], draw: (g: CanvasRenderingContext2D, cw: number, ch: number) => void, T = 1.6): FlatModule {
  const grp = new THREE.Group();
  const n = labels.length;
  const x0 = -((n - 1) / 2) * PITCH;
  const tex = canvasTexture(Math.round(W * S), Math.round(H * S), (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = color;
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#d9b860';
    for (let i = 0; i < n; i++) {
      g.beginPath();
      g.arc(cw / 2 + (x0 + i * PITCH) * S, 2 * S, 0.8 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#eef3fb';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${Math.min(1, (PITCH * 0.95) / Math.max(...labels.map((l) => l.length)) * 1.6) * S}px "JetBrains Mono", Menlo, monospace`;
    labels.forEach((l, i) => g.fillText(l, cw / 2 + (x0 + i * PITCH) * S, 4.2 * S));
    draw(g, cw, ch);
  });
  const pcb = modulePcb(W, H, T, [], tex, edge);
  const flat = new THREE.Group();
  flat.rotation.x = -Math.PI / 2;
  pcb.position.y = -H / 2;
  flat.add(pcb);
  flat.position.y = 1.2 + T / 2;
  grp.add(flat);
  const pcbTop = 1.2 + T;
  const m = new THREE.Matrix4();
  const feet = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 10), MAT.tin, n);
  for (let i = 0; i < n; i++) feet.setMatrixAt(i, m.makeTranslation(x0 + i * PITCH, 0.6, -H / 2 + 2));
  grp.add(feet);
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(n * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.set(0, pcbTop + 1.25, -H / 2 + 2);
  grp.add(plastic);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 8.5, 0.64), MAT.gold, n);
  for (let i = 0; i < n; i++) pins.setMatrixAt(i, m.makeTranslation(x0 + i * PITCH, pcbTop + 4.25, -H / 2 + 2));
  grp.add(pins);
  const plugAt = labels.map((_, i) => new THREE.Vector3(x0 + i * PITCH, pcbTop + 2.5, -H / 2 + 2));
  return { grp, plugAt, labels, size: [W, H] as const, pcbTop };
}

function lampMesh(color: number, pin: number, on = 3, invert = false) {
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0, roughness: 0.3 });
  lamps.push({ pin, mat, on, invert });
  return new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.8), mat);
}

const silk = (g: CanvasRenderingContext2D, text: string, x: number, y: number, mm: number) => {
  g.fillStyle = '#eef3fb';
  g.font = `bold ${mm * S}px Helvetica, sans-serif`;
  g.fillText(text, x, y);
};

/** DS18B20 waterproof probe: adapter board (pull-up on board) + 6 × 50 mm stainless tube on a black cable */
export function ds18b20Probe(): FlatModule {
  const m = flatPcb(16, 18, '#1f55b0', 0x18458f, ['VDD', 'DQ', 'GND'], (g, cw) => {
    silk(g, 'DS18B20', cw / 2, 8.5 * S, 1.5);
    silk(g, 'R1 4K7', cw / 2, 11 * S, 1.2);
  });
  const y = 3.2;
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 34, 12), MAT.plastic);
  cable.rotation.x = Math.PI / 2;
  cable.position.set(0, y, 9 + 17);
  m.grp.add(cable);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 50, 20), MAT.steel);
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, y + 0.8, 9 + 34 + 25);
  tube.castShadow = true;
  m.grp.add(tube);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), MAT.steel);
  tip.rotation.x = Math.PI / 2;
  tip.position.set(0, y + 0.8, 9 + 34 + 50);
  m.grp.add(tip);
  return m;
}

/** HC-SR501: 32 × 24 mm board, 23 mm Fresnel dome; the dome tints while OUT is high */
export function pirModule(pin: number): FlatModule {
  const m = flatPcb(32, 24, '#2a8a3e', 0x1f6a2f, ['VCC', 'OUT', 'GND'], (g, cw) => {
    silk(g, 'HC-SR501', cw / 2, 21.5 * S, 1.4);
  });
  const domeMat = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, emissive: 0xff5a3c, emissiveIntensity: 0, roughness: 0.75 });
  lamps.push({ pin, mat: domeMat, on: 0.6 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(24, 2, 24), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.75 }));
  base.position.set(0, m.pcbTop + 1, 2);
  m.grp.add(base);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(11.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
  dome.position.set(0, m.pcbTop + 2, 2);
  dome.castShadow = true;
  m.grp.add(dome);
  return m;
}

/** 1-channel relay: 50 × 26 mm board, SRD-05VDC can (19 × 15.5 × 15 mm), terminal block, status LED from IN */
export function relayModule(pin: number, low?: boolean): FlatModule {
  const m = flatPcb(26, 50, '#1f55b0', 0x18458f, ['VCC', 'GND', 'IN'], (g, cw) => {
    silk(g, '1 Relay', cw / 2, 8 * S, 1.6);
    silk(g, 'NO COM NC', cw / 2, 40.5 * S, 1.3);
  });
  const can = new THREE.Mesh(new THREE.BoxGeometry(15.5, 15, 19), new THREE.MeshStandardMaterial({ color: 0x2b62c9, roughness: 0.4 }));
  can.position.set(0, m.pcbTop + 7.5, 24 - 25);
  can.castShadow = true;
  m.grp.add(can);
  const term = new THREE.Mesh(new THREE.BoxGeometry(15, 10, 7.5), new THREE.MeshStandardMaterial({ color: 0x2f9b4b, roughness: 0.5 }));
  term.position.set(0, m.pcbTop + 5, 25 - 5);
  m.grp.add(term);
  const screws = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.4, 1.4, 0.6, 12), MAT.steel, 3);
  const mx = new THREE.Matrix4();
  for (let i = 0; i < 3; i++) screws.setMatrixAt(i, mx.makeTranslation((i - 1) * 5, m.pcbTop + 10.2, 25 - 6));
  m.grp.add(screws);
  const led = lampMesh(0xff3020, pin, 4, !!low);
  led.position.set(8.5, m.pcbTop + 0.4, -14);
  m.grp.add(led);
  return m;
}

/** Photoresistor module: 32 × 14 mm board, 5 mm GL5528 at the front edge */
export function ldrModule(): FlatModule {
  const m = flatPcb(14, 32, '#1f55b0', 0x18458f, ['VCC', 'GND', 'AO'], (g, cw) => {
    silk(g, 'LDR', cw / 2, 12 * S, 1.6);
    silk(g, '10K', cw / 2, 18 * S, 1.2);
  });
  const S5 = canvasTexture(128, 128, (g) => {
    g.fillStyle = '#e8d8a8';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#b4472e';
    g.lineWidth = 9;
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const y = 22 + i * 17;
      g.moveTo(i % 2 ? 100 : 28, y);
      g.lineTo(i % 2 ? 28 : 100, y);
      g.lineTo(i % 2 ? 28 : 100, y + 17);
    }
    g.stroke();
  });
  const cell = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 2, 24), [new THREE.MeshStandardMaterial({ color: 0xd8c898, roughness: 0.4 }), new THREE.MeshStandardMaterial({ map: S5, roughness: 0.25 }), MAT.plastic]);
  cell.position.set(0, m.pcbTop + 4, 13);
  m.grp.add(cell);
  const legs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.25, 3, 6), MAT.tin, 2);
  const mx = new THREE.Matrix4();
  for (let i = 0; i < 2; i++) legs.setMatrixAt(i, mx.makeTranslation(i ? 1.2 : -1.2, m.pcbTop + 1.5, 13));
  m.grp.add(legs);
  return m;
}

/** RC522: 60 × 39 mm board, antenna loop on the far end, 8-pin header on the short edge */
export function rc522Module(): FlatModule {
  const m = flatPcb(39, 60, '#1f55b0', 0x18458f, ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'], (g, cw, ch) => {
    g.strokeStyle = '#c9a957';
    g.lineWidth = 0.7 * S;
    for (let i = 0; i < 4; i++) {
      const d = (3 + i * 1.6) * S;
      g.strokeRect(d, ch - 34 * S + d, cw - 2 * d, 34 * S - 2 * d - 2 * S);
    }
    g.textAlign = 'center';
    silk(g, 'RFID-RC522', cw / 2, 10 * S, 2);
  });
  const ic = new THREE.Mesh(new THREE.BoxGeometry(5, 1.2, 5), MAT.chip);
  ic.rotation.y = Math.PI / 4;
  ic.position.set(0, m.pcbTop + 0.6, -12);
  m.grp.add(ic);
  const xtal = new THREE.Mesh(new THREE.BoxGeometry(11, 3.5, 4.5), MAT.steel);
  xtal.position.set(10, m.pcbTop + 1.75, -12);
  m.grp.add(xtal);
  // ISO card (85.6 × 54 mm), shown hovering over the antenna while one is presented
  const c = new THREE.Mesh(new THREE.BoxGeometry(54, 0.8, 85.6), new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.4, transparent: true, opacity: 0.85 }));
  c.position.set(0, m.pcbTop + 12, 14);
  c.visible = false;
  m.grp.add(c);
  card = c;
  return m;
}

/** IR receiver breakout: 15 × 21 mm board, VS1838B body (7 × 6 × 9 mm) with its lens facing -x, toward the IR LED */
export function irRxModule(): FlatModule {
  const m = flatPcb(15, 21, '#1f55b0', 0x18458f, ['OUT', 'GND', 'VCC'], (g, cw) => {
    silk(g, 'VS1838B', cw / 2, 18.5 * S, 1.3);
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(6, 9, 7), MAT.plastic);
  body.position.set(0, m.pcbTop + 4.5, 5);
  body.castShadow = true;
  m.grp.add(body);
  const lens = new THREE.Mesh(new THREE.SphereGeometry(2.6, 20, 10, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 0.15 }));
  lens.rotation.y = -Math.PI / 2;
  lens.position.set(-3, m.pcbTop + 5, 5);
  m.grp.add(lens);
  return m;
}

/** IR LED module: 15 × 18.5 mm board, 5 mm 940 nm LED bent over to face +x (into the receiver's lens); the lens glows faintly while S is high (as a phone camera sees it) */
export function irLedModule(pin: number): FlatModule {
  const m = flatPcb(15, 18.5, '#1a1d24', 0x111318, ['S', 'GND'], (g, cw) => {
    silk(g, 'IR 940nm', cw / 2, 15.5 * S, 1.3);
  });
  const mat = new THREE.MeshStandardMaterial({ color: 0xb9b4d8, emissive: 0x9a6bff, emissiveIntensity: 0, roughness: 0.2, transparent: true, opacity: 0.9 });
  lamps.push({ pin, mat, on: 1.5 });
  const led = new THREE.Group();
  const can = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 5.6, 20), mat);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  dome.position.y = 2.8;
  led.add(can, dome);
  led.rotation.z = -Math.PI / 2;
  led.position.set(2, m.pcbTop + 3, 4);
  m.grp.add(led);
  return m;
}

/** Box on the PCB top: w along x, h up, d along z (module local, z = 0 at the board centre) */
function onTop(m: FlatModule, w: number, h: number, d: number, x: number, z: number, mat: THREE.Material) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  b.position.set(x, m.pcbTop + h / 2, z);
  b.castShadow = true;
  m.grp.add(b);
  return b;
}

/** AHT20 breakout: 16 × 11 mm purple board, 3 × 3 mm DFN sensor, 4-pin header */
export function aht20Module(): FlatModule {
  const m = flatPcb(16, 11, '#5a2a8a', 0x45206b, ['VCC', 'GND', 'SCL', 'SDA'], (g, cw) => silk(g, 'AHT20', cw / 2, 8.6 * S, 1.3));
  onTop(m, 3, 1, 3, 4.5, 2, new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.5 }));
  onTop(m, 2.9, 1.1, 1.6, -4.5, 2.4, MAT.chip);
  return m;
}

/** INA219 breakout (CJMCU-219 class): 25.6 × 22.3 mm, SOT-23-8 INA219, R100 2512 shunt, 2-pin screw terminal for Vin+ / Vin- */
export function ina219Module(): FlatModule {
  const m = flatPcb(25.6, 22.3, '#1f55b0', 0x18458f, ['VCC', 'GND', 'SCL', 'SDA', 'VIN-', 'VIN+'], (g, cw) => silk(g, 'INA219', cw / 2 - 5 * S, 11 * S, 1.4));
  onTop(m, 3, 1.1, 3, -6, 1.5, MAT.chip);
  onTop(m, 6.3, 0.6, 3.2, 5, 1.5, new THREE.MeshStandardMaterial({ color: 0x232325, roughness: 0.35 }));
  const term = onTop(m, 10, 10, 7.5, 0, 6.5, new THREE.MeshStandardMaterial({ color: 0x2f9b4b, roughness: 0.5 }));
  const screws = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.4, 1.4, 0.6, 12), MAT.steel, 2);
  const mx = new THREE.Matrix4();
  for (let i = 0; i < 2; i++) screws.setMatrixAt(i, mx.makeTranslation((i - 0.5) * 5, term.position.y + 5.3, 6.5));
  m.grp.add(screws);
  return m;
}

/** ZS-042 DS3231 board: 22 × 38 mm, SOIC-16 DS3231SN and SOIC-8 AT24C32 on top (CR2032 holder underneath, not drawn), 6-pin header */
export function ds3231Module(): FlatModule {
  const m = flatPcb(22, 38, '#1f55b0', 0x18458f, ['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'], (g, cw) => {
    silk(g, 'DS3231', cw / 2, 23 * S, 1.5);
    silk(g, 'ZS-042', cw / 2, 34 * S, 1.2);
  });
  onTop(m, 7.5, 2.5, 10.3, -3, -4, MAT.chip);
  onTop(m, 4, 1.5, 5, 6, -5, MAT.chip);
  onTop(m, 1.6, 0.8, 0.8, 7, 9, new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff2020, emissiveIntensity: 1.2 }));
  return m;
}

export type TutorialPart = Extract<PartSpec, { type: 'ds18b20' | 'pir' | 'relay' | 'ldr' | 'rc522' | 'irrx' | 'irled' | 'aht20' | 'ina219' | 'ds3231' }>;
const TUTORIAL = new Set<PartSpec['type']>(['ds18b20', 'pir', 'relay', 'ldr', 'rc522', 'irrx', 'irled', 'aht20', 'ina219', 'ds3231']);
export const isTutorialPart = (p: PartSpec): p is TutorialPart => TUTORIAL.has(p.type);

/** Desk slot per type (fixed x, distance out from the breadboard on the signal pin's side), so all of them fit side by side.
 *  The IR LED sits 26 mm on the receiver's lens side (local -x), so it swaps sides when the modules are turned round */
const SLOT: Record<TutorialPart['type'], { dx: number; out: number }> = { ds18b20: { dx: -25, out: 17 }, pir: { dx: 10, out: 22 }, relay: { dx: -58, out: 34 }, ldr: { dx: 45, out: 24 }, rc522: { dx: 52, out: 76 }, irrx: { dx: 92, out: 16 }, irled: { dx: 66, out: 16 }, aht20: { dx: -30, out: 56 }, ina219: { dx: -6, out: 56 }, ds3231: { dx: 22, out: 60 } };

/** Module on the desk + Dupont wires to the board (same routing as the DHT11 builder) */
export function buildTutorialPart(ctx: BenchCtx, grp: THREE.Group, p: TutorialPart) {
  const { pinCands, boardHole, lift, top, addRole, addWire, registerPart, tl, label } = ctx;
  const root = new THREE.Group();
  registerPart(p.type, root);
  grp.add(root);
  const io = (n?: number) => (n === undefined ? undefined : 'IO' + n);
  type End = [string | undefined, number, string, string];
  let m: FlatModule;
  let ends: End[];
  let text: string;
  const sigPin = p.type === 'rc522' ? p.cs : isI2cMod(p) ? p.sda : p.pin;
  switch (p.type) {
    case 'ds18b20':
      m = ds18b20Probe();
      ends = [['3V3', WIRE.vcc, 'VDD', t('DS18B20 power (3.3 V)')], [io(p.pin), WIRE.sig, 'DQ', t('DS18B20 1-Wire data (4.7 kΩ pull-up)')], ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'DS18B20' })]];
      text = t('DS18B20 × {n} · DQ IO{pin} · temperature from the slider', { n: p.n ?? 1, pin: p.pin });
      break;
    case 'pir':
      m = pirModule(p.pin);
      ends = [['5V', WIRE.vcc, 'VCC', t('PIR power (5 V)')], [io(p.pin), WIRE.sig, 'OUT', t('PIR motion output')], ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'HC-SR501' })]];
      text = t('HC-SR501 · OUT IO{pin} · press "Wave" to trigger', { pin: p.pin });
      break;
    case 'relay':
      m = relayModule(p.pin, p.low);
      ends = [['5V', WIRE.vcc, 'VCC', t('Relay coil power (5 V)')], ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: t('Relay') })], [io(p.pin), WIRE.sig, 'IN', t('Relay control input')]];
      text = t('Relay · IN IO{pin} · red LED = contacts closed', { pin: p.pin });
      break;
    case 'ldr':
      m = ldrModule();
      ends = [['3V3', WIRE.vcc, 'VCC', t('Light sensor power (3.3 V)')], ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'LDR' })], [io(p.pin), WIRE.sig, 'AO', t('Analog light level')]];
      text = t('Photoresistor · AO IO{pin} · light from the slider', { pin: p.pin });
      break;
    case 'rc522':
      m = rc522Module();
      ends = [
        [io(p.cs), 0x8e5bd8, 'SDA', t('RC522 chip select')],
        [io(p.sck), WIRE.scl, 'SCK', 'RC522 SCK'],
        [io(p.mosi), WIRE.sig, 'MOSI', 'RC522 MOSI'],
        [io(p.miso), 0x2f8fd8, 'MISO', 'RC522 MISO'],
        ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'RC522' })],
        [io(p.rst), WIRE.sda, 'RST', t('RC522 reset')],
        ['3V3', WIRE.vcc, '3.3V', t('RC522 power (3.3 V only)')],
      ];
      text = t('RC522 · SDA IO{pin} · tap a card below', { pin: p.cs ?? '—' });
      break;
    case 'irrx':
      m = irRxModule();
      ends = [[io(p.pin), WIRE.sig, 'OUT', t('IR receiver output (low = burst)')], ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: 'VS1838B' })], ['3V3', WIRE.vcc, 'VCC', t('IR receiver power (3.3 V)')]];
      text = t('IR receiver · OUT IO{pin} · press remote keys', { pin: p.pin });
      break;
    case 'irled':
      m = irLedModule(p.pin);
      ends = [[io(p.pin), WIRE.sig, 'S', t('IR LED drive')], ['GND', WIRE.gnd, 'GND', t('{name} GND', { name: t('IR LED') })]];
      text = t('IR LED · S IO{pin} · faces the receiver', { pin: p.pin });
      break;
    case 'aht20':
    case 'ina219':
    case 'ds3231': {
      const name = p.type.toUpperCase();
      m = p.type === 'aht20' ? aht20Module() : p.type === 'ina219' ? ina219Module() : ds3231Module();
      const vcc = m.labels.includes('VIN') ? 'VIN' : 'VCC';
      ends = [
        ['3V3', WIRE.vcc, vcc, t('{name} power', { name })],
        ['GND', WIRE.gnd, 'GND', t('{name} GND', { name })],
        [io(p.scl), WIRE.scl, 'SCL', 'I2C SCL'],
        [io(p.sda), WIRE.sda, 'SDA', 'I2C SDA'],
      ];
      text = `${name} · I2C 0x${p.addr.toString(16)} · SDA IO${p.sda} SCL IO${p.scl}`;
      break;
    }
  }
  const sig = sigPin !== undefined ? pinCands('IO' + sigPin)[0]?.p : undefined;
  const slot = SLOT[p.type];
  const side = Math.sign(sig?.z || 1);
  const bx = p.type === 'irled' && side < 0 ? 2 * SLOT.irrx.dx - slot.dx : slot.dx, bz = side * (BB.D / 2 + slot.out);
  m.grp.position.set(bx, 0, bz);
  if (bz < 0) m.grp.rotation.y = Math.PI;
  root.add(m.grp);
  const shadow = contactShadow(m.size[0], m.size[1], 0.3);
  shadow.position.set(bx, shadow.position.y, bz);
  grp.add(shadow);
  m.grp.updateMatrixWorld(true);
  const recs = m.labels.map((l, i) => ({ id: `${p.type}:${l}`, label: l, anchor: m.plugAt[i].clone(), parent: m.grp }));
  pinHits(m.grp, recs, m.plugAt.map((v) => v.clone().setY(v.y + 4)), [2.4, 9, 2.8], ctx.modulePins);
  ends.forEach(([pin, color, end, role], i) => {
    if (!pin) return;
    const b = m.plugAt[m.labels.indexOf(end)].clone().applyMatrix4(m.grp.matrixWorld);
    const a = boardHole(pin, b);
    const h = top + 12 + i * 1.5;
    addWire(grp, [a, lift(a, h), new THREE.Vector3((a.x + b.x) / 2, h + 2, (a.z + b.z) / 2 + side * 4), lift(b, h - 2), b], color, pin, `${p.type}:${end}`);
    addRole(apiId(pin), role);
  });
  label(grp, tl(p.label) ?? text, new THREE.Vector3(bx, 6, bz + side * (m.size[1] / 2 + 8)));
}
