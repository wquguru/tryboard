// F-04a2 bare rectangular TFT modules (ILI9341 2.4″, ST7789 1.54″ / 2.0″), procedural at seller-drawing size (mm).
import * as THREE from 'three';
import { PITCH, canvasTexture, modulePcb } from './util';
import { moduleHeader } from './modules';
import { TFT_HEADER, TFT_PX, type TftPanel } from '../lcdspec.ts';

/** PCB w × h, active area w × h, glass w × h, board colour (texture / edge); sizes from common seller drawings */
const DIM: Record<TftPanel, { pcb: [number, number]; act: [number, number]; glass: [number, number]; col: [string, number] }> = {
  ili9341: { pcb: [42.7, 72.5], act: [36.72, 48.96], glass: [42, 58], col: ['#b81f2a', 0x8f1720] },
  'st7789-240x240': { pcb: [31, 40], act: [27.72, 27.72], glass: [31, 31.5], col: ['#1d3f8f', 0x173270] },
  'st7789-240x320': { pcb: [34, 58], act: [30.6, 40.8], glass: [34, 46], col: ['#16181c', 0x101114] },
};

/** Upright module on its header (origin at the header base, pins along x), screen facing +z. */
export function tftModule(tex: THREE.Texture, panel: TftPanel) {
  const grp = new THREE.Group();
  const d = DIM[panel];
  const [W, H] = d.pcb;
  const T = 1.6;
  const labels = TFT_HEADER[panel].map(([n]) => n);
  const n = labels.length;
  const S = 14;
  const pcbTex = canvasTexture(Math.round(W * S), Math.round(H * S), (g) => {
    const cw = W * S, ch = H * S;
    g.fillStyle = d.col[0];
    g.fillRect(0, 0, cw, ch);
    // Texture y down = module top to bottom; header pads and silkscreen along the bottom edge
    g.fillStyle = '#d9b860';
    for (let i = 0; i < n; i++) {
      g.beginPath();
      g.arc(cw / 2 + (i - (n - 1) / 2) * PITCH * S, ch - 1.4 * S, 0.75 * S, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#f2f4f7';
    g.font = `bold ${(n > 8 ? 0.95 : 1.1) * S}px "JetBrains Mono", Menlo, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    labels.forEach((t, i) => g.fillText(t, cw / 2 + (i - (n - 1) / 2) * PITCH * S, ch - 3.2 * S));
    g.font = `bold ${1.2 * S}px Helvetica, sans-serif`;
    const [pw, ph] = TFT_PX[panel];
    g.fillText(`${panel === 'ili9341' ? 'ILI9341' : 'ST7789'} ${pw}x${ph}`, cw / 2, ch - 5.4 * S);
  });
  const hole = 1.5;
  const pcb = modulePcb(W, H, T, [[-W / 2 + 2.5, H / 2 - 2.5, hole], [W / 2 - 2.5, H / 2 - 2.5, hole], [-W / 2 + 2.5, -H / 2 + 2.5, hole], [W / 2 - 2.5, -H / 2 + 2.5, hole]], pcbTex, d.col[1]);
  pcb.position.y = 0.6;
  grp.add(pcb);
  // Glass sits above the silkscreen strip; the lit area is centred on the glass
  const [gw, gh] = d.glass;
  const glassY = 0.6 + H - 2 - gh / 2;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, 1.6), new THREE.MeshPhysicalMaterial({ color: 0x07080a, roughness: 0.06, metalness: 0.2, clearcoat: 1 }));
  glass.position.set(0, glassY, T / 2 + 0.8);
  glass.castShadow = true;
  grp.add(glass);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(d.act[0], d.act[1]), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, glassY, glass.position.z + 0.81);
  grp.add(screen);
  const pins = moduleHeader(grp, n);
  return { grp, pins, labels, screen, height: H };
}
