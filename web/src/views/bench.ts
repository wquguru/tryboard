// 实验桌（面包板）视图：ESP32-S3 开发板 + OLED + BME280 + 舵机表盘。画面由模拟器驱动，BOOT / RST / 室温可操作。
import { dialLabel, dialTicks, envBoxSvg, envButtons, holdButton, ledCss, mount, oledImage, servoAngle, type LiveFrame } from './common';

export interface BenchHandlers {
  boot(down: boolean): void;
  reset(): void;
  temp(delta: number): void;
}

export function createBenchView(el: HTMLElement, h: BenchHandlers, opts: { caption: string; servoPin: number }) {
  let ruler = '';
  for (let x = 0; x <= 1000; x += 20) ruler += `M${x} 0 L${x} ${x % 100 === 0 ? 14 : 7} `;
  const labels = [0, 10, 20, 30, 40].map((t) => {
    const [x, y] = dialLabel(180, 330, 128, t);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="#C9D6CF" class="tb-mono" font-size="11" font-weight="700" text-anchor="middle">${t}</text>`;
  });
  const q = mount(
    el,
    `<div class="tb-view">
<svg viewBox="0 0 1000 560" role="img" aria-label="实验桌：ESP32-S3 开发板插在面包板上，接着 OLED 屏、BME280 传感器和一个当作温度表的舵机">
<defs>
<pattern id="tb-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0 L0 0 L0 40" fill="none" stroke="#3B5C4F"/></pattern>
<pattern id="tb-holes" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="7" cy="7" r="2.2" fill="#CFCAC0"/></pattern>
<pattern id="tb-pin" width="14" height="10" patternUnits="userSpaceOnUse"><rect x="4" y="2" width="6" height="6" fill="#D4A63A"/></pattern>
</defs>
<rect width="1000" height="560" fill="#2E4A3F"/><rect width="1000" height="560" fill="url(#tb-grid)"/>
<path d="${ruler}" fill="none" stroke="#5E7F71" stroke-width="1.5"/>
<rect x="300" y="140" width="560" height="320" rx="8" fill="#EEEBE3"/>
<rect x="316" y="150" width="528" height="28" fill="url(#tb-holes)"/><rect x="316" y="422" width="528" height="28" fill="url(#tb-holes)"/>
<line x1="316" y1="148" x2="844" y2="148" stroke="#D9452B" stroke-width="2"/><line x1="316" y1="180" x2="844" y2="180" stroke="#2B5FD9" stroke-width="2"/>
<line x1="316" y1="420" x2="844" y2="420" stroke="#D9452B" stroke-width="2"/><line x1="316" y1="452" x2="844" y2="452" stroke="#2B5FD9" stroke-width="2"/>
<rect x="316" y="192" width="528" height="98" fill="url(#tb-holes)"/><rect x="316" y="310" width="528" height="98" fill="url(#tb-holes)"/>
<rect x="300" y="292" width="560" height="16" fill="#E0DCD2"/>
<path d="M322 292 C240 292 200 470 0 500" fill="none" stroke="#141414" stroke-width="12" stroke-linecap="round"/>
<rect x="330" y="208" width="300" height="168" rx="6" fill="#141414"/>
<rect x="340" y="212" width="280" height="10" fill="url(#tb-pin)"/><rect x="340" y="362" width="280" height="10" fill="url(#tb-pin)"/>
<rect x="318" y="276" width="20" height="32" rx="3" fill="#8A867E"/>
<rect x="470" y="232" width="146" height="120" rx="4" fill="#BDB9B0" stroke="#8A867E" stroke-width="1.5"/>
<text x="543" y="290" fill="#3A3936" class="tb-mono" font-size="15" font-weight="700" text-anchor="middle">ESP32-S3</text>
<text x="543" y="308" fill="#6E6A63" class="tb-mono" font-size="10" text-anchor="middle">WROOM-1</text>
<rect x="365" y="252" width="24" height="24" rx="3" fill="#2A2A28"/>
<circle data-k="bootCap" cx="377" cy="264" r="7" fill="#55534F"/>
<text x="377" y="246" fill="#A29E96" class="tb-mono" font-size="9" font-weight="700" text-anchor="middle">BOOT</text>
<rect x="365" y="318" width="24" height="24" rx="3" fill="#2A2A28"/>
<circle cx="377" cy="330" r="7" fill="#55534F"/>
<text x="377" y="356" fill="#A29E96" class="tb-mono" font-size="9" font-weight="700" text-anchor="middle">RST</text>
<circle data-k="glow1" cx="430" cy="244" r="26" opacity="0"/><circle data-k="glow2" cx="430" cy="244" r="15" opacity="0"/>
<rect data-k="ledCore" x="423" y="237" width="14" height="14" rx="2" fill="#E8E6E1" stroke="#3A3936"/>
<circle cx="377" cy="264" r="20" fill="none" stroke="#FF7A1A" stroke-width="1.5" stroke-dasharray="3 4"/>
<path d="M560 216 C560 130 735 210 735 166" fill="none" stroke="#141414" stroke-width="5" stroke-linecap="round"/>
<path d="M574 216 C574 120 750 200 750 166" fill="none" stroke="#D9452B" stroke-width="5" stroke-linecap="round"/>
<path d="M588 216 C588 110 765 190 765 166" fill="none" stroke="#2FA36B" stroke-width="5" stroke-linecap="round"/>
<path d="M602 216 C602 100 780 180 780 166" fill="none" stroke="#E8C547" stroke-width="5" stroke-linecap="round"/>
<path d="M588 368 C620 430 660 392 702 382" fill="none" stroke="#2FA36B" stroke-width="5" stroke-linecap="round"/>
<path d="M602 368 C640 440 670 380 702 370" fill="none" stroke="#E8C547" stroke-width="5" stroke-linecap="round"/>
<path d="M352 216 C330 150 260 230 232 340" fill="none" stroke="#E8762B" stroke-width="5" stroke-linecap="round"/>
<path d="M366 216 C340 140 270 240 240 340" fill="none" stroke="#D9452B" stroke-width="5" stroke-linecap="round"/>
<path d="M380 216 C350 130 280 250 248 340" fill="none" stroke="#6B4A2B" stroke-width="5" stroke-linecap="round"/>
<rect x="690" y="156" width="152" height="132" rx="6" fill="#1C4F86"/>
<rect x="728" y="160" width="60" height="10" fill="url(#tb-pin)"/>
<rect x="700" y="184" width="132" height="82" rx="2" fill="#050608"/>
<image data-k="oled" x="702" y="192" width="128" height="64" preserveAspectRatio="none" style="image-rendering: pixelated"/>
<text x="766" y="282" fill="#8FB3D9" class="tb-mono" font-size="8" font-weight="700" text-anchor="middle">SSD1306 0x3C</text>
<rect x="700" y="340" width="84" height="64" rx="4" fill="#6A3FA0"/>
<rect x="732" y="360" width="20" height="20" rx="2" fill="#C9C6BF"/>
<text x="742" y="398" fill="#D9CCF0" class="tb-mono" font-size="8" font-weight="700" text-anchor="middle">BME280 0x76</text>
<path d="M70 330 A110 110 0 0 1 290 330" fill="none" stroke="#EEEBE3" stroke-width="3"/>
<path d="${dialTicks(180, 330, 110, 94, 102, 2, 10)}" fill="none" stroke="#EEEBE3" stroke-width="2"/>
${labels.join('')}
<rect x="135" y="322" width="90" height="46" rx="4" fill="#2B5FD9"/>
<text x="180" y="356" fill="#CFE0FF" class="tb-mono" font-size="9" font-weight="700" text-anchor="middle">SG90 · GPIO${opts.servoPin}</text>
<g data-k="horn" transform="rotate(-90 180 330)"><path d="M180 324 L272 328 L272 332 L180 336 Z" fill="#F7F6F3" stroke="#141414"/></g>
<circle cx="180" cy="330" r="11" fill="#F7F6F3" stroke="#141414" stroke-width="1.5"/>
${envBoxSvg}
<text x="24" y="34" fill="#C9D6CF" class="tb-mono" font-size="12" font-weight="700">${opts.caption}</text>
</svg>
<button type="button" class="tb-hit" data-k="boot" aria-label="按 BOOT" style="left:37.7%;top:47.1%;width:6%;height:10.5%"></button>
<button type="button" class="tb-hit" data-k="rst" aria-label="按 RST 复位" style="left:37.7%;top:58.9%;width:4%;height:7%"></button>
<div class="tb-tag" style="left:24.5%;top:36.5%">按 BOOT 换单位</div>
${envButtons}
</div>`,
  );
  holdButton(q('boot'), () => {
    q('bootCap').setAttribute('r', '5');
    q('bootCap').setAttribute('fill', '#FF7A1A');
    h.boot(true);
  }, () => {
    q('bootCap').setAttribute('r', '7');
    q('bootCap').setAttribute('fill', '#55534F');
    h.boot(false);
  });
  q('rst').addEventListener('click', () => h.reset());
  q('up').addEventListener('click', () => h.temp(+1));
  q('down').addEventListener('click', () => h.temp(-1));
  let lastOled: Uint8Array | null = null;
  return {
    update(f: LiveFrame, roomTemp: number) {
      q('envTemp').textContent = roomTemp.toFixed(1);
      const a = servoAngle(f.pwm, opts.servoPin);
      q('horn').setAttribute('transform', `rotate(${a === null ? -90 : a - 180} 180 330)`);
      const c = f.running ? ledCss(f.rgb) : null;
      for (const k of ['glow1', 'glow2']) {
        q(k).setAttribute('fill', c ?? '#000');
        q(k).setAttribute('opacity', c ? (k === 'glow1' ? '0.25' : '0.45') : '0');
      }
      q('ledCore').setAttribute('fill', c ?? '#E8E6E1');
      if (f.oled !== lastOled) {
        lastOled = f.oled;
        if (f.oled) q('oled').setAttribute('href', oledImage(f.oled));
        else q('oled').removeAttribute('href');
      }
    },
  };
}
