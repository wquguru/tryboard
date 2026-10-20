// M5Stack enclosures (M5-09c): one parametric generator over a per-board table (mm, real outside dimensions).
// Procedural only: product names as plain text, no logos or vendor artwork.
import * as THREE from 'three';
import type { PickTarget } from '../scene-api';
import { MAT, canvasTexture, roundRect } from './util';
import type { BoardSpec } from './boards';
import type { BoardId, M5Id } from './boarddevs';
import type { LedState } from './ctx';
import { AIO_CHIP } from '../chipid';
import { remapUv } from './amoled';

type Side = 'left' | 'right' | 'front' | 'back';
interface Btn {
  name: string;
  pin: number;
  /** top = cap on the top face, face = the screen plate itself is the key (Atom / Dial), left / right = side key */
  at: 'top' | 'face' | Side;
  x: number;
  z: number;
  w: number;
  l: number;
}
interface Shell {
  label: string;
  W: number;
  L: number;
  H: number;
  r: number;
  color: number;
  /** Panel: frame size in px (= tb_lcd_w / h), active area mm, centre, glass plate mm; round = circular panel */
  lcd?: { px: [number, number]; mm: [number, number]; x: number; z: number; glass: [number, number]; round?: boolean };
  touch?: boolean;
  /** Rotary ring the panel sits in (Dial): radius, height above the body */
  ring?: [number, number];
  buttons: Btn[];
  /** WS2812 under the top key (Atom Lite family) or a plain GPIO LED (lens at x, z) */
  ws2812?: number;
  gpioLed?: { pin: number; x: number; z: number };
  grove: { side: Side; at: number };
  usb: { side: Side; at: number };
  /** Printed touch zones below the panel (Core2 A / B / C, visual only) */
  zones?: number;
  keyboard?: boolean;
  camera?: boolean;
  /** Label centre on the top face; null = no room */
  text?: [number, number, number] | null;
}

// Panel active areas: 1.14″ 135×240 ≈ 14.9 × 26.4, 0.85″ 128² ≈ 15.3², 2.0″ 320×240 ≈ 40.8 × 30.6, 1.28″ round ≈ Ø32.4
const STICK: Shell = {
  label: 'M5StickC Plus2', W: 25, L: 54, H: 16, r: 4, color: 0xe2712c,
  lcd: { px: [135, 240], mm: [14.9, 26.4], x: 0, z: -6, glass: [21, 34] },
  buttons: [
    { name: 'A', pin: 37, at: 'top', x: 0, z: 18, w: 11, l: 7 },
    { name: 'B', pin: 39, at: 'right', x: 0, z: -10, w: 1.2, l: 6 },
    { name: 'C', pin: 35, at: 'left', x: 0, z: -14, w: 1.2, l: 6 },
  ],
  gpioLed: { pin: 19, x: 6, z: -25 },
  grove: { side: 'back', at: 0 },
  usb: { side: 'front', at: 0 },
  text: null,
};
const CORE: Shell = {
  label: 'Core2', W: 54, L: 54, H: 16, r: 5, color: 0x2a2c30,
  lcd: { px: [320, 240], mm: [40.8, 30.6], x: 0, z: -4, glass: [50, 44] },
  touch: true, buttons: [], zones: 3,
  grove: { side: 'left', at: 6 },
  usb: { side: 'right', at: 6 },
  text: [0, 24.5, 18],
};
const ATOM: Shell = {
  label: 'AtomS3', W: 24, L: 24, H: 13, r: 3, color: 0x2f3135,
  lcd: { px: [128, 128], mm: [15.3, 15.3], x: 0, z: -1, glass: [21, 21] },
  buttons: [{ name: 'A', pin: 41, at: 'face', x: 0, z: 0, w: 0, l: 0 }],
  grove: { side: 'front', at: 0 },
  usb: { side: 'left', at: 0 },
  text: null,
};
const ATOM_LITE: Shell = {
  label: 'AtomS3 Lite', W: 24, L: 24, H: 10, r: 3, color: 0x2f3135,
  buttons: [{ name: 'A', pin: 41, at: 'top', x: 0, z: 0, w: 11, l: 11 }],
  ws2812: 35,
  grove: { side: 'front', at: 0 },
  usb: { side: 'left', at: 0 },
  text: null,
};
const CARD: Shell = {
  label: 'Cardputer', W: 84, L: 54, H: 19.7, r: 4, color: 0xd9d9d4,
  lcd: { px: [240, 135], mm: [26.4, 14.9], x: -22, z: -14, glass: [34, 22] },
  buttons: [{ name: 'A', pin: 0, at: 'top', x: 34, z: -20, w: 4, l: 4 }],
  keyboard: true,
  grove: { side: 'back', at: 26 },
  usb: { side: 'right', at: -18 },
  text: [14, -14, 26],
};

const SHELLS: Record<M5Id, Shell> = {
  m5stickcplus2: STICK,
  m5core2: CORE,
  m5core2v11: { ...CORE, label: 'Core2 v1.1' },
  m5cores3: { ...CORE, label: 'CoreS3', zones: 0, camera: true, color: 0x3a3c40 },
  m5cores3se: { ...CORE, label: 'CoreS3 SE', zones: 0, color: 0x3a3c40 },
  m5atoms3: ATOM,
  m5atoms3r: { ...ATOM, label: 'AtomS3R' },
  m5atoms3lite: ATOM_LITE,
  m5atomlite: { ...ATOM_LITE, label: 'Atom Lite', buttons: [{ ...ATOM_LITE.buttons[0], pin: 39 }], ws2812: 27 },
  m5dial: {
    label: 'Dial', W: 45, L: 45, H: 14, r: 8, color: 0x3a3c40,
    lcd: { px: [240, 240], mm: [32.4, 32.4], x: 0, z: 0, glass: [36, 36], round: true },
    touch: true, ring: [22, 10],
    buttons: [{ name: 'A', pin: 42, at: 'face', x: 0, z: 0, w: 0, l: 0 }],
    grove: { side: 'back', at: -8 },
    usb: { side: 'back', at: 8 },
    text: null,
  },
  m5cardputer: CARD,
  m5cardputeradv: { ...CARD, label: 'Cardputer-Adv' },
};

/** Outward normal (x, z) of a side and the point on that wall at offset `at` along it */
function wall(s: Shell, side: Side, at: number, out = 0): [number, number] {
  if (side === 'left') return [-s.W / 2 - out, at];
  if (side === 'right') return [s.W / 2 + out, at];
  return [at, side === 'back' ? -s.L / 2 - out : s.L / 2 + out];
}

/** Flat text plate lying on a surface (label or key legend), w mm wide */
function textPlate(text: string, w: number, color: string) {
  const tex = canvasTexture(512, 64, (g) => {
    g.fillStyle = color;
    g.font = 'bold 40px Helvetica, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 34);
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 8), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** Grove HY2.0-4P socket set into a side wall: white housing with a dark mouth */
function groveSocket(s: Shell, top: number) {
  const g = new THREE.Group();
  const along = s.grove.side === 'left' || s.grove.side === 'right';
  const [x, z] = wall(s, s.grove.side, s.grove.at, 0.4);
  const body = new THREE.Mesh(new THREE.BoxGeometry(along ? 1.2 : 10, 5.6, along ? 10 : 1.2), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.5 }));
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(along ? 1.3 : 8.4, 3.6, along ? 8.4 : 1.3), MAT.plug);
  const y = Math.min(0, top - 4);
  body.position.set(x, y, z);
  mouth.position.set(x + (s.grove.side === 'left' ? -0.1 : s.grove.side === 'right' ? 0.1 : 0), y, z + (s.grove.side === 'back' ? -0.1 : s.grove.side === 'front' ? 0.1 : 0));
  g.add(body, mouth);
  g.name = 'grove-a';
  return g;
}

/** Cardputer key field: 4 rows × 14 caps as one instanced mesh (the host keyboard drives tb_board_key) */
function keyCaps(s: Shell, top: number) {
  const cols = 14, rows = 4, px = 5.7, pz = 6.1;
  const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(4.6, 1.4, 4.8), new THREE.MeshStandardMaterial({ color: 0x4a4c50, roughness: 0.55 }), cols * rows);
  const m = new THREE.Matrix4();
  const z0 = s.L / 2 - 4 - (rows - 0.5) * pz;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) caps.setMatrixAt(r * cols + c, m.makeTranslation((c - (cols - 1) / 2) * px, top + 0.7, z0 + r * pz));
  caps.castShadow = true;
  return caps;
}

/** Same record shape as amoledBoard(): flat on the desk, screen mesh fed by the scene's DataTexture */
export function m5Shell(id: M5Id) {
  const s = SHELLS[id];
  const { W, L, H } = s;
  const grp = new THREE.Group();
  grp.userData.pick = { kind: 'part', id: 'board' } satisfies PickTarget;
  const body = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.58 });
  const b = 0.8;
  const geo = new THREE.ExtrudeGeometry(roundRect(W - 2 * b, L - 2 * b, s.r - b), { depth: H - 2 * b, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 3, curveSegments: 12 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -(H - 2 * b) / 2, 0);
  const box = new THREE.Mesh(geo, shellMat);
  box.castShadow = box.receiveShadow = true;
  body.add(box);
  grp.add(body);
  let top = H / 2;
  if (s.ring) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(s.ring[0], s.ring[0], s.ring[1], 64), new THREE.MeshStandardMaterial({ color: 0xe86a2a, roughness: 0.45 }));
    ring.position.y = top + s.ring[1] / 2;
    // Pressing the knob anywhere off the touch glass presses the key under it
    ring.userData.pick = { kind: 'button', id: 'A' } satisfies PickTarget;
    grp.add(ring);
    top += s.ring[1];
  }

  // Panel: black glass plate (the Atom / Dial key when `face`), emissive screen 0.05 mm above it
  const buttons: THREE.Mesh[] = [];
  let screen: THREE.Mesh | null = null;
  const faceBtn = s.buttons.find((k) => k.at === 'face');
  if (s.lcd) {
    const { mm, glass, round } = s.lcd;
    const gh = 0.8;
    const glassGeo = round ? new THREE.CylinderGeometry(glass[0] / 2, glass[0] / 2, gh, 64) : new THREE.BoxGeometry(glass[0], gh, glass[1]);
    const plate = new THREE.Mesh(glassGeo, new THREE.MeshStandardMaterial({ color: 0x060607, roughness: 0.12, metalness: 0.2 }));
    plate.position.set(s.lcd.x, top + gh / 2, s.lcd.z);
    grp.add(plate);
    const scrGeo = round ? new THREE.CircleGeometry(mm[0] / 2, 64) : new THREE.PlaneGeometry(mm[0], mm[1]);
    if (!round) remapUv(scrGeo, mm[0], mm[1], 'xy');
    screen = new THREE.Mesh(scrGeo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
    screen.rotation.x = -Math.PI / 2;
    screen.position.set(0, gh / 2 + 0.05, 0);
    screen.renderOrder = 1;
    plate.add(screen);
    if (faceBtn) {
      plate.name = faceBtn.name;
      plate.userData = { baseY: plate.position.y, gpio: faceBtn.pin, pick: { kind: 'button', id: faceBtn.name } satisfies PickTarget };
      buttons.push(plate);
      // On a touch panel the glass is the finger surface, the key is the rim / ring around it
      if (s.touch) screen.userData.pick = { kind: 'part', id: 'board' } satisfies PickTarget;
    }
  }

  // WS2812 boards: the milky top key is the LED diffuser, so the key cap carries the RGB material
  const rgbMat = new THREE.MeshStandardMaterial({ color: s.ws2812 !== undefined ? 0xdedcd6 : 0x000000, roughness: 0.35 });
  const rgbLight = new THREE.PointLight(0xffffff, 0, 30, 2);
  for (const k of s.buttons) {
    if (k.at === 'face') continue;
    const pick = { kind: 'button', id: k.name } satisfies PickTarget;
    let cap: THREE.Mesh;
    if (k.at === 'top') {
      cap = new THREE.Mesh(new THREE.BoxGeometry(k.w, 1.2, k.l), s.ws2812 !== undefined ? rgbMat : MAT.plug);
      cap.position.set(k.x, H / 2 + 0.6, k.z);
      if (s.ws2812 !== undefined) {
        rgbLight.position.set(k.x, H / 2 + 4, k.z);
        grp.add(rgbLight);
      }
    } else {
      const [x, z] = wall(s, k.at, k.z, 0.5);
      const side = k.at === 'left' || k.at === 'right';
      cap = new THREE.Mesh(new THREE.BoxGeometry(side ? 1.4 : k.l, 3, side ? k.l : 1.4), MAT.plug);
      cap.position.set(x, 1, z);
    }
    cap.name = k.name;
    cap.userData = { baseY: cap.position.y, gpio: k.pin, pick };
    grp.add(cap);
    buttons.push(cap);
  }

  // Plain GPIO LED (StickC Plus2 red LED): rides the bench LED animation like a breadboard LED
  const gpioLeds: LedState[] = [];
  if (s.gpioLed) {
    const lens = new THREE.MeshPhysicalMaterial({ color: 0x7a1010, emissive: 0xff2010, emissiveIntensity: 0, roughness: 0.3 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 1.2), lens);
    m.position.set(s.gpioLed.x, H / 2 + 0.2, s.gpioLed.z);
    const light = new THREE.PointLight(0xff3020, 0, 20, 2);
    light.position.set(s.gpioLed.x, H / 2 + 3, s.gpioLed.z);
    grp.add(m, light);
    gpioLeds.push({ pin: s.gpioLed.pin, lens, light, now: 0, target: 0 });
  }

  for (let i = 0; i < (s.zones ?? 0); i++) {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(1.4, 24), new THREE.MeshBasicMaterial({ color: 0xc8ccd2 }));
    dot.rotation.x = -Math.PI / 2;
    dot.position.set((i - 1) * 14, top + 0.02, 21);
    grp.add(dot);
  }
  if (s.camera) {
    const cam = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.3, 24), MAT.chip);
    cam.position.set(0, top + 0.95, -20.5);
    grp.add(cam);
  }
  if (s.keyboard) grp.add(keyCaps(s, top));
  if (s.text) {
    const t = textPlate(s.label, s.text[2], s.color < 0x808080 ? '#d8dbe0' : '#3a3c40');
    t.position.set(s.text[0], top + 0.03, s.text[1]);
    grp.add(t);
  }
  grp.add(groveSocket(s, H / 2));
  // USB-C mouth on the given wall; usbPort is where the bench's virtual cable plugs in
  const along = s.usb.side === 'left' || s.usb.side === 'right';
  const [ux, uz] = wall(s, s.usb.side, s.usb.at, 0.1);
  const usb = new THREE.Mesh(new THREE.BoxGeometry(along ? 0.6 : 8.9, 3.2, along ? 8.9 : 0.6), MAT.steel);
  usb.position.set(ux, -1, uz);
  grp.add(usb);
  const [px, pz] = wall(s, s.usb.side, s.usb.at, 4);
  const usbPort = new THREE.Vector3(px, -1, pz);

  const pwrMat = new THREE.MeshStandardMaterial({ color: 0x000000 });
  const spec: BoardSpec = {
    chip: AIO_CHIP[id], title: s.label, silk: s.label, W, L, j1: [], j3: [], left: [], right: [], headerZ: 0,
    module: { title: '', flash: '', W: 7, L: 7, shieldL: 0 }, dualUsb: false, rgbPin: -1, bootPin: 0, boardCol: 0, cols: 1, partOffset: 0,
  };
  return {
    grp, buttons, pwrMat, rgbMat, rgbLight, pinPositions: {} as Record<string, THREE.Vector3>, pinRecs: [], usbPort, L, T: H, spec, extSlots: [],
    screen, boardId: id as BoardId, flat: true as const,
    lcdPx: s.lcd?.px ?? null, screenMm: s.lcd ? s.lcd.mm : ([0, 0] as [number, number]), touch: !!s.touch, rest: 0, ledPin: s.ws2812 ?? -1, gpioLeds,
  };
}
