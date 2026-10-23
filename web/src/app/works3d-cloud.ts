// G-05c cloud reporter for works3d.ts: vented case 7 x 2.5 x 5 cm with an ESP32-C3 and an AHT20, and a tablet with the cloud dashboard.
// Every number on the tablet is parsed from c3-cloud serial (cloudNow); its interval buttons publish interval=N like the 2D view, units cm.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { t } from '../i18n';
import { CLOUD_INTERVALS, cloudNow, type CloudState } from '../views/cloudproduct';

export interface CloudCtx {
  scene: THREE.Scene;
  shellMat(color: string): THREE.Material;
  occluders: THREE.Object3D[];
  hits: THREE.Object3D[];
  tag(text: string, cls?: string): HTMLElement;
  tagList: { el: HTMLElement; at: () => THREE.Vector3; dx?: number; dy?: number }[];
  effects(): { sensorOffset?: number };
  /** Dashboard button: publish this payload on the command topic */
  onCloud?(payload: string): void;
}

const CW = 7, CH = 2.5, CD = 5;
/** Tablet canvas size (px) and the button row (px) the hit boxes are laid over */
const TW = 640, TH = 400, BY = 330, BW = 150, BH = 50;
const btnX = (i: number) => 40 + i * 190;

function paintDash(g: CanvasRenderingContext2D, s: CloudState) {
  g.fillStyle = '#15171B';
  g.fillRect(0, 0, TW, TH);
  g.fillStyle = '#8A867E';
  g.font = '600 20px "JetBrains Mono", ui-monospace, monospace';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillText('tryboard/cloud/data', 40, 44);
  g.textAlign = 'right';
  g.fillStyle = s.sub ? '#5BD08A' : '#8A867E';
  g.fillText(s.sub ? t('online') : s.ip ? t('Wi-Fi only') : t('offline'), TW - 40, 44);
  const last = s.reports[s.reports.length - 1];
  g.textAlign = 'left';
  g.fillStyle = '#F2F2F2';
  g.font = '700 84px system-ui, sans-serif';
  g.fillText(last ? `${last.t.toFixed(1)}℃` : '--.-℃', 36, 140);
  g.fillStyle = '#7CC4FF';
  g.font = '700 48px system-ui, sans-serif';
  g.fillText(last ? `${last.h.toFixed(0)} %` : '-- %', 400, 140);
  g.fillStyle = '#C9C6BF';
  g.font = '500 20px system-ui, sans-serif';
  g.fillText(last ? t('Report #{seq} · every {n} s', { seq: last.seq, n: s.interval }) : t('No report yet'), 40, 176);
  // Temperature curve of the kept reports, auto-scaled with 0.5 ℃ head-room
  g.strokeStyle = '#2E3036';
  g.lineWidth = 2;
  g.strokeRect(40, 196, TW - 80, 108);
  const ts = s.reports.map((r) => r.t);
  if (ts.length > 1) {
    const lo = Math.min(...ts) - 0.5, hi = Math.max(...ts) + 0.5;
    g.strokeStyle = '#FF7A1A';
    g.lineWidth = 4;
    g.beginPath();
    ts.forEach((v, i) => {
      const x = 50 + (i * (TW - 100)) / (ts.length - 1), y = 296 - ((v - lo) / (hi - lo)) * 92;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 22px "JetBrains Mono", ui-monospace, monospace';
  CLOUD_INTERVALS.forEach((n, i) => {
    g.fillStyle = n === s.interval ? '#2B5FD9' : '#2E3036';
    g.beginPath();
    g.roundRect(btnX(i), BY, BW, BH, 12);
    g.fill();
    g.fillStyle = '#F2F2F2';
    g.fillText(`interval=${n}`, btnX(i) + BW / 2, BY + BH / 2 + 1);
  });
}

export function buildCloud(c: CloudCtx) {
  // Case: open-top tray plus a smoked lid so the board and the sensor stay visible
  const caseMat = c.shellMat('#E9E5DC');
  const floor = new THREE.Mesh(new RoundedBoxGeometry(CW, 0.4, CD, 3, 0.15), caseMat);
  floor.position.y = 0.2;
  floor.castShadow = floor.receiveShadow = true;
  c.scene.add(floor);
  // 2 mm walls; [x, z, width along x, depth along z]
  for (const [x, z, w, d] of [[0, CD / 2 - 0.1, CW, 0.2], [0, -CD / 2 + 0.1, CW, 0.2], [CW / 2 - 0.1, 0, 0.2, CD], [-CW / 2 + 0.1, 0, 0.2, CD]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, CH, d), caseMat);
    wall.position.set(x, CH / 2, z);
    wall.castShadow = wall.receiveShadow = true;
    c.scene.add(wall);
    c.occluders.push(wall);
  }
  const lid = new THREE.Mesh(new RoundedBoxGeometry(CW + 0.02, 0.2, CD + 0.02, 3, 0.08), new THREE.MeshPhysicalMaterial({ color: '#CFE3F2', roughness: 0.15, transparent: true, opacity: 0.32, depthWrite: false }));
  lid.position.y = CH + 0.1;
  c.scene.add(lid);
  // Vent slots on the right wall (+x), USB-C hole on the left
  const slotMat = new THREE.MeshStandardMaterial({ color: '#3A3936', roughness: 0.8 });
  for (let i = 0; i < 6; i++) {
    const sl = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.3, 0.22), slotMat);
    sl.position.set(CW / 2 + 0.005, CH / 2 + 0.1, -1.6 + i * 0.64);
    c.scene.add(sl);
  }
  const cable = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-CW / 2 + 0.2, 1.0, 0), new THREE.Vector3(-CW / 2 - 1.2, 1.0, 0), new THREE.Vector3(-CW / 2 - 2.4, 0.15, 0.8), new THREE.Vector3(-CW / 2 - 7, 0.15, 3)]), 40, 0.16, 10),
    new THREE.MeshStandardMaterial({ color: '#1E1E1E', roughness: 0.6 }),
  );
  cable.castShadow = true;
  c.scene.add(cable);
  // ESP32-C3 board (5.2 x 2.4 cm) on standoffs, module shield and status LED; the LDO sits next to the shield
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.16, 2.4), new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.6 }));
  pcb.position.set(-0.6, 0.9, 0);
  c.scene.add(pcb);
  const shield = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 1.4), new THREE.MeshStandardMaterial({ color: '#BDB9B0', metalness: 0.7, roughness: 0.35 }));
  shield.position.set(0.9, 1.13, 0);
  c.scene.add(shield);
  const ldo = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.3), new THREE.MeshStandardMaterial({ color: '#26262B', roughness: 0.4 }));
  ldo.position.set(-0.4, 1.04, 0.6);
  c.scene.add(ldo);
  const ledMat = new THREE.MeshBasicMaterial({ color: '#2A2C31' });
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.16), ledMat);
  led.position.set(-2.4, 1.02, -0.8);
  c.scene.add(led);
  // AHT20 breakout 1.6 x 1.1 cm: A on a post by the vents, B lying on the board beside the LDO; B shows a warm halo
  const aht = new THREE.Group();
  const apcb = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.1), new THREE.MeshStandardMaterial({ color: '#5A2A8A', roughness: 0.5 }));
  const chip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.3), new THREE.MeshStandardMaterial({ color: '#C9C6BF', roughness: 0.4 }));
  chip.position.y = 0.1;
  aht.add(apcb, chip);
  c.scene.add(aht);
  const haloMat = new THREE.MeshBasicMaterial({ color: '#FF7A1A', transparent: true, opacity: 0, depthWrite: false });
  const halo = new THREE.Mesh(new THREE.CircleGeometry(1.4, 32), haloMat);
  halo.rotation.x = -Math.PI / 2;
  c.scene.add(halo);

  // Tablet 12 x 7.5 cm on a stand behind and right of the case, showing the cloud dashboard
  const tablet = new THREE.Group();
  tablet.position.set(9, 0, -3);
  tablet.rotation.y = -0.45;
  c.scene.add(tablet);
  const stand = new THREE.Mesh(new THREE.BoxGeometry(3, 0.3, 2.4), c.shellMat('#3A3936'));
  stand.position.y = 0.15;
  tablet.add(stand);
  const body = new THREE.Mesh(new RoundedBoxGeometry(12.6, 8.1, 0.5, 3, 0.25), c.shellMat('#1B1D21'));
  body.position.set(0, 4.6, 0);
  body.rotation.x = -0.18;
  body.castShadow = true;
  tablet.add(body);
  c.occluders.push(body);
  const cv = document.createElement('canvas');
  cv.width = TW;
  cv.height = TH;
  const g = cv.getContext('2d')!;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const SW = 12, SH = (12 * TH) / TW;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.z = 0.26;
  body.add(screen);
  const btnHits = CLOUD_INTERVALS.map((_, i) => {
    const h = new THREE.Mesh(new THREE.BoxGeometry((BW / TW) * SW, (BH / TH) * SH, 0.2), new THREE.MeshBasicMaterial({ visible: false }));
    h.position.set(((btnX(i) + BW / 2) / TW - 0.5) * SW, (0.5 - (BY + BH / 2) / TH) * SH, 0.3);
    body.add(h);
    c.hits.push(h);
    return h;
  });
  // Wi-Fi pulse from the case to the tablet on every new report
  const beamMat = new THREE.MeshBasicMaterial({ color: '#7CC4FF', transparent: true, opacity: 0, depthWrite: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8, 1, true), beamMat);
  c.scene.add(beam);
  const a = new THREE.Vector3(1.5, CH + 0.3, -1), b = tablet.localToWorld(new THREE.Vector3(0, 4.6, 0));
  beam.position.copy(a).lerp(b, 0.5);
  beam.scale.set(1, a.distanceTo(b), 1);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());

  const tagAht = c.tag('', 'hot');
  c.tagList.push({ el: tagAht, at: () => aht.position.clone().add(new THREE.Vector3(0, -0.6, CD / 2 + 0.3)), dy: 16 });
  c.tagList.push({ el: c.tag(t('Cloud dashboard · click an interval')), at: () => tablet.localToWorld(new THREE.Vector3(0, 9.2, 0)), dy: -8 });

  let sent = '';
  let sig = '';
  let flash = 0;
  let seen = -1;
  const onDown = (hit: THREE.Object3D) => {
    const i = btnHits.findIndex((h) => h === hit);
    if (i < 0) return false;
    sent = `interval=${CLOUD_INTERVALS[i]}`;
    c.onCloud?.(sent);
    return true;
  };
  const tick = (_f: unknown, dt: number) => {
    const s = cloudNow;
    const hot = (c.effects().sensorOffset ?? 0) > 0;
    aht.position.set(hot ? -0.1 : 2.75, hot ? 1.04 : 1.4, hot ? 0.2 : 0.4);
    halo.position.set(aht.position.x, aht.position.y + 0.02, aht.position.z);
    haloMat.opacity = hot ? 0.28 + 0.08 * Math.sin(performance.now() / 300) : 0;
    tagAht.textContent = hot ? t('AHT20 against the board: reads about {n} ℃ high', { n: (c.effects().sensorOffset ?? 0).toFixed(1) }) : t('AHT20 by the vents: reads the room');
    ledMat.color.set(s.mqtt ? '#22C55E' : s.ip ? '#FFC000' : '#2A2C31');
    const last = s.reports[s.reports.length - 1];
    if (last && last.seq !== seen) {
      if (seen >= 0) flash = 1;
      seen = last.seq;
    }
    flash = Math.max(0, flash - dt * 1.5);
    beamMat.opacity = flash * 0.6;
    const k = `${s.ip}|${s.sub}|${s.interval}|${s.reports.map((r) => `${r.seq}:${r.t}:${r.h}`).join(',')}`;
    if (k !== sig) {
      sig = k;
      paintDash(g, s);
      tex.needsUpdate = true;
    }
  };
  // "interval=2" is the test handle
  return { tick, onDown, handle: btnHits[0], key: () => sent };
}
