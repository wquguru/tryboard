// G-05b temperature / humidity to the cloud: flat product (SVG) = C3 + AHT20 on a shelf, Wi-Fi to a cloud dashboard.
// Everything shown is parsed from c3-cloud serial; the dashboard's interval buttons publish interval=N on the command topic.
import { t } from '../i18n';
import { mount, type LiveFrame } from './common';
import { BG } from './workproducts';

/** Topic the firmware subscribes to for interval=<1–60> */
export const CLOUD_CMD = 'tryboard/cloud/cmd';
/** mqtt= script action that publishes one command (same text the network tab's MQTT panel sends) */
export const cloudCmd = (payload: string) => `pub,${CLOUD_CMD},${payload}`;

export interface CloudReport {
  seq: number;
  t: number;
  h: number;
  /** Seconds since the previous publish (absent on the first one and right after an interval change) */
  gap?: number;
}
/** Reporter state rebuilt from serial: Wi-Fi IP, broker session, interval, recent reports, last ack */
export interface CloudState {
  ip: string;
  mqtt: boolean;
  sub: boolean;
  interval: number;
  reports: CloudReport[];
  ack: string;
  cmds: number;
  sensorErr: boolean;
}
export const cloudIdle = (): CloudState => ({ ip: '', mqtt: false, sub: false, interval: 5, reports: [], ack: '', cmds: 0, sensorErr: false });
/** Reports kept for the dashboard list and sparkline */
const KEEP = 8;

type CloudEvent = [icon: string, text: string, tone?: 'ok' | 'bad'];
/** One c3-cloud serial line -> new state + timeline event (null = no event) */
export function parseCloudLine(l: string, s: CloudState): CloudEvent | null {
  let m: RegExpMatchArray | null;
  if (l.startsWith('温湿度上云：')) Object.assign(s, cloudIdle()); // lint: allow-cjk
  else if ((m = /^已连上 Wi-Fi，IP (\S+)/.exec(l))) { // lint: allow-cjk
    s.ip = m[1];
    return ['⌁', t('Joined Wi-Fi, IP {ip}', { ip: m[1] }), 'ok'];
  } else if (l.startsWith('Wi-Fi 断开')) { // lint: allow-cjk
    Object.assign(s, { ip: '', mqtt: false, sub: false });
    return ['!', t('Wi-Fi dropped, reconnecting'), 'bad'];
  } else if (l.startsWith('MQTT 已连上 broker')) { // lint: allow-cjk
    s.mqtt = true;
    return ['☁', t('Connected to the MQTT broker'), 'ok'];
  } else if (l.startsWith('已订阅 ')) s.sub = true; // lint: allow-cjk
  else if (l.startsWith('MQTT 断开')) Object.assign(s, { mqtt: false, sub: false }); // lint: allow-cjk
  else if ((m = /^发布 #(\d+) → \S+ \{"t":(-?\d+\.\d),"h":(\d+\.\d),"seq":\d+\}(?: 距上次 (\d+\.\d+) 秒)?/.exec(l))) { // lint: allow-cjk
    s.reports = [...s.reports, { seq: Number(m[1]), t: Number(m[2]), h: Number(m[3]), ...(m[4] ? { gap: Number(m[4]) } : {}) }].slice(-KEEP);
    // A publish proves the broker session, so a page mounted mid-run doesn't read "offline"
    Object.assign(s, { sensorErr: false, mqtt: true, sub: true });
  } else if ((m = /^收到命令 \S+ "(.*)"$/.exec(l))) { // lint: allow-cjk
    s.cmds++;
    return ['↓', t('Cloud command: {cmd}', { cmd: m[1] })];
  } else if ((m = /^间隔改为 (\d+) 秒/.exec(l))) { // lint: allow-cjk
    s.interval = Number(m[1]);
    return ['⏱', t('Interval changed to {n} s', { n: m[1] }), 'ok'];
  } else if ((m = /^拒绝命令 "(.*)"/.exec(l))) return ['!', t('Command refused: {cmd} (interval must be 1–60 s)', { cmd: m[1] }), 'bad']; // lint: allow-cjk
  else if ((m = /^回执 → \S+ (\{.*\})/.exec(l))) s.ack = m[1]; // lint: allow-cjk
  else if (l.startsWith('AHT20 读取失败') || l.startsWith('AHT20 无应答')) { // lint: allow-cjk
    s.sensorErr = true;
    return ['!', t('AHT20 did not answer: check SDA / SCL and 3V3'), 'bad'];
  }
  return null;
}

/** The product page's / home card's reporter state (one at a time); reset on every power-up banner */
export const cloudNow: CloudState = cloudIdle();

/** Interval buttons on the dashboard (seconds) */
export const CLOUD_INTERVALS = [2, 5, 10];

export function createCloudProduct(el: HTMLElement, opts: { send?: (cmd: string) => void; get?: () => CloudState } = {}) {
  const get = opts.get ?? (() => cloudNow);
  const btns = CLOUD_INTERVALS.map((n, i) => {
    const x = 600 + i * 118;
    return `<g data-iv="${n}" role="button" tabindex="0" aria-label="${t('Set the interval to {n} s from the cloud', { n })}" style="cursor:${opts.send ? 'pointer' : 'default'}">
<rect data-k="iv${n}" x="${x}" y="470" width="106" height="44" rx="10" fill="#2E3036"/><text x="${x + 53}" y="498" fill="#F2F2F2" class="tb-mono" font-size="14" font-weight="700" text-anchor="middle" pointer-events="none">interval=${n}</text></g>`;
  }).join('');
  const rows = Array.from({ length: 4 }, (_, i) => `<text data-k="r${i}" x="600" y="${336 + i * 24}" fill="#C9C6BF" class="tb-mono" font-size="13"></text>`).join('');
  const q = mount(
    el,
    `<div class="tb-view sc-root cl-root"><svg viewBox="0 0 1000 560" role="img" aria-label="${t('Product: an ESP32-C3 with an AHT20 sensor on a shelf, sending readings over Wi-Fi to a cloud dashboard')}">
${BG}
<rect x="60" y="388" width="380" height="16" rx="3" fill="#8A6A48"/><rect x="60" y="404" width="380" height="8" fill="#6E5236"/>
<rect x="110" y="300" width="170" height="88" rx="6" fill="#141414"/><rect x="200" y="314" width="70" height="56" rx="3" fill="#BDB9B0"/>
<rect x="100" y="330" width="16" height="26" fill="#8A867E"/><circle data-k="led" cx="140" cy="318" r="5" fill="#2A2C31"/>
<path d="M280 344 C320 344 320 360 340 360" fill="none" stroke="#3A3936" stroke-width="3"/>
<rect x="336" y="334" width="66" height="54" rx="4" fill="#2B5FD9"/><rect x="354" y="346" width="30" height="30" rx="3" fill="#E9E5DC"/>
<text x="369" y="400" fill="#6E6A63" class="tb-mono" font-size="11" font-weight="700" text-anchor="middle">AHT20</text>
<g data-k="wifi" opacity="0.25" fill="none" stroke="#2B5FD9" stroke-width="5" stroke-linecap="round">
<path d="M170 270 Q195 250 220 270"/><path d="M155 252 Q195 220 235 252"/><path d="M140 234 Q195 190 250 234"/></g>
<path data-k="link" d="M260 220 Q 420 120 560 150" fill="none" stroke="#2B5FD9" stroke-width="3" stroke-dasharray="8 8" opacity="0.2"/>
<rect x="570" y="44" width="400" height="490" rx="22" fill="#1E2024"/>
<text x="600" y="84" fill="#F2F2F2" class="tb-mono" font-size="15" font-weight="700">${t('Cloud dashboard')}</text>
<text data-k="conn" x="940" y="84" fill="#8A867E" class="tb-mono" font-size="12" font-weight="700" text-anchor="end"></text>
<text data-k="temp" x="600" y="160" fill="#FFB347" class="tb-mono" font-size="52" font-weight="700">--.-</text>
<text x="760" y="160" fill="#8A867E" class="tb-mono" font-size="20" font-weight="700">℃</text>
<text data-k="hum" x="800" y="160" fill="#7CC6FF" class="tb-mono" font-size="52" font-weight="700">--</text>
<text x="905" y="160" fill="#8A867E" class="tb-mono" font-size="20" font-weight="700">%</text>
<text data-k="age" x="600" y="190" fill="#8A867E" class="tb-mono" font-size="12"></text>
<rect x="600" y="206" width="340" height="80" rx="8" fill="#16181C"/>
<polyline data-k="spark" points="" fill="none" stroke="#FFB347" stroke-width="2.5" stroke-linejoin="round"/>
<text x="600" y="312" fill="#8A867E" class="tb-mono" font-size="12" font-weight="700">${t('Recent reports')}</text>
${rows}
<text data-k="iv" x="600" y="452" fill="#F2F2F2" class="tb-mono" font-size="13" font-weight="700"></text>
${btns}
<text x="24" y="34" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700">${t('Cloud sensor · product · ESP32-C3 + AHT20 + Wi-Fi + MQTT')}</text>
<text data-k="state" x="24" y="58" fill="#3A3936" class="tb-mono" font-size="14" font-weight="700"></text>
<text data-k="ack" x="24" y="80" fill="#6E6A63" class="tb-mono" font-size="12" font-weight="700"></text>
<text data-k="note" x="24" y="102" fill="#C23A00" class="tb-mono" font-size="12" font-weight="700"></text>
</svg></div>`,
  );
  const root = el.querySelector('svg')!;
  if (opts.send)
    root.querySelectorAll<SVGGElement>('[data-iv]').forEach((g) => {
      const go = () => opts.send!(cloudCmd(`interval=${g.dataset.iv}`));
      g.addEventListener('click', go);
      g.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && go());
    });
  return {
    update(_f: LiveFrame, _room?: number) {
      const s = get();
      const last = s.reports[s.reports.length - 1];
      q('temp').textContent = last ? last.t.toFixed(1) : '--.-';
      q('hum').textContent = last ? last.h.toFixed(0) : '--';
      q('age').textContent = last ? t('Report #{seq} · every {n} s', { seq: last.seq, n: s.interval }) : t('No report yet');
      q('conn').textContent = s.sub ? t('online') : s.ip ? t('Wi-Fi only') : t('offline');
      q('conn').setAttribute('fill', s.sub ? '#5BD08A' : '#8A867E');
      q('wifi').setAttribute('opacity', s.ip || s.mqtt ? '1' : '0.25');
      q('link').setAttribute('opacity', s.mqtt ? '0.9' : '0.2');
      q('led').setAttribute('fill', s.mqtt ? '#22C55E' : s.ip ? '#FFC000' : '#2A2C31');
      const ts = s.reports.map((r) => r.t);
      const lo = Math.min(...ts) - 0.5, hi = Math.max(...ts) + 0.5;
      q('spark').setAttribute('points', ts.length < 2 ? '' : ts.map((v, i) => `${610 + (i * 320) / (ts.length - 1)},${276 - ((v - lo) / (hi - lo)) * 60}`).join(' '));
      const recent = [...s.reports].reverse();
      for (let i = 0; i < 4; i++) {
        const r = recent[i];
        q(`r${i}`).textContent = r ? `#${r.seq}  ${r.t.toFixed(1)} ℃  ${r.h.toFixed(1)} %  ${r.gap !== undefined ? `+${r.gap.toFixed(2)} s` : ''}` : '';
      }
      q('iv').textContent = t('Change the interval from the cloud (now {n} s):', { n: s.interval });
      CLOUD_INTERVALS.forEach((n) => q(`iv${n}`).setAttribute('fill', n === s.interval ? '#2B5FD9' : '#2E3036'));
      q('state').textContent = !s.ip && !s.sub ? '' : s.sub ? t('Online · reporting every {n} s · {k} reports', { n: s.interval, k: last?.seq ?? 0 }) : t('Wi-Fi up, waiting for the broker');
      q('ack').textContent = s.ack ? t('Last ack: {json}', { json: s.ack }) : '';
      q('note').textContent = s.sensorErr ? t('AHT20 did not answer: check SDA / SCL and 3V3') : '';
    },
  };
}
