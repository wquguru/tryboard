// 首页：实验桌和装配区跑的是同一份真实固件（weather，ESP32-S3），不是动画。
import { LiveSim } from './live';
import { createBenchView } from './views/bench';
import { createAssembly } from './views/assembly';
import { createShowcase, type ShowKind } from './views/showcase';
import levelsJson from '../../firmware/levels.json';
import type { Level } from './checks';

const $ = (id: string) => document.getElementById(id)!;
const SERVO = 4;
let productMode = false;
let offset = 0;

const sim = new LiveSim({
  fw: './fw/weather/flash.bin',
  i2c: [{ kind: 'ssd1306', addr: 0x3c }, { kind: 'bme280', addr: 0x76 }],
  env: { temp: 23.5, humidity: 45, pressure: 101325 },
  onConsole(text) {
    const lines = text.split('\n').filter((l) => /T=/.test(l));
    if (lines.length) $('benchLine').textContent = '串口：' + lines[lines.length - 1].trim();
  },
  onFrame(f) {
    bench.update(f, sim.env.temp);
    assembly.update(f, sim.env.temp);
  },
});
const temp = (d: number) => sim.setTemp(sim.env.temp + d);
const bench = createBenchView($('bench'), { boot: (d) => sim.press(d), reset: () => sim.reset(), temp }, { caption: 'weather.bin · ESP32-S3', servoPin: SERVO });
// 传感器偏移只在"装进壳里开机"后生效：面包板上传感器在空气里
const applyOffset = () => sim.setOffset(productMode ? offset : 0);
const assembly = createAssembly(
  $('assembly'),
  {
    boot: (d) => sim.press(d),
    temp,
    offset: (d) => {
      offset = d;
      applyOffset();
    },
    mode: (m) => {
      productMode = m === 'product';
      applyOffset();
    },
  },
  { servoPin: SERVO },
);

// 看不见就暂停，省电
const visible = new Set<Element>();
const io = new IntersectionObserver((es) => {
  for (const e of es) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
  if (visible.size) sim.resume();
  else sim.pause();
});
io.observe($('bench'));
io.observe($('assembly'));
sim.start().catch((e) => ($('benchLine').textContent = `加载失败：${e}`));

document.querySelectorAll<HTMLElement>('[data-show]').forEach((el) => createShowcase(el, el.dataset.show as ShowKind));

const levels = levelsJson as Level[];
$('path').innerHTML = levels
  .map(
    (l, i) => `<a href="./levels.html#${l.id}" style="text-decoration:none;background:var(--card);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:6px;border-top:4px solid ${i === levels.length - 1 ? 'var(--accent)' : 'var(--fg)'}">
<span class="mono" style="font-size:22px;font-weight:700;line-height:1;color:${i === levels.length - 1 ? 'var(--accent)' : 'var(--fg)'}">${l.id}</span>
<span style="font-weight:900;font-size:18px">${l.title}</span><span style="font-size:13px;color:var(--dim)">${l.buy.split('、')[0]}</span></a>`,
  )
  .join('');

interface Ex { id: string; title: string; chip?: string; tags: string[] }
fetch('./fw/examples.json')
  .then((r) => r.json())
  .then((ex: Ex[]) => {
    $('exCount').textContent = `C3 · S3 · ${ex.length} 个都能跑`;
    const pick = ['blink', 'oled', 'bme280', 'servo', 'wifi-http', 's3-usb-keyboard', 'weather'];
    const shown = pick.map((id) => ex.find((e) => e.id === id)).filter((e): e is Ex => !!e);
    $('exGrid').innerHTML = shown
      .map((e, i) => {
        const color = ['#2B5FD9', '#1C4F86', '#6A3FA0', '#141414', '#2E2E2B', '#8A867E', '#C23A00'][i % 7];
        const title = e.title.split('：')[0];
        return `<a href="./index.html?example=${e.id}" style="text-decoration:none;background:var(--card);border-radius:12px;overflow:hidden;display:flex;flex-direction:column">
<div style="height:132px;background:#2E4A3F;display:flex;align-items:center;justify-content:center"><svg width="160" height="96" viewBox="0 0 160 96" aria-hidden="true"><rect x="20" y="22" width="76" height="52" rx="4" fill="#141414"/><rect x="52" y="30" width="38" height="36" rx="2" fill="#BDB9B0"/><rect x="104" y="28" width="40" height="40" rx="4" fill="${color}"/><rect x="110" y="36" width="28" height="18" rx="1" fill="#050608"/><path d="M90 34 C100 20 110 20 118 28" fill="none" stroke="#E8C547" stroke-width="3" stroke-linecap="round"/><circle cx="36" cy="34" r="4" fill="#22C55E"/></svg></div>
<div style="padding:16px 18px 18px;display:flex;flex-direction:column;gap:4px"><span style="font-weight:900;font-size:18px">${title}</span><span class="mono" style="font-size:12px;color:var(--dim)">${e.id} · ${e.chip === 'esp32s3' ? 'ESP32-S3' : 'ESP32-C3'}</span></div></a>`;
      })
      .join('');
  })
  .catch(() => {});
