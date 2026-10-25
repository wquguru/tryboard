// Add-on part meshes (displays, sensors, actuators, audio, keys, LED, resistor), procedural at real size (mm).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EXT } from '../extmodels';
import { resistorBands } from './ledparams';
import { PITCH, type ExtSlot, ACCENT, MAT, canvasTexture, roundRect, modulePcb, contactShadow } from './util';

// ---------------------------------------------------------------- modules and parts

/** 4 / 8-pin header (black plastic strip + gold pins), inserted upright: origin on the breadboard surface, pins along x */
export function moduleHeader(grp: THREE.Group, count: number) {
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(count * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.y = 1.25;
  grp.add(plastic);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 11, 0.64), MAT.gold, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) pins.setMatrixAt(i, m.makeTranslation((i - (count - 1) / 2) * PITCH, 1.5, 0));
  grp.add(pins);
  return Array.from({ length: count }, (_, i) => new THREE.Vector3((i - (count - 1) / 2) * PITCH, 0, 0));
}

/** 1.28″ GC9A01 round LCD module: round PCB inserted upright in the breadboard, 8 pins. Origin at the header base. */
export const LCD_PINS = ['GND', 'VCC', 'SCL', 'SDA', 'RES', 'DC', 'CS', 'BLK'];
/** Extra 4 pins on the touch version (CST816S): full names don't fit the silkscreen, so the texture uses short names */
export const TP_PINS = ['TP_SDA', 'TP_SCL', 'TP_INT', 'TP_RST'];
export function roundLcdModule(tex: THREE.Texture, touch = false) {
  const grp = new THREE.Group();
  const R = 19, T = 1.2;
  const labels = touch ? [...LCD_PINS, ...TP_PINS] : LCD_PINS;
  const n = labels.length;
  const pcbTex = canvasTexture(512, 512, (g) => {
    g.fillStyle = '#17181b';
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#eef0f3';
    g.textAlign = 'center';
    // Texture maps in mm: x ∈ [-R, R] → 0..512; pin labels on the bottom strip
    labels.forEach((t, i) => {
      g.font = `bold ${i < 8 ? 15 : 11}px "JetBrains Mono", Menlo, monospace`;
      g.fillText(i < 8 ? t : 'T' + t.slice(3), 256 + ((i - (n - 1) / 2) * PITCH * 512) / (2 * R), 512 - (2.2 * 512) / (2 * R + 6));
    });
    if (touch) {
      g.font = 'bold 13px Helvetica, sans-serif';
      g.fillText('TOUCH · CST816S', 256, 512 - (5.6 * 512) / (2 * R + 6));
    }
  });
  const shape = new THREE.Shape();
  shape.absarc(0, R + 3, R, 0, Math.PI * 2, false);
  const pcbGeo = mergeGeometries([
    new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 64 }),
    new THREE.ExtrudeGeometry(roundRect(n * PITCH + 1.7, 8, 0.6), { depth: T, bevelEnabled: false }).translate(0, 4.5, 0),
  ]);
  pcbGeo.translate(0, 0, -T / 2);
  pcbTex.repeat.set(1 / (2 * R), 1 / (2 * R + 6));
  pcbTex.offset.set(0.5, 0);
  const pcb = new THREE.Mesh(pcbGeo, new THREE.MeshStandardMaterial({ map: pcbTex, roughness: 0.55 }));
  pcb.position.y = 0.5;
  pcb.castShadow = true;
  grp.add(pcb);
  // Touch version: thicker cover glass with a silver bezel (touch sensor under the glass), plus a CST816S beside the screen
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(17.2, 17.2, touch ? 1.9 : 1.4, 64), new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.05, metalness: 0.2, clearcoat: 1 }));
  glass.rotation.x = Math.PI / 2;
  glass.position.set(0, 0.5 + R + 3, T / 2 + (touch ? 0.95 : 0.7));
  grp.add(glass);
  const screen = new THREE.Mesh(new THREE.CircleGeometry(16.25, 64), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, glass.position.y, glass.position.z + (touch ? 0.96 : 0.71));
  grp.add(screen);
  let tp: THREE.Mesh | null = null;
  if (touch) {
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(17.25, 0.35, 8, 96), new THREE.MeshStandardMaterial({ color: 0xb9bec6, metalness: 1, roughness: 0.3 }));
    bezel.position.set(0, glass.position.y, glass.position.z + 0.7);
    grp.add(bezel);
    tp = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.8), MAT.chip);
    tp.position.set(9.5, 5.6, T / 2 + 0.4);
    tp.castShadow = true;
    grp.add(tp);
  }
  const pins = moduleHeader(grp, n);
  return { grp, pins, labels, screen, tp };
}

/** Flat IMU board (header pins down through the PCB, face up): GY-521 (MPU6050, blue 21.2 × 16.4, 8 pins) or QMI8658 (black 17 × 13, 6 pins).
 *  Origin at header base (breadboard surface), pins in a row along x, PCB extends toward −z; silkscreen X / Y arrows match sensor axes: X = +x, Y = −z. */
export function imuModule(kind: 'mpu6050' | 'qmi8658') {
  const grp = new THREE.Group();
  const gy = kind === 'mpu6050';
  const labels = gy ? ['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'] : ['VIN', 'GND', 'SCL', 'SDA', 'SA0', 'INT'];
  const n = labels.length;
  const W = gy ? 21.2 : 17, H = gy ? 16.4 : 13, T = 1.6, S = 28;
  const color = gy ? '#1d4fa8' : '#1b1d22';
  const tex = canvasTexture(Math.round(W * S), Math.round(H * S), (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = color;
    g.fillRect(0, 0, cw, ch);
    // Pin pads along the texture's bottom edge (= the edge nearest the viewer)
    g.fillStyle = '#d9b860';
    for (let i = 0; i < n; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - (n - 1) / 2) * PITCH * S, ch - 1.3 * S, 0.8 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#eef3fb';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${0.78 * S}px "JetBrains Mono", Menlo, monospace`;
    labels.forEach((t, i) => g.fillText(t, cw / 2 + (i - (n - 1) / 2) * PITCH * S, ch - 3.1 * S));
    g.font = `bold ${1.15 * S}px Helvetica, sans-serif`;
    g.textAlign = 'left';
    g.fillText(gy ? 'GY-521' : 'QMI8658', 1.2 * S, 1.6 * S);
    // Axis silkscreen: X right, Y up (= inward), Z out of the board (⊙)
    const ox = cw - 4.2 * S, oy = 5.4 * S;
    g.strokeStyle = g.fillStyle = '#eef3fb';
    g.lineWidth = 0.18 * S;
    const arrow = (dx: number, dy: number, t: string) => {
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ox + dx * 2.6 * S, oy + dy * 2.6 * S);
      g.stroke();
      g.beginPath();
      g.moveTo(ox + dx * 3 * S, oy + dy * 3 * S);
      g.lineTo(ox + dx * 2.3 * S - dy * 0.4 * S, oy + dy * 2.3 * S + dx * 0.4 * S);
      g.lineTo(ox + dx * 2.3 * S + dy * 0.4 * S, oy + dy * 2.3 * S - dx * 0.4 * S);
      g.fill();
      g.font = `bold ${0.8 * S}px Helvetica, sans-serif`;
      g.textAlign = 'center';
      g.fillText(t, ox + dx * 3.6 * S, oy + dy * 3.6 * S);
    };
    arrow(1, 0, 'X');
    arrow(0, -1, 'Y');
    g.beginPath();
    g.arc(ox, oy, 0.35 * S, 0, Math.PI * 2);
    g.stroke();
  });
  const holes: [number, number, number][] = gy ? [[-W / 2 + 1.8, H / 2 - 1.8, 1.5], [W / 2 - 1.8, H / 2 - 1.8, 1.5]] : [[-W / 2 + 1.6, H / 2 - 1.6, 1.1]];
  const pcb = modulePcb(W, H, T, holes, tex, gy ? 0x163f88 : 0x111215);
  // Lay the upright PCB flat: local +y (texture top) → −z (inward), face up
  pcb.rotation.x = -Math.PI / 2;
  pcb.position.set(0, 2.5 + T / 2, 1.3);
  grp.add(pcb);
  const top = 2.5 + T;
  // Sensor chip (MPU6050 4×4 QFN / QMI8658 2.5×3 LGA) + regulator, passives, power LED
  const chip = new THREE.Mesh(new THREE.BoxGeometry(gy ? 4 : 2.5, 0.9, gy ? 4 : 3), MAT.chip);
  chip.position.set(gy ? -1 : -1.5, top + 0.45, 1.3 - H / 2 - 0.5);
  chip.castShadow = true;
  grp.add(chip);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.3, 12), new THREE.MeshBasicMaterial({ color: 0x8a8d92 }));
  dot.rotation.x = -Math.PI / 2;
  dot.position.set(chip.position.x - (gy ? 1.4 : 0.8), top + 0.91, chip.position.z - (gy ? 1.4 : 1));
  grp.add(dot);
  const smd = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), MAT.chip, 4);
  const m4 = new THREE.Matrix4();
  [[-W / 2 + 3.5, -H + 6, 2.9, 1.6], [W / 2 - 4, -5.5, 1.6, 0.8], [W / 2 - 4, -7.5, 1.6, 0.8], [-W / 2 + 3.5, -4, 1.6, 0.8]].forEach(([x, z, w, d], i) =>
    smd.setMatrixAt(i, m4.compose(new THREE.Vector3(x * (gy ? 1 : 0.8), top + 0.3, z * (gy ? 1 : 0.8)), new THREE.Quaternion(), new THREE.Vector3(w, 0.6, d))),
  );
  grp.add(smd);
  const led = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.8), new THREE.MeshStandardMaterial({ color: 0xffe2e2, emissive: 0xff2a1a, emissiveIntensity: 1.2 }));
  led.position.set(W / 2 - 6, top + 0.25, 1.3 - H + 2.4);
  grp.add(led);
  // Header: black plastic spacer on the breadboard, pins through the PCB with solder joints on top
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(n * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.y = 1.25;
  grp.add(plastic);
  const pinMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 6.2, 0.64), MAT.gold, n);
  const solder = new THREE.InstancedMesh(new THREE.SphereGeometry(0.75, 10, 6), MAT.tin, n);
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * PITCH;
    pinMesh.setMatrixAt(i, m4.makeTranslation(x, top - 3.1 + 1.2, 0));
    solder.setMatrixAt(i, m4.makeTranslation(x, top + 0.15, 0));
  }
  grp.add(pinMesh, solder);
  const shadow = contactShadow(W, H, 0.22);
  shadow.position.z = 1.3 - H / 2;
  grp.add(shadow);
  const pins = Array.from({ length: n }, (_, i) => new THREE.Vector3((i - (n - 1) / 2) * PITCH, 0, 0));
  return { grp, pins, labels };
}

/** 0.96″ SSD1306 module: blue PCB 27.3 × 27.8, four Φ2 mounting holes, glass + FPC, inserted upright facing the viewer. Origin at the header base. */
export function oledModule(tex: THREE.Texture) {
  const grp = new THREE.Group();
  const W = 27.3, H = 27.8, T = 1.2;
  const labels = ['GND', 'VCC', 'SCL', 'SDA'];
  const S = 18;
  const pcbTex = canvasTexture(Math.round(W * S), Math.round(H * S), (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#1f55b0';
    g.fillRect(0, 0, cw, ch);
    // Texture y down = module top to bottom; pins on the bottom edge
    g.fillStyle = '#d9b860';
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - 1.5) * PITCH * S, ch - 1.6 * S, 0.8 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#eef3fb';
    g.font = `bold ${1.3 * S}px "JetBrains Mono", Menlo, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    labels.forEach((t, i) => g.fillText(t, cw / 2 + (i - 1.5) * PITCH * S * 1.0, ch - 3.6 * S));
    g.strokeStyle = '#eef3fb';
    g.lineWidth = 0.25 * S;
    for (const [x, y] of [[2, 2], [W - 2, 2], [2, H - 2], [W - 2, H - 2]]) {
      g.beginPath();
      g.arc(x * S, y * S, 1.6 * S, 0, Math.PI * 2);
      g.stroke();
    }
  });
  const pcb = modulePcb(W, H, T, [[-W / 2 + 2, H / 2 - 2, 1], [W / 2 - 2, H / 2 - 2, 1], [-W / 2 + 2, -H / 2 + 2, 1], [W / 2 - 2, -H / 2 + 2, 1]].map(([x, y, r]) => [x, y, r] as [number, number, number]), pcbTex, 0x18458f);
  pcb.position.y = 0.6;
  grp.add(pcb);
  // Glass panel (black) + active area + amber FPC at the bottom
  const glassY = 0.6 + H - 19.26 / 2 - 0.5;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(26.7, 19.26, 1.4), new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.06, metalness: 0.2, clearcoat: 1 }));
  glass.position.set(0, glassY, T / 2 + 0.7);
  glass.castShadow = true;
  grp.add(glass);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(21.74, 10.86), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, glassY + 1.6, glass.position.z + 0.71);
  grp.add(screen);
  const fpc = new THREE.Mesh(new THREE.BoxGeometry(12, 2.2, 0.15), new THREE.MeshStandardMaterial({ color: 0xc9821c, roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.92 }));
  fpc.position.set(0, glassY - 9.63 - 1.0, T / 2 + 0.08);
  grp.add(fpc);
  const pins = moduleHeader(grp, 4);
  return { grp, pins, labels };
}

/** BME280 board: purple PCB 13 × 10.5, one mounting hole, 2.5 × 2.5 metal-can sensor, inserted upright. Origin at the header base. */
export function bmeModule() {
  const grp = new THREE.Group();
  const W = 13, H = 10.5, T = 1.2;
  const labels = ['VIN', 'GND', 'SCL', 'SDA'];
  const S = 32;
  const tex = canvasTexture(W * S, Math.round(H * S), (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#5a2a8a';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#d9b860';
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - 1.5) * PITCH * S, ch - 1.4 * S, 0.75 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#f3ecfa';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${0.95 * S}px "JetBrains Mono", Menlo, monospace`;
    labels.forEach((t, i) => g.fillText(t, cw / 2 + (i - 1.5) * PITCH * S, ch - 3.0 * S));
    g.font = `bold ${1.1 * S}px Helvetica, sans-serif`;
    g.fillText('BME280', cw / 2 + 2.2 * S, 1.6 * S);
    g.strokeStyle = '#f3ecfa';
    g.lineWidth = 0.18 * S;
    g.beginPath();
    g.arc(2 * S, 2 * S, 1.6 * S, 0, Math.PI * 2);
    g.stroke();
  });
  const pcb = modulePcb(W, H, T, [[-W / 2 + 2, H / 2 - 2, 1.1]], tex, 0x45206b);
  pcb.position.y = 0.6;
  grp.add(pcb);
  const can = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 0.93), new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 1, roughness: 0.25 }));
  can.position.set(0.6, 0.6 + H / 2 + 0.6, T / 2 + 0.47);
  can.castShadow = true;
  grp.add(can);
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 12), MAT.plastic);
  hole.rotation.x = Math.PI / 2;
  hole.position.set(can.position.x + 0.6, can.position.y + 0.6, can.position.z + 0.47);
  grp.add(hole);
  // Onboard regulator and passives
  const parts = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), MAT.chip, 4);
  const m = new THREE.Matrix4();
  [[-3.6, 6.6, 2.9, 1.6], [3.8, 4.6, 1.6, 0.8], [4.6, 7.4, 1.6, 0.8], [-3.6, 3.4, 1.6, 0.8]].forEach(([x, y, w, h], i) =>
    parts.setMatrixAt(i, m.compose(new THREE.Vector3(x, 0.6 + y, T / 2 + 0.3), new THREE.Quaternion(), new THREE.Vector3(w, h, 0.6))),
  );
  grp.add(parts);
  const pins = moduleHeader(grp, 4);
  return { grp, pins, labels };
}

/** SG90 servo: translucent blue case 22.2 × 11.8 × 22.7, mounting ears with two Φ2 screw holes, white single-arm horn, brown/red/orange leads. Origin at case bottom centre. */
export function servoModel() {
  const grp = new THREE.Group();
  const blue = new THREE.MeshPhysicalMaterial({ color: 0x2d5bd3, roughness: 0.32, transmission: 0.12, thickness: 2 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(22.2, 22.7, 11.8), blue);
  body.position.y = 11.35;
  body.castShadow = true;
  grp.add(body);
  // Mounting ears: one plate with a screw hole at each end (extruded with holes)
  const ear = roundRect(32.2, 11.8, 1.2);
  for (const x of [-13.85, 13.85]) {
    const p = new THREE.Path();
    p.absarc(x, 0, 1.0, 0, Math.PI * 2, true);
    ear.holes.push(p);
  }
  const earGeo = new THREE.ExtrudeGeometry(ear, { depth: 2.5, bevelEnabled: false, curveSegments: 16 });
  earGeo.rotateX(Math.PI / 2);
  const ears = new THREE.Mesh(earGeo, blue);
  ears.position.y = 17.2;
  ears.castShadow = true;
  grp.add(ears);
  // Label sticker (side)
  const label = canvasTexture(256, 128, (g) => {
    g.fillStyle = '#e9ecef';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#1e1e1e';
    g.font = 'bold 52px Helvetica, sans-serif';
    g.textAlign = 'center';
    g.fillText('SG90', 128, 64);
    g.font = '22px Helvetica, sans-serif';
    g.fillText('9g micro servo', 128, 100);
  });
  const sticker = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), new THREE.MeshStandardMaterial({ map: label, roughness: 0.6 }));
  sticker.position.set(0, 8, 5.95);
  grp.add(sticker);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(5.9, 5.9, 4, 32), blue);
  const shaftTop = 29.5;
  tower.position.set(-5.4, 24.7, 0);
  grp.add(tower);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 3, 24), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }));
  shaft.position.set(-5.4, 28, 0);
  grp.add(shaft);
  const horn = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.55 });
  const hornShape = new THREE.Shape();
  hornShape.absarc(0, 0, 3.6, Math.PI / 2, (Math.PI * 3) / 2, false);
  hornShape.lineTo(16, -2.1);
  hornShape.absarc(16, 0, 2.1, -Math.PI / 2, Math.PI / 2, false);
  hornShape.lineTo(0, 3.6);
  for (let i = 0; i < 5; i++) {
    const p = new THREE.Path();
    p.absarc(6 + i * 2.2, 0, 0.45, 0, Math.PI * 2, true);
    hornShape.holes.push(p);
  }
  const hornGeo = new THREE.ExtrudeGeometry(hornShape, { depth: 1.6, bevelEnabled: false, curveSegments: 16 });
  hornGeo.rotateX(Math.PI / 2);
  const arm = new THREE.Mesh(hornGeo, white);
  arm.position.y = 0.8;
  horn.add(arm);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 1.6, 24), white);
  hub.position.y = 1.4;
  horn.add(hub);
  const screw = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.4, 16), MAT.steel);
  screw.position.y = 2.3;
  horn.add(screw);
  horn.position.set(-5.4, shaftTop, 0);
  horn.traverse((o) => (o.castShadow = true));
  grp.add(horn);
  grp.add(contactShadow(32, 12, 0.35));
  // Optional Adafruit 1143 (9 g servo, same outline as SG90). glb shaft at origin, case along -z, bottom y=-18.8, spline top y=+11.9 (mm).
  // Rotate -90° so the case runs along +x with the shaft at x=-5.4; the horn stays procedural (the model has none), raised onto the spline
  const ext: ExtSlot = {
    root: grp,
    name: EXT.servo,
    proc: [body, ears, tower, shaft],
    fit(m) {
      if (m) {
        m.rotation.y = -Math.PI / 2;
        m.position.set(-5.4, 18.8, 0);
      }
      horn.position.y = m ? 18.8 + 11.9 - 0.6 : shaftTop;
      sticker.position.z = m ? 6.05 : 5.95;
    },
  };
  return { grp, horn, ext };
}

/** Passive 3-pin buzzer module (S8550 transistor): blue PCB 15 × 22, Φ12 × 8.5 black buzzer, VCC I/O GND silkscreen, straight header up
 *  (lies flat on the desk, female Dupont plugs from above). Origin at PCB bottom centre, header on the -z side (toward the board). */
export const BUZZER_PINS = ['VCC', 'I/O', 'GND'];
export function buzzerModule() {
  const grp = new THREE.Group();
  const W = 15, H = 22, T = 1.2;
  const S = 28;
  const tex = canvasTexture(W * S, H * S, (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#1f55b0';
    g.fillRect(0, 0, cw, ch);
    // Texture top edge = header side
    g.fillStyle = '#d9b860';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - 1) * PITCH * S, 2 * S, 0.8 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#eef3fb';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${1.05 * S}px "JetBrains Mono", Menlo, monospace`;
    BUZZER_PINS.forEach((t, i) => g.fillText(t, cw / 2 + (i - 1) * PITCH * 1.25 * S, 4.4 * S));
    g.strokeStyle = '#eef3fb';
    g.lineWidth = 0.18 * S;
    g.beginPath();
    g.arc(cw / 2, ch - 7.5 * S, 6.6 * S, 0, Math.PI * 2);
    g.stroke();
    g.font = `bold ${0.9 * S}px Helvetica, sans-serif`;
    g.fillText('Q1', cw / 2 - 4.6 * S, 7.4 * S);
    g.fillText('R1', cw / 2 + 4.6 * S, 7.4 * S);
  });
  const pcb = modulePcb(W, H, T, [], tex, 0x18458f);
  // modulePcb is upright (y 0..H); rotate about x to lie flat, texture top edge ends up at -z
  const flat = new THREE.Group();
  flat.rotation.x = -Math.PI / 2;
  pcb.position.y = -H / 2;
  flat.add(pcb);
  flat.position.y = 1.2 + T / 2;
  grp.add(flat);
  const pcbTop = 1.2 + T;
  // Bottom solder joints lift the board slightly
  const feet = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 10), MAT.tin, 3);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 3; i++) feet.setMatrixAt(i, m.makeTranslation((i - 1) * PITCH, 0.6, -H / 2 + 2));
  grp.add(feet);
  // Buzzer: black plastic cylinder + top sound hole; the diaphragm (dark disc in the hole) moves slightly while sounding
  const body = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 8.5, 48), new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.48 }));
  const bz = H / 2 - 7.5;
  body.position.set(0, pcbTop + 4.25, bz);
  body.castShadow = true;
  grp.add(body);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.25, 8, 40).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.4 }));
  ring.position.set(0, pcbTop + 8.5, bz);
  grp.add(ring);
  const membrane = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9 }));
  membrane.position.set(0, pcbTop + 8.52, bz);
  grp.add(membrane);
  // Transistor (TO-92 black half-cylinder) and SMD resistor
  const q = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 4.5, 24, 1, false, 0, Math.PI), MAT.chip);
  q.position.set(-4.6, pcbTop + 2.25, -H / 2 + 7.4);
  q.castShadow = true;
  grp.add(q);
  const r = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.8), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5 }));
  r.position.set(4.6, pcbTop + 0.25, -H / 2 + 6);
  grp.add(r);
  // Header: black plastic block + gold pins (facing up)
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(3 * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.set(0, pcbTop + 1.25, -H / 2 + 2);
  grp.add(plastic);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 8.5, 0.64), MAT.gold, 3);
  for (let i = 0; i < 3; i++) pins.setMatrixAt(i, m.makeTranslation((i - 1) * PITCH, pcbTop + 4.25, -H / 2 + 2));
  grp.add(pins);
  // Female Dupont plugs sit on the header: plug bottom at the plastic block top
  const plugAt = [0, 1, 2].map((i) => new THREE.Vector3((i - 1) * PITCH, pcbTop + 2.5, -H / 2 + 2));
  // Sound-wave hint: two arcs above the buzzer that appear and expand while sounding
  const waves = new THREE.Group();
  const waveMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.8, depthWrite: false });
  for (const k of [0, 1]) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(4 + k * 2.6, 0.32, 6, 24, Math.PI * 0.6), waveMat);
    arc.rotation.z = Math.PI * 0.2;
    arc.raycast = () => {};
    waves.add(arc);
  }
  waves.position.set(0, pcbTop + 12, bz);
  waves.visible = false;
  grp.add(waves);
  // Optional KiCad Buzzer_12x9.5RM7.6 (glb pins at x=0 / 7.6, body 9.5 tall, bottom y=0, mm): centre the body, lift diaphragm and waves to the new top
  const ext: ExtSlot = {
    root: grp,
    name: EXT.buzzer,
    proc: [body, ring],
    fit(m) {
      if (m) m.position.set(-3.8, pcbTop, bz);
      const topY = pcbTop + (m ? 9.5 : 8.5);
      membrane.position.y = topY + 0.02;
      waves.position.y = topY + 3.5;
    },
  };
  return { grp, plugAt, labels: BUZZER_PINS, membrane, waves, waveMat, size: [W, H] as const, ext };
}

export const ENC_PINS = ['GND', '+', 'SW', 'DT', 'CLK'];
/** EC11 rotary encoder module (KY-040 style): lies flat on the desk, header on the -z side; knob drag-rotates and clicks. Origin at board bottom centre */
export function encoderModule() {
  const grp = new THREE.Group();
  const W = 19, H = 26, T = 1.2;
  const S = 24;
  const tex = canvasTexture(W * S, H * S, (g) => {
    const cw = W * S;
    g.fillStyle = '#1f55b0';
    g.fillRect(0, 0, cw, H * S);
    g.fillStyle = '#eef3fb';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${0.9 * S}px "JetBrains Mono", Menlo, monospace`;
    ENC_PINS.forEach((t, i) => g.fillText(t, cw / 2 + (i - 2) * PITCH * S, 4.6 * S));
    g.font = `bold ${0.9 * S}px Helvetica, sans-serif`;
    g.fillText('R1  R2', cw / 2, H * S - 2.2 * S);
  });
  const pcb = modulePcb(W, H, T, [], tex, 0x18458f);
  const flat = new THREE.Group();
  flat.rotation.x = -Math.PI / 2;
  pcb.position.y = -H / 2;
  flat.add(pcb);
  flat.position.y = 1.2 + T / 2;
  grp.add(flat);
  const pcbTop = 1.2 + T;
  // Encoder body: 12 mm square steel can + black base
  const base = new THREE.Mesh(new THREE.BoxGeometry(12.4, 2.2, 13.2), MAT.plastic);
  base.position.set(0, pcbTop + 1.1, 2);
  grp.add(base);
  const can = new THREE.Mesh(new THREE.BoxGeometry(12, 4.2, 12.4), MAT.steel);
  can.position.set(0, pcbTop + 4.3, 2);
  can.castShadow = true;
  grp.add(can);
  const bush = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 5, 24), MAT.steel);
  bush.position.set(0, pcbTop + 8.9, 2);
  grp.add(bush);
  // Knob: knurled black aluminium cap + white indicator line; the whole group rotates about y (18° per detent)
  const knob = new THREE.Group();
  const kmat = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.45, metalness: 0.3 });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.4, 12, 30), kmat);
  cap.position.y = 6;
  knob.add(cap);
  const ridges = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 9, 0.7), kmat, 30);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2;
    ridges.setMatrixAt(i, m.makeRotationY(-a).premultiply(new THREE.Matrix4().makeTranslation(Math.cos(a) * 7.25, 5.5, Math.sin(a) * 7.25)));
  }
  knob.add(ridges);
  const mark = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 5), new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }));
  mark.position.set(0, 12.1, -3.6);
  knob.add(mark);
  knob.position.set(0, pcbTop + 10.4, 2);
  knob.traverse((o) => (o.castShadow = true));
  grp.add(knob);
  // Pick box: the whole knob (both drag and click hit it)
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 14, 16), MAT.hit);
  hit.position.set(0, pcbTop + 17, 2);
  grp.add(hit);
  // Header and female Dupont plugs
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(5 * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.set(0, pcbTop + 1.25, -H / 2 + 2);
  grp.add(plastic);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 8.5, 0.64), MAT.gold, 5);
  for (let i = 0; i < 5; i++) pins.setMatrixAt(i, m.makeTranslation((i - 2) * PITCH, pcbTop + 4.25, -H / 2 + 2));
  grp.add(pins);
  const plugAt = [0, 1, 2, 3, 4].map((i) => new THREE.Vector3((i - 2) * PITCH, pcbTop + 2.5, -H / 2 + 2));
  return { grp, knob, hit, plugAt, labels: ENC_PINS, size: [W, H] as const, knobY: knob.position.y };
}

export const STICK_PINS = ['GND', 'DIN', '5V'];
/** 8-LED WS2812 stick (common 51 × 10 mm black board, three pins GND / DIN / 5V at one end): lies flat, header at the -x end facing up.
 *  Each 5050 LED is a white frame + translucent diffuser whose emissive colour comes from core-decoded frames. Origin at board bottom centre */
export function stickModule(n: number) {
  const W = 6.4 * n + 6, H = 10;
  const S = 20;
  const tex = canvasTexture(W * S, H * S, (g) => {
    g.fillStyle = '#16181b';
    g.fillRect(0, 0, W * S, H * S);
    g.fillStyle = '#d9dce0';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${0.75 * S}px "JetBrains Mono", Menlo, monospace`;
    STICK_PINS.forEach((t, i) => g.fillText(t, 4.2 * S, (H / 2 + (i - 1) * PITCH) * S));
    g.font = `bold ${0.7 * S}px Helvetica, sans-serif`;
    g.fillText(`WS2812B x${n}`, (W / 2 + 2) * S, (H - 1.2) * S);
  });
  const pinsAt: [number, number][] = [0, 1, 2].map((i) => [-W / 2 + 1.8, (i - 1) * PITCH]);
  const m = flatModule(W, H, tex, 0x111214, pinsAt);
  const frame = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.6 });
  const lenses: THREE.MeshStandardMaterial[] = [];
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + 7 + i * 6.4;
    const body = new THREE.Mesh(new THREE.BoxGeometry(5, 1.5, 5), frame);
    body.position.set(x, m.pcbTop + 0.75, -0.6);
    body.castShadow = true;
    m.grp.add(body);
    const lm = new THREE.MeshStandardMaterial({ color: 0xdedbd2, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.3 });
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.1, 24), lm);
    lens.position.set(x, m.pcbTop + 1.52, -0.6);
    m.grp.add(lens);
    lenses.push(lm);
  }
  const light = new THREE.PointLight(0xffffff, 0, 90, 2);
  light.position.set(0, m.pcbTop + 8, 0);
  m.grp.add(light);
  return { grp: m.grp, plugAt: m.plugAt, labels: STICK_PINS, lenses, light, size: [W, H] as const };
}

/** WS2812 LED colour → diffuser material. The bench has no tone mapping, so white base + strong emission clips to whitish pink:
 *  when lit, darken the base, use the normalised hue as emission and scale intensity with brightness (dimming must stay visible) */
export function ledGlow(mat: THREE.MeshStandardMaterial, rgb: number[]) {
  const [r, g, b] = rgb.map((v) => v / 255);
  const peak = Math.max(r, g, b);
  if (!peak) {
    mat.emissiveIntensity = 0;
    mat.color.set(0xdedbd2);
    return { peak };
  }
  mat.color.setRGB((r / peak) * 0.2, (g / peak) * 0.2, (b / peak) * 0.2);
  mat.emissive.setRGB(r / peak, g / peak, b / peak);
  mat.emissiveIntensity = 0.55 + 1.2 * peak;
  return { peak };
}

export const SONAR_PINS = ['VCC', 'Trig', 'Echo', 'GND'];
/** HC-SR04: upright blue board, two transducers facing local +z; header at the back bottom, horizontal toward -z. Origin at the board's bottom-edge centre on the desk */
export const DHT_PINS = ['VCC', 'DATA', 'GND'];
/** DHT11 breakout (real dimensions): 15 × 25 mm PCB lying flat, blue 12 × 15.5 × 5.5 mm sensor housing with a vent grid, 3-pin header */
export function dht11Module() {
  const grp = new THREE.Group();
  const W = 15, H = 25, T = 1.2;
  const S = 28;
  const tex = canvasTexture(W * S, H * S, (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#1f55b0';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#d9b860';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - 1) * PITCH * S, 2 * S, 0.8 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#eef3fb';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${0.95 * S}px "JetBrains Mono", Menlo, monospace`;
    DHT_PINS.forEach((t, i) => g.fillText(t, cw / 2 + (i - 1) * PITCH * 1.25 * S, 4.4 * S));
    g.font = `bold ${0.9 * S}px Helvetica, sans-serif`;
    g.fillText('R1 10K', cw / 2, 6.6 * S);
  });
  const pcb = modulePcb(W, H, T, [], tex, 0x18458f);
  const flat = new THREE.Group();
  flat.rotation.x = -Math.PI / 2;
  pcb.position.y = -H / 2;
  flat.add(pcb);
  flat.position.y = 1.2 + T / 2;
  grp.add(flat);
  const pcbTop = 1.2 + T;
  const m = new THREE.Matrix4();
  const feet = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 10), MAT.tin, 3);
  for (let i = 0; i < 3; i++) feet.setMatrixAt(i, m.makeTranslation((i - 1) * PITCH, 0.6, -H / 2 + 2));
  grp.add(feet);
  // Sensor housing: light-blue plastic with a grid of square vents on top
  const grid = canvasTexture(12 * S, 15.5 * S, (g) => {
    g.fillStyle = '#5aa7e0';
    g.fillRect(0, 0, 12 * S, 15.5 * S);
    g.fillStyle = '#1d3f66';
    for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) g.fillRect((1.4 + c * 2.5) * S, (1.6 + r * 2.2) * S, 1.6 * S, 1.3 * S);
  });
  const shell = new THREE.MeshStandardMaterial({ color: 0x5aa7e0, roughness: 0.55 });
  const top = new THREE.MeshStandardMaterial({ map: grid, roughness: 0.55 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(12, 5.5, 15.5), [shell, shell, top, shell, shell, shell]);
  const bz = H / 2 - 9.5;
  body.position.set(0, pcbTop + 2.75, bz);
  body.castShadow = true;
  grp.add(body);
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(3 * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.set(0, pcbTop + 1.25, -H / 2 + 2);
  grp.add(plastic);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 8.5, 0.64), MAT.gold, 3);
  for (let i = 0; i < 3; i++) pins.setMatrixAt(i, m.makeTranslation((i - 1) * PITCH, pcbTop + 4.25, -H / 2 + 2));
  grp.add(pins);
  const plugAt = [0, 1, 2].map((i) => new THREE.Vector3((i - 1) * PITCH, pcbTop + 2.5, -H / 2 + 2));
  return { grp, plugAt, labels: DHT_PINS, size: [W, H] as const };
}

export function sonarModule() {
  const grp = new THREE.Group();
  const W = 45, H = 20, T = 1.6, Y0 = 6;
  const S = 20;
  const tex = canvasTexture(W * S, H * S, (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#1f55b0';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#eef3fb';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${1.6 * S}px Helvetica, sans-serif`;
    g.fillText('HC-SR04', cw / 2, 2.4 * S);
    g.font = `bold ${1.05 * S}px "JetBrains Mono", Menlo, monospace`;
    SONAR_PINS.forEach((t, i) => g.fillText(t, cw / 2 + (i - 1.5) * PITCH * 1.6 * S, ch - 1.8 * S));
    g.font = `bold ${1.2 * S}px Helvetica, sans-serif`;
    g.fillText('T', cw / 2 - 13 * S, ch / 2 + 7.6 * S);
    g.fillText('R', cw / 2 + 13 * S, ch / 2 + 7.6 * S);
  });
  const pcb = modulePcb(W, H, T, [], tex, 0x18458f);
  pcb.position.y = Y0;
  grp.add(pcb);
  // Small 3D-printed stand holds the board upright on the desk
  const stand = new THREE.Mesh(new THREE.BoxGeometry(W - 6, Y0, 14), new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.7 }));
  stand.position.set(0, Y0 / 2, -3);
  stand.castShadow = stand.receiveShadow = true;
  grp.add(stand);
  // Two transducers: silver aluminium shell + black dust mesh
  const shell = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.9, roughness: 0.32 });
  const mesh = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.85 });
  const heads: THREE.Vector3[] = [];
  for (const x of [-13, 13]) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 12, 40, 1, true).rotateX(Math.PI / 2), shell);
    c.position.set(x, Y0 + H / 2, T / 2 + 6);
    c.castShadow = true;
    grp.add(c);
    const net = new THREE.Mesh(new THREE.CircleGeometry(7.6, 40), mesh);
    net.position.set(x, Y0 + H / 2, T / 2 + 11.8);
    grp.add(net);
    heads.push(new THREE.Vector3(x, Y0 + H / 2, T / 2 + 12));
  }
  // Crystal in the middle
  const xtal = new THREE.Mesh(new THREE.BoxGeometry(8, 3.4, 2), MAT.steel);
  xtal.position.set(0, Y0 + H / 2 + 3, T / 2 + 1);
  grp.add(xtal);
  // Header: back bottom, horizontal toward -z (right-angle pins)
  const m = new THREE.Matrix4();
  const plastic = new THREE.Mesh(new THREE.BoxGeometry(4 * PITCH, 2.5, 2.5), MAT.plastic);
  plastic.position.set(0, Y0 + 2.2, -T / 2 - 1.25);
  grp.add(plastic);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 0.64, 8), MAT.gold, 4);
  for (let i = 0; i < 4; i++) pins.setMatrixAt(i, m.makeTranslation((i - 1.5) * PITCH, Y0 + 2.2, -T / 2 - 4));
  grp.add(pins);
  const plugAt = [0, 1, 2, 3].map((i) => new THREE.Vector3((i - 1.5) * PITCH, Y0 + 2.2, -T / 2 - 8));
  // Sound waves: arcs expanding forward from the transmitter (flash once per measurement)
  const waves = new THREE.Group();
  const waveMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthWrite: false });
  for (const k of [0, 1, 2]) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(6 + k * 5, 0.35, 6, 32, Math.PI * 0.5), waveMat);
    arc.rotation.set(0, 0, Math.PI * 0.75);
    arc.raycast = () => {};
    waves.add(arc);
  }
  waves.position.set(0, Y0 + H / 2, T / 2 + 14);
  grp.add(waves);
  return { grp, plugAt, labels: SONAR_PINS, heads, face: T / 2 + 12, waves, waveMat, size: [W, 16] as const, y: Y0 + H / 2 };
}

/** Obstacle: an upright light-coloured panel (drag it to change distance). Origin at its bottom-edge centre on the desk, face toward local -x */
export function obstacleModel() {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xe9d9bd, roughness: 0.8 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(4, 50, 70), mat);
  panel.position.y = 25;
  panel.castShadow = panel.receiveShadow = true;
  grp.add(panel);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(24, 3, 40), new THREE.MeshStandardMaterial({ color: 0xbfae90, roughness: 0.8 }));
  foot.position.y = 1.5;
  grp.add(foot);
  return { grp, panel };
}

/** Shared part of small flat modules: PCB (texture top = header side = -z), solder feet, a row of upright pins + Dupont plug points.
 *  Origin at PCB bottom centre. pinsAt: (x, z) of each pin, in labels order */
export function flatModule(W: number, H: number, tex: THREE.Texture, side: number, pinsAt: [number, number][]) {
  const grp = new THREE.Group();
  const T = 1.2;
  const pcb = modulePcb(W, H, T, [], tex, side);
  const flat = new THREE.Group();
  flat.rotation.x = -Math.PI / 2;
  pcb.position.y = -H / 2;
  flat.add(pcb);
  flat.position.y = 1.2 + T / 2;
  grp.add(flat);
  const pcbTop = 1.2 + T;
  const m = new THREE.Matrix4();
  const n = pinsAt.length;
  const feet = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 10), MAT.tin, n);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 8.5, 0.64), MAT.gold, n);
  const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(PITCH, 2.5, 2.5), MAT.plastic, n);
  pinsAt.forEach(([x, z], i) => {
    feet.setMatrixAt(i, m.makeTranslation(x, 0.6, z));
    pins.setMatrixAt(i, m.makeTranslation(x, pcbTop + 4.25, z));
    seats.setMatrixAt(i, m.makeTranslation(x, pcbTop + 1.25, z));
  });
  grp.add(feet, pins, seats);
  const plugAt = pinsAt.map(([x, z]) => new THREE.Vector3(x, pcbTop + 2.5, z));
  return { grp, pcbTop, plugAt };
}

/** Silkscreen: a row of pin names */
export function silkPins(g: CanvasRenderingContext2D, S: number, labels: string[], xs: number[], y: number, color: string, size = 0.8) {
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${size * S}px "JetBrains Mono", Menlo, monospace`;
  labels.forEach((t, i) => g.fillText(t, xs[i] * S, y * S));
}

/** MAX98357A I2S class-D amp module: dark blue PCB 17.8 × 19.4, one row of 7 pins (LRC BCLK DIN GAIN SD GND Vin), a 2-way green
 *  screw terminal (+ −) for the speaker on the far edge, QFN chip and caps in between. Lies flat, header up, origin at PCB bottom centre. */
export const AMP_PINS = ['LRC', 'BCLK', 'DIN', 'GAIN', 'SD', 'GND', 'Vin'];
export function ampModule() {
  const W = 17.8, H = 19.4;
  const S = 28;
  const xs = AMP_PINS.map((_, i) => (i - 3) * PITCH);
  const pz = -H / 2 + 1.8;
  const tex = canvasTexture(Math.round(W * S), Math.round(H * S), (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = '#16307a';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#d9b860';
    for (const x of xs) {
      g.beginPath();
      g.arc(cw / 2 + x * S, 1.8 * S, 0.8 * S, 0, Math.PI * 2);
      g.fill();
    }
    silkPins(g, S, AMP_PINS, xs.map((x) => W / 2 + x), 3.9, '#eef3fb', 0.62);
    g.fillStyle = '#eef3fb';
    g.textAlign = 'center';
    g.font = `bold ${0.95 * S}px Helvetica, sans-serif`;
    g.fillText('MAX98357A', cw / 2, ch / 2 - 1.4 * S);
    g.font = `${0.7 * S}px Helvetica, sans-serif`;
    g.fillText('I2S 3W Class D Amp', cw / 2, ch / 2 + 3.2 * S);
    g.font = `bold ${1.0 * S}px Helvetica, sans-serif`;
    g.fillText('+', cw / 2 - 1.75 * S, ch - 7.2 * S);
    g.fillText('−', cw / 2 + 1.75 * S, ch - 7.2 * S);
    g.fillText('SPEAKER', cw / 2, ch - 0.9 * S);
  });
  const base = flatModule(W, H, tex, 0x10235c, xs.map((x) => [x, pz]));
  const { grp, pcbTop } = base;
  // QFN-16 chip (3 × 3) and SMD caps
  const ic = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 3), MAT.chip);
  ic.position.set(0, pcbTop + 0.4, 0.6);
  grp.add(ic);
  const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.8, 0.8), new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.6 }), 3);
  const m = new THREE.Matrix4();
  [[-4.8, -1.2], [4.8, -1.2], [4.8, 2.4]].forEach(([x, z], i) => caps.setMatrixAt(i, m.makeTranslation(x, pcbTop + 0.4, z)));
  grp.add(caps);
  // 3.5 mm 2-way screw terminal: green plastic block + two silver screws, wire entry toward +z
  const tz = H / 2 - 3.6;
  const block = new THREE.Mesh(new THREE.BoxGeometry(7.2, 7.4, 6.6), new THREE.MeshStandardMaterial({ color: 0x1f8a4c, roughness: 0.55 }));
  block.position.set(0, pcbTop + 3.7, tz);
  block.castShadow = true;
  grp.add(block);
  const screwAt: THREE.Vector3[] = [];
  for (const dx of [-1.75, 1.75]) {
    const sc = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.6, 20), MAT.steel);
    sc.position.set(dx, pcbTop + 7.5, tz - 0.8);
    grp.add(sc);
    const slot = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 0.3), MAT.plastic);
    slot.position.set(dx, pcbTop + 7.82, tz - 0.8);
    grp.add(slot);
    // Wire entry: square hole on the terminal's outer face
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 0.2), MAT.plastic);
    mouth.position.set(dx, pcbTop + 2.4, tz + 3.31);
    grp.add(mouth);
    screwAt.push(new THREE.Vector3(dx, pcbTop + 2.4, tz + 3.4));
  }
  return { grp, plugAt: base.plugAt, labels: AMP_PINS, screwAt, size: [W, H] as const };
}

/** Φ40 4 Ω 3 W speaker (cone up, lying flat): neodymium magnet, stamped steel basket, black cone + surround + dust cap, two solder tabs with red/black leads.
 *  Origin at magnet bottom centre. cone is the moving part (cone + dust cap) */
export function speakerModel() {
  const grp = new THREE.Group();
  const magnet = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 4.5, 40), new THREE.MeshStandardMaterial({ color: 0x8d9096, metalness: 0.9, roughness: 0.35 }));
  magnet.position.y = 2.25;
  magnet.castShadow = true;
  grp.add(magnet);
  // Basket: steel frustum from magnet top to the rim + flat top flange
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(19.5, 10, 4.5, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide }));
  basket.position.y = 4.5 + 2.25;
  basket.castShadow = true;
  grp.add(basket);
  const flange = new THREE.Mesh(new THREE.RingGeometry(18.2, 20, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide }));
  flange.position.y = 9.02;
  grp.add(flange);
  const cone = new THREE.Group();
  // Cone: outer edge r=17 at height 8.6, inner edge r=5.5 at 5.2 (conical), matte black
  const prof = [new THREE.Vector2(5.5, 5.2), new THREE.Vector2(10, 6.6), new THREE.Vector2(15, 8.0), new THREE.Vector2(17, 8.6)];
  const paper = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.9, side: THREE.DoubleSide }));
  cone.add(paper);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 12, 0, Math.PI * 2, 0, Math.PI * 0.32), new THREE.MeshStandardMaterial({ color: 0x0f0f10, roughness: 0.55 }));
  cap.position.y = 5.2 - 6 * Math.cos(Math.PI * 0.32) + 0.2;
  cone.add(cap);
  grp.add(cone);
  // Surround (rubber edge)
  const surround = new THREE.Mesh(new THREE.TorusGeometry(17.6, 0.8, 8, 48).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.8 }));
  surround.position.y = 8.8;
  grp.add(surround);
  // Solder tabs (+ red dot, − black), toward -z (the amp)
  const tabAt: THREE.Vector3[] = [];
  for (const dx of [-4, 4]) {
    const tab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.3, 4), MAT.tin);
    tab.position.set(dx, 5.2, -19.6);
    grp.add(tab);
    tabAt.push(new THREE.Vector3(dx, 5.4, -21));
  }
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.7, 12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd8342a }));
  dot.position.set(-4, 9.05, -19.1);
  grp.add(dot);
  // Sound-wave hint: two arcs above the cone
  const waves = new THREE.Group();
  const waveMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.8, depthWrite: false });
  for (const k of [0, 1]) {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(10 + k * 5, 0.45, 6, 32, Math.PI * 0.5), waveMat);
    arc.rotation.z = Math.PI * 0.25;
    arc.raycast = () => {};
    waves.add(arc);
  }
  waves.position.set(0, 20, 0);
  waves.visible = false;
  grp.add(waves);
  return { grp, cone, tabAt, waves, waveMat, r: 20 };
}

/** INMP441 digital MEMS mic module: Φ14 round purple PCB, two rows of 3 pins (L/R WS SCK / SD VDD GND),
 *  LGA mic on the bottom with a sound hole in the centre of the top (bottom port). Lies flat, header up, origin at PCB bottom centre */
export const MIC_PINS = ['L/R', 'WS', 'SCK', 'SD', 'VDD', 'GND'];
export function micModule() {
  const D = 14.2, T = 1.2;
  const S = 28;
  const pinsAt: [number, number][] = MIC_PINS.map((_, i) => [((i % 3) - 1) * PITCH, i < 3 ? -4.4 : -4.4 + PITCH]);
  const tex = canvasTexture(Math.round(D * S), Math.round(D * S), (g) => {
    const c = D * S;
    g.fillStyle = '#4a2b86';
    g.fillRect(0, 0, c, c);
    g.fillStyle = '#d9b860';
    for (const [x, z] of pinsAt) {
      g.beginPath();
      g.arc(c / 2 + x * S, c / 2 + z * S, 0.75 * S, 0, Math.PI * 2);
      g.fill();
    }
    // Pin names: first row above the pins, second row below
    silkPins(g, S, MIC_PINS.slice(0, 3), [0, 1, 2].map((i) => D / 2 + (i - 1) * PITCH), D / 2 - 6.3, '#f3ecfa', 0.55);
    silkPins(g, S, MIC_PINS.slice(3), [0, 1, 2].map((i) => D / 2 + (i - 1) * PITCH), D / 2 - 4.4 + PITCH + 1.9, '#f3ecfa', 0.55);
    g.strokeStyle = '#f3ecfa';
    g.lineWidth = 0.15 * S;
    g.beginPath();
    g.arc(c / 2, c / 2 + 3.4 * S, 1.6 * S, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#f3ecfa';
    g.font = `bold ${0.75 * S}px Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.fillText('INMP441', c / 2, c / 2 + 6.0 * S);
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  const grp = new THREE.Group();
  const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.05 });
  const edge = new THREE.MeshStandardMaterial({ color: 0x35206a, roughness: 0.6 });
  const pcb = new THREE.Mesh(new THREE.CylinderGeometry(D / 2, D / 2, T, 48), [edge, top, edge]);
  pcb.position.y = 1.2 + T / 2;
  pcb.castShadow = pcb.receiveShadow = true;
  grp.add(pcb);
  const pcbTop = 1.2 + T;
  // Sound hole and bottom LGA mic (4.7 × 3.8, metal lid)
  const port = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16).rotateX(-Math.PI / 2), MAT.plastic);
  port.position.set(0, pcbTop + 0.01, 3.4);
  grp.add(port);
  const mic = new THREE.Mesh(new THREE.BoxGeometry(4.7, 1, 3.8), MAT.steel);
  mic.position.set(0, 0.7, 3.4);
  grp.add(mic);
  const m = new THREE.Matrix4();
  const feet = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 10), MAT.tin, 6);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, 8.5, 0.64), MAT.gold, 6);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(3 * PITCH, 2.5, 2 * PITCH), MAT.plastic);
  seat.position.set(0, pcbTop + 1.25, -4.4 + PITCH / 2);
  grp.add(seat);
  pinsAt.forEach(([x, z], i) => {
    feet.setMatrixAt(i, m.makeTranslation(x, 0.6, z));
    pins.setMatrixAt(i, m.makeTranslation(x, pcbTop + 4.25, z));
  });
  grp.add(feet, pins);
  const plugAt = pinsAt.map(([x, z]) => new THREE.Vector3(x, pcbTop + 2.5, z));
  // Pickup hint: a ring above the sound hole, shown when sound reaches the mic
  const ringMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.8, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.25, 6, 32).rotateX(Math.PI / 2), ringMat);
  ring.position.set(0, pcbTop + 3, 3.4);
  ring.visible = false;
  ring.raycast = () => {};
  grp.add(ring);
  return { grp, plugAt, labels: MIC_PINS, ring, ringMat, size: [D, D] as const };
}

/** 6×6 mm tactile switch + square keycap (the cap can carry one printed character) */
export function keySwitch(cap: string) {
  const grp = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(6, 3.4, 6), new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.7 }));
  base.position.y = 1.7;
  base.castShadow = true;
  grp.add(base);
  for (const [x, z] of [[-2.25, -3.1], [2.25, -3.1], [-2.25, 3.1], [2.25, 3.1]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.7, 3, 0.4), MAT.tin);
    leg.position.set(x, -0.6, z);
    grp.add(leg);
  }
  const tex = canvasTexture(128, 128, (g) => {
    g.fillStyle = '#F2EFE8';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#1E1E1E';
    g.font = '700 72px "JetBrains Mono", Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(cap, 64, 70);
  });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.55 });
  const topMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 });
  // Keycap: plain sides, printed top (BoxGeometry material order +x −x +y −y +z −z)
  const key = new THREE.Mesh(new THREE.BoxGeometry(9, 4, 9), [capMat, capMat, topMat, capMat, capMat, capMat]);
  key.position.y = 5.4;
  key.castShadow = true;
  key.userData.baseY = key.position.y;
  grp.add(key);
  return { grp, key };
}

/** Rotary potentiometer (R16): blue square case + metal shaft + black knob with indicator line. Origin at the leg base. */
export function potModel() {
  const grp = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(9.8, 9.8, 5), new THREE.MeshStandardMaterial({ color: 0x2e63b8, roughness: 0.6 }));
  shell.rotation.x = Math.PI / 2;
  shell.position.y = 3.5;
  shell.castShadow = true;
  grp.add(shell);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 4, 24), MAT.steel);
  shaft.position.y = 8;
  grp.add(shaft);
  const knob = new THREE.Group();
  const kmat = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.55 });
  const k = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 6, 7, 40), kmat);
  knob.add(k);
  const mark = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 4.6), new THREE.MeshBasicMaterial({ color: 0xf2a33a }));
  mark.position.set(0, 3.6, -2.6);
  knob.add(mark);
  knob.position.y = 13.5;
  knob.traverse((o) => (o.castShadow = true));
  grp.add(knob);
  for (const x of [-PITCH, 0, PITCH]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 0.6), MAT.tin);
    leg.position.set(x, -1, 0);
    grp.add(leg);
  }
  return { grp, knob, hit: k };
}

export function led(color: number) {
  const grp = new THREE.Group();
  const lens = new THREE.MeshPhysicalMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0,
    roughness: 0.15,
    transmission: 0.4,
    thickness: 2,
    transparent: true,
    opacity: 0.9,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 5.5, 32), lens);
  body.position.y = 2.75;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), lens);
  dome.position.y = 5.5;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 1, 32), lens);
  rim.position.y = 0.5;
  for (const p of [body, dome, rim]) {
    p.castShadow = true;
    grp.add(p);
  }
  for (const x of [-1.27, 1.27]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4, 8), MAT.tin);
    leg.position.set(x, -1.6, 0);
    grp.add(leg);
  }
  const light = new THREE.PointLight(color, 0, 60, 2);
  light.position.y = 6;
  grp.add(light);
  return { grp, lens, light };
}

export function resistor(ohm = 220) {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 4.2, 8, 16), new THREE.MeshStandardMaterial({ color: 0xd9c49a, roughness: 0.6 }));
  body.rotation.z = Math.PI / 2;
  body.position.y = 2.2;
  body.castShadow = true;
  grp.add(body);
  resistorBands(ohm).forEach((c, i) => {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.16, 0.45, 20), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));
    band.rotation.z = Math.PI / 2;
    band.position.set(-1.8 + i * 1.1 + (i === 3 ? 0.4 : 0), 2.2, 0);
    grp.add(band);
  });
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-5.08, -1.5, 0),
    new THREE.Vector3(-5.08, 1.6, 0),
    new THREE.Vector3(-4.2, 2.2, 0),
    new THREE.Vector3(4.2, 2.2, 0),
    new THREE.Vector3(5.08, 1.6, 0),
    new THREE.Vector3(5.08, -1.5, 0),
  ]);
  grp.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.25, 8), MAT.tin));
  return grp;
}
