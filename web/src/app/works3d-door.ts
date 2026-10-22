// G-03 RFID door product for works3d.ts: wall section with a door, the reader panel (enclosure-door 86 x 120 x 28 mm) and an electric strike.
// The strike follows the relay pin (closed = released, the leaf swings ajar); units cm like the other work products.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { t } from '../i18n';
import type { WorkFrame } from './works3d';
import { DOOR_CARDS } from '../views/doorproduct';

export interface DoorCtx {
  scene: THREE.Scene;
  shellMat(color: string): THREE.Material;
  tag(text: string, cls?: string): HTMLElement;
  tagList: { el: HTMLElement; at: () => THREE.Vector3; dx?: number; dy?: number }[];
  hits: THREE.Object3D[];
  occluders: THREE.Object3D[];
  oled: { tex: THREE.DataTexture; data: Uint8Array };
  paintOled(px: Uint8Array, data: Uint8Array): void;
  /** Tap a card (uid, '' = take it away); clickable cards only when supplied */
  onCard?(uid: string): void;
  /** UID the page currently has on the reader, so toolbar taps move the 3D card too */
  card?(): string;
  effects(): { cardBlock?: boolean };
}

/** Relay IN of the c3-door firmware (strike) and its red LED */
const RELAY_PIN = 10;
const LED_PIN = 0;

export function buildDoor(c: DoorCtx) {
  let open = false;
  // Wall section 46 cm tall (cut away) with a door opening at x = 14; the reader panel 8.6 x 12 x 2.8 cm sits beside the jamb
  const WALL_H = 46, PX = -8, PY = 24, PD = 2.8;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(54, WALL_H, 4), c.shellMat('#E9E5DC'));
  wall.position.set(-17, WALL_H / 2, -2);
  wall.castShadow = wall.receiveShadow = true;
  c.scene.add(wall);
  c.occluders.push(wall);
  const trim = c.shellMat('#F4F1EA');
  const casing = new THREE.Mesh(new THREE.BoxGeometry(4, WALL_H, 1.2), trim);
  casing.position.set(12, WALL_H / 2, 0.6);
  casing.castShadow = true;
  c.scene.add(casing);
  // Door leaf 90 x 4 cm, hinged at its far edge (x = 104); it swings out when the strike releases
  const hinge = new THREE.Group();
  hinge.position.set(104, 0, 0);
  c.scene.add(hinge);
  const leaf = new THREE.Mesh(new RoundedBoxGeometry(90, WALL_H, 4, 3, 0.3), new THREE.MeshStandardMaterial({ color: '#C8A26B', roughness: 0.7 }));
  leaf.position.set(-45, WALL_H / 2, -2);
  leaf.castShadow = leaf.receiveShadow = true;
  hinge.add(leaf);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(1.4, 24, 16), new THREE.MeshStandardMaterial({ color: '#B8BCC2', metalness: 0.85, roughness: 0.3 }));
  knob.position.set(-84, PY - 4, 1.2);
  hinge.add(knob);
  // Electric strike 4.1 x 5.4 x 2.8 cm on the casing; its keeper flips out and turns green when released
  const metal = new THREE.MeshStandardMaterial({ color: '#8A8E94', metalness: 0.8, roughness: 0.35 });
  const strike = new THREE.Mesh(new RoundedBoxGeometry(4.1, 5.4, 2.8, 3, 0.2), metal);
  strike.position.set(12, PY, 2.6);
  strike.castShadow = true;
  c.scene.add(strike);
  const keeperPivot = new THREE.Group();
  keeperPivot.position.set(14.05, PY, 2.6);
  c.scene.add(keeperPivot);
  const keeperMat = new THREE.MeshStandardMaterial({ color: '#5A5E64', metalness: 0.6, roughness: 0.4, emissive: '#22C55E', emissiveIntensity: 0 });
  const keeper = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.6, 2), keeperMat);
  keeper.position.set(0.15, 0, 0);
  keeperPivot.add(keeper);
  // Reader panel (enclosure-door 86 x 120 x 28 mm): screen window up top, card zone over the RC522 below
  const panel = new THREE.Mesh(new RoundedBoxGeometry(8.6, 12, PD, 4, 0.5), c.shellMat('#2F3338'));
  panel.position.set(PX, PY, PD / 2);
  panel.castShadow = panel.receiveShadow = true;
  c.scene.add(panel);
  c.occluders.push(panel);
  const { tex: oTex, data: oData } = c.oled;
  const bez = new THREE.Mesh(new RoundedBoxGeometry(3.6, 2.1, 0.1, 2, 0.04), new THREE.MeshStandardMaterial({ color: '#0B0C0E', roughness: 0.55 }));
  bez.position.set(PX, PY + 3.4, PD + 0.02);
  c.scene.add(bez);
  // SH1106 1.3 inch active area 29.4 x 14.7 mm
  const scrMat = new THREE.MeshBasicMaterial({ map: oTex, toneMapped: false });
  scrMat.color.setScalar(1.15);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(2.94, 1.47), scrMat);
  scr.position.set(PX, PY + 3.4, PD + 0.08);
  c.scene.add(scr);
  const zoneMat = new THREE.MeshStandardMaterial({ color: '#9AA3AD', roughness: 0.6 });
  const zone = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.1, 48), zoneMat);
  zone.position.set(PX, PY - 2, PD + 0.01);
  c.scene.add(zone);
  for (const r of [0.6, 1.1]) {
    const arc = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.12, 24, 1, Math.PI * 0.25, Math.PI * 0.5), zoneMat);
    arc.position.set(PX, PY - 2.5, PD + 0.01);
    c.scene.add(arc);
  }
  const ledMat = new THREE.MeshStandardMaterial({ color: '#4A1E1E', emissive: '#FF3B30', emissiveIntensity: 0, roughness: 0.3 });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 12), ledMat);
  led.position.set(PX + 3.2, PY - 5.2, PD);
  c.scene.add(led);
  // Cards: the whitelisted white card (85.6 x 54 mm) and an unknown blue fob; clickable only when the page wires onCard
  const cards: { mesh: THREE.Mesh; uid: string; home: THREE.Vector3 }[] = [];
  const cardAt = new THREE.Vector3(PX, PY - 2, PD + 0.6);
  const addCard = (geo: THREE.BufferGeometry, color: string, uid: string, home: THREE.Vector3) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
    m.position.copy(home);
    m.castShadow = true;
    c.scene.add(m);
    cards.push({ mesh: m, uid, home });
    if (c.onCard) c.hits.push(m);
  };
  addCard(new RoundedBoxGeometry(5.4, 8.56, 0.2, 2, 0.08), '#F7F6F3', DOOR_CARDS.ok, new THREE.Vector3(PX - 9, PY - 9, 8));
  addCard(new RoundedBoxGeometry(3.2, 4, 0.6, 3, 0.25), '#2563EB', DOOR_CARDS.bad, new THREE.Vector3(PX - 2, PY - 12, 9));
  let onPanel: (typeof cards)[number] | null = null;
  const handle = c.onCard ? cards[0].mesh : null;
  const onDown = (hit: THREE.Object3D) => {
    const k = cards.find((x) => x.mesh === hit);
    if (!k) return false;
    onPanel = onPanel === k ? null : k;
    c.onCard?.(onPanel ? k.uid : '');
    return true;
  };
  const tagLock = c.tag('', 'hot');
  c.tagList.push({ el: tagLock, at: () => new THREE.Vector3(12, PY + 4.6, 3) });
  c.tagList.push({ el: c.tag(t('RC522 card zone')), at: () => new THREE.Vector3(PX, PY - 6.6, PD), dy: 10 });
  const tagBlock = c.tag('', 'hot');
  c.tagList.push({ el: tagBlock, at: () => new THREE.Vector3(PX, PY + 7.4, PD) });
  let lastOled: Uint8Array | null = null;
  let swing = 0;
  const tick = (f: WorkFrame, dt: number) => {
    if (f.oled && f.oled !== lastOled) {
      lastOled = f.oled;
      c.paintOled(f.oled, oData);
      oTex.needsUpdate = true;
    }
    // Relay closed = strike released = door can swing (12° ajar); ease toward the target
    open = !!f.gpio && !!(f.gpio & (1 << RELAY_PIN));
    swing += ((open ? 1 : 0) - swing) * Math.min(1, dt * 6);
    hinge.rotation.y = (-12 * Math.PI * swing) / 180;
    keeperPivot.rotation.y = (55 * Math.PI * swing) / 180;
    keeperMat.emissiveIntensity = open ? 0.9 : 0;
    ledMat.emissiveIntensity = f.gpio && f.gpio & (1 << LED_PIN) ? 2.2 : 0;
    tagLock.textContent = open ? t('Strike released: door opens') : t('Strike locked');
    const blocked = !!c.effects().cardBlock;
    tagBlock.textContent = blocked ? t('Reader on the steel back box: cards are never read') : '';
    tagBlock.style.visibility = blocked ? '' : 'hidden';
    if (c.card) onPanel = cards.find((k) => k.uid === c.card!()) ?? null;
    for (const c of cards) c.mesh.position.lerp(onPanel === c ? cardAt : c.home, Math.min(1, dt * 10));
  };
  return { tick, onDown, handle, open: () => open };
}
