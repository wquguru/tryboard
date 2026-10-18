// P2-09 三个新作品的 2D 成品（SVG）：旋钮台灯、超声波尺子、体感小人。
// 用在没有 WebGL 的设备上（成品步骤兜底）。灯色、屏幕画面全部来自模拟器。
import { lcdImage, mount, oledImage, type LiveFrame } from './common';

export interface WorkEffects {
  /** 灯带贴着灯罩壁：罩子上一排亮点（只改画面，估算） */
  glare?: boolean;
  /** 探头缩在外壳孔后面：声波先打到孔壁，读数被截到这么多厘米（进模拟器） */
  sonarBlock?: number;
  /** 六轴模块装反（转了 180°）：俯仰、横滚都反号（进模拟器） */
  imuFlip?: boolean;
}

const BG = `<rect width="1000" height="560" fill="#DCD8D0"/><rect y="390" width="1000" height="170" fill="#CFCAC0"/>
<defs><radialGradient id="wp-floor" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#141414" stop-opacity="0.28"/><stop offset="1" stop-color="#141414" stop-opacity="0"/></radialGradient>
<radialGradient id="wp-glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FFF" stop-opacity="0.9"/><stop offset="1" stop-color="#FFF" stop-opacity="0"/></radialGradient>
<clipPath id="wp-round"><circle cx="500" cy="236" r="118"/></clipPath></defs>`;

/** 乳白灯罩被里面的灯照着：罩子本色和灯色按 a 混合 */
function tint(c: number[], a: number) {
  const m = Math.max(...c) || 1;
  const base = [244, 241, 234];
  return `rgb(${base.map((b, k) => Math.round(b * (1 - a) + (c[k] / m) * 255 * a)).join(',')})`;
}

/** 灯珠颜色按最亮通道放大到看得见（固件常写低亮度） */
function css(c: number[] | undefined, k = 1) {
  if (!c) return '#2A2A28';
  const m = Math.max(...c);
  if (!m) return '#2A2A28';
  return `rgb(${c.map((v) => Math.round((v / m) * 255 * k + 42 * (1 - k))).join(',')})`;
}

export function createLampProduct(el: HTMLElement, opts: { pin: number }) {
  const leds = Array.from({ length: 8 }, (_, i) => `<circle data-k="led${i}" cx="${430 + i * 20}" cy="300" r="7" fill="#2A2A28"/>`).join('');
  const q = mount(
    el,
    `<div class="tb-view sc-root lp-root"><svg viewBox="0 0 1000 560" role="img" aria-label="成品：旋钮台灯，乳白灯罩里是 8 颗 WS2812，前面一个旋钮">
${BG}
<ellipse cx="500" cy="472" rx="220" ry="34" fill="url(#wp-floor)"/>
<ellipse data-k="halo" cx="500" cy="250" rx="230" ry="190" fill="url(#wp-glow)" opacity="0"/>
<rect x="380" y="380" width="240" height="84" rx="16" fill="#3A3936"/><rect x="380" y="380" width="240" height="18" rx="8" fill="#4A4946"/>
<circle cx="560" cy="430" r="22" fill="#1B1D21"/><circle cx="560" cy="430" r="15" fill="#2A2C31"/><rect data-k="mark" x="558" y="412" width="4" height="12" fill="#F2F2F2"/>
<rect x="490" y="232" width="20" height="150" fill="#E8E5DE"/>${leds}
<path data-k="shade" d="M410 380 C390 300 400 170 500 150 C600 170 610 300 590 380 Z" fill="#F4F1EA" fill-opacity="0.82" stroke="#BDB9B0" stroke-width="2"/>
<g data-k="spots" opacity="0">${Array.from({ length: 8 }, (_, i) => `<circle data-k="spot${i}" cx="${424 + i * 22}" cy="300" r="9" fill="#FFF"/>`).join('')}</g>
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">旋钮台灯 · 成品 · WS2812 × 8 + EC11 旋钮</text>
<text data-k="note" x="24" y="56" fill="#C23A00" class="tb-mono" font-size="12" font-weight="700"></text>
</svg></div>`,
  );
  return {
    update(f: LiveFrame, _room: number, fx: WorkEffects) {
      const strip = f.strips?.[opts.pin] ?? [];
      let peak = 0;
      strip.forEach((c, i) => {
        q(`led${i}`)?.setAttribute('fill', css(c));
        q(`spot${i}`)?.setAttribute('fill', css(c, 0.4));
        peak = Math.max(peak, ...c);
      });
      const avg = strip.length ? [0, 1, 2].map((k) => strip.reduce((s, c) => s + c[k], 0) / strip.length) : null;
      q('shade').setAttribute('fill', avg && peak ? tint(avg, 0.25 + 0.4 * Math.min(1, peak / 128)) : '#F4F1EA');
      const halo = q('halo');
      halo.setAttribute('opacity', String(Math.min(0.9, peak / 140)));
      q('spots').setAttribute('opacity', fx.glare && peak ? '1' : '0');
      q('note').textContent = fx.glare ? '灯带贴着灯罩：罩子上一排刺眼亮点（估算）' : '';
    },
  };
}

export function createRulerProduct(el: HTMLElement) {
  const q = mount(
    el,
    `<div class="tb-view sc-root lp-root"><svg viewBox="0 0 1000 560" role="img" aria-label="成品：手持超声波尺子，前面两个探头，顶上一块 OLED 显示距离">
${BG}
<ellipse cx="470" cy="470" rx="240" ry="30" fill="url(#wp-floor)"/>
<rect x="280" y="250" width="380" height="200" rx="24" fill="#2B5FD9"/><rect x="280" y="250" width="380" height="40" rx="18" fill="#3A6DE0"/>
<rect x="330" y="300" width="200" height="100" rx="6" fill="#0E0F12"/><image data-k="oled" x="338" y="308" width="184" height="84" preserveAspectRatio="none"/>
<g data-k="ph"><text x="348" y="346" fill="#D7F3FF" class="tb-mono" font-size="30" font-weight="700">42.0 cm</text><rect x="340" y="370" width="180" height="16" fill="none" stroke="#D7F3FF" stroke-width="2"/><rect x="340" y="370" width="38" height="16" fill="#D7F3FF"/></g>
<circle cx="600" cy="350" r="16" fill="#1B1D21"/><circle cx="600" cy="350" r="6" fill="#3A3936"/>
<g data-k="probes"><rect x="660" y="290" width="26" height="120" rx="6" fill="#C9C6BF"/><circle cx="700" cy="315" r="22" fill="#B8BCC2" stroke="#8A8E94" stroke-width="3"/><circle cx="700" cy="385" r="22" fill="#B8BCC2" stroke="#8A8E94" stroke-width="3"/></g>
<rect data-k="wall" x="840" y="200" width="18" height="250" fill="#8A867E"/>
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">超声波尺子 · 成品 · HC-SR04 + SSD1306 + 无源蜂鸣器</text>
<text data-k="note" x="24" y="56" fill="#C23A00" class="tb-mono" font-size="12" font-weight="700"></text>
</svg></div>`,
  );
  let last: Uint8Array | null = null;
  return {
    update(f: LiveFrame, _room: number, fx: WorkEffects) {
      if (f.oled && f.oled !== last) {
        last = f.oled;
        q('oled').setAttribute('href', oledImage(f.oled));
        q('ph').setAttribute('display', 'none');
      }
      q('probes').setAttribute('transform', fx.sonarBlock ? 'translate(-26 0)' : '');
      q('note').textContent = fx.sonarBlock ? `探头缩在外壳孔里：读数被截到约 ${fx.sonarBlock} cm` : '';
    },
  };
}

export function createTiltProduct(el: HTMLElement) {
  const q = mount(
    el,
    `<div class="tb-view sc-root lp-root"><svg viewBox="0 0 1000 560" role="img" aria-label="成品：圆盘外壳，顶面圆屏上的小豆跟着倾斜滑动">
${BG}
<ellipse cx="500" cy="440" rx="190" ry="36" fill="url(#wp-floor)"/>
<g data-k="disc"><circle cx="500" cy="236" r="150" fill="#ECE9E2" stroke="#BDB9B0" stroke-width="3"/><circle cx="500" cy="236" r="124" fill="#1A1A19"/>
<g data-k="ph"><circle cx="500" cy="236" r="118" fill="#10213A"/><circle cx="500" cy="236" r="108" fill="none" stroke="#3A5A80" stroke-width="4"/>
<g transform="translate(556 262)"><circle r="27" fill="#FFC933"/><rect x="-19" y="-20" width="38" height="17" rx="8.5" fill="#141414"/><rect x="-12" y="-17" width="7" height="11" rx="3.5" fill="#7CF5FF"/><rect x="5" y="-17" width="7" height="11" rx="3.5" fill="#7CF5FF"/><path d="M-7 8 A8 8 0 0 0 7 8" fill="none" stroke="#141414" stroke-width="3"/></g></g>
<image data-k="lcd" x="382" y="118" width="236" height="236" clip-path="url(#wp-round)"/></g>
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">体感小人 · 成品 · QMI8658 + 1.28″ 圆屏 GC9A01</text>
<text data-k="note" x="24" y="56" fill="#C23A00" class="tb-mono" font-size="12" font-weight="700"></text>
</svg></div>`,
  );
  let last: Uint8Array | null = null;
  return {
    update(f: LiveFrame, _room: number, fx: WorkEffects) {
      if (f.lcd && f.lcd !== last) {
        last = f.lcd;
        q('lcd').setAttribute('href', lcdImage(f.lcd));
        q('ph').setAttribute('display', 'none');
      }
      q('note').textContent = fx.imuFlip ? '六轴模块装反了：俯仰、横滚方向全反，小豆往高处爬' : '';
    },
  };
}
