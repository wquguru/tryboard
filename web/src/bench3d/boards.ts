// Devboards and the breadboard: board specs (pin order from Espressif user guides), silkscreen textures, devboard mesh.

import * as THREE from 'three';
import { EXT } from '../extmodels';
import type { PickTarget } from '../scene-api';
import { PITCH, type ExtSlot, MAT, canvasTexture, topPlane, roundRect, contactShadow, type PinRec, pinHits } from './util';

export type ChipId = 'esp32' | 'esp32c3' | 'esp32s3';

/** Devboard definition. j1 / j3 follow the header tables in Espressif's user guide, from pin 1 (antenna end), as printed on the silkscreen. */
export interface BoardSpec {
  chip: ChipId;
  title: string;
  /** Board name on the silkscreen (model number used descriptively, see LICENSING.md) */
  silk: string;
  /** Board width / length (mm) */
  W: number;
  L: number;
  j1: string[];
  j3: string[];
  /** Internal pin names ('IO4', '3V3', 'GND'…) numbered from the USB end; left = J1, right = J3. The editor lists usable GPIOs from this */
  left: string[];
  right: string[];
  /** Header centre offset from board centre along the long side, so every pin lands in a breadboard hole */
  headerZ: number;
  /** Header row spacing (mm): default 0.9″ lands on rows b / i; DevKitC V4 is 1″, fits only b / j, so the board shifts half a pitch */
  rowSpan?: number;
  module: { title: string; flash: string; W: number; L: number; shieldL: number };
  /** Two USB-C ports (UART bridge + native USB) or one */
  dualUsb: boolean;
  /** Older boards use micro-USB (ESP32-DevKitC V4) */
  microUsb?: boolean;
  /** GPIO of the onboard WS2812; -1 = none (DevKitC V4 only has a power LED) */
  rgbPin: number;
  bootPin: number;
  /** Breadboard column of the board centre, column count of the old half breadboard (part columns are relative to it), columns parts shift right */
  boardCol: number;
  cols: number;
  partOffset: number;
}

/** Silkscreen name → internal name: S3 boards print GPIOs as bare numbers and ground as G */
export const internalName = (s: string) => (/^\d+$/.test(s) ? 'IO' + s : s === 'G' ? 'GND' : s === 'VP' ? 'IO36' : s === 'VN' ? 'IO39' : s);
/** Internal name → scene-api id */
export const apiId = (n: string) => (/^IO\d+$/.test(n) ? 'GPIO' + n.slice(2) : n);

export function makeSpec(s: Omit<BoardSpec, 'left' | 'right'>): BoardSpec {
  return { ...s, left: [...s.j1].reverse().map(internalName), right: [...s.j3].reverse().map(internalName) };
}

/** ESP32-C3-DevKitM-1: 2×15 pins, ESP32-C3-MINI-1 module, RGB on GPIO8 */
export const BOARD_C3: BoardSpec = makeSpec({
  chip: 'esp32c3',
  title: 'ESP32-C3 DEV',
  silk: 'ESP32-C3-DevKitM-1',
  W: 25.4,
  L: 50.8,
  j1: ['GND', '3V3', '3V3', 'IO2', 'IO3', 'GND', 'RST', 'GND', 'IO0', 'IO1', 'IO10', 'GND', '5V', '5V', 'GND'],
  j3: ['GND', 'TX', 'RX', 'GND', 'IO9', 'IO8', 'GND', 'IO7', 'IO6', 'IO5', 'IO4', 'GND', 'IO18', 'IO19', 'GND'],
  headerZ: -2.54,
  module: { title: 'ESP32-C3-MINI-1', flash: 'H4', W: 13.2, L: 16.6, shieldL: 11.4 },
  dualUsb: false,
  rgbPin: 8,
  bootPin: 9,
  boardCol: 7,
  cols: 30,
  partOffset: 0,
});

/** ESP32-S3-DevKitC-1 v1.0: 2×22 pins, WROOM-1 (N16R8), two USB-C (UART / USB), RGB on GPIO48 (v1.1 moved it to GPIO38) */
export const BOARD_S3: BoardSpec = makeSpec({
  chip: 'esp32s3',
  title: 'ESP32-S3 DEV',
  silk: 'ESP32-S3-DevKitC-1',
  W: 25.4,
  L: 62.7,
  j1: ['3V3', '3V3', 'RST', '4', '5', '6', '7', '15', '16', '17', '18', '8', '3', '46', '9', '10', '11', '12', '13', '14', '5V', 'G'],
  j3: ['G', 'TX', 'RX', '1', '2', '42', '41', '40', '39', '38', '37', '36', '35', '0', '45', '48', '47', '21', '20', '19', 'G', 'G'],
  headerZ: -1.27,
  module: { title: 'ESP32-S3-WROOM-1', flash: 'N16R8', W: 18, L: 25.5, shieldL: 17.6 },
  dualUsb: true,
  rgbPin: 48,
  bootPin: 0,
  boardCol: 8,
  cols: 40,
  partOffset: 10,
});

/** ESP32-DevKitC V4: 2×19 pins (rows 1″ apart), WROOM-32E, micro-USB + CP2102, 54.4 × 27.9 mm. No user LED, only a red power LED
 *  (blink examples use an external LED on GPIO2). SD0–SD3 / CMD / CLK are wired to the module flash and unusable */
export const BOARD_E32: BoardSpec = makeSpec({
  chip: 'esp32',
  title: 'ESP32 DEV',
  silk: 'ESP32-DevKitC V4',
  W: 27.9,
  L: 54.4,
  j1: ['3V3', 'EN', 'VP', 'VN', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27', 'IO14', 'IO12', 'GND', 'IO13', 'SD2', 'SD3', 'CMD', '5V'],
  j3: ['GND', 'IO23', 'IO22', 'TX', 'RX', 'IO21', 'GND', 'IO19', 'IO18', 'IO5', 'IO17', 'IO16', 'IO4', 'IO0', 'IO2', 'IO15', 'SD1', 'SD0', 'CLK'],
  headerZ: -2.54,
  rowSpan: 25.4,
  module: { title: 'ESP32-WROOM-32E', flash: 'N4', W: 18, L: 25.5, shieldL: 17.6 },
  dualUsb: false,
  microUsb: true,
  rgbPin: -1,
  bootPin: 0,
  boardCol: 8,
  cols: 36,
  partOffset: 6,
});

export const BOARDS: Record<ChipId, BoardSpec> = { esp32: BOARD_E32, esp32c3: BOARD_C3, esp32s3: BOARD_S3 };

// Moved to chipid.ts (F-04a2) so dependency-free modules (place.ts, node tests) can use it
export { LCD_WIRING } from '../chipid';


// ---------------------------------------------------------------- breadboard

/** 830-hole breadboard (63 cols × 10 rows + four 50-hole power rails), 165.1 × 54.6 × 8.5 mm. Columns along x, rows a–j along z.
 *  2.54 mm grid; the board's two headers (22.86 mm apart) land on rows b / i, leaving a / j for jumpers, as on the real thing. */
export const BB = { cols: 63, W: 165.1, D: 54.6, H: 8.5, x: -PITCH / 2 };
export const rowZ = (r: number) => (r < 5 ? -(3.81 + (4 - r) * PITCH) : 3.81 + (r - 5) * PITCH);
export const RAILS = [-22.86, -20.32, 20.32, 22.86];

export function breadboard() {
  const grp = new THREE.Group();
  const { W, D, H, cols } = BB;
  const S = 14; // texture px / mm
  const cw = Math.round(W * S), ch = Math.round(D * S);
  const cx = (x: number) => (x + W / 2) * S;
  const cy = (z: number) => (z + D / 2) * S;
  const holeX = (j: number) => (j - (cols - 1) / 2) * PITCH;
  const holes: [number, number][] = [];
  for (let j = 0; j < cols; j++) for (let r = 0; r < 10; r++) holes.push([holeX(j), rowZ(r)]);
  for (const z of RAILS) for (let g = 0; g < 10; g++) for (let k = 0; k < 5; k++) holes.push([holeX(2 + g * 6 + k), z]);
  const drawHoles = (g: CanvasRenderingContext2D, bump: boolean) => {
    const hs = 1.1 * S;
    for (const [x, z] of holes) {
      const px = cx(x) - hs / 2, py = cy(z) - hs / 2;
      if (bump) {
        g.fillStyle = '#000';
        g.fillRect(px, py, hs, hs);
        continue;
      }
      // Square hole: darker top edge, lighter bottom edge so it looks recessed, with a glimpse of the metal clip
      const grad = g.createLinearGradient(0, py, 0, py + hs);
      grad.addColorStop(0, '#2a2a2a');
      grad.addColorStop(1, '#4a4a48');
      g.fillStyle = grad;
      g.fillRect(px, py, hs, hs);
      g.fillStyle = '#8c8c86';
      g.fillRect(px + hs * 0.3, py + hs * 0.55, hs * 0.4, hs * 0.18);
    }
  };
  const tex = canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#f4f2ec';
    g.fillRect(0, 0, cw, ch);
    // Power rail lines: red + outside, blue − inside
    for (const sgn of [-1, 1]) {
      for (const [z, color] of [[25.0, '#d6372c'], [18.2, '#2d62d0']] as const) {
        g.fillStyle = color;
        g.fillRect(cx(-74), cy(sgn * z) - 0.25 * S, 148 * S, 0.5 * S);
      }
    }
    g.fillStyle = '#d6372c';
    g.font = `bold ${2.2 * S}px Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const sgn of [-1, 1]) for (const x of [-77.5, 77.5]) {
      g.fillStyle = '#d6372c';
      g.fillText('+', cx(x), cy(sgn * 22.86));
      g.fillStyle = '#2d62d0';
      g.fillText('−', cx(x), cy(sgn * 20.32));
    }
    // Row letters a–j, column numbers 1 5 10 … (embossed light grey)
    g.fillStyle = '#9a978f';
    g.font = `${1.5 * S}px Helvetica, sans-serif`;
    'abcdefghij'.split('').forEach((ch2, r) => {
      g.fillText(ch2, cx(-W / 2 + 1.6), cy(rowZ(r)));
      g.fillText(ch2, cx(W / 2 - 1.6), cy(rowZ(r)));
    });
    for (let j = 0; j < cols; j++) {
      if (j !== 0 && (j + 1) % 5) continue;
      g.fillText(String(j + 1), cx(holeX(j)), cy(rowZ(0) - 2.3));
      g.fillText(String(j + 1), cx(holeX(j)), cy(rowZ(9) + 2.3));
    }
    drawHoles(g, false);
  });
  const bump = canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cw, ch);
    g.filter = `blur(${0.12 * S}px)`;
    drawHoles(g, true);
  });
  bump.colorSpace = THREE.NoColorSpace;
  const topMat = new THREE.MeshStandardMaterial({ map: tex, bumpMap: bump, bumpScale: 1.2, roughness: 0.72 });
  const sideMat = new THREE.MeshStandardMaterial({ color: 0xeeebe3, roughness: 0.75 });
  const uvOf = (x: number, z: number): [number, number] => [(x + W / 2) / W, 1 - (z + D / 2) / D];
  const G = 1.3; // half width of the centre groove
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? -D / 2 : G, z1 = s < 0 ? -G : D / 2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, z1 - z0), sideMat);
    body.position.set(0, H / 2, (z0 + z1) / 2);
    body.castShadow = body.receiveShadow = true;
    grp.add(body);
    const top = new THREE.Mesh(topPlane(-W / 2, W / 2, z0, z1, H + 0.01, uvOf), topMat);
    top.receiveShadow = true;
    grp.add(top);
  }
  const grooveFloor = new THREE.Mesh(new THREE.BoxGeometry(W, H - 2.6, 2 * G), new THREE.MeshStandardMaterial({ color: 0xdedad0, roughness: 0.8 }));
  grooveFloor.position.y = (H - 2.6) / 2;
  grooveFloor.receiveShadow = true;
  grp.add(grooveFloor);
  grp.add(contactShadow(W, D, 0.3));
  grp.position.x = BB.x;
  return grp;
}

export function silkTexture(spec: BoardSpec, pinX: number, pinZ: (i: number) => number) {
  // PCB top: black solder mask + white silkscreen, drawn USB-down / J1-left as on the real board (UVs map accordingly)
  const S = 40;
  const { W, L } = spec;
  const cw = Math.round(W * S), ch = Math.round(L * S);
  const cx = (x: number) => (W / 2 - x) * S;
  const cy = (z: number) => (L / 2 - z) * S;
  const n = spec.j1.length;
  return canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#121316';
    g.fillRect(0, 0, cw, ch);
    // Faint traces (copper under the mask)
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 0.25 * S;
    for (let i = 0; i < n; i += 2) {
      g.beginPath();
      g.moveTo(cx(pinX - 1.4), cy(pinZ(i)));
      g.lineTo(cx(3), cy(pinZ(i) + 2));
      g.moveTo(cx(-pinX + 1.4), cy(pinZ(i)));
      g.lineTo(cx(-3), cy(pinZ(i) - 2));
      g.stroke();
    }
    // Pads
    for (let i = 0; i < n; i++) {
      for (const x of [pinX, -pinX]) {
        g.fillStyle = '#d9b860';
        g.beginPath();
        g.arc(cx(x), cy(pinZ(i)), 0.85 * S, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Pin labels: J1 left (+x), J3 right (−x), inside the pins; pin 1 (antenna end) gets a silkscreen box
    g.fillStyle = '#f2f2f2';
    g.textBaseline = 'middle';
    g.font = `bold ${1.15 * S}px "JetBrains Mono", Menlo, monospace`;
    for (let i = 0; i < n; i++) {
      const z = pinZ(n - 1 - i); // j1[i]: i=0 is the antenna end
      g.textAlign = 'left';
      g.fillText(spec.j1[i], cx(pinX - 1.3), cy(z));
      g.textAlign = 'right';
      g.fillText(spec.j3[i], cx(-pinX + 1.3), cy(z));
    }
    g.strokeStyle = '#f2f2f2';
    g.lineWidth = 0.15 * S;
    for (const x of [pinX, -pinX]) g.strokeRect(cx(x) - 1.2 * S, cy(pinZ(n - 1)) - 1.2 * S, 2.4 * S, 2.4 * S);
    g.textAlign = 'center';
    g.font = `bold ${0.9 * S}px Helvetica, sans-serif`;
    g.fillText('J1', cx(pinX), cy(pinZ(n - 1) + 2.2));
    g.fillText('J3', cx(-pinX), cy(pinZ(n - 1) + 2.2));
    // Board name, buttons, USB labels
    g.font = `bold ${1.2 * S}px Helvetica, sans-serif`;
    g.fillText(spec.silk, cx(0), cy(L / 2 - spec.module.L - 2.6));
    g.font = `bold ${0.95 * S}px Helvetica, sans-serif`;
    g.fillText('BOOT', cx(W * 0.26), cy(-L / 2 + 13.6));
    g.fillText(spec.chip === 'esp32' ? 'EN' : 'RST', cx(-W * 0.26), cy(-L / 2 + 13.6));
    if (spec.dualUsb) {
      g.fillText('USB', cx(W * 0.21), cy(-L / 2 + 8.4));
      g.fillText('UART', cx(-W * 0.21), cy(-L / 2 + 8.4));
    }
    g.font = `${0.8 * S}px Helvetica, sans-serif`;
    if (spec.rgbPin >= 0) g.fillText('RGB', cx(-W * 0.06), cy(-L / 2 + 20.3));
  });
}

export function shieldTexture(spec: BoardSpec, w: number, l: number) {
  // Shield top: brushed metal + laser marking (map and bump drawn together so the marking looks slightly engraved)
  const S = 48;
  const cw = Math.round(w * S), ch = Math.round(l * S);
  const text = (g: CanvasRenderingContext2D, color: string) => {
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${1.55 * S}px Helvetica, sans-serif`;
    g.fillText(spec.module.title, cw / 2, ch * 0.32);
    g.font = `${1.1 * S}px "JetBrains Mono", Menlo, monospace`;
    g.fillText(spec.module.flash, cw / 2, ch * 0.32 + 2.2 * S);
    g.strokeStyle = color;
    g.lineWidth = 0.1 * S;
    // Block where the QR code sits
    const q = 4.2 * S;
    g.strokeRect(cw / 2 - q / 2, ch * 0.62, q, q);
    for (let i = 0; i < 36; i++) if ((i * 7919) % 3 === 0) g.fillRect(cw / 2 - q / 2 + (i % 6) * (q / 6), ch * 0.62 + Math.floor(i / 6) * (q / 6), q / 6, q / 6);
  };
  const map = canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#b9bdc3';
    g.fillRect(0, 0, cw, ch);
    for (let y = 0; y < ch; y += 2) {
      g.fillStyle = `rgba(${(y * 37) % 2 ? 255 : 0},${(y * 37) % 2 ? 255 : 0},${(y * 37) % 2 ? 255 : 0},${0.03 + ((y * 7) % 5) * 0.008})`;
      g.fillRect(0, y, cw, 1);
    }
    text(g, '#5d6168');
  });
  const bump = canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cw, ch);
    text(g, '#000');
  });
  bump.colorSpace = THREE.NoColorSpace;
  return { map, bump };
}

export function modulePcbTexture(spec: BoardSpec) {
  // Module base: dark mask, meandering antenna copper, castellated edge holes
  const { W, L, shieldL } = spec.module;
  const S = 40;
  const cw = Math.round(W * S), ch = Math.round(L * S);
  return canvasTexture(cw, ch, (g) => {
    g.fillStyle = '#1b2026';
    g.fillRect(0, 0, cw, ch);
    const antL = L - shieldL - 1;
    g.strokeStyle = '#a88a4a';
    g.lineWidth = 0.45 * S;
    g.beginPath();
    const y0 = 0.8 * S, y1 = (antL - 0.8) * S;
    let x = 1.6 * S;
    g.moveTo(x, y1);
    for (let i = 0; i < 7; i++) {
      g.lineTo(x, y0);
      x += 1.1 * S;
      g.lineTo(x, y0);
      g.lineTo(x, y1 * 0.8);
      x += 1.1 * S;
      g.lineTo(x, y1 * 0.8);
    }
    g.stroke();
    g.fillStyle = '#d9b860';
    for (let z = antL + 1.2; z < L - 0.5; z += 1.27) {
      g.beginPath();
      g.arc(0, z * S, 0.35 * S, 0, Math.PI * 2);
      g.arc(cw, z * S, 0.35 * S, 0, Math.PI * 2);
      g.fill();
    }
  });
}

export function devboard(spec: BoardSpec) {
  const grp = new THREE.Group();
  grp.userData.pick = { kind: 'part', id: 'board' } satisfies PickTarget;
  const { W, L } = spec;
  const T = 1.6;
  const n = spec.j1.length;
  const pinX = (spec.rowSpan ?? 22.86) / 2; // default 0.9″ (22.86 mm) header spacing lands exactly on breadboard rows b / i
  // z of pin i (counted from the USB end)
  const pinZ = (i: number) => spec.headerZ + (i - (n - 1) / 2) * PITCH;

  // PCB: black sides, silkscreen texture on top
  const pcbSide = new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.6 });
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(W, T, L), pcbSide);
  pcb.castShadow = pcb.receiveShadow = true;
  grp.add(pcb);
  const silk = silkTexture(spec, pinX, pinZ);
  const top = new THREE.Mesh(
    topPlane(-W / 2, W / 2, -L / 2, L / 2, T / 2 + 0.005, (x, z) => [(W / 2 - x) / W, (z + L / 2) / L]),
    new THREE.MeshStandardMaterial({ map: silk, roughness: 0.42, metalness: 0.05 }),
  );
  top.receiveShadow = true;
  grp.add(top);

  // Module: PCB base (with antenna area) + metal shield (engraved model)
  const md = spec.module;
  const modZ = L / 2 - md.L / 2;
  const modBase = new THREE.Mesh(new THREE.BoxGeometry(md.W, 0.8, md.L), new THREE.MeshStandardMaterial({ color: 0x1b2026, roughness: 0.55 }));
  modBase.position.set(0, T / 2 + 0.4, modZ);
  modBase.castShadow = true;
  grp.add(modBase);
  const modTop = new THREE.Mesh(
    topPlane(-md.W / 2, md.W / 2, modZ - md.L / 2, modZ + md.L / 2, T / 2 + 0.81, (x, z) => [(md.W / 2 - x) / md.W, (z - (modZ - md.L / 2)) / md.L]),
    new THREE.MeshStandardMaterial({ map: modulePcbTexture(spec), roughness: 0.45 }),
  );
  grp.add(modTop);
  const shW = md.W - 1.4, shL = md.shieldL, shH = 2.3;
  const shZ = modZ - md.L / 2 + 0.7 + shL / 2;
  const metal = new THREE.MeshStandardMaterial({ color: 0xc3c7cc, metalness: 1, roughness: 0.3 });
  const shield = new THREE.Mesh(new THREE.BoxGeometry(shW, shH, shL), metal);
  shield.position.set(0, T / 2 + 0.8 + shH / 2, shZ);
  shield.castShadow = true;
  grp.add(shield);
  const st = shieldTexture(spec, shW, shL);
  const shieldTop = new THREE.Mesh(
    topPlane(-shW / 2, shW / 2, shZ - shL / 2, shZ + shL / 2, T / 2 + 0.8 + shH + 0.005, (x, z) => [(shW / 2 - x) / shW, (z - (shZ - shL / 2)) / shL]),
    new THREE.MeshStandardMaterial({ map: st.map, bumpMap: st.bump, bumpScale: 0.6, metalness: 0.9, roughness: 0.34 }),
  );
  grp.add(shieldTop);

  // USB-C: stainless shell (stadium section) + black tongue. One on C3, two on S3 (left native USB, right UART bridge)
  const usbX = spec.dualUsb ? [W * 0.21, -W * 0.21] : [0];
  const mu = !!spec.microUsb;
  const shellShape = mu ? roundRect(7.5, 2.45, 0.6) : roundRect(8.94, 3.26, 1.6);
  shellShape.holes.push(mu ? roundRect(6.9, 1.85, 0.4, new THREE.Path()) : roundRect(8.3, 2.62, 1.3, new THREE.Path()));
  const shellGeo = new THREE.ExtrudeGeometry(shellShape, { depth: mu ? 5 : 7.35, bevelEnabled: false, curveSegments: 10 });
  const uy = mu ? 1.23 : 1.63;
  const extSlots: ExtSlot[] = [];
  for (const x of usbX) {
    const shell = new THREE.Mesh(shellGeo, MAT.steel);
    shell.position.set(x, T / 2 + uy, -L / 2 - 0.6);
    shell.castShadow = true;
    grp.add(shell);
    const back = new THREE.Mesh(mu ? new THREE.BoxGeometry(6.9, 1.8, 0.4) : new THREE.BoxGeometry(8.3, 2.6, 0.4), MAT.steel);
    back.position.set(x, T / 2 + uy, -L / 2 - 0.6 + (mu ? 4.8 : 7.1));
    grp.add(back);
    const inner = new THREE.Mesh(mu ? new THREE.BoxGeometry(6.8, 1.7, 4.4) : new THREE.BoxGeometry(8.2, 2.5, 6.6), MAT.plastic);
    inner.position.set(x, T / 2 + uy, -L / 2 - 0.6 + (mu ? 2.8 : 3.9));
    grp.add(inner);
    const tongue = new THREE.Mesh(mu ? new THREE.BoxGeometry(5.2, 0.5, 3) : new THREE.BoxGeometry(6.6, 0.7, 4.2), MAT.plug);
    tongue.position.set(x, T / 2 + uy, -L / 2 - 0.6 + (mu ? 1.6 : 2.0));
    grp.add(tongue);
    // Optional KiCad GCT USB4105 receptacle (glb opening +z, SMD face y=0, shell 7.4 mm): rotate 180° so it opens at the board edge
    if (!mu) extSlots.push({
      root: grp,
      name: EXT.usbC,
      proc: [shell, back, inner, tongue],
      fit(m) {
        if (!m) return;
        m.rotation.y = Math.PI;
        m.position.set(x, T / 2, -L / 2 - 0.6 + 3.7);
      },
    });
  }

  // BOOT / RST buttons (SMD tact switch: black base + metal plate + plunger)
  const buttons: THREE.Mesh[] = [];
  for (const [name, x] of [['BOOT', W * 0.26], ['RST', -W * 0.26]] as const) {
    const bz = -L / 2 + 10.5;
    const pick = { kind: 'button', id: name } satisfies PickTarget;
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.0, 3.2), MAT.plastic);
    base.position.set(x, T / 2 + 0.5, bz);
    base.userData.pick = pick;
    grp.add(base);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.15, 2.8), MAT.steel);
    plate.position.set(x, T / 2 + 1.08, bz);
    plate.userData.pick = pick;
    grp.add(plate);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.7, 24), MAT.plug);
    cap.position.set(x, T / 2 + 1.5, bz);
    cap.name = name;
    cap.userData.baseY = cap.position.y;
    cap.userData.pick = pick;
    grp.add(cap);
    buttons.push(cap);
  }

  // Other onboard parts: USB-UART bridge, LDO, SMD passives (instanced, one draw call)
  const chips: [number, number, number, number, number][] = [
    // x, z, w, l, h
    [0, -L / 2 + 28, 5.0, 3.5, 1.6], // LDO SOT-223
    ...(spec.dualUsb ? ([[W * 0.2, -L / 2 + 17, 4, 4, 0.85]] as [number, number, number, number, number][]) : []),
    ...(spec.microUsb ? ([[-W * 0.05, -L / 2 + 16, 5, 5, 0.9]] as [number, number, number, number, number][]) : []),
  ];
  const chipMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), MAT.chip, chips.length);
  const m = new THREE.Matrix4();
  chips.forEach(([x, z, w, l, h], i) => chipMesh.setMatrixAt(i, m.compose(new THREE.Vector3(x, T / 2 + h / 2, z), new THREE.Quaternion(), new THREE.Vector3(w, h, l))));
  chipMesh.castShadow = true;
  grp.add(chipMesh);
  const smd: [number, number, number][] = [];
  for (let k = 0; k < 14; k++) {
    const x = ((k % 5) - 2) * 2.2 + (k > 9 ? 1 : 0);
    const z = -L / 2 + 21.5 + Math.floor(k / 5) * 1.6 + (k % 2) * 0.3;
    smd.push([x, z, k % 3]);
  }
  for (let k = 0; k < 4; k++) smd.push([((k % 2) ? 1 : -1) * 4.6, -L / 2 + 27.2 + Math.floor(k / 2) * 1.8, (k + 1) % 3]);
  const smdMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.5, 0.8), new THREE.MeshStandardMaterial({ roughness: 0.5 }), smd.length);
  const colors = [new THREE.Color(0x1a1a1a), new THREE.Color(0xa58a62), new THREE.Color(0x8a7a66)];
  smd.forEach(([x, z, c], i) => {
    smdMesh.setMatrixAt(i, m.makeTranslation(x, T / 2 + 0.25, z));
    smdMesh.setColorAt(i, colors[c]);
  });
  grp.add(smdMesh);

  // Onboard power LED (red, 0603)
  const pwrMat = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0xff2010, emissiveIntensity: 0 });
  const pwr = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.8), pwrMat);
  pwr.position.set(W * 0.2, T / 2 + 0.3, -L / 2 + 20.6);
  grp.add(pwr);

  // Onboard WS2812 (5050): white plastic frame + translucent diffuser
  const rgbZ = -L / 2 + 17.0;
  const rgbX = -W * 0.06;
  const rgbBody = new THREE.Mesh(new THREE.BoxGeometry(5, 1.5, 5), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.6 }));
  rgbBody.position.set(rgbX, T / 2 + 0.75, rgbZ);
  rgbBody.castShadow = true;
  if (spec.rgbPin >= 0) grp.add(rgbBody);
  const rgbMat = new THREE.MeshStandardMaterial({ color: 0xdedbd2, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.3 });
  const rgbLens = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.1, 32), rgbMat);
  rgbLens.position.set(rgbX, T / 2 + 1.52, rgbZ);
  if (spec.rgbPin >= 0) grp.add(rgbLens);
  const rgbLight = new THREE.PointLight(0xffffff, 0, 70, 2);
  rgbLight.position.set(rgbX, T / 2 + 5, rgbZ);
  if (spec.rgbPin >= 0) grp.add(rgbLight);

  // Headers: per-pin black plastic block, gold pin and top solder joint (all instanced)
  const headerY = -T / 2 - 1.25;
  const pinTop = T / 2 + 1.0, pinBot = -T / 2 - 2.5 - 6;
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(2.5, 2.5, 2.42), MAT.plastic, 2 * n);
  const pins = new THREE.InstancedMesh(new THREE.BoxGeometry(0.64, pinTop - pinBot, 0.64), MAT.gold, 2 * n);
  const solderGeo = new THREE.SphereGeometry(0.85, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  solderGeo.scale(1, 0.7, 1);
  const solder = new THREE.InstancedMesh(solderGeo, MAT.tin, 2 * n);
  const recs: PinRec[] = [];
  const centers: THREE.Vector3[] = [];
  const pinPositions: Record<string, THREE.Vector3> = {};
  let k = 0;
  for (const [side, x, names, silkNames] of [['L', pinX, spec.left, [...spec.j1].reverse()], ['R', -pinX, spec.right, [...spec.j3].reverse()]] as const) {
    for (let i = 0; i < n; i++) {
      const z = pinZ(i);
      blocks.setMatrixAt(k, m.makeTranslation(x, headerY, z));
      pins.setMatrixAt(k, m.makeTranslation(x, (pinTop + pinBot) / 2, z));
      solder.setMatrixAt(k, m.makeTranslation(x, T / 2, z));
      k++;
      pinPositions[side + i] = new THREE.Vector3(x, 0, z);
      recs.push({ id: apiId(names[i]), label: silkNames[i], name: names[i], anchor: new THREE.Vector3(x, pinTop, z), parent: grp });
      centers.push(new THREE.Vector3(x, (pinTop + headerY - 1.25) / 2, z));
    }
  }
  blocks.castShadow = true;
  pins.castShadow = true;
  for (const im of [blocks, pins, solder]) grp.add(im);
  const pinRecs: PinRec[] = [];
  pinHits(grp, recs, centers, [2.3, pinTop - headerY + 1.25 + 0.6, 2.3], pinRecs);
  // Native USB port mouth (used by setUsb)
  const usbPort = new THREE.Vector3(usbX[0], T / 2 + 1.6, -L / 2 - 0.6);
  return { grp, buttons, pwrMat, rgbMat, rgbLight, pinPositions, pinRecs, usbPort, L, T, spec, extSlots };
}
