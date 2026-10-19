// The 3D "virtual computer": a laptop cabled to the board's USB-C port whose screen shows what the virtual host sees
// (enumerated device, typed text, mouse trail, CDC serial data).
import * as THREE from 'three';
import { t } from './i18n';
import { SANS } from './scene-api';

export interface UsbView {
  state: string;
  configured: boolean;
  vid: number;
  pid: number;
  manufacturer: string;
  product: string;
  serial: string;
  interfaces: string[];
  log: string[];
  typed: string;
  mouse: { x: number; y: number; buttons: number; reports: number };
  cdc: string;
}

const SW = 1024;
const SH = 640;

export function createUsbHost(scene: THREE.Scene, port: THREE.Vector3) {
  const grp = new THREE.Group();
  scene.add(grp);

  // Laptop: base + lid hinged on the back edge, tilted back to 105°
  const W = 150;
  const D = 100;
  const alu = new THREE.MeshStandardMaterial({ color: 0xb9bdc4, metalness: 0.8, roughness: 0.35 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(W, 5, D), alu);
  base.position.y = 2.5;
  base.castShadow = base.receiveShadow = true;
  grp.add(base);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(W - 12, 0.4, D * 0.48), new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.8 }));
  deck.position.set(0, 5.2, -D * 0.12);
  grp.add(deck);
  const pad = new THREE.Mesh(new THREE.BoxGeometry(46, 0.3, 28), new THREE.MeshStandardMaterial({ color: 0x9a9fa6, metalness: 0.5, roughness: 0.4 }));
  pad.position.set(0, 5.15, D * 0.3);
  grp.add(pad);

  const canvas = document.createElement('canvas');
  canvas.width = SW;
  canvas.height = SH;
  const g = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const lid = new THREE.Group();
  lid.position.set(0, 5, -D / 2);
  lid.rotation.x = -0.26; // tilt back
  const shell = new THREE.Mesh(new THREE.BoxGeometry(W, D * 0.66, 3), alu);
  shell.position.set(0, (D * 0.66) / 2, -1.5);
  shell.castShadow = true;
  lid.add(shell);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(W - 10, (W - 10) * (SH / SW)),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
  );
  screen.position.set(0, (D * 0.66) / 2, 0.05);
  lid.add(screen);
  grp.add(lid);

  // Front-left of the board's USB port, screen facing the default camera
  grp.scale.setScalar(0.62);
  grp.position.set(port.x - 100, 0, port.z - 4);
  grp.rotation.y = 0.45;
  grp.updateMatrixWorld();

  // Cable leaves the port, drops to the desk and plugs into the laptop's left side
  const plug = new THREE.Vector3(W / 2 + 1, 3, -12).applyMatrix4(grp.matrixWorld);
  const curve = new THREE.CatmullRomCurve3(
    [
      port.clone(),
      port.clone().add(new THREE.Vector3(-8, 0, 0)),
      new THREE.Vector3(port.x - 16, 2, port.z + 6),
      new THREE.Vector3((port.x + plug.x) / 2, 1.5, (port.z + plug.z) / 2 + 14),
      plug.clone().add(new THREE.Vector3(10, 0, 4)),
      plug,
    ],
    false,
    'catmullrom',
    0.4,
  );
  const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 1.6, 12), new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5 }));
  cable.castShadow = true;
  grp.parent!.add(cable);
  const boot = new THREE.Mesh(new THREE.BoxGeometry(10, 4.2, 8.5), new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6 }));
  boot.position.copy(port).add(new THREE.Vector3(-5.5, 0, 0));
  grp.parent!.add(boot);

  // Mouse trail (screen coords)
  const trail: [number, number][] = [];
  let lastReports = -1;

  function draw(v: UsbView | null) {
    g.fillStyle = '#0f1726';
    g.fillRect(0, 0, SW, SH);
    g.fillStyle = '#1d2738';
    g.fillRect(0, 0, SW, 56);
    g.fillStyle = '#e8edf5';
    g.font = `600 30px ${SANS}`;
    g.fillText(t('Virtual computer · USB'), 24, 38);
    g.textAlign = 'right';
    g.fillStyle = v?.configured ? '#4cc38a' : '#f2a33a';
    g.fillText(v ? v.state : t('Waiting for device'), SW - 24, 38);
    g.textAlign = 'left';
    if (!v) {
      tex.needsUpdate = true;
      return;
    }
    g.fillStyle = '#9fb0c8';
    g.font = `26px ${SANS}`;
    const name = v.product ? t('{product} ({maker})', { product: v.product, maker: v.manufacturer }) : t('Unknown device');
    g.fillText(t('Connected: {name}', { name }), 24, 98);
    g.font = '22px Menlo, monospace';
    g.fillText(`VID ${v.vid.toString(16).padStart(4, '0').toUpperCase()}  PID ${v.pid.toString(16).padStart(4, '0').toUpperCase()}  ${t('Interfaces: {n}', { n: v.interfaces.length })}`, 24, 132);

    // Left: text editor (keyboard input) or serial terminal
    const isCdc = v.interfaces.some((s) => s.includes('CDC-ACM'));
    // Keyboard-only devices (USB keypad) get the whole screen for the editor, no mouse area
    const mouse = !isCdc && (v.mouse.reports > 0 || v.interfaces.some((s) => s.includes('mouse')) || v.log.some((s) => s.startsWith('HID report descriptor') && s.includes('mouse')));
    g.fillStyle = '#0a0f18';
    g.fillRect(24, 156, mouse ? 560 : SW - 48, SH - 180);
    g.fillStyle = '#5f6f86';
    g.font = `20px ${SANS}`;
    g.fillText(isCdc ? t('Serial terminal · the new port on the computer') : t('Text editor'), 40, 186);
    g.fillStyle = '#e8edf5';
    g.font = '28px Menlo, monospace';
    const text = (isCdc ? v.cdc : v.typed).replace(/\r/g, '');
    const lines = text.split('\n').slice(mouse || isCdc ? -9 : -8);
    if (!mouse && !isCdc) g.font = '40px Menlo, monospace';
    lines.forEach((l, i) => g.fillText(l + (i === lines.length - 1 ? '▌' : ''), 40, (mouse || isCdc ? 232 : 244) + i * (mouse || isCdc ? 38 : 50)));

    // Right: mouse area (HID devices with mouse reports)
    if (mouse) {
      const ax = 608, ay = 156, aw = SW - ax - 24, ah = SH - 180;
      g.fillStyle = '#0a0f18';
      g.fillRect(ax, ay, aw, ah);
      g.fillStyle = '#5f6f86';
      g.font = `20px ${SANS}`;
      g.fillText(t('Mouse · reports: {n}', { n: v.mouse.reports }), ax + 16, ay + 30);
      // Origin sits up-left of centre; host coords scaled 1:1.6
      const cx = ax + aw * 0.3 + v.mouse.x * 1.6;
      const cy = ay + ah * 0.3 + v.mouse.y * 1.6;
      if (v.mouse.reports !== lastReports) {
        lastReports = v.mouse.reports;
        trail.push([cx, cy]);
        if (trail.length > 400) trail.shift();
      }
      g.strokeStyle = '#f2a33a';
      g.lineWidth = 3;
      g.beginPath();
      trail.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx, cy + 26);
      g.lineTo(cx + 7, cy + 19);
      g.lineTo(cx + 18, cy + 18);
      g.closePath();
      g.fill();
    }
    tex.needsUpdate = true;
  }
  draw(null);

  return {
    update: draw,
    dispose() {
      scene.remove(grp);
      grp.parent?.remove(cable);
      scene.remove(cable);
      scene.remove(boot);
      tex.dispose();
    },
  };
}
