// ② 实验台：构建树（零件 / 引脚 / 连线 / 供电 / 环境 / 固件 / 运行 / 检查点）+ 属性面板 + 检查点验收
// + 快捷卡片（P0-04）+ 针脚实时值与示波器（P0-11）+ 接线规则检查（P0-12）+ 尺子与运行历史（P0-13）。
// 点树和点台面（ScenePickApi.onPick）改的是同一个 selection；属性面板只跟着 selection 走。
import type { PickTarget, ScreenPoint } from '../../scene-api';
import { CHIP_HEAT_OFFSET } from '../../views/templates';
import { partId, partInfo, usedPins, wiresOf, type WireMods } from '../wiring';
import { checkWiring, faultByWire, type WireFault } from '../wirecheck';
import { PinTrace, bit, drawScope, pinKind, powerVolts, pwmText } from '../pinscope';
import { diffRuns, summarize, type BenchStep } from '../history';
import { checkCommand, type Level } from '../../checks';
import { verifyLevel } from '../../verify';
import { fetchBuf } from '../../assets';
import { servoAngle, ledCss } from '../../views/common';
import type { AppState, CheckOutcome, Selection, StepCtx, StepImpl } from '../types';
import { getAnalyzer } from '../analyzer';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hex = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

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
  const openGroups: Record<string, boolean> = { part: true, pin: false, wire: false, power: true, env: true, firmware: true, run: true, checkpoint: true };
  /** 选中的那根针的采样（示波器小窗） */
  const trace = new PinTrace();
  /** 尺子：工具条"尺子"按下后，台面上点两个目标 */
  let ruler: { a: PickTarget | null; b: PickTarget | null; mm: number | null } | null = null;
  /** 运行历史里点的第二条（和选中的那条对比） */
  let cmpRun: number | null = null;
  /** 快捷卡片跟着的目标 */
  let cardFor: PickTarget | null = null;
  let cardRaf = 0;
  /** 热源：放上去之前的室温（拿开时回到它） */
  let heatRoom: number | null = null;
  let faults: WireFault[] = [];
  let shownFaults = new Set<string>();

  function select(sel: Selection | null) {
    // 从台面点中的东西，在构建树里展开它所在的分组
    if (sel && sel.kind in openGroups) openGroups[sel.kind] = true;
    // 选了别的东西：卡片和"量到芯片"的尺子标注收起（尺子工具自己管自己的标注）
    if (cardFor && !(sel && sel.kind === cardFor.kind && sel.id === cardFor.id)) closeCard();
    if (!ruler) ctx!.session.pick.measure?.(null);
    ctx!.store.set({ selection: sel });
  }
  const benchWires = () => wiresOf(ctx!.session.scene.parts, !!ctx!.session.power?.ext5v, ctx!.session.wireMods);

  // ------------------------------------------------------------ 接线规则检查（P0-12）
  function recheckWiring() {
    const c = ctx!;
    faults = checkWiring(c.session.scene.parts, benchWires());
    const by = faultByWire(faults);
    for (const id of shownFaults) if (!by.has(id)) c.session.pick.setWireFault?.(id, null);
    for (const [id, f] of by) c.session.pick.setWireFault?.(id, f.short);
    shownFaults = new Set(by.keys());
  }

  // ------------------------------------------------------------ 构建树
  function renderTree() {
    const c = ctx!;
    const s = c.store.get();
    const ses = c.session;
    const parts = ses.scene.parts;
    const wires = benchWires();
    const byWire = faultByWire(faults);
    const item = (sel: Selection, label: string, meta = '', status = '') =>
      `<button type="button" class="tn ${selEq(s.selection, sel) ? 'on' : ''}" data-kind="${sel.kind}" data-id="${esc(sel.id)}" role="treeitem" aria-selected="${selEq(s.selection, sel)}"><span class="tn-l">${label}</span>${meta ? `<span class="tn-m">${meta}</span>` : ''}${status}</button>`;
    const group = (key: string, title: string, count: string, body: string) =>
      `<details class="tg" data-g="${key}" ${openGroups[key] ? 'open' : ''}><summary><span>${title}</span><span class="tn-m">${count}</span></summary><div role="group">${body}</div></details>`;
    const board = ses.chip === 'esp32s3' ? 'ESP32-S3-DevKitC-1' : 'ESP32-C3-DevKitM-1';
    const partItems = [item({ kind: 'part', id: 'board' }, board, ses.chip === 'esp32s3' ? 'S3' : 'C3'), ...parts.map((p) => item({ kind: 'part', id: partId(p) }, esc(partInfo(p).name), p.type === 'bme280' || p.type === 'oled' ? hex(p.addr) : 'pin' in p ? `GPIO${p.pin}` : ''))].join('');
    // 引脚：只列用到的针（接了线的 + 板上自带用途的，如 BOOT、板载彩灯）
    const pinInfo = ses.pick.listPins?.() ?? [];
    const used = new Set(usedPins(wires));
    const pins = pinInfo.filter((p) => used.has(p.id) || p.role);
    const pinItems = pins.map((p) => item({ kind: 'pin', id: p.id }, `<span class="mono">${esc(p.id)}</span>`, esc(p.role ?? wires.find((w) => w.a === p.id)?.role ?? ''))).join('') || '<div class="tree-empty">没有用到的针脚</div>';
    const wireItems = wires.map((w) => item({ kind: 'wire', id: w.id }, `${esc(w.a)} → ${esc(w.b)}`, w.color, byWire.has(w.id) ? '<span class="tn-st bad">✗</span>' : '')).join('') || '<div class="tree-empty">没有外接线</div>';
    const nBad = new Set(faults.flatMap((f) => f.wires)).size;
    const wireCount = nBad ? `<span class="bad">${wires.length} · ${faults.length} 处问题</span>` : `${wires.length} · ✓`;
    const env = s.env;
    const cps = c.work.checkpoints
      .map((id) => {
        const l = ses.levels.find((x) => x.id === id);
        const r = s.checks[id];
        const st = s.verifying === id ? '<span class="tn-st run">…</span>' : r ? (r.ok ? `<span class="tn-st ok">${r.own ? '✓' : '✓参考'}</span>` : '<span class="tn-st bad">✗</span>') : '';
        return item({ kind: 'checkpoint', id }, `<span class="mono">${esc(id)}</span> ${esc(l?.title ?? '')}`, '', st);
      })
      .join('');
    const runs = c.hist?.runs() ?? [];
    const runItems = runs.map((r) => item({ kind: 'run', id: String(r.n) }, `运行 #${r.n}`, r.snap ? `${r.snap.simSeconds.toFixed(1)} s` : '运行中', r.n === s.runNo && s.hist.seeked ? '<span class="tn-st run">◂</span>' : '')).join('') || '<div class="tree-empty">还没运行过</div>';
    const ext = !!ses.power?.ext5v;
    const hasServo = parts.some((p) => p.type === 'servo');
    c.shell.tree.innerHTML = `<div role="tree" aria-label="构建树">
${group('part', '零件', String(parts.length + 1), partItems)}
${group('pin', '引脚', String(pins.length), pinItems)}
${group('wire', '连线', wireCount, wireItems)}
${group('power', '供电', ext ? 'USB + 外接' : 'USB', item({ kind: 'power', id: 'usb' }, 'USB 5 V（电脑）', '5V') + (ext ? item({ kind: 'power', id: 'ext5v' }, '外接 5 V 2 A（舵机）', 'EXT5V') : hasServo ? item({ kind: 'power', id: 'ext5v' }, '<span class="muted">外接 5 V（没接）</span>', '') : ''))}
${group('env', '环境', '', item({ kind: 'env', id: 'room' }, '室内', `<span class="mono">${env.temp.toFixed(1)} °C</span>`, ses.heat ? '<span class="tn-st bad">热</span>' : ''))}
${group('firmware', '固件', '', ses.fwName ? item({ kind: 'firmware', id: 'main' }, esc(ses.fwName), ses.fwSize ? `${(ses.fwSize / 1024).toFixed(0)} KB` : '') : item({ kind: 'firmware', id: 'main' }, '还没有固件', '拖 .bin 进来'))}
${group('run', '运行历史', String(runs.length), runItems)}
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

  /** 停在回退点时，属性面板顶上的一条：回到了哪、指纹对不对、从这里继续 */
  function seekBanner() {
    const c = ctx!;
    const h = c.store.get().hist;
    if (h.busy) return `<div class="seekbar"><b>正在回退…</b><span class="mono" data-live="sim"></span><span class="muted">按输入日志快进，不看墙钟</span></div>`;
    const r = c.hist?.lastSeek();
    if (!h.seeked || !r) return '';
    const same = r.same === null ? '<span class="muted">同一次运行里后面还有操作：停在下一步发生之前，所以不和整次运行的指纹比</span>' : r.same ? '<span class="ok">✓ 指纹与当时一致</span>' : '<span class="bad">✗ 指纹与当时不一致</span>';
    return `<div class="seekbar" data-seek="${r.run}"><b>回到运行 #${r.run} 的 ${(r.untilMs / 1000).toFixed(2)} s · 已暂停</b><span class="mono">指纹 ${esc(r.fingerprint)}</span>${same}<div class="btns"><button type="button" class="btn primary" id="resume">从这里继续</button><button type="button" class="btn" id="seekRerun">重新上电</button></div><span class="muted">接着改、接着跑，后面的步骤会被丢掉</span></div>`;
  }
  function bindSeekBanner() {
    const c = ctx!;
    c.shell.props.querySelector<HTMLButtonElement>('#resume')?.addEventListener('click', () => c.hist?.resume());
    c.shell.props.querySelector<HTMLButtonElement>('#seekRerun')?.addEventListener('click', () => c.session.reboot());
  }

  function renderProps() {
    const c = ctx!;
    const s = c.store.get();
    const sel = s.selection;
    const el = c.shell.props;
    if (!sel) {
      el.innerHTML = `${seekBanner()}${sec('属性')}<div class="tree-empty">点左边的构建树或台面上的零件</div>`;
    } else if (sel.kind === 'checkpoint') renderCheckpoint(sel.id);
    else if (sel.kind === 'env') renderEnv();
    else if (sel.kind === 'firmware') renderFirmware();
    else if (sel.kind === 'power') renderPower(sel.id);
    else if (sel.kind === 'wire') renderWire(sel.id);
    else if (sel.kind === 'pin') renderPin(sel.id);
    else if (sel.kind === 'button') renderButton(sel.id);
    else if (sel.kind === 'run') renderRuns(Number(sel.id));
    else if (sel.kind === 'tool') renderRuler();
    else renderPart(sel.id);
    const banner = seekBanner();
    if (banner && !el.querySelector('.seekbar')) el.insertAdjacentHTML('afterbegin', banner);
    bindSeekBanner();
  }

  function renderPower(id: string) {
    const c = ctx!;
    const el = c.shell.props;
    const ext = !!c.session.power?.ext5v;
    const hasServo = c.session.scene.parts.some((p) => p.type === 'servo');
    const toggle = hasServo
      ? `${sec('舵机从哪取电')}<div class="seg" role="radiogroup" aria-label="舵机供电"><button type="button" class="segb" data-power="usb" aria-pressed="${!ext}">USB 5 V</button><button type="button" class="segb" data-power="ext" aria-pressed="${ext}">外接 5 V 2 A</button></div><p class="note">只改清单和供电显示：外接 = 清单里加 5 V 2 A 电源 + DC 母座。舵机一转 USB 掉压复位的模拟属于 P1 电气，这里不算。</p>`
      : '';
    el.innerHTML =
      id === 'ext5v'
        ? `${sec('供电')}<div class="ph">外接 5 V 2 A</div>${ext ? `${rowT('来源', '5 V 2 A 电源适配器 → DC 母座 → 面包板电源轨')}${rowT('给谁', '舵机；地线和开发板 GND 接在一起')}` : '<p class="note">还没接外接电源：舵机从 USB 5V 取电。</p>'}${row('电压', ext ? '≈ 5.0 V' : '—')}${row('可信度', '估算')}${toggle}`
        : `${sec('供电')}<div class="ph">USB 5 V（电脑）</div>${rowT('来源', 'USB-C 接电脑，5 V，最多约 500 mA')}${rowT('3V3', '板载 LDO 稳压，给 BME280 / OLED')}${rowT('5V 轨', ext ? '只给开发板；舵机走外接 5 V' : hasServo ? '直通 USB，舵机也从这里取电' : '直通 USB')}${row('可信度', '估算')}${!ext && hasServo ? '<p class="note bad">舵机只靠 USB：一转板子可能复位。欠压演示由 P1 电气接上，现在只显示。</p>' : ''}${toggle}`;
    bindPowerToggle(el);
  }
  function bindPowerToggle(root: HTMLElement) {
    root.querySelectorAll<HTMLButtonElement>('[data-power]').forEach((b) => (b.onclick = () => setPower(b.dataset.power === 'ext')));
  }
  function setPower(ext: boolean) {
    const c = ctx!;
    if (!!c.session.power?.ext5v === ext) return;
    c.hist?.op({ k: 'power', ext5v: ext });
    c.session.setPower(ext);
    c.shell.toast(ext ? '舵机改由外接 5 V 2 A 供电：清单里有电源适配器和 DC 母座' : '舵机改回 USB 5 V 供电：清单去掉了外接电源');
  }

  function renderWire(id: string) {
    const c = ctx!;
    const el = c.shell.props;
    const w = benchWires().find((x) => x.id === id);
    if (!w) {
      el.innerHTML = `${sec('连线')}<div class="ph mono">${esc(id)}</div>`;
      return;
    }
    const fs = faults.filter((f) => f.wires.includes(id));
    const power = w.part === 'servo' && w.pinRole === 'power';
    el.innerHTML = `${sec('连线')}<div class="ph">${esc(w.a)} → ${esc(w.b)}</div>${row('作用', esc(w.role))}${row('颜色', w.color + '色杜邦线')}${row('开发板一端', esc(w.a), '', w.from ? 'bad' : '')}${w.from ? row('原来接在', esc(w.from)) : ''}${row('零件一端', esc(w.b))}${w.ohm !== undefined ? row('限流电阻', w.ohm ? `${w.ohm} Ω` : '没有', '', w.ohm ? '' : 'bad') : ''}${w.missing ? row('状态', '没插上', '', 'bad') : ''}
${sec(fs.length ? `接线检查 · ${fs.length} 处问题` : '接线检查')}${fs.length ? fs.map(faultHtml).join('') : '<div class="res ok"><span class="mk">✓</span><span>这根线没发现问题</span></div>'}
${power ? renderPowerInline() : ''}`;
    bindPowerToggle(el);
  }
  const faultHtml = (f: WireFault) => `<div class="res bad"><span class="mk">✗</span><span><b>${esc(f.title)}</b> · ${esc(f.detail)}<br><span class="muted">${f.rule} · ${esc(f.confidence)} · ${esc(f.source)}</span></span></div>`;
  const renderPowerInline = () => {
    const ext = !!ctx!.session.power?.ext5v;
    return `${sec('舵机从哪取电')}<div class="seg" role="radiogroup" aria-label="舵机供电"><button type="button" class="segb" data-power="usb" aria-pressed="${!ext}">USB 5 V</button><button type="button" class="segb" data-power="ext" aria-pressed="${ext}">外接 5 V 2 A</button></div>`;
  };

  // ------------------------------------------------------------ 针脚（P0-11）
  function renderPin(id: string) {
    const c = ctx!;
    const el = c.shell.props;
    const pin = c.session.pick.listPins?.().find((p) => p.id === id);
    const wires = benchWires().filter((w) => w.a === id && !w.missing);
    const kind = pinKind(id, wires);
    const gpio = /^GPIO(\d+)$/.exec(id);
    trace.watch(gpio ? Number(gpio[1]) : -1);
    const to = wires.map((w) => `${partName(w.part)} · ${w.pin}`).join('；');
    const fs = faults.filter((f) => f.wires.some((x) => wires.some((w) => w.id === x)));
    el.innerHTML = `${sec('针脚')}<div class="ph mono">${esc(id)}</div>${row('丝印', esc(pin?.label ?? id))}${row('角色', esc(pin?.role ?? (wires[0]?.role || '没接东西')))}${to ? rowT('接到', esc(to)) : ''}
${sec('实时值')}${kind === 'gpio' ? `${row('方向', '', 'pdir')}${row('电平', '', 'plv')}${row('PWM 频率', '', 'pf')}${row('脉宽', '', 'pw2')}${row('占空比', '', 'pd')}` : kind === 'i2c' ? `${row('I2C 角色', esc(wires.map((w) => `${w.pin === 'SDA' ? 'SDA 数据' : 'SCL 时钟'} → ${partName(w.part)}`).join('；')))}${row('电平', '', 'plv')}${row('总线', '开漏，模块上拉到 3V3')}` : `${row('电压', esc(powerVolts(id, !!c.session.power?.ext5v)))}${row('可信度', '估算')}`}
${sec('示波器')}<canvas class="scope" data-live="scope" width="280" height="96" aria-label="${esc(id)} 波形"></canvas><p class="note" data-live="scopeNote"></p>
${kind === 'gpio' || kind === 'i2c' ? `<div class="btns"><button type="button" class="btn" data-ana="${esc(id)}">在分析仪里打开</button></div><p class="note">${kind === 'i2c' ? '逻辑分析仪按 I2C 事务解码（起始、地址、每个字节和应答），带寄存器注释。' : '逻辑分析仪画的是内核按周期记下的事件（电平变化、PWM 占空比 / 频率），不是 tick 采样。'}</p>` : ''}
${fs.length ? sec('接线检查') + fs.map(faultHtml).join('') : ''}`;
    el.querySelector<HTMLButtonElement>('[data-ana]')?.addEventListener('click', (e) => getAnalyzer(c).open((e.currentTarget as HTMLButtonElement).dataset.ana));
    updateLive();
  }
  const partName = (pid: string) => {
    const p = ctx!.session.scene.parts.find((x) => partId(x) === pid);
    return p ? partInfo(p).name : pid;
  };

  function renderButton(id: string) {
    const c = ctx!;
    c.shell.props.innerHTML = `${sec('按键')}<div class="ph mono">${esc(id)}</div>${row('接了', id === 'BOOT' ? 'GPIO' + (c.session.chip === 'esp32s3' ? 0 : 9) + '，按下接地' : 'EN，松开重新上电')}
<div class="btns">${id === 'BOOT' ? '<button type="button" class="btn" data-boot="down">按下</button><button type="button" class="btn" data-boot="up">松开</button>' : '<button type="button" class="btn" id="rstBtn">按一下 RST</button>'}</div><p class="note">按键进输入日志（模拟时间戳），回退时按原来的时刻重放。</p>`;
    bindBoot(c.shell.props);
    c.shell.props.querySelector<HTMLButtonElement>('#rstBtn')?.addEventListener('click', () => c.session.reboot());
  }
  function bindBoot(root: HTMLElement) {
    root.querySelectorAll<HTMLButtonElement>('[data-boot]').forEach((b) => (b.onclick = () => {
      const down = b.dataset.boot === 'down';
      ctx!.session.pressBoot(down);
      root.querySelectorAll<HTMLButtonElement>('[data-boot]').forEach((x) => x.setAttribute('aria-pressed', String((x.dataset.boot === 'down') === down)));
      ctx!.shell.toast(down ? 'BOOT 按住了（GPIO0 接地），点「松开」放开' : 'BOOT 松开了');
    }));
  }

  // ------------------------------------------------------------ 运行历史（P0-13）
  function renderRuns(n: number) {
    const c = ctx!;
    const runs = c.hist?.runs() ?? [];
    const a = runs.find((r) => r.n === n);
    const el = c.shell.props;
    if (!a) {
      el.innerHTML = `${sec('运行历史')}<div class="tree-empty">没有运行 #${n}</div>`;
      return;
    }
    const sa = summarize(a);
    const b = cmpRun !== null && cmpRun !== n ? runs.find((r) => r.n === cmpRun) : undefined;
    const list = runs
      .map((r) => {
        const x = summarize(r);
        const tag = r.n === n ? 'A' : r.n === cmpRun ? 'B' : '';
        return `<button type="button" class="runrow ${tag ? 'on' : ''}" data-run="${r.n}"><span class="mono rk">${tag || '·'}</span><span class="rt"><b>运行 #${r.n}</b> <span class="muted">${esc(x.fw)}</span><br><span class="mono">${esc(x.env0)}</span> · ${esc(x.power)}<br><span class="mono fp">${esc(x.fingerprint)}</span></span></button>`;
      })
      .join('');
    let cmp = '';
    if (b) {
      const d = diffRuns(sa, summarize(b));
      const nCh = d.filter((x) => x.changed).length;
      cmp = `${sec(`差异项 · ${nCh} 项不同（≠ 标出）`)}<div class="diff"><div class="drow hd"><span class="k"></span><span>A #${a.n}</span><span>B #${b.n}</span></div>${d.map((x) => `<div class="drow ${x.changed ? 'ch' : ''}"><span class="k">${x.changed ? '≠ ' : ''}${x.label}</span><span class="${x.key === 'fingerprint' || x.key === 'result' ? 'mono' : ''}">${esc(x.a)}</span><span class="${x.key === 'fingerprint' || x.key === 'result' ? 'mono' : ''}">${esc(x.b)}</span></div>`).join('')}</div>`;
    }
    const step = (c.hist?.steps() ?? []).findIndex((s: BenchStep) => s.op.k === 'run' && s.op.n === n);
    // 有对比时先给差异项（结论先说），单条详情收进下面的列表
    const detail = b
      ? ''
      : `${row('固件', esc(sa.fw))}${row('上电时环境', esc(sa.env0))}${row('运行中改环境', `${sa.envChanges} 次`)}${row('供电', esc(sa.power))}${row('热源', esc(sa.heat))}${row('模拟时长', esc(sa.seconds))}${rowT('最后一行', `<span class="mono">${esc(sa.result)}</span>`)}${row('指纹', esc(sa.fingerprint), '', 'fp')}`;
    el.innerHTML = `${sec('运行历史')}<div class="ph">运行 #${a.n}${b ? ` ↔ 运行 #${b.n}` : ''}</div>${detail}${cmp}
<div class="btns"><button type="button" class="btn" id="gotoRun" ${step < 0 ? 'disabled' : ''}>回到运行 #${a.n}</button>${b ? '<button type="button" class="btn" id="cmpOff">不对比</button>' : ''}</div>
${sec('全部运行 · 点一条和 A 对比')}<div class="runs">${list}</div>`;
    el.querySelector<HTMLButtonElement>('#cmpOff')?.addEventListener('click', () => {
      cmpRun = null;
      renderProps();
    });
    el.querySelectorAll<HTMLButtonElement>('.runrow').forEach((btn) => (btn.onclick = () => {
      const k = Number(btn.dataset.run);
      if (k === n) return;
      cmpRun = k;
      renderProps();
    }));
    el.querySelector<HTMLButtonElement>('#gotoRun')?.addEventListener('click', () => step >= 0 && c.hist?.seek(step));
  }

  // ------------------------------------------------------------ 尺子（P0-13）
  const pickName = (t: PickTarget) => (t.kind === 'part' ? (t.id === 'board' ? '开发板芯片' : partName(t.id)) : t.id);
  function renderRuler() {
    const r = ruler;
    const el = ctx!.shell.props;
    const drift = r?.mm != null && r.a && r.b && [r.a.id, r.b.id].includes('bme280') && [r.a.id, r.b.id].includes('board') ? driftText(r.mm) : '';
    el.innerHTML = `${sec('尺子')}<div class="ph">量两个目标之间的距离</div><p class="note">在台面上依次点两个零件 / 针脚 / 导线；量完再点就重新开始。点工具条「选择」退出。</p>
${row('起点', r?.a ? esc(pickName(r.a)) : '点第一个目标')}${row('终点', r?.b ? esc(pickName(r.b)) : r?.a ? '点第二个目标' : '—')}${row('距离', r?.mm != null ? `${r.mm.toFixed(1)} mm` : '—', '', 'fp')}${drift ? rowT('温漂（估算）', esc(drift)) : ''}
<div class="btns"><button type="button" class="btn" id="rulerChip">量 BME280 到芯片</button></div>`;
    el.querySelector<HTMLButtonElement>('#rulerChip')!.onclick = () => measureChip();
  }
  /** 传感器离芯片越近读数越高：组装步骤用的同一个数（贴着芯片 +2.5 ℃），这里按距离线性收到 30 mm 为 0，估算 */
  const driftOf = (mm: number) => Math.max(0, Math.min(1, (30 - mm) / 25)) * CHIP_HEAT_OFFSET;
  const driftText = (mm: number) => {
    const d = driftOf(mm);
    return d < 0.05 ? `离芯片 ${mm.toFixed(1)} mm：芯片发热影响可以忽略（贴着芯片 < 5 mm 时约 +${CHIP_HEAT_OFFSET} ℃，估算）` : `离芯片 ${mm.toFixed(1)} mm：读数约偏高 ${d.toFixed(1)} ℃（估算，未经真机标定）`;
  };
  function measureChip(): number | null {
    const mm = ctx!.session.pick.measure?.({ kind: 'part', id: 'bme280' }, { kind: 'part', id: 'board' }) ?? null;
    if (ruler) {
      ruler = { a: { kind: 'part', id: 'bme280' }, b: { kind: 'part', id: 'board' }, mm };
      renderProps();
    }
    return mm;
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
    const info = partInfo(p, !!ses.power?.ext5v);
    let live = '';
    if (p.type === 'bme280') {
      const t = c.store.get().env.temp;
      live = `${sec('实时读数 · 固件串口最近一行')}${row('温度', '', 'rt')}${row('湿度', '', 'rh')}${row('气压', '', 'rp')}
${sec('环境温度 · 改的是虚拟世界')}<label class="slider"><input type="range" min="-10" max="45" step="0.5" value="${t}" data-env="temp" aria-label="环境温度" /><output class="mono">${t.toFixed(1)} °C</output></label>
<div class="btns"><button type="button" class="btn" data-act="heat" aria-pressed="${!!ses.heat}">${ses.heat ? '把手拿开' : '把手放上去'}</button><button type="button" class="btn" data-act="chip">量到芯片</button></div><div class="kv col" data-live="chipmm" hidden></div>
<p class="note">湿度、气压在构建树「环境」里调。可信度：模拟器验证过（与命令行一致）。</p>`;
    } else if (p.type === 'oled') {
      live = `${sec('实时画面')}<canvas class="oled" width="128" height="64" data-live="oledc"></canvas>${row('点亮像素', '', 'oledn')}`;
    } else if (p.type === 'servo') {
      live = `${sec('实时')}${row('脉宽', '', 'pw')}${row('角度', '', 'ang')}`;
    }
    el.innerHTML = `${sec('零件')}<div class="ph">${esc(info.name)}</div>${rowT('型号', esc(info.model))}${rowT('接口', esc(info.iface))}${row('供电', esc(info.power))}${live}${p.type === 'servo' ? renderPowerInline() : ''}`;
    bindEnvInputs();
    bindPartActs(el);
    bindPowerToggle(el);
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

  /** 拖滑块：一次手势只记一步（第一下 input 时记，后面改这一步的值），松手结束 */
  const gestures = new WeakMap<HTMLInputElement, BenchStep>();
  function bindEnvInputs(root: HTMLElement = ctx!.shell.props) {
    const c = ctx!;
    const fmt: Record<string, (v: number) => string> = { temp: (v) => `${v.toFixed(1)} °C`, humidity: (v) => `${v.toFixed(0)} %`, pressure: (v) => `${(v / 100).toFixed(1)} hPa` };
    root.querySelectorAll<HTMLInputElement>('input[data-env]').forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.env as 'temp' | 'humidity' | 'pressure';
        const v = Number(inp.value);
        inp.parentElement!.querySelector('output')!.textContent = fmt[k](v);
        const env = { ...c.store.get().env, [k]: v };
        let st = gestures.get(inp);
        if (!st && c.store.get().env[k] === v) return;
        if (!st) {
          st = c.hist?.op({ k: 'env', env });
          if (st) gestures.set(inp, st);
        } else if (st.op.k === 'env') st.op.env = env;
        c.session.setEnv({ [k]: v });
        c.hist?.render();
      };
      inp.onchange = () => gestures.delete(inp);
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
    if (!keep) c.hist?.op({ k: 'check', id: l.id, outcome: out });
    c.store.set((s) => ({ verifying: null, checks: keep ? s.checks : { ...s.checks, [l.id]: out } }));
    if (keep) c.shell.toast(`参考固件：${out.ok ? '通过' : '未通过'}，指纹 ${out.fingerprint}（不覆盖你的记录）`);
  }

  // ------------------------------------------------------------ 实时字段（不重建面板，免得拖滑块时被打断）
  function updateLive() {
    const c = ctx!;
    const s = c.store.get();
    const el = c.shell.props;
    // 快捷卡片里的读数和属性面板用同一套 data-live
    const card = c.shell.stage.querySelector<HTMLElement>('.qcard:not([hidden])');
    const set = (k: string, v: string, bad = false) => {
      for (const root of card ? [el, card] : [el]) {
        const n = root.querySelector<HTMLElement>(`[data-live="${k}"]`);
        if (n) {
          n.textContent = v;
          n.classList.toggle('bad', bad);
        }
      }
    };
    set('run', s.run ? `#${s.runNo || s.run}${s.hist.seeked ? ' · 回退点（暂停）' : s.running ? ' · 运行中' : ' · 停止'}` : '未上电');
    set('sim', `${s.simSeconds.toFixed(2)} s`);
    const rd = s.reading;
    // 读数和设定差太多（超过第 06 关的容差）标红：通常是固件换算错了
    set('rt', rd ? `${rd.t.toFixed(2)} °C` : '等固件打印…', !!rd && Math.abs(rd.t - s.env.temp) > 0.5);
    set('rh', rd ? `${rd.h.toFixed(1)} %` : '—');
    set('rp', rd ? `${rd.p.toFixed(2)} hPa` : '—');
    set('vp', `${s.verifyProgress.toFixed(1)} s`);
    // 别处改了环境（卡片 / 热源 / 回退），没在拖的滑块跟上
    const fmtEnv: Record<string, (v: number) => string> = { temp: (v) => `${v.toFixed(1)} °C`, humidity: (v) => `${v.toFixed(0)} %`, pressure: (v) => `${(v / 100).toFixed(1)} hPa` };
    for (const root of card ? [el, card] : [el])
      root.querySelectorAll<HTMLInputElement>('input[data-env]').forEach((inp) => {
        if (inp === document.activeElement) return;
        const k = inp.dataset.env as 'temp' | 'humidity' | 'pressure';
        if (Number(inp.value) === s.env[k]) return;
        inp.value = String(s.env[k]);
        const o = inp.parentElement?.querySelector('output');
        if (o) o.textContent = fmtEnv[k](s.env[k]);
      });
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
    // 针脚实时值 + 示波器
    const sel = s.selection;
    if (sel?.kind === 'pin') {
      const g = /^GPIO(\d+)$/.exec(sel.id);
      const pin = g ? Number(g[1]) : -1;
      if (pin >= 0) {
        const duty = f.pwm[pin] ?? -1;
        const freq = f.pwmFreq[pin] ?? 0;
        const out = !!bit(f.enable, f.enableHi, pin);
        const lv = bit(f.gpio, f.gpioHi, pin);
        set('pdir', duty >= 0 ? '输出（LEDC PWM）' : out ? '输出' : '输入 / 未驱动');
        set('plv', duty >= 0 ? '方波' : lv ? '高（3.3 V）' : '低（0 V）');
        if (duty >= 0 && freq > 0) {
          const t = pwmText(duty, freq);
          set('pf', t.freq);
          set('pw2', t.width);
          set('pd', t.duty);
        } else {
          set('pf', '没有 PWM');
          set('pw2', '—');
          set('pd', '—');
        }
      }
      const cv = el.querySelector<HTMLCanvasElement>('canvas.scope');
      if (cv) {
        const wires = benchWires().filter((w) => w.a === sel.id && !w.missing);
        const kind = pinKind(sel.id, wires);
        const v = sel.id === '3V3' ? 3.3 : sel.id === '5V' || sel.id === 'EXT5V' ? 5 : 0;
        set('scopeNote', drawScope(cv, kind, trace, trace.latest()?.t ?? s.simSeconds, v));
      }
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

  // ------------------------------------------------------------ 热源 / 量到芯片（P0-04）
  function toggleHeat() {
    const c = ctx!;
    if (!c.session.scene.parts.some((p) => p.type === 'bme280')) {
      c.shell.toast('台面上没有 BME280，热源没有可靠近的传感器');
      return;
    }
    const on = !c.session.heat;
    const room = c.store.get().env.temp;
    const temp = on ? room + 8 : (heatRoom ?? room - 8);
    heatRoom = on ? room : null;
    c.hist?.op({ k: 'heat', part: on ? 'bme280' : null, env: { ...c.store.get().env, temp } });
    c.session.setEnv({ temp });
    c.session.setHeat(on ? 'bme280' : null);
    c.shell.toast(on ? `手放在 BME280 上：传感器周围 ${room.toFixed(1)} → ${temp.toFixed(1)} °C（示意：+8 °C）` : `手拿开：回到 ${temp.toFixed(1)} °C`);
  }
  function bindPartActs(root: HTMLElement) {
    root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => (b.onclick = () => {
      if (b.dataset.act === 'heat') toggleHeat();
      if (b.dataset.act === 'chip') {
        const mm = measureChip();
        const out = root.querySelector<HTMLElement>('[data-live="chipmm"]');
        if (out) {
          out.hidden = false;
          out.innerHTML = mm === null ? '<span class="k">量到芯片</span><span class="v txt">看不到这两个目标</span>' : `<span class="k">量到芯片</span><span class="v mono fp">${mm.toFixed(1)} mm</span><span class="v txt muted">${esc(driftText(mm))}</span>`;
        }
      }
    }));
  }

  // ------------------------------------------------------------ 快捷卡片（P0-04）
  function cardContent(t: PickTarget): HTMLElement | null {
    const c = ctx!;
    const box = document.createElement('div');
    if (t.kind === 'part' && t.id === 'bme280') {
      const e = c.store.get().env;
      box.innerHTML = `<div class="sec">BME280 · 温度 / 湿度 / 气压</div>${row('读到', '', 'rt')}
<label class="slider"><input type="range" min="-10" max="45" step="0.5" value="${e.temp}" data-env="temp" aria-label="环境温度" /><output class="mono">${e.temp.toFixed(1)} °C</output></label>
<div class="btns"><button type="button" class="btn" data-act="heat" aria-pressed="${!!c.session.heat}">${c.session.heat ? '把手拿开' : '把手放上去'}</button><button type="button" class="btn" data-act="chip">量到芯片</button></div><div class="kv col" data-live="chipmm" hidden></div>`;
      bindEnvInputs(box);
      bindPartActs(box);
      return box;
    }
    const isServoPower = (t.kind === 'wire' && /servo:VCC/.test(t.id)) || (t.kind === 'pin' && t.id === '5V' && c.session.scene.parts.some((p) => p.type === 'servo'));
    if (isServoPower) {
      box.innerHTML = `<div class="sec">舵机供电 · 现在${c.session.power?.ext5v ? '外接 5 V' : ' USB 5 V'}</div><div class="seg" role="radiogroup" aria-label="舵机供电"><button type="button" class="segb" data-power="usb" aria-pressed="${!c.session.power?.ext5v}">USB 5 V</button><button type="button" class="segb" data-power="ext" aria-pressed="${!!c.session.power?.ext5v}">外接 5 V 2 A</button></div><p class="note">只改清单和供电显示；舵机一转 USB 掉压复位属于 P1 电气。</p>`;
      bindPowerToggle(box);
      return box;
    }
    if (t.kind === 'button' && t.id === 'BOOT') {
      box.innerHTML = `<div class="sec">BOOT 键 · GPIO${c.session.chip === 'esp32s3' ? 0 : 9}</div><div class="btns"><button type="button" class="btn" data-boot="down">按下</button><button type="button" class="btn" data-boot="up">松开</button></div><p class="note">weather 固件：按一下切换 ℃ / ℉。</p>`;
      bindBoot(box);
      return box;
    }
    if (t.kind === 'part') {
      const p = c.session.scene.parts.find((x) => partId(x) === t.id);
      box.innerHTML = `<div class="sec">${p ? esc(partInfo(p).name) : t.id === 'board' ? '开发板' : esc(t.id)}</div><div class="muted">详情在右侧属性面板</div>`;
      return box;
    }
    return null;
  }
  function openCard(t: PickTarget, screen: ScreenPoint) {
    const c = ctx!;
    const box = cardContent(t);
    if (!box) {
      closeCard();
      return;
    }
    cardFor = t;
    c.shell.card.show(c.session.pick.project?.(t) ?? screen, box);
    updateLive();
    // 台面转动时卡片跟着目标走；目标转到看不见就关掉
    cancelAnimationFrame(cardRaf);
    const follow = () => {
      if (!cardFor || !c.shell.card.open) return;
      const p = c.session.pick.project?.(cardFor);
      if (!p) return closeCard();
      c.shell.card.place(p);
      cardRaf = requestAnimationFrame(follow);
    };
    cardRaf = requestAnimationFrame(follow);
  }
  function closeCard() {
    cancelAnimationFrame(cardRaf);
    cardFor = null;
    ctx?.shell.card.hide();
  }

  function onPick(t: PickTarget | null, screen: ScreenPoint) {
    if (!ctx || ctx.store.get().step !== 'bench') return;
    if (ruler) {
      if (!t) return;
      if (!ruler.a || ruler.b) ruler = { a: t, b: null, mm: null };
      else {
        ruler.b = t;
        ruler.mm = ctx.session.pick.measure?.(ruler.a, t) ?? null;
      }
      if (!ruler.b) ctx.session.pick.measure?.(null);
      renderProps();
      return;
    }
    if (!t) {
      closeCard();
      return select(null);
    }
    select({ kind: t.kind, id: t.id });
    openCard(t, screen);
  }

  function setRuler(on: boolean) {
    const c = ctx!;
    ruler = on ? { a: null, b: null, mm: null } : null;
    c.shell.toolbar.setActive(on ? 'ruler' : 'select');
    if (!on) c.session.pick.measure?.(null);
    closeCard();
    if (on) select({ kind: 'tool', id: 'ruler' });
    else if (c.store.get().selection?.kind === 'tool') select(null);
  }

  function onTool(id: string) {
    if (!ctx || ctx.store.get().step !== 'bench') return;
    const c = ctx;
    if (id === 'select' || id === 'orbit') {
      if (ruler) setRuler(false);
      c.shell.toolbar.setActive(id);
    } else if (id === 'ruler') setRuler(!ruler);
    else if (id === 'rerun') c.session.reboot();
    else if (id === 'heat') toggleHeat();
    else if (id === 'scope') getAnalyzer(c).toggle();
    else if (id === 'button') {
      c.session.pressBoot(true);
      setTimeout(() => c.session.pressBoot(false), 150);
      c.shell.toast('按了一下 BOOT（GPIO0）');
    } else c.shell.toast(id === 'meter' ? '万用表要电路求解（P1-01 / P1-04），现在针脚面板里的电压是估算' : '这个工具由后续任务实现');
  }

  // ------------------------------------------------------------ 造错误接线（验收用的 debug 钩子，?debug=1 才挂出）
  function injectWiring(kind: 'drive' | '5v' | 'nores' | 'nognd' | 'addr' | 'clear'): string[] {
    const c = ctx!;
    const ses = c.session;
    let scene = ses.scene;
    let mods: WireMods = {};
    let label = '';
    const servo = scene.parts.find((p) => p.type === 'servo');
    if (kind === 'drive') {
      // 电位器滑片接到舵机信号脚上：滑片在推电平，GPIO 又在出 PWM
      const pin = servo && 'pin' in servo ? servo.pin : 4;
      scene = { ...scene, parts: [...scene.parts.filter((p) => p.type !== 'pot'), { type: 'pot', pin }] };
      label = `电位器接到 GPIO${pin}`;
    } else if (kind === '5v') {
      mods = { retarget: { 'wire:3V3~bme280:VIN': '5V' } };
      label = 'BME280 供电改接 5V';
    } else if (kind === 'nores') {
      scene = { ...scene, parts: [...scene.parts.filter((p) => !(p.type === 'led' && p.pin === 6)), { type: 'led', pin: 6 }] };
      mods = { noResistor: ['led:6'] };
      label = 'LED 不串电阻';
    } else if (kind === 'nognd') {
      mods = { drop: ['wire:GND~bme280:GND'] };
      label = '拔掉 BME280 地线';
    } else if (kind === 'addr') {
      scene = { ...scene, parts: scene.parts.map((p) => (p.type === 'oled' ? { ...p, addr: 0x76 } : p)) };
      label = 'OLED 地址改成 0x76';
    } else {
      label = '接线复原';
    }
    if (kind === 'clear') scene = { ...scene, parts: scene.parts.filter((p) => p.type !== 'pot' && !(p.type === 'led' && p.pin === 6)).map((p) => (p.type === 'oled' ? { ...p, addr: 0x3c } : p)) };
    c.hist?.op({ k: 'wiring', mods, scene, label });
    // 只改台面和规则检查，不重新上电（模拟器里的器件不变）：这里验的是接线检查
    ses.restoreScene(scene, ses.power);
    ses.setWireMods(mods);
    return faults.flatMap((f) => f.wires);
  }

  return {
    mount(_el, c) {
      ctx = c;
      if (!hooked) {
        hooked = true;
        c.session.pick.onPick?.(onPick);
        c.shell.toolbar.onTool(onTool);
        c.shell.card.onHide(() => {
          cancelAnimationFrame(cardRaf);
          cardFor = null;
        });
        c.session.onTick((m) => {
          if (trace.pin < 0) return;
          const p = trace.pin;
          trace.push({ t: m.simSeconds, duty: m.pwm[p] ?? -1, freq: m.pwmFreq[p] ?? 0, level: bit(m.gpio, m.gpioHi, p), out: !!bit(m.enable, m.enableHi, p) });
        });
        if (new URLSearchParams(location.search).has('debug')) {
          const w = window as unknown as { __tbApp?: Record<string, unknown> };
          w.__tbApp ??= {};
          w.__tbApp.injectWiring = (k: Parameters<typeof injectWiring>[0]) => (ctx ? injectWiring(k) : []);
          w.__tbApp.faults = () => faults.map((f) => ({ rule: f.rule, wires: f.wires, short: f.short }));
        }
      }
      c.shell.toolbar.setGroups([
        { id: 'nav', tools: [{ id: 'select', label: '选择', key: 'V' }, { id: 'orbit', label: '转视角', key: 'H' }] },
        { id: 'edit', tools: [{ id: 'place', label: '放置', todo: true }, { id: 'wire', label: '连线', todo: true }] },
        { id: 'measure', tools: [{ id: 'meter', label: '万用表', todo: true }, { id: 'ruler', label: '尺子' }, { id: 'scope', label: '示波器' }] },
        { id: 'act', tools: [{ id: 'heat', label: '热源' }, { id: 'button', label: '按键' }] },
        { id: 'run', tools: [{ id: 'rerun', label: '再跑一次', primary: true }] },
      ]);
      c.shell.toolbar.setActive(ruler ? 'ruler' : 'select');
      if (!c.store.get().selection) c.store.set({ selection: c.work.checkpoints.length ? { kind: 'part', id: 'bme280' } : { kind: 'firmware', id: 'main' } });
      if (!c.session.scene.parts.some((p) => partId(p) === 'bme280') && c.store.get().selection?.id === 'bme280') c.store.set({ selection: { kind: 'part', id: 'board' } });
      recheckWiring();
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
        c.store.subscribe((s, prev) => {
          recheckWiring();
          renderTree();
          // 拖滑块时不重建面板（会打断拖动）：时间线只是多了一步不重画；编辑状态变了（供电、热源、改接线、回退）才重画
          const h = s.hist, p = prev.hist;
          if (s.editRev !== prev.editRev && cardFor && c.shell.card.open) {
            const box = cardContent(cardFor);
            if (box) c.shell.card.show(c.session.pick.project?.(cardFor) ?? { x: 0, y: 0 }, box);
          }
          if (s.editRev !== prev.editRev || s.sceneRev !== prev.sceneRev || h.seeked !== p.seeked || h.busy !== p.busy || h.runs !== p.runs || (h.seeked && h.cur !== p.cur) || s.selection?.kind === 'run') renderProps();
        }, ['editRev', 'sceneRev', 'hist']),
        c.store.subscribe(() => renderTree(), ['env', 'run', 'runNo']),
        c.store.subscribe(() => updateLive(), ['simSeconds', 'reading', 'running', 'run', 'verifyProgress', 'env']),
      ];
      c.session.pick.highlight?.(toPick(c.store.get().selection));
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      closeCard();
      // 分析仪属于实验台：离开时由 CSS 藏起来（body[data-step]），状态保留，回来接着看
      if (ruler) {
        ruler = null;
        ctx?.session.pick.measure?.(null);
      }
      ctx?.session.pick.highlight?.(null);
      ctx = null;
    },
  };
}
