// Waveshare ESP32-S3-Touch-AMOLED-2.16 (E-03), procedural at estimated real size: lies flat on the desk, no breadboard.
import * as THREE from 'three';
import type { PickTarget } from '../scene-api';
import { MAT, canvasTexture, roundRect } from './util';
import type { BoardSpec } from './boards';
import type { BoardId } from './boarddevs';
import { AIO_CHIP } from '../chipid';
import type { LedState } from './ctx';

/** 2.16″ square panel: active area 2.16·25.4/√2 ≈ 38.8 mm; PCB outline is an estimate (catalog todo: sizeMm) */
export const AMOLED = { W: 44, L: 50, T: 1.6, screen: 38.8, glassW: 41.6, glassL: 43.4, corner: 4 };

const SPEC: BoardSpec = {
  chip: AIO_CHIP['ws-amoled216'],
  title: 'ESP32-S3-Touch-AMOLED-2.16',
  silk: 'ESP32-S3-Touch-AMOLED-2.16',
  W: AMOLED.W,
  L: AMOLED.L,
  j1: [],
  j3: [],
  left: [],
  right: [],
  headerZ: 0,
  module: { title: 'ESP32-S3R8', flash: '16MB', W: 7, L: 7, shieldL: 0 },
  dualUsb: false,
  rgbPin: -1,
  bootPin: 0,
  boardCol: 0,
  cols: 1,
  partOffset: 0,
};

/** Same record shape as devboard() so the bench code paths stay shared; screen is the touch mesh (texture set per scene). */
export function amoledBoard(id: BoardId) {
  const { W, L, T } = AMOLED;
  const grp = new THREE.Group();
  grp.userData.pick = { kind: 'part', id: 'board' } satisfies PickTarget;
  const pcbTex = canvasTexture(256, 296, (g) => {
    g.fillStyle = '#16171a';
    g.fillRect(0, 0, 256, 296);
    g.fillStyle = '#d8dbe0';
    g.font = 'bold 11px Helvetica, sans-serif';
    g.textAlign = 'center';
    g.fillText('ESP32-S3-Touch-AMOLED-2.16', 128, 288);
  });
  const pcbGeo = new THREE.ExtrudeGeometry(roundRect(W, L, 3), { depth: T, bevelEnabled: false, curveSegments: 12 });
  pcbGeo.rotateX(-Math.PI / 2);
  pcbGeo.translate(0, -T / 2, 0);
  remapUv(pcbGeo, W, L, 'xz');
  const pcb = new THREE.Mesh(pcbGeo, [new THREE.MeshStandardMaterial({ map: pcbTex, roughness: 0.55 }), new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.6 })]);
  pcb.castShadow = pcb.receiveShadow = true;
  grp.add(pcb);

  // Cover glass (black when off), then the emissive panel just above it; texture flips with the scene's DataTexture
  const glassH = 1.2;
  const glass = new THREE.Mesh(new THREE.ExtrudeGeometry(roundRect(AMOLED.glassW, AMOLED.glassL, AMOLED.corner + 1), { depth: glassH, bevelEnabled: false, curveSegments: 16 }), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.12, metalness: 0.2 }));
  glass.rotation.x = -Math.PI / 2;
  glass.position.set(0, T / 2, -1.5);
  grp.add(glass);
  const S = AMOLED.screen;
  const scrGeo = new THREE.ShapeGeometry(roundRect(S, S, AMOLED.corner), 16);
  remapUv(scrGeo, S, S, 'xy');
  const screen = new THREE.Mesh(scrGeo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
  screen.rotation.x = -Math.PI / 2;
  screen.position.set(0, T / 2 + glassH + 0.02, -1.5);
  screen.renderOrder = 1;
  grp.add(screen);

  // BOOT / PWR side keys on the lower edge (USB end), drawn as tact caps so the bench can press them
  const buttons: THREE.Mesh[] = [];
  for (const [name, x] of [['BOOT', -W * 0.3], ['PWR', W * 0.3]] as const) {
    const pick = { kind: 'button', id: name } satisfies PickTarget;
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.0, 3.2), MAT.plastic);
    base.position.set(x, T / 2 + 0.5, L / 2 - 2.6);
    base.userData.pick = pick;
    grp.add(base);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.8, 24), MAT.plug);
    cap.position.set(x, T / 2 + 1.4, L / 2 - 2.6);
    cap.name = name;
    cap.userData.baseY = cap.position.y;
    cap.userData.pick = pick;
    grp.add(cap);
    buttons.push(cap);
  }
  // USB-C under the PCB at the lower edge (the top side is all glass)
  const usb = new THREE.Mesh(new THREE.BoxGeometry(8.9, 3.2, 7.4), MAT.steel);
  usb.position.set(0, -T / 2 - 1.6, L / 2 - 3.0);
  grp.add(usb);
  const usbPort = new THREE.Vector3(0, -T / 2 - 1.6, L / 2 + 0.8);
  // Power LED / RGB stand-ins: the board has no WS2812, the bench API still expects these handles
  const pwrMat = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0xff2010, emissiveIntensity: 0 });
  const pwr = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.8), pwrMat);
  pwr.position.set(W / 2 - 4, T / 2 + 0.3, L / 2 - 6.5);
  grp.add(pwr);
  const rgbMat = new THREE.MeshStandardMaterial({ color: 0x000000 });
  const rgbLight = new THREE.PointLight(0xffffff, 0, 1, 2);
  return {
    grp, buttons, pwrMat, rgbMat, rgbLight, pinPositions: {} as Record<string, THREE.Vector3>, pinRecs: [], usbPort, L, T, spec: SPEC, extSlots: [],
    screen: screen as THREE.Mesh | null, boardId: id, flat: true as const,
    lcdPx: [480, 480] as [number, number] | null, screenMm: [S, S] as [number, number], touch: true, rest: 3.2, ledPin: -1, gpioLeds: [] as LedState[],
  };
}

/** Normalised UVs over the w×h outline (ShapeGeometry / Extrude UVs are in raw mm) */
export function remapUv(g: THREE.BufferGeometry, w: number, h: number, plane: 'xy' | 'xz') {
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const a = pos.getX(i);
    const b = plane === 'xy' ? pos.getY(i) : -pos.getZ(i);
    uv.setXY(i, a / w + 0.5, b / h + 0.5);
  }
  uv.needsUpdate = true;
}
