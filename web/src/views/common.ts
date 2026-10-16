// 实验桌 / 成品 / 装配几个 SVG 视图共用的小工具。视图只负责画，数据全部来自模拟器（LiveFrame）。

/** 模拟器给视图的一帧：OLED 像素、各引脚 PWM 占空比、板载彩灯、是否在跑 */
export interface LiveFrame {
  oled: Uint8Array | null;
  /** GC9A01 圆屏：240×240 RGBA；没有圆屏时为 null */
  lcd: Uint8Array | null;
  pwm: number[];
  rgb: number[] | null;
  /** 外接 WS2812 灯条：引脚 → 各灯 [r,g,b]（P2-09 旋钮台灯） */
  strips?: Record<number, number[][]>;
  running: boolean;
}

export const emptyFrame = (): LiveFrame => ({ oled: null, lcd: null, pwm: [], rgb: null, running: false });

/** 在容器里放一段 SVG/HTML，返回按 data-k 取元素的函数 */
let uid = 0;
export function mount(el: HTMLElement, html: string) {
  // 同一页面可能有好几个视图：SVG 里的 id（图案、渐变）加上实例后缀，免得 url(#id) 指到别的（可能隐藏的）实例
  const n = ++uid;
  el.innerHTML = html.replace(/id="([\w-]+)"/g, `id="$1-${n}"`).replace(/url\(#([\w-]+)\)/g, `url(#$1-${n})`);
  return <T extends Element = SVGElement>(k: string) => el.querySelector(`[data-k="${k}"]`) as T;
}

/** 舵机角度（°）：50Hz 下脉宽 0.5–2.5 ms 对应 0–180°；没有 PWM 时返回 null */
export function servoAngle(pwm: number[], pin: number): number | null {
  const d = pwm[pin];
  if (d === undefined || d < 0) return null;
  const ms = d * 20;
  return Math.max(0, Math.min(180, ((ms - 0.5) / 2) * 180));
}

/** 彩灯颜色：固件常把亮度压得很低（如 0x20），画的时候按最大通道放大到可见 */
export function ledCss(rgb: number[] | null): string | null {
  if (!rgb) return null;
  const m = Math.max(...rgb);
  if (m === 0) return null;
  const k = 255 / m;
  return `rgb(${rgb.map((c) => Math.round(c * k)).join(',')})`;
}

const oledCanvas = document.createElement('canvas');
oledCanvas.width = 128;
oledCanvas.height = 64;
/** OLED 128×64 亮度 → 冷白色图像（data URL，给 <image href>） */
export function oledImage(px: Uint8Array): string {
  const g = oledCanvas.getContext('2d')!;
  const img = g.createImageData(128, 64);
  for (let i = 0; i < 128 * 64; i++) {
    const v = px[i] / 255;
    img.data[i * 4] = 5 + v * 210;
    img.data[i * 4 + 1] = 6 + v * 237;
    img.data[i * 4 + 2] = 8 + v * 247;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return oledCanvas.toDataURL();
}

const lcdCanvas = document.createElement('canvas');
lcdCanvas.width = 240;
lcdCanvas.height = 240;
/** GC9A01 240×240 RGBA → data URL */
export function lcdImage(rgba: Uint8Array): string {
  const g = lcdCanvas.getContext('2d')!;
  g.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, 240 * 240 * 4), 240, 240), 0, 0);
  return lcdCanvas.toDataURL();
}

/** 0–40 ℃ 半圆表盘的刻度路径 */
export function dialTicks(cx: number, cy: number, r1: number, rMajor: number, rMinor: number, step: number, major: number) {
  let d = '';
  for (let t = 0; t <= 40; t += step) {
    const a = ((180 - t * 4.5) * Math.PI) / 180;
    const r2 = t % major === 0 ? rMajor : rMinor;
    d += `M${(cx + r1 * Math.cos(a)).toFixed(1)} ${(cy - r1 * Math.sin(a)).toFixed(1)} L${(cx + r2 * Math.cos(a)).toFixed(1)} ${(cy - r2 * Math.sin(a)).toFixed(1)} `;
  }
  return d;
}

export function dialLabel(cx: number, cy: number, r: number, t: number) {
  const a = ((180 - t * 4.5) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a) + 4];
}

/** 按下 / 松开：鼠标和触摸都走 pointer 事件；松开在窗口上监听，拖出按钮也能松开 */
export function holdButton(el: Element, onDown: () => void, onUp: () => void) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onDown();
    const up = () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onUp();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  el.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if ((k === 'Enter' || k === ' ') && !(e as KeyboardEvent).repeat) {
      e.preventDefault();
      onDown();
      setTimeout(onUp, 150);
    }
  });
}

/** 环境箱（ENV · TEMP）的 SVG，两种视图共用 */
export const envBoxSvg = `
<rect x="60" y="420" width="230" height="108" rx="8" fill="#1A1A19" stroke="#3A3936" stroke-width="1.5"/>
<text x="78" y="446" fill="#8A867E" class="tb-mono" font-size="10" font-weight="700">ENV · 室温</text>
<rect x="76" y="456" width="120" height="56" rx="4" fill="#0E0E0D"/>
<text data-k="envTemp" x="186" y="498" fill="#FF7A1A" class="tb-mono" font-size="34" font-weight="700" text-anchor="end">23.5</text>`;

/** 环境箱旁的 −/+（HTML 按钮，叠在 SVG 上，按百分比定位） */
export const envButtons = `
<div class="tb-env">
<button type="button" data-k="down" aria-label="降温">−</button>
<button type="button" data-k="up" aria-label="升温">+</button>
</div>`;
