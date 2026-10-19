// Product previews: turning Little Yellow, the lens buddy, the desk weather station. Looks only, no firmware; the home page's
// "run real firmware" swaps in the simulator-driven product view.
import { t } from '../i18n';
import { dialTicks, fitText, mount } from './common';

export type ShowKind = 'spin' | 'lens' | 'weather' | 'usbkey';
const SPEC: Record<ShowKind, string> = {
  usbkey: t('USB keypad · 4 keys + macro · ESP32-S3 native USB'),
  spin: t('Little Yellow · servo turntable ±60° · ESP32-S3'),
  lens: t('Lens buddy · 1.28″ round LCD GC9A01 · ESP32-S3'),
  weather: t('Desk weather station · OLED + BME280 · ESP32-S3'),
};
const ARIA: Record<ShowKind, string> = {
  usbkey: t('A USB keypad plugged into a laptop; key presses type on the screen'),
  spin: t('Little Yellow, a desk robot that turns on a servo turntable'),
  lens: t('A face on a round LCD magnified by a lens dome, like a little figure inside'),
  weather: t('A desk weather station; the dial needle and screen show temperature and humidity'),
};
const MOODS = [t('Calm'), t('Happy'), t('Love'), t('Sleepy')];

function art(kind: ShowKind) {
  if (kind === 'usbkey') {
    const keys = ['a', 'b', 'c', 'M'].map((k, i) => `<g data-k="key${i}"><rect x="${150 + i * 48}" y="318" width="40" height="40" rx="8" fill="${k === 'M' ? '#0D99FF' : '#F2EFE8'}" stroke="#141414" stroke-width="2"/><text x="${170 + i * 48}" y="345" fill="${k === 'M' ? '#FFF' : '#141414'}" class="tb-mono" font-size="18" font-weight="700" text-anchor="middle">${k}</text></g>`).join('');
    return `<rect x="96" y="70" width="288" height="180" rx="10" fill="#B9BDC4"/><rect x="108" y="82" width="264" height="156" rx="4" fill="#0F1726"/>
<text x="120" y="104" fill="#E8EDF5" class="tb-mono" font-size="11" font-weight="700">${t('Virtual computer · USB')}</text>
<text data-k="typed" x="120" y="140" fill="#E8EDF5" class="tb-mono" font-size="16"></text>
<path d="M84 252 L396 252 L410 268 L70 268 Z" fill="#9A9FA6"/>
<path d="M240 300 C240 286 300 290 300 270" fill="none" stroke="#1C1E22" stroke-width="5"/>
<rect x="138" y="300" width="204" height="72" rx="12" fill="#3A3936" stroke="#141414" stroke-width="2"/>${keys}`;
  }
  if (kind === 'spin') {
    let dial = '';
    for (let d = -60; d <= 60; d += 20) {
      const r = (d * Math.PI) / 180;
      const x = 240 + 112 * Math.sin(r), y = 380 + 24 * Math.cos(r);
      dial += `M${x.toFixed(1)} ${(y - 4).toFixed(1)} L${x.toFixed(1)} ${(y + 4).toFixed(1)} `;
    }
    return `<ellipse cx="240" cy="402" rx="112" ry="24" fill="#2A2A28"/><rect x="128" y="380" width="224" height="22" fill="#2A2A28"/><ellipse cx="240" cy="380" rx="112" ry="24" fill="#3A3936"/>
<path d="${dial}" fill="none" stroke="#6E6A63" stroke-width="2"/>
<g data-k="body"><path d="M-2 120 C-12 100 0 82 18 86 C32 90 30 108 16 106" fill="none" stroke="#141414" stroke-width="5" stroke-linecap="round"/>
<rect x="-78" y="120" width="156" height="252" rx="74" fill="#FFC933"/><rect x="-78" y="300" width="156" height="16" fill="#2F2A57"/><rect x="-78" y="316" width="156" height="56" fill="#F2B31F"/>
<rect x="-78" y="120" width="156" height="252" rx="74" fill="none" stroke="#141414" stroke-width="3"/>
<g data-k="face"><rect x="-58" y="160" width="116" height="84" rx="30" fill="#141414"/><rect x="-38" y="180" width="24" height="42" rx="12" fill="#7CF5FF"/><rect x="14" y="180" width="24" height="42" rx="12" fill="#7CF5FF"/>
<path d="M-14 268 Q0 282 14 268" fill="none" stroke="#141414" stroke-width="3.5" stroke-linecap="round"/><rect x="-14" y="296" width="28" height="22" rx="6" fill="#F7F6F3" stroke="#141414" stroke-width="2"/></g></g>`;
  }
  if (kind === 'lens') {
    return `<rect x="120" y="350" width="240" height="56" rx="22" fill="#EDEAE2" stroke="#BDB9B0" stroke-width="2"/><rect x="150" y="340" width="180" height="20" rx="8" fill="#D6D1C6"/>
<circle cx="240" cy="226" r="128" fill="#1A1A19"/><circle cx="240" cy="226" r="100" fill="#06070A"/>
<g data-k="eyes">
<g data-k="m0"><rect x="-40" y="-34" width="28" height="56" rx="14" fill="#7CF5FF"/><rect x="12" y="-34" width="28" height="56" rx="14" fill="#7CF5FF"/><circle data-k="p1" cx="-20" cy="-14" r="6" fill="#FFF"/><circle data-k="p2" cx="32" cy="-14" r="6" fill="#FFF"/></g>
<g data-k="m1" opacity="0"><path d="M-42 4 Q-26 -26 -10 4" fill="none" stroke="#7CF5FF" stroke-width="10" stroke-linecap="round"/><path d="M10 4 Q26 -26 42 4" fill="none" stroke="#7CF5FF" stroke-width="10" stroke-linecap="round"/></g>
<g data-k="m2" opacity="0"><path d="M-26 22 C-52 4 -48 -24 -26 -12 C-4 -24 0 4 -26 22 Z" fill="#FF8FB1"/><path d="M26 22 C0 4 4 -24 26 -12 C48 -24 52 4 26 22 Z" fill="#FF8FB1"/></g>
<g data-k="m3" opacity="0"><path d="M-42 0 Q-26 12 -10 0" fill="none" stroke="#7CF5FF" stroke-width="8" stroke-linecap="round"/><path d="M10 0 Q26 12 42 0" fill="none" stroke="#7CF5FF" stroke-width="8" stroke-linecap="round"/><text x="46" y="-26" fill="#7CF5FF" class="tb-mono" font-size="20" font-weight="700">z</text></g>
<ellipse cx="-50" cy="36" rx="12" ry="6" fill="#FF8FB1" opacity="0.6"/><ellipse cx="50" cy="36" rx="12" ry="6" fill="#FF8FB1" opacity="0.6"/></g>
<circle cx="240" cy="226" r="128" fill="url(#sc-dome)"/>
<path d="M150 170 A110 110 0 0 1 220 112" fill="none" stroke="#FFF" opacity="0.75" stroke-width="7" stroke-linecap="round"/>
<ellipse cx="300" cy="300" rx="22" ry="8" fill="#FFF" opacity="0.18" transform="rotate(-35 300 300)"/>
<circle cx="240" cy="226" r="128" fill="none" stroke="#8A9BAD" stroke-width="2"/>`;
  }
  return `<rect x="110" y="70" width="260" height="320" rx="34" fill="#F2EFE8" stroke="#BDB9B0" stroke-width="2"/>
<path d="M150 198 A90 90 0 0 1 330 198 Z" fill="#1A1A19"/><path d="${dialTicks(240, 198, 84, 70, 77, 5, 20)}" fill="none" stroke="#F2EFE8" stroke-width="2"/>
<g data-k="needle"><path d="M240 195 L315 197 L315 199 L240 201 Z" fill="#FF7A1A"/></g><circle cx="240" cy="198" r="7" fill="#F2EFE8"/>
<rect x="170" y="228" width="140" height="70" rx="6" fill="#050608"/>
<text data-k="wt" x="240" y="268" fill="#D7F3FF" class="tb-mono" font-size="26" font-weight="700" text-anchor="middle"></text>
<text data-k="wh" x="240" y="288" fill="#D7F3FF" class="tb-mono" font-size="11" text-anchor="middle"></text>
<circle data-k="wg" cx="240" cy="334" r="15" opacity="0.35"/><circle data-k="wl" cx="240" cy="334" r="6"/>`;
}

export function createShowcase(el: HTMLElement, kind: ShowKind) {
  const s = { angle: -30, mood: 0, look: 0, temp: 23.5, hum: 45, typed: '' };
  const q = mount(
    el,
    `<div class="tb-view sc-root">
<svg viewBox="0 0 480 480" role="img" aria-label="${ARIA[kind]}">
<defs>
<radialGradient id="sc-dome" cx="0.38" cy="0.3" r="0.75"><stop offset="0" stop-color="#FFF" stop-opacity="0.55"/><stop offset="0.35" stop-color="#FFF" stop-opacity="0.08"/><stop offset="0.85" stop-color="#9FB4C8" stop-opacity="0.18"/><stop offset="1" stop-color="#5E738A" stop-opacity="0.55"/></radialGradient>
<radialGradient id="sc-floor" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#141414" stop-opacity="0.28"/><stop offset="1" stop-color="#141414" stop-opacity="0"/></radialGradient>
</defs>
<rect width="480" height="480" fill="#DCD8D0"/><rect y="330" width="480" height="150" fill="#CFCAC0"/><ellipse cx="240" cy="404" rx="170" ry="30" fill="url(#sc-floor)"/>
${art(kind)}
<text data-k="spec" x="20" y="30" fill="#6E6A63" class="tb-mono" font-size="11" font-weight="700">${SPEC[kind]}</text>
<text x="460" y="30" fill="#8A867E" class="tb-mono" font-size="11" text-anchor="end">${t('Illustration')}</text>
</svg>
<div class="sc-controls" data-k="controls"></div>
</div>`,
  );
  const controls: [string, string, () => void][] =
    kind === 'spin'
      ? [['◀', t('Turn left'), () => (s.angle = Math.max(-60, s.angle - 20))], [t('Look at me'), t('Turn to face front'), () => (s.angle = 0)], ['▶', t('Turn right'), () => (s.angle = Math.min(60, s.angle + 20))]]
      : kind === 'usbkey'
        ? [['a', t('Press K1'), () => (s.typed += 'a')], ['b', t('Press K2'), () => (s.typed += 'b')], [t('Macro'), t('Press the macro key'), () => (s.typed += 'Hello TryBoard ')]]
      : kind === 'lens'
        ? [['◀', t('Look left'), () => (s.look = Math.max(-1, s.look - 1))], [t('Change face'), t('Change face'), () => (s.mood = (s.mood + 1) % 4)], ['▶', t('Look right'), () => (s.look = Math.min(1, s.look + 1))]]
        : [['−', t('Cooler'), () => (s.temp = Math.max(0, s.temp - 2))], [t('Breathe on it'), t('Raise humidity'), () => (s.hum = Math.min(95, s.hum + 15))], ['+', t('Warmer'), () => (s.temp = Math.min(40, s.temp + 2))]];
  const box = q<HTMLElement>('controls');
  const btns = controls.map(([label, aria, fn]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.onclick = () => {
      fn();
      render();
    };
    box.appendChild(b);
    return b;
  });
  function render() {
    if (kind === 'usbkey') {
      q('typed').textContent = (s.typed.slice(-24) || t('Try the keys below')) + '▌';
    } else if (kind === 'spin') {
      const a = (s.angle * Math.PI) / 180;
      q('body').setAttribute('transform', `translate(240 0) scale(${(0.72 + 0.28 * Math.cos(a)).toFixed(3)} 1)`);
      q('face').setAttribute('transform', `translate(${(34 * Math.sin(a)).toFixed(1)} 0)`);
    } else if (kind === 'lens') {
      q('eyes').setAttribute('transform', `translate(${240 + s.look * 22} 226) scale(1.35)`);
      for (let i = 0; i < 4; i++) q(`m${i}`).setAttribute('opacity', i === s.mood ? '1' : '0');
      q('p1').setAttribute('cx', String(-20 + s.look * 6));
      q('p2').setAttribute('cx', String(32 + s.look * 6));
      btns[1].textContent = t('Change face · {mood}', { mood: MOODS[s.mood] });
    } else {
      q('needle').setAttribute('transform', `rotate(${s.temp * 4.5 - 180} 240 198)`);
      q('wt').textContent = `${s.temp.toFixed(1)}°C`;
      q('wh').textContent = `${s.hum}% RH`;
      const c = s.hum > 70 ? '#3B82F6' : s.temp >= 28 ? '#EF4444' : '#22C55E';
      q('wg').setAttribute('fill', c);
      q('wl').setAttribute('fill', c);
    }
  }
  render();
  // Leave room for the right-hand "Illustration" tag when the spec line translates long
  requestAnimationFrame(() => fitText(q('spec'), 330));
}
