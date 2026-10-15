// 3D 里的"虚拟电脑"：一台笔记本，USB 线连到开发板的 Type-C 口；屏幕实时显示虚拟主机看到的东西
// （枚举出的设备名、键盘打出的字、鼠标光标轨迹、USB 串口收到的内容）。
import * as THREE from 'three';

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

  // 笔记本：底座 + 屏幕（铰链在底座后沿，屏幕后仰 105°）
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
  lid.rotation.x = -0.26; // 后仰
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

  // 放在开发板 USB 口的左前方，屏幕朝向默认机位
  grp.scale.setScalar(0.62);
  grp.position.set(port.x - 100, 0, port.z - 4);
  grp.rotation.y = 0.45;
  grp.updateMatrixWorld();

  // USB 线：从板子的口出来，落到桌面，再接到笔记本左侧
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

  // 鼠标轨迹（屏幕坐标）
  const trail: [number, number][] = [];
  let lastReports = -1;

  function draw(v: UsbView | null) {
    g.fillStyle = '#0f1726';
    g.fillRect(0, 0, SW, SH);
    // 标题栏
    g.fillStyle = '#1d2738';
    g.fillRect(0, 0, SW, 56);
    g.fillStyle = '#e8edf5';
    g.font = '600 30px Inter, "PingFang SC", sans-serif';
    g.fillText('虚拟电脑 · USB', 24, 38);
    g.textAlign = 'right';
    g.fillStyle = v?.configured ? '#4cc38a' : '#f2a33a';
    g.fillText(v ? v.state : '等待设备', SW - 24, 38);
    g.textAlign = 'left';
    if (!v) {
      tex.needsUpdate = true;
      return;
    }
    g.fillStyle = '#9fb0c8';
    g.font = '26px Inter, "PingFang SC", sans-serif';
    const name = v.product ? `${v.product}（${v.manufacturer}）` : '未知设备';
    g.fillText(`已连接：${name}`, 24, 98);
    g.font = '22px Menlo, monospace';
    g.fillText(`VID ${v.vid.toString(16).padStart(4, '0').toUpperCase()}  PID ${v.pid.toString(16).padStart(4, '0').toUpperCase()}  ${v.interfaces.length} 个接口`, 24, 132);

    // 左：文本编辑器（键盘输入）或串口终端
    const isCdc = v.interfaces.some((s) => s.includes('CDC-ACM'));
    g.fillStyle = '#0a0f18';
    g.fillRect(24, 156, isCdc ? SW - 48 : 560, SH - 180);
    g.fillStyle = '#5f6f86';
    g.font = '20px Inter, "PingFang SC", sans-serif';
    g.fillText(isCdc ? '串口终端（/dev/ttyACM0）' : '文本编辑器', 40, 186);
    g.fillStyle = '#e8edf5';
    g.font = '28px Menlo, monospace';
    const text = (isCdc ? v.cdc : v.typed).replace(/\r/g, '');
    const lines = text.split('\n').slice(-9);
    lines.forEach((l, i) => g.fillText(l + (i === lines.length - 1 ? '▌' : ''), 40, 232 + i * 38));

    // 右：鼠标区（只有 HID 设备时）
    if (!isCdc) {
      const ax = 608, ay = 156, aw = SW - ax - 24, ah = SH - 180;
      g.fillStyle = '#0a0f18';
      g.fillRect(ax, ay, aw, ah);
      g.fillStyle = '#5f6f86';
      g.font = '20px Inter, "PingFang SC", sans-serif';
      g.fillText(`鼠标 · ${v.mouse.reports} 次报告`, ax + 16, ay + 30);
      // 原点放在区域中央偏左上，坐标 1:1.6 缩放
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
      // 光标箭头
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
