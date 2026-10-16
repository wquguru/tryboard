// ② 实验台：构建树（零件 / 连线 / 供电 / 环境 / 固件 / 检查点）+ 属性面板 + 检查点验收。
// 点树和点台面（ScenePickApi.onPick）改的是同一个 selection；属性面板只跟着 selection 走。
import type { PartSpec } from '../../board3d';
import type { PickTarget } from '../../scene-api';
import { checkCommand, type Level } from '../../checks';
import { verifyLevel } from '../../verify';
import { fetchBuf } from '../../assets';
import { servoAngle, ledCss } from '../../views/common';
import type { AppState, CheckOutcome, Selection, StepCtx, StepImpl } from '../types';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

interface PartInfo {
  name: string;
  model: string;
  iface: string;
  power: string;
}
function partId(p: PartSpec) {
  return p.type === 'led' ? `led:${p.pin}` : p.type;
}
function partInfo(p: PartSpec): PartInfo {
  switch (p.type) {
    case 'bme280':
      return { name: 'BME280', model: 'Bosch BME280 模块（温度 / 湿度 / 气压）', iface: `I2C ${hex(p.addr)} · SDA GPIO${p.sda} · SCL GPIO${p.scl}`, power: '3V3' };
    case 'oled':
      return { name: 'SSD1306 OLED', model: '0.96″ 128×64 单色 OLED（SSD1306）', iface: `I2C ${hex(p.addr)} · SDA GPIO${p.sda} · SCL GPIO${p.scl}`, power: '3V3' };
    case 'servo':
      return { name: 'SG90 舵机', model: 'SG90 9 g 微型舵机，50 Hz PWM，0.5–2.5 ms → 0–180°', iface: `信号 GPIO${p.pin}`, power: '5V（USB 直供）' };
    case 'gc9a01':
      return { name: 'GC9A01 圆屏', model: '1.28″ 240×240 RGB 圆屏（GC9A01）', iface: 'SPI2 · SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15', power: '3V3' };
    case 'pot':
      return { name: '电位器', model: '10 kΩ 旋钮电位器', iface: `滑片 GPIO${p.pin}（ADC）`, power: '3V3' };
    case 'led':
      return { name: `LED（GPIO${p.pin}）`, model: '5 mm LED + 220 Ω 限流电阻', iface: `GPIO${p.pin}，高电平亮`, power: '经 GPIO' };
    case 'buzzer':
      return { name: '无源蜂鸣器', model: '无源蜂鸣器（LEDC 方波驱动）', iface: `GPIO${p.pin}`, power: '经 GPIO' };
  }
}

interface Wire {
  id: string;
  a: string;
  b: string;
  role: string;
  color: string;
}
/** 接线由场景声明推出来；id 按 scene-api 约定 'wire:<板上针脚>~<零件>:<丝印>' */
function wiresOf(parts: PartSpec[], ext5v = false): Wire[] {
  const w: Wire[] = [];
  const add = (a: string, b: string, role: string, color: string) => w.push({ id: `wire:${a}~${b}`, a, b, role, color });
  for (const p of parts) {
    const id = partId(p);
    if (p.type === 'bme280' || p.type === 'oled') {
      add(`GPIO${p.sda}`, `${id}:SDA`, 'I2C 数据', '绿');
      add(`GPIO${p.scl}`, `${id}:SCL`, 'I2C 时钟', '黄');
      add('3V3', `${id}:VCC`, '供电', '红');
      add('GND', `${id}:GND`, '地', '黑');
    } else if (p.type === 'servo') {
      add(`GPIO${p.pin}`, `${id}:SIG`, 'PWM 信号', '橙');
      add(ext5v ? 'EXT5V' : '5V', `${id}:VCC`, ext5v ? '供电（外接 5 V）' : '供电', '红');
      add('GND', `${id}:GND`, '地', '黑');
    } else if (p.type === 'gc9a01') {
      for (const [g, n] of [[12, 'SCL'], [11, 'SDA'], [10, 'CS'], [14, 'DC'], [13, 'RST'], [15, 'BLK']] as const) add(`GPIO${g}`, `${id}:${n}`, `SPI ${n}`, '橙');
      add('3V3', `${id}:VCC`, '供电', '红');
      add('GND', `${id}:GND`, '地', '黑');
    } else if (p.type === 'pot') {
      add(`GPIO${p.pin}`, `${id}:W`, '模拟输入', '橙');
      add('3V3', `${id}:VCC`, '供电', '红');
      add('GND', `${id}:GND`, '地', '黑');
    } else if (p.type === 'led') {
      add(`GPIO${p.pin}`, `${id}:A`, '输出', '橙');
      add('GND', `${id}:K`, '地', '黑');
    }
  }
  return w;
}

/** 本页里用户自己验收过的固件（组装的"开机复测"用同一份固件；刷新后丢失，回落到台面上的固件） */
export const ownFirmware: Record<string, { buf: ArrayBuffer; name: string }> = {};

const PROGRESS_KEY = (work: string) => `tryboard-app-checks:${work}`;
function loadProgress(work: string): Record<string, { fp: string; at: string }> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY(work)) ?? '{}');
  } catch {
    return {};
  }
}
function saveProgress(work: string, id: string, fp: string) {
  try {
    const p = loadProgress(work);
    p[id] = { fp, at: new Date().toLocaleString('zh-CN', { hour12: false }) };
    localStorage.setItem(PROGRESS_KEY(work), JSON.stringify(p));
  } catch {
    /* 隐私模式存不了，进度只在本页有效 */
  }
}

/** 页面启动时把本机存过的进度放进 store（只记了通过与指纹，没有逐条结果） */
export function restoreChecks(ctx: StepCtx) {
  const p = loadProgress(ctx.work.id);
  const checks: Record<string, CheckOutcome> = {};
  for (const [id, v] of Object.entries(p)) if (ctx.work.checkpoints.includes(id)) checks[id] = { ok: true, own: true, who: `你的固件（${v.at} 通过）`, rows: [], fingerprint: v.fp, sim: 0 };
  ctx.store.set({ checks });
}

export function passedCount(ctx: StepCtx, s: AppState = ctx.store.get()) {
  return ctx.work.checkpoints.filter((id) => s.checks[id]?.ok && s.checks[id].own).length;
}

const selEq = (a: Selection | null, b: Selection | null) => !!a && !!b && a.kind === b.kind && a.id === b.id;
const toPick = (s: Selection | null): PickTarget | null => (s && (s.kind === 'part' || s.kind === 'pin' || s.kind === 'wire' || s.kind === 'button') ? { kind: s.kind, id: s.id } : null);

export function benchStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  const openGroups: Record<string, boolean> = { part: true, wire: false, power: true, env: true, firmware: true, checkpoint: true };

  function select(sel: Selection | null) {
    ctx!.store.set({ selection: sel });
  }

  // ------------------------------------------------------------ 构建树
  function renderTree() {
    const c = ctx!;
    const s = c.store.get();
    const ses = c.session;
    const parts = ses.scene.parts;
    const wires = wiresOf(parts, !!ses.power?.ext5v);
    const item = (sel: Selection, label: string, meta = '', status = '') =>
      `<button type="button" class="tn ${selEq(s.selection, sel) ? 'on' : ''}" data-kind="${sel.kind}" data-id="${esc(sel.id)}" role="treeitem" aria-selected="${selEq(s.selection, sel)}"><span class="tn-l">${label}</span>${meta ? `<span class="tn-m">${meta}</span>` : ''}${status}</button>`;
    const group = (key: string, title: string, count: string, body: string) =>
      `<details class="tg" data-g="${key}" ${openGroups[key] ? 'open' : ''}><summary><span>${title}</span><span class="tn-m">${count}</span></summary><div role="group">${body}</div></details>`;
    const board = ses.chip === 'esp32s3' ? 'ESP32-S3-DevKitC-1' : 'ESP32-C3-DevKitM-1';
    const partItems = [item({ kind: 'part', id: 'board' }, board, ses.chip === 'esp32s3' ? 'S3' : 'C3'), ...parts.map((p) => item({ kind: 'part', id: partId(p) }, esc(partInfo(p).name), p.type === 'bme280' || p.type === 'oled' ? hex(p.addr) : 'pin' in p ? `GPIO${p.pin}` : ''))].join('');
    const wireItems = wires.map((w) => item({ kind: 'wire', id: w.id }, `${esc(w.a)} → ${esc(w.b)}`, w.color)).join('') || '<div class="tree-empty">没有外接线</div>';
    const env = s.env;
    const cps = c.work.checkpoints
      .map((id) => {
        const l = ses.levels.find((x) => x.id === id);
        const r = s.checks[id];
        const st = s.verifying === id ? '<span class="tn-st run">…</span>' : r ? (r.ok ? `<span class="tn-st ok">${r.own ? '✓' : '✓参考'}</span>` : '<span class="tn-st bad">✗</span>') : '';
        return item({ kind: 'checkpoint', id }, `<span class="mono">${esc(id)}</span> ${esc(l?.title ?? '')}`, '', st);
      })
      .join('');
    c.shell.tree.innerHTML = `<div role="tree" aria-label="构建树">
${group('part', '零件', String(parts.length + 1), partItems)}
${group('wire', '连线', String(wires.length), wireItems)}
${group('power', '供电', '', item({ kind: 'power', id: 'usb' }, 'USB 5 V（电脑）', '5V') + (ses.power?.ext5v ? item({ kind: 'power', id: 'ext5v' }, '外接 5 V 2 A（舵机）', 'EXT5V') : ''))}
${group('env', '环境', '', item({ kind: 'env', id: 'room' }, '室内', `<span class="mono">${env.temp.toFixed(1)} °C</span>`))}
${group('firmware', '固件', '', ses.fwName ? item({ kind: 'firmware', id: 'main' }, esc(ses.fwName), ses.fwSize ? `${(ses.fwSize / 1024).toFixed(0)} KB` : '') : item({ kind: 'firmware', id: 'main' }, '还没有固件', '拖 .bin 进来'))}
${c.work.checkpoints.length ? group('checkpoint', '检查点', `${passedCount(c, s)}/${c.work.checkpoints.length}`, cps) : ''}
</div>`;
    c.shell.tree.querySelectorAll<HTMLButtonElement>('.tn').forEach((b) => (b.onclick = () => select({ kind: b.dataset.kind as Selection['kind'], id: b.dataset.id! })));
    c.shell.tree.querySelectorAll<HTMLDetailsElement>('details.tg').forEach((d) => d.addEventListener('toggle', () => (openGroups[d.dataset.g!] = d.open)));
  }

  // ------------------------------------------------------------ 属性面板
  const row = (k: string, v: string, live = '', cls = '') => `<div class="kv"><span class="k">${k}</span><span class="v mono ${cls}" ${live ? `data-live="${live}"` : ''}>${v}</span></div>`;
  /** 长文字（型号、作用）：键在上、值在下，正文字体 */
  const rowT = (k: string, v: string) => `<div class="kv col"><span class="k">${k}</span><span class="v txt">${v}</span></div>`;
  const sec = (t: string) => `<div class="sec">${t}</div>`;

  function renderProps() {
    const c = ctx!;
    const s = c.store.get();
    const sel = s.selection;
    const el = c.shell.props;
    if (!sel) {
      el.innerHTML = `${sec('属性')}<div class="tree-empty">点左边的构建树或台面上的零件</div>`;
      return;
    }
    if (sel.kind === 'checkpoint') return renderCheckpoint(sel.id);
    if (sel.kind === 'env') return renderEnv();
    if (sel.kind === 'firmware') return renderFirmware();
    if (sel.kind === 'power' && c.session.power) {
      // 从采购清单摆上来的台面：按清单说清楚舵机从哪取电（欠压演示留给 P1 电气，这里只显示）
      const ext = c.session.power.ext5v;
      const hasServo = c.session.scene.parts.some((p) => p.type === 'servo');
      el.innerHTML =
        sel.id === 'ext5v'
          ? `${sec('供电')}<div class="ph">外接 5 V 2 A</div>${rowT('来源', '5 V 2 A 电源适配器 → DC 母座 → 面包板电源轨')}${rowT('给谁', '舵机；地线和开发板 GND 接在一起')}${row('可信度', '估算')}`
          : `${sec('供电')}<div class="ph">USB 5 V（电脑）</div>${rowT('来源', 'USB-C 接电脑，5 V，最多约 500 mA')}${rowT('3V3', '板载 LDO 稳压，给 BME280 / OLED')}${rowT('5V 轨', ext ? '只给开发板；舵机走外接 5 V' : hasServo ? '直通 USB，舵机也从这里取电' : '直通 USB')}${row('可信度', '估算')}${!ext && hasServo ? '<p class="note bad">清单里没有舵机电源：舵机只靠 USB，一转板子可能复位。欠压演示由后续任务（P1 电气）接上，现在只显示。</p>' : ''}`;
      return;
    }
    if (sel.kind === 'power') {
      el.innerHTML = `${sec('供电')}<div class="ph">USB 5 V（电脑）</div>${rowT('来源', 'USB-C 接电脑，5 V')}${rowT('3V3', '板载 LDO 稳压，给 BME280 / OLED')}${rowT('5V 轨', '直通 USB，给舵机')}${row('可信度', '估算')}<p class="note">换外接 5 V、看舵机一转板子会不会复位：由后续任务（P0-04 / P1 电气）实现。</p>`;
      return;
    }
    if (sel.kind === 'wire') {
      const w = wiresOf(c.session.scene.parts).find((x) => x.id === sel.id);
      el.innerHTML = w
        ? `${sec('连线')}<div class="ph">${esc(w.a)} → ${esc(w.b)}</div>${row('作用', w.role)}${row('颜色', w.color + '色杜邦线')}${row('一端', esc(w.a))}${row('另一端', esc(w.b))}`
        : `${sec('连线')}<div class="ph mono">${esc(sel.id)}</div>`;
      return;
    }
    if (sel.kind === 'pin' || sel.kind === 'button') {
      const pin = c.session.pick.listPins?.().find((p) => p.id === sel.id);
      el.innerHTML = `${sec(sel.kind === 'pin' ? '针脚' : '按键')}<div class="ph mono">${esc(pin?.label ?? sel.id)}</div>${row('接了', esc(pin?.role ?? (sel.id === 'BOOT' ? 'GPIO0，按下接地' : sel.id === 'RST' ? 'EN，松开重新上电' : '—')))}<p class="note">针脚实时值与示波器小窗由 P0-11 实现。</p>`;
      return;
    }
    renderPart(sel.id);
  }

  function renderPart(id: string) {
    const c = ctx!;
    const el = c.shell.props;
    const ses = c.session;
    if (id === 'board') {
      const s3 = ses.chip === 'esp32s3';
      el.innerHTML = `${sec('开发板')}<div class="ph">${s3 ? 'ESP32-S3-DevKitC-1' : 'ESP32-C3-DevKitM-1'}</div>
${row('芯片', s3 ? 'ESP32-S3 · 双核 160 MHz' : 'ESP32-C3 · 160 MHz')}${row('供电', 'USB 5 V → 3V3')}
${sec('实时')}${row('运行', '', 'run')}${row('模拟时间', '', 'sim')}${row(`板载 RGB（GPIO${s3 ? 48 : 8}）`, '', 'rgb')}
<div class="btns"><button type="button" class="btn" id="bootBtn">按住 BOOT（GPIO0）</button><button type="button" class="btn" id="rstBtn">RST 重新上电</button></div>`;
      const boot = el.querySelector<HTMLButtonElement>('#bootBtn')!;
      boot.onpointerdown = () => ses.pressBoot(true);
      boot.onpointerup = boot.onpointerleave = () => ses.pressBoot(false);
      el.querySelector<HTMLButtonElement>('#rstBtn')!.onclick = () => ses.reboot();
      updateLive();
      return;
    }
    const p = ses.scene.parts.find((x) => partId(x) === id);
    if (!p) {
      el.innerHTML = `${sec('零件')}<div class="ph mono">${esc(id)}</div><div class="tree-empty">这个零件不在当前台面上</div>`;
      return;
    }
    const info = partInfo(p);
    let live = '';
    if (p.type === 'bme280') {
      const t = c.store.get().env.temp;
      live = `${sec('实时读数 · 固件串口最近一行')}${row('温度', '', 'rt')}${row('湿度', '', 'rh')}${row('气压', '', 'rp')}
${sec('环境温度 · 改的是虚拟世界')}<label class="slider"><input type="range" min="-10" max="45" step="0.5" value="${t}" data-env="temp" aria-label="环境温度" /><output class="mono">${t.toFixed(1)} °C</output></label>
<p class="note">湿度、气压在构建树「环境」里调。可信度：模拟器验证过（与命令行一致）。</p>`;
    } else if (p.type === 'oled') {
      live = `${sec('实时画面')}<canvas class="oled" width="128" height="64" data-live="oledc"></canvas>${row('点亮像素', '', 'oledn')}`;
    } else if (p.type === 'servo') {
      live = `${sec('实时')}${row('脉宽', '', 'pw')}${row('角度', '', 'ang')}`;
    }
    el.innerHTML = `${sec('零件')}<div class="ph">${esc(info.name)}</div>${rowT('型号', esc(info.model))}${rowT('接口', esc(info.iface))}${row('供电', esc(info.power))}${live}`;
    bindEnvInputs();
    updateLive();
  }

  function renderEnv() {
    const c = ctx!;
    const e = c.store.get().env;
    const rows: [keyof typeof e, string, number, number, number, (v: number) => string][] = [
      ['temp', '温度', -10, 45, 0.5, (v) => `${v.toFixed(1)} °C`],
      ['humidity', '湿度', 0, 100, 1, (v) => `${v.toFixed(0)} %`],
      ['pressure', '气压', 90000, 110000, 50, (v) => `${(v / 100).toFixed(1)} hPa`],
    ];
    c.shell.props.innerHTML = `${sec('环境')}<div class="ph">室内</div><p class="note">改的是虚拟世界：BME280 读到的、固件打印的、OLED 显示的都跟着变。</p>
${rows.map(([k, n, min, max, step, f]) => `<div class="kv col"><span class="k">${n}</span><label class="slider"><input type="range" min="${min}" max="${max}" step="${step}" value="${e[k]}" data-env="${k}" aria-label="${n}" /><output class="mono">${f(e[k])}</output></label></div>`).join('')}
${sec('传感器读到')}${row('温度', '', 'rt')}${row('湿度', '', 'rh')}${row('气压', '', 'rp')}`;
    bindEnvInputs();
    updateLive();
  }

  function bindEnvInputs() {
    const c = ctx!;
    const fmt: Record<string, (v: number) => string> = { temp: (v) => `${v.toFixed(1)} °C`, humidity: (v) => `${v.toFixed(0)} %`, pressure: (v) => `${(v / 100).toFixed(1)} hPa` };
    c.shell.props.querySelectorAll<HTMLInputElement>('input[data-env]').forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.env as 'temp' | 'humidity' | 'pressure';
        const v = Number(inp.value);
        inp.parentElement!.querySelector('output')!.textContent = fmt[k](v);
        c.session.setEnv({ [k]: v });
      };
    });
  }

  function renderFirmware() {
    const c = ctx!;
    const ses = c.session;
    c.shell.props.innerHTML = `${sec('固件')}<div class="ph mono">${esc(ses.fwName || '还没有固件')}</div>
${ses.fwName ? row('大小', `${(ses.fwSize / 1024).toFixed(0)} KB`) + row('芯片', ses.chip === 'esp32s3' ? 'ESP32-S3' : 'ESP32-C3') : ''}
${row('运行', '', 'run')}${row('模拟时间', '', 'sim')}
<label class="drop" data-drop="bench"><input type="file" accept=".bin" class="vh" /><b>把 .bin 拖到这里</b><span>换成你的固件在台面上跑（ESP-IDF / Arduino 的完整 flash 镜像）</span></label>
<div class="btns"><button type="button" class="btn primary" id="rerun">再跑一次</button></div>`;
    c.shell.props.querySelector<HTMLButtonElement>('#rerun')!.onclick = () => ses.reboot();
    bindDrop(c.shell.props.querySelector('.drop')!, async (f) => {
      ses.loadFirmware(await f.arrayBuffer(), f.name);
      renderTree();
      renderFirmware();
    });
    updateLive();
  }

  function bindDrop(zone: HTMLElement, handle: (f: File) => Promise<void>) {
    const input = zone.querySelector('input')!;
    // 文件读不出来（被移走、没权限）时给提示，不抛到页面上
    const onFile = (f: File) => handle(f).catch((e) => ctx?.shell.toast(`读不了 ${f.name}：${e instanceof Error ? e.message : e}`));
    input.onchange = () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) onFile(f);
    };
    zone.ondragover = (e) => {
      e.preventDefault();
      zone.classList.add('over');
    };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) onFile(f);
    };
  }

  function renderCheckpoint(id: string) {
    const c = ctx!;
    const s = c.store.get();
    const l = c.session.levels.find((x) => x.id === id);
    const el = c.shell.props;
    if (!l) {
      el.innerHTML = `${sec('检查点')}<div class="tree-empty">没有这个检查点：${esc(id)}</div>`;
      return;
    }
    const r = s.checks[id];
    const busy = s.verifying === id;
    const other = !!s.verifying && !busy;
    const rows = r
      ? r.rows.map((x) => `<div class="res ${x.ok === null ? 'na' : x.ok ? 'ok' : 'bad'}"><span class="mk">${x.ok === null ? '·' : x.ok ? '✓' : '✗'}</span><span>${esc(x.text)}</span></div>`).join('')
      : '';
    const result = r
      ? `${sec('验收结果')}<div class="verdict-line ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ 通过' : '✗ 未通过'} <span class="muted">· ${esc(r.who)}${r.sim ? ` · 模拟 ${r.sim.toFixed(2)} s` : ''}</span></div>${rows}${row('运行指纹', esc(r.fingerprint), '', 'fp')}<p class="note">同一固件、同样输入，网页和命令行 <span class="mono">tools/check.py</span> 都是这个指纹。${r.ok && !r.own ? '参考固件通过只说明检查点本身能过，不算你的进度。' : ''}</p>`
      : '';
    el.innerHTML = `${sec(`检查点 ${esc(l.id)}`)}<div class="ph">${esc(l.title)}</div><p class="goal">${esc(l.goal)}</p>
${sec('通过条件')}<div class="field">${esc(l.pass)}</div>
<div class="sec edit-only">验收</div><label class="drop ${busy || other ? 'busy' : ''}" data-drop="check"><input type="file" accept=".bin" class="vh" ${busy || other ? 'disabled' : ''} /><b>${busy ? `模拟中 <span class="mono" data-live="vp"></span>` : '把 .bin 拖到这里'}</b><span>${busy ? '按模拟时间跑完再判定，不看墙钟' : other ? '另一个检查点正在验收，稍等' : '或点这里选文件 · 逐条判定 + 运行指纹'}</span></label>
<div class="btns">${l.ref ? `<button type="button" class="btn" id="runRef" ${s.verifying ? 'disabled' : ''}>用参考固件试</button>` : ''}</div>
${result}
${sec('交给 AI 的任务书')}<pre class="brief">${esc(l.brief)}</pre><div class="btns"><button type="button" class="btn" id="copyBrief">复制任务书</button></div>
${sec('验收命令 · 你和 AI 用同一条')}<pre class="code">${esc(checkCommand(l))}</pre>`;
    el.querySelector<HTMLButtonElement>('#copyBrief')!.onclick = async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement;
      const text = `${l.brief}\n\n通过条件：${l.pass}\n验收：${checkCommand(l)}`;
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = '已复制';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(el.querySelector('.brief')!);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        b.textContent = '已选中，按 ⌘C / Ctrl+C 复制';
      }
    };
    if (!busy && !other) bindDrop(el.querySelector('.drop')!, async (f) => verify(l, await f.arrayBuffer(), f.name, true));
    el.querySelector<HTMLButtonElement>('#runRef')?.addEventListener('click', async () => verify(l, await fetchBuf(`./fw/${l.ref}/flash.bin`), `参考固件 ${l.ref}`, false));
    updateLive();
  }

  async function verify(l: Level, buf: ArrayBuffer, who: string, own: boolean) {
    const c = ctx!;
    if (c.store.get().verifying) return;
    if (own) ownFirmware[l.id] = { buf: buf.slice(0), name: who };
    c.store.set({ verifying: l.id, verifyProgress: 0 });
    let out: CheckOutcome;
    try {
      const v = await verifyLevel(l, buf, (t) => {
        if (t - c.store.get().verifyProgress >= 0.1) c.store.set({ verifyProgress: t });
      });
      const rows: CheckOutcome['rows'] = v.results.map((x) => ({ ok: x.ok, text: x.text }));
      // 装配检查是几何估算，命令行不判；实验台上也不判，留给「组装」步骤
      if (l.assembly) rows.push({ ok: null, text: '装配检查（几何估算）在「组装」步骤判定，这里不计' });
      out = { ok: v.ok, who, own, rows, fingerprint: v.fingerprint, sim: v.sim };
    } catch (e) {
      out = { ok: false, who, own, rows: [{ ok: false, text: `运行失败：${e}` }], fingerprint: '—', sim: 0 };
    }
    if (own && out.ok) saveProgress(c.work.id, l.id, out.fingerprint);
    // 参考固件的结果不覆盖你已经通过的记录
    const prev = c.store.get().checks[l.id];
    const keep = prev?.own && prev.ok && !own;
    c.store.set((s) => ({ verifying: null, checks: keep ? s.checks : { ...s.checks, [l.id]: out } }));
    if (keep) c.shell.toast(`参考固件：${out.ok ? '通过' : '未通过'}，指纹 ${out.fingerprint}（不覆盖你的记录）`);
  }

  // ------------------------------------------------------------ 实时字段（不重建面板，免得拖滑块时被打断）
  function updateLive() {
    const c = ctx!;
    const s = c.store.get();
    const el = c.shell.props;
    const set = (k: string, v: string, bad = false) => {
      const n = el.querySelector<HTMLElement>(`[data-live="${k}"]`);
      if (n) {
        n.textContent = v;
        n.classList.toggle('bad', bad);
      }
    };
    set('run', s.run ? `#${s.run}${s.running ? ' · 运行中' : ' · 停止'}` : '未上电');
    set('sim', `${s.simSeconds.toFixed(2)} s`);
    const rd = s.reading;
    // 读数和设定差太多（超过第 06 关的容差）标红：通常是固件换算错了
    set('rt', rd ? `${rd.t.toFixed(2)} °C` : '等固件打印…', !!rd && Math.abs(rd.t - s.env.temp) > 0.5);
    set('rh', rd ? `${rd.h.toFixed(1)} %` : '—');
    set('rp', rd ? `${rd.p.toFixed(2)} hPa` : '—');
    set('vp', `${s.verifyProgress.toFixed(1)} s`);
    const f = c.session.frame;
    const rgbN = el.querySelector<HTMLElement>('[data-live="rgb"]');
    if (rgbN) {
      const css = ledCss(f.rgb);
      rgbN.innerHTML = f.rgb ? `<i class="sw" style="background:${css ?? '#000'}"></i>#${f.rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}` : '灭';
    }
    const servo = c.session.scene.parts.find((p) => p.type === 'servo');
    if (servo && 'pin' in servo) {
      const d = f.pwm[servo.pin];
      set('pw', d !== undefined && d >= 0 ? `${(d * 20).toFixed(3)} ms` : '没有 PWM');
      const a = servoAngle(f.pwm, servo.pin);
      set('ang', a === null ? '—' : `${a.toFixed(1)}°`);
    }
    const cv = el.querySelector<HTMLCanvasElement>('canvas.oled');
    if (cv && f.oled) {
      const g = cv.getContext('2d')!;
      const img = g.createImageData(128, 64);
      let lit = 0;
      for (let i = 0; i < 128 * 64; i++) {
        const on = f.oled[i] > 0;
        lit += on ? 1 : 0;
        img.data.set(on ? [120, 200, 255, 255] : [8, 14, 24, 255], i * 4);
      }
      g.putImageData(img, 0, 0);
      set('oledn', String(lit));
    }
  }

  // ------------------------------------------------------------ 结论、下一步、工具条
  function syncChrome() {
    const c = ctx!;
    const n = c.work.checkpoints.length;
    const done = passedCount(c);
    c.shell.setNext('去组装 →', n && done === n ? 'assemble' : null, `检查点全部通过（${done}/${n}）才能组装`);
  }

  function onPick(t: PickTarget | null, screen: { x: number; y: number }) {
    if (!ctx) return;
    if (!t) {
      ctx.shell.card.hide();
      return select(null);
    }
    select({ kind: t.kind, id: t.id });
    if (t.kind === 'part') {
      const p = ctx.session.scene.parts.find((x) => partId(x) === t.id);
      const box = document.createElement('div');
      box.innerHTML = `<div class="sec">${p ? esc(partInfo(p).name) : t.id === 'board' ? '开发板' : esc(t.id)}</div><div class="muted">详情在右侧属性面板</div>`;
      ctx.shell.card.show(screen, box);
    } else ctx.shell.card.hide();
  }

  function onTool(id: string) {
    if (!ctx || ctx.store.get().step !== 'bench') return;
    const c = ctx;
    if (id === 'select' || id === 'orbit') c.shell.toolbar.setActive(id);
    else if (id === 'rerun') c.session.reboot();
    else if (id === 'button') {
      c.session.pressBoot(true);
      setTimeout(() => c.session.pressBoot(false), 150);
      c.shell.toast('按了一下 BOOT（GPIO0）');
    } else c.shell.toast('这个工具由后续任务实现');
  }

  return {
    mount(_el, c) {
      ctx = c;
      if (!hooked) {
        hooked = true;
        c.session.pick.onPick?.(onPick);
        c.shell.toolbar.onTool(onTool);
      }
      c.shell.toolbar.setGroups([
        { id: 'nav', tools: [{ id: 'select', label: '选择', key: 'V' }, { id: 'orbit', label: '转视角', key: 'H' }] },
        { id: 'edit', tools: [{ id: 'place', label: '放置', todo: true }, { id: 'wire', label: '连线', todo: true }] },
        { id: 'measure', tools: [{ id: 'meter', label: '万用表', todo: true }, { id: 'ruler', label: '尺子', todo: true }, { id: 'scope', label: '示波器', todo: true }] },
        { id: 'act', tools: [{ id: 'heat', label: '热源', todo: true }, { id: 'button', label: '按键' }] },
        { id: 'run', tools: [{ id: 'rerun', label: '再跑一次', primary: true }] },
      ]);
      c.shell.toolbar.setActive('select');
      if (!c.store.get().selection) c.store.set({ selection: c.work.checkpoints.length ? { kind: 'part', id: 'bme280' } : { kind: 'firmware', id: 'main' } });
      if (!c.session.scene.parts.some((p) => partId(p) === 'bme280') && c.store.get().selection?.id === 'bme280') c.store.set({ selection: { kind: 'part', id: 'board' } });
      renderTree();
      renderProps();
      syncChrome();
      unsubs = [
        c.store.subscribe(() => {
          renderTree();
          renderProps();
          c.session.pick.highlight?.(toPick(c.store.get().selection));
          syncChrome();
        }, ['selection', 'checks', 'verifying']),
        c.store.subscribe(() => renderTree(), ['env', 'run']),
        c.store.subscribe(() => updateLive(), ['simSeconds', 'reading', 'running', 'run', 'verifyProgress', 'env']),
      ];
      c.session.pick.highlight?.(toPick(c.store.get().selection));
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      ctx?.session.pick.highlight?.(null);
      ctx = null;
    },
  };
}
