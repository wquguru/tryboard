// 成品视图：装进外壳后的桌面气象站。表盘指针、屏幕、导光柱都由同一份固件驱动；顶部按键就是 BOOT。
import { dialLabel, dialTicks, envBoxSvg, envButtons, holdButton, ledCss, mount, oledImage, servoAngle, type LiveFrame } from './common';

export interface ProductHandlers {
  boot(down: boolean): void;
  temp(delta: number): void;
  /** 外接按键（USB 小键盘的 K1–K4）：按下接地 */
  press?(pin: number, down: boolean): void;
}

export function createProductView(el: HTMLElement, h: ProductHandlers, opts: { servoPin: number }) {
  const lab = [0, 20, 40].map((t) => {
    const [x, y] = dialLabel(560, 236, 84, t);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="#C9C6BF" class="tb-mono" font-size="10" font-weight="700" text-anchor="middle">${t}</text>`;
  });
  const q = mount(
    el,
    `<div class="tb-view">
<svg viewBox="0 0 1000 560" role="img" aria-label="成品：桌面气象站，表盘指针和屏幕显示固件读到的温度">
<defs><pattern id="pd-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0 L0 0 L0 40" fill="none" stroke="#3B5C4F"/></pattern></defs>
<rect width="1000" height="560" fill="#2E4A3F"/><rect width="1000" height="560" fill="url(#pd-grid)"/>
<ellipse cx="560" cy="486" rx="200" ry="16" fill="#1E332A"/>
<path d="M740 300 C820 300 860 420 1000 430" fill="none" stroke="#141414" stroke-width="10" stroke-linecap="round"/>
<rect x="390" y="88" width="340" height="392" rx="40" fill="#F2EFE8" stroke="#BDB9B0" stroke-width="2"/>
<rect x="404" y="102" width="312" height="364" rx="30" fill="none" stroke="#FFFFFF" opacity="0.6" stroke-width="2"/>
<rect data-k="key" x="636" y="80" width="40" height="12" rx="5" fill="#C9C6BF"/>
<path d="M440 236 A120 120 0 0 1 680 236 Z" fill="#1A1A19"/>
<path d="${dialTicks(560, 236, 112, 96, 104, 5, 20)}" fill="none" stroke="#F2EFE8" stroke-width="2"/>
${lab.join('')}
<g data-k="needle" transform="rotate(-90 560 236)"><path d="M560 232 L660 235 L660 237 L560 240 Z" fill="#FF7A1A"/></g>
<circle cx="560" cy="236" r="9" fill="#F2EFE8"/>
<rect x="470" y="276" width="180" height="84" rx="8" fill="#050608"/>
<image data-k="oled" x="480" y="278" width="160" height="80" preserveAspectRatio="none" style="image-rendering: pixelated"/>
<circle data-k="glow" cx="560" cy="402" r="18" opacity="0"/>
<circle data-k="ledCore" cx="560" cy="402" r="7" fill="#E8E6E1" stroke="#C9C6BF" stroke-width="1.5"/>
<path d="M420 420 L420 452 M432 420 L432 452 M444 420 L444 452 M676 420 L676 452 M688 420 L688 452 M700 420 L700 452" stroke="#C9C6BF" stroke-width="4" stroke-linecap="round"/>
<circle cx="656" cy="86" r="22" fill="none" stroke="#FF7A1A" stroke-width="1.5" stroke-dasharray="3 4"/>
${envBoxSvg}
<text data-k="caption" x="24" y="34" fill="#C9D6CF" class="tb-mono" font-size="12" font-weight="700">weather · 成品 · 同一份固件</text>
</svg>
<button type="button" class="tb-hit" data-k="boot" aria-label="按住顶部按键（BOOT）" style="left:65.6%;top:15.4%;width:6%;height:9%"></button>
<div class="tb-tag" style="left:65.6%;top:7%">按键换单位</div>
${envButtons}
</div>`,
  );
  holdButton(q('boot'), () => {
    q('key').setAttribute('fill', '#FF7A1A');
    h.boot(true);
  }, () => {
    q('key').setAttribute('fill', '#C9C6BF');
    h.boot(false);
  });
  q('up').addEventListener('click', () => h.temp(+1));
  q('down').addEventListener('click', () => h.temp(-1));
  let lastOled: Uint8Array | null = null;
  return {
    update(f: LiveFrame, roomTemp: number, sensorOffset: number) {
      q('envTemp').textContent = roomTemp.toFixed(1);
      q('caption').textContent = sensorOffset
        ? `weather · 成品 · 传感器贴着芯片，读到 ${(roomTemp + sensorOffset).toFixed(1)} ℃（室温 ${roomTemp.toFixed(1)}）`
        : 'weather · 成品 · 同一份固件';
      q('caption').setAttribute('fill', sensorOffset ? '#FFB27A' : '#C9D6CF');
      const a = servoAngle(f.pwm, opts.servoPin);
      q('needle').setAttribute('transform', `rotate(${a === null ? -90 : a - 180} 560 236)`);
      const c = f.running ? ledCss(f.rgb) : null;
      q('glow').setAttribute('fill', c ?? '#000');
      q('glow').setAttribute('opacity', c ? '0.35' : '0');
      q('ledCore').setAttribute('fill', c ?? '#E8E6E1');
      if (f.oled !== lastOled) {
        lastOled = f.oled;
        if (f.oled) q('oled').setAttribute('href', oledImage(f.oled));
        else q('oled').removeAttribute('href');
      }
    },
  };
}
