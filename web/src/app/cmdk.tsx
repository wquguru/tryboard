// ⌘K palette (P1-06): search parts / pins / checkpoints and run commands (room temp, 5 V / USB rerun, back to run n, analyzer, steps).
// ⌘K is not stolen from other inputs; React draws <CmdkBox/> <CmdkList/>, key/focus logic stays native (uncontrolled input).
import { Fragment, type ReactNode } from 'react';
import type { StepCtx, StepId, SelKind } from './types';
import { fuzzy, parseRun, parseTemp, pushRecent } from './cmdmatch';
import { partId, partInfo } from './wiring';
import { getAnalyzer } from './analyzer';
import { BOARD_NAME } from '../chips';
import { commit, useStore } from './react';
import { createStore } from './store';
import { t } from '../i18n';

interface Item {
  id: string;
  group: string;
  label: string;
  /** English source of label, so English queries match in every locale */
  en?: string;
  meta?: string;
  keys?: string;
  /** Keep the box open after running (e.g. a parameter is still missing; the hint goes into the input) */
  keep?: boolean;
  run(): void | Promise<unknown>;
}

type Vars = Record<string, string | number>;
const fillEn = (s: string, v?: Vars) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s);
/** Localized label plus its English source (matched as extra keys) */
const L = (en: string, v?: Vars) => ({ label: t(en, v), en: fillEn(en, v) });

const RECENT_KEY = 'tryboard-cmdk-recent';
const STEP_NAMES: [StepId, string, string][] = [
  ['shop', 'Go to Shop', 'shop caigou 清单 买 buy'], // lint: allow-cjk
  ['bench', 'Go to Bench', 'bench shiyantai 台面 lab'], // lint: allow-cjk
  ['assemble', 'Go to Assemble', 'assemble zuzhuang 外壳 装 case'], // lint: allow-cjk
  ['product', 'Go to Product', 'product chengpin 3d'],
];

export interface Cmdk {
  open(q?: string): void;
  close(): void;
  /** For tests: items listed for the current input */
  items(): { id: string; label: string; group: string }[];
  /** For tests: run directly (same as typing q and pressing Enter on the first item) */
  exec(q: string): Promise<string | null>;
}

export function createCmdk(ctx: StepCtx): Cmdk {
  const { session, store, shell, work } = ctx;
  const input = document.getElementById('cmdk') as HTMLInputElement;
  const list = { get hidden() { return !view.get().open; } };
  input.placeholder = t('Search commands, parts, pins');
  input.title = t('e.g. temp 35, GPIO8, restart');
  const G = { cmd: t('Commands'), run: t('Runs'), part: t('Parts'), pin: t('Pins'), cp: t('Checkpoints'), recent: t('Recent') };

  let shown: Item[] = [];
  let sel = 0;
  let recent: string[] = [];
  try {
    recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(recent)) recent = [];
  } catch {
    recent = [];
  }

  const goBench = () => {
    if (store.get().step !== 'bench') location.hash = 'bench';
  };
  const select = (kind: SelKind, id: string) => {
    goBench();
    store.set({ selection: { kind, id } });
  };

  function setTemp(want: number) {
    const v = Math.max(-10, Math.min(45, want));
    const env = { ...store.get().env, temp: v };
    ctx.hist?.op({ k: 'env', env });
    session.setEnv({ temp: v });
    const vs = v.toFixed(1);
    shell.toast(v !== want ? t('Room temperature set to {v} ℃ (outside -10–45 ℃, using {clamp} ℃); sensor readings, serial and OLED follow', { v: vs, clamp: v }) : t('Room temperature set to {v} ℃; sensor readings, serial and OLED follow', { v: vs }));
  }
  function powerRerun(ext: boolean) {
    goBench();
    if (!!session.power?.ext5v !== ext) {
      ctx.hist?.op({ k: 'power', ext5v: ext });
      session.setPower(ext);
    }
    session.reboot();
    shell.toast(ext ? t('Servo now powered by external 5 V 2 A, power cycled') : t('Servo back on USB 5 V power, power cycled'));
  }
  async function backToRun(n: number) {
    const h = ctx.hist;
    if (!h) return;
    const i = h.steps().findIndex((s) => s.op.k === 'run' && s.op.n === n);
    if (i < 0) {
      shell.toast(t('There is no run {n} (runs so far: {count})', { n, count: h.runs().length }));
      return;
    }
    goBench();
    const r = await h.seek(i);
    if (!r) return;
    const v = { run: r.run, s: (r.untilMs / 1000).toFixed(2) };
    shell.toast(r.same === null ? t('Back to run #{run} at {s} s', v) : r.same ? t('Back to run #{run} at {s} s · identical to back then', v) : t('Back to run #{run} at {s} s · differs from back then', v));
  }

  /** All candidates for the input (parameter commands are generated from it) */
  function candidates(q: string): Item[] {
    const out: Item[] = [];
    const temp = parseTemp(q);
    out.push(
      temp !== null
        ? { id: `temp:${temp}`, group: G.cmd, ...L('Set room temperature to {temp} ℃', { temp }), meta: t('Environment'), keys: '室温 温度 temp 设为 room set', run: () => setTemp(temp) } // lint: allow-cjk
        : { id: 'temp', group: G.cmd, ...L('Set room temperature to … ℃'), meta: t('Type a number'), keys: '室温 温度 temp 设为 环境 shiwen room set environment', keep: true, run: () => open('temp ') }, // lint: allow-cjk
    );
    const ana = getAnalyzer(ctx);
    out.push(
      { id: 'meter3v3', group: G.cmd, ...L('Measure 3V3'), meta: t('Multimeter'), keys: '万用表 电压 3.3 3v3 multimeter liang voltage', run: () => { select('pin', '3V3'); shell.toast(t('Selected the 3V3 pin; to read its voltage, press Multimeter in the toolbar, then click 3V3')); } }, // lint: allow-cjk
      { id: 'power:ext', group: G.cmd, ...L('Switch to external 5 V and rerun'), meta: t('Power'), keys: '外接 5v 电源 power ext 重跑 舵机 servo', run: () => powerRerun(true) }, // lint: allow-cjk
      { id: 'power:usb', group: G.cmd, ...L('Switch back to USB power and rerun'), meta: t('Power'), keys: 'usb 电脑 power 重跑', run: () => powerRerun(false) }, // lint: allow-cjk
      { id: 'rerun', group: G.cmd, ...L('Restart (power cycle)'), meta: t('Run'), keys: 'rerun reboot 重新上电 复位 reset', run: () => { goBench(); session.reboot(); } }, // lint: allow-cjk
      { id: 'analyzer', group: G.cmd, ...(ana.isOpen ? L('Close logic analyzer') : L('Open logic analyzer')), meta: t('Oscilloscope'), keys: '逻辑分析仪 示波器 波形 scope analyzer i2c pwm luoji waveform', run: () => { goBench(); ana.toggle(); } }, // lint: allow-cjk
    );
    for (const [id, name, keys] of STEP_NAMES) out.push({ id: `step:${id}`, group: G.cmd, ...L(name), meta: t('Step'), keys: `${keys} 切到 去 go switch`, run: () => { location.hash = id; } }); // lint: allow-cjk
    const runs = ctx.hist?.runs() ?? [];
    const rn = parseRun(q);
    for (const r of runs) {
      if (rn !== null && r.n !== rn) continue;
      out.push({ id: `run:${r.n}`, group: G.run, ...L('Back to run {n}', { n: r.n }), meta: r.snap ? `${r.snap.simSeconds.toFixed(1)} s` : t('Running'), keys: `回到 运行 run #${r.n} 回退 时间线 back timeline`, run: () => backToRun(r.n) }); // lint: allow-cjk
    }
    if (rn !== null && !runs.some((r) => r.n === rn)) out.push({ id: `run:${rn}`, group: G.run, ...L('Back to run {n}', { n: rn }), meta: t('Does not exist'), keys: '回到 运行 run back', run: () => backToRun(rn) }); // lint: allow-cjk
    const board = BOARD_NAME[session.chip];
    out.push({ id: 'part:board', group: G.part, label: board, meta: t('Dev board'), keys: 'board 开发板 esp32', run: () => select('part', 'board') }); // lint: allow-cjk
    for (const p of session.scene.parts) {
      const info = partInfo(p);
      out.push({ id: `part:${partId(p)}`, group: G.part, label: info.name, meta: info.iface.split(' · ')[0], keys: `${p.type} ${info.model} ${info.iface}`, run: () => select('part', partId(p)) });
    }
    for (const p of session.pick.listPins?.() ?? []) out.push({ id: `pin:${p.id}`, group: G.pin, label: p.id, meta: p.role ?? '', keys: `${p.label} 引脚 针脚 pin`, run: () => select('pin', p.id) }); // lint: allow-cjk
    for (const id of work.checkpoints) {
      const l = session.levels.find((x) => x.id === id);
      out.push({ id: `cp:${id}`, group: G.cp, label: `${id} ${l?.title ? t(l.title) : ''}`, en: l?.title, meta: store.get().checks[id]?.ok ? '✓' : '', keys: '检查点 关卡 checkpoint 验收 level', run: () => select('checkpoint', id) }); // lint: allow-cjk
    }
    return out;
  }

  function compute(q: string): Item[] {
    const all = candidates(q);
    if (!q.trim()) {
      const rec = recent.flatMap((id) => {
        const it = all.find((x) => x.id === id) ?? (id.startsWith('temp:') ? candidates(`temp ${id.slice(5)}`)[0] : undefined);
        return it ? [{ ...it, group: G.recent }] : [];
      });
      const cmds = all.filter((x) => x.group === G.cmd && !rec.some((r) => r.id === x.id));
      return [...rec, ...cmds, ...all.filter((x) => x.group === G.run).slice(-3)];
    }
    // A parameter was recognized (temp 35, run 2): parameter commands go first
    const scored = all
      .map((it) => ({ it, m: fuzzy(q, it.label, `${it.keys ?? ''} ${it.en ?? ''}`) }))
      .filter((x) => x.m || (parseTemp(q) !== null && x.it.id.startsWith('temp:')) || (parseRun(q) !== null && x.it.id.startsWith('run:')))
      .map((x) => ({ it: x.it, score: (x.m?.score ?? 0) + (/^(temp:|run:)/.test(x.it.id) && (parseTemp(q) !== null || parseRun(q) !== null) ? 100 : 0), hits: x.m?.hits ?? [] }));
    scored.sort((a, b) => b.score - a.score);
    hitMap = new Map(scored.map((s) => [s.it.id, s.hits]));
    return scored.slice(0, 40).map((s) => s.it);
  }
  let hitMap = new Map<string, number[]>();

  function render() {
    const q = input.value;
    hitMap = new Map();
    shown = compute(q);
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    const rows: ReactNode[] = [];
    let g = '';
    shown.forEach((it, i) => {
      if (it.group !== g) {
        g = it.group;
        rows.push(
          <div key={`g${i}`} className="ck-g px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted">
            {g}
          </div>,
        );
      }
      const hits = q.trim() ? (hitMap.get(it.id) ?? []) : [];
      rows.push(
        <button
          key={i}
          type="button"
          className="ck-i flex w-full cursor-pointer items-baseline gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-fg aria-selected:bg-accent-bg"
          role="option"
          id={`ck-${i}`}
          data-i={i}
          aria-selected={i === sel}
          onMouseDown={(e) => {
            // Run on mousedown: before click, the input would blur and close the box
            e.preventDefault();
            void run(i);
          }}
        >
          <span className="ck-l min-w-0 flex-1 truncate">{hlParts(it.label, hits)}</span>
          {it.meta ? <span className="ck-m flex-none font-mono text-[11px] text-muted">{it.meta}</span> : null}
        </button>,
      );
    });
    commit(() =>
      view.set({
        node: (
          <>
            {shown.length ? rows : <div className="ck-empty p-2.5 text-xs text-muted">{t('No parts, pins or commands match “{q}”', { q })}</div>}
            <div className="ck-foot mt-1 flex gap-3 border-t border-line-soft px-2.5 pt-1.5 pb-1 text-[11px] text-muted">
              <span>{t('↑↓ select')}</span>
              <span>{t('↵ run')}</span>
              <span>{t('Esc close')}</span>
            </div>
          </>
        ),
      }),
    );
    input.setAttribute('aria-activedescendant', shown.length ? `ck-${sel}` : '');
    document.getElementById('cmdkList')?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  async function run(i: number) {
    const it = shown[i];
    if (!it) return null;
    if (!it.keep) {
      recent = pushRecent(recent, it.id);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      } catch {
        /* Private mode: recent commands live only on this page */
      }
      close();
      input.value = '';
      input.blur();
    }
    await it.run();
    return it.label;
  }

  function open(q?: string) {
    if (q !== undefined) input.value = q;
    if (document.activeElement !== input) input.focus();
    sel = 0;
    commit(() => view.set({ open: true }));
    render();
  }
  function close() {
    commit(() => view.set({ open: false }));
  }

  document.addEventListener('keydown', (e) => {
    if (!((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k')) return;
    const tgt = e.target as HTMLElement | null;
    // Focus is in another input: don't steal (its ⌘K belongs to that input / the browser)
    if (tgt && tgt !== input && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return;
    e.preventDefault();
    if (list.hidden) {
      input.select();
      open();
    } else close();
  });
  input.addEventListener('focus', () => open());
  input.addEventListener('input', () => {
    sel = 0;
    open();
  });
  input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && close(), 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return open();
      const n = shown.length;
      if (n) sel = (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (list.hidden) open();
      else void run(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      input.blur();
    }
  });

  return {
    open,
    close,
    items: () => {
      const q = input.value;
      return compute(q).map((x) => ({ id: x.id, label: x.label, group: x.group }));
    },
    async exec(q) {
      input.value = q;
      shown = compute(q);
      sel = 0;
      return run(0);
    },
  };
}

/** Wrap hit indices of label in <mark> (same rule as cmdmatch.highlight, as JSX) */
function hlParts(label: string, hits: number[]): ReactNode[] {
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let i = 0;
  while (i < label.length) {
    const h = set.has(i);
    let j = i;
    while (j < label.length && set.has(j) === h) j++;
    const t = label.slice(i, j);
    out.push(h ? <mark key={i} className="bg-transparent font-medium text-accent-ink">{t}</mark> : <Fragment key={i}>{t}</Fragment>);
    i = j;
  }
  return out;
}

const view = createStore<{ open: boolean; node: ReactNode }>({ open: false, node: null });

/** The centered top-bar input (uncontrolled; listeners are attached in createCmdk) */
export function CmdkBox() {
  const { open } = useStore(view);
  return (
    <div role="search" className="cmdk flex h-8 w-[200px] flex-none items-center rounded-lg border border-line bg-field focus-within:border-accent focus-within:bg-surface max-[1100px]:hidden">
      <input
        id="cmdk"
        type="search"
        placeholder={t('Search commands, parts, pins')}
        aria-label={t('Command palette')}
        autoComplete="off"
        role="combobox"
        aria-controls="cmdkList"
        aria-expanded={open}
        className="min-w-0 flex-1 border-0 bg-transparent px-2.5 py-1 text-[13px] text-inherit outline-none"
      />
      <kbd className="mono px-2 font-mono text-[11px] text-muted">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
    </div>
  );
}

export function CmdkList() {
  const { open, node } = useStore(view);
  return (
    <div
      id="cmdkList"
      role="listbox"
      hidden={!open}
      className="pnl cmdk-list max-md:hidden! fixed top-[calc(var(--top-h)+4px)] left-[calc((100vw+var(--left-w)-var(--right-w))/2)] z-5 max-h-[min(420px,60vh)] w-[min(460px,calc(100vw-var(--left-w)-var(--right-w)-32px))] min-w-[300px] -translate-x-1/2 overflow-auto rounded-(--r) border border-line bg-surface p-1 text-fg shadow-panel"
    >
      {node}
    </div>
  );
}
