// ⌘K 命令框（P1-06）：顶部正中的输入框 + 下拉列表。搜零件（选中并在台面上高亮）、引脚（GPIO4）、检查点，
// 执行命令：量 3V3、把室温设为 N ℃、换外接 5 V / USB 并重跑、回到第 n 次运行、打开逻辑分析仪、切到四个步骤。
// ⌘K / Ctrl+K 打开；焦点在别的输入框里时不抢这个键（用户可能在输入框里用它）。上下键选、回车执行、Esc 关；记最近用过的。
// 输入框和下拉列表由 React 画（外壳里的 <CmdkBox/> <CmdkList/>）；按键、焦点逻辑仍是这里的原生监听（输入框非受控）。
import { Fragment, type ReactNode } from 'react';
import type { StepCtx, StepId, SelKind } from './types';
import { fuzzy, parseRun, parseTemp, pushRecent } from './cmdmatch';
import { partId, partInfo } from './wiring';
import { getAnalyzer } from './analyzer';
import { BOARD_NAME } from '../chips';
import { commit, useStore } from './react';
import { createStore } from './store';

interface Item {
  id: string;
  group: string;
  label: string;
  meta?: string;
  keys?: string;
  /** 执行后不关框（比如还缺参数，把提示填进输入框） */
  keep?: boolean;
  run(): void | Promise<unknown>;
}

const RECENT_KEY = 'tryboard-cmdk-recent';
const STEP_NAMES: [StepId, string, string][] = [
  ['shop', '采购', 'shop caigou 清单 买'],
  ['bench', '实验台', 'bench shiyantai 台面'],
  ['assemble', '组装', 'assemble zuzhuang 外壳 装'],
  ['product', '成品', 'product chengpin 3d'],
];

export interface Cmdk {
  open(q?: string): void;
  close(): void;
  /** 测试用：按当前输入列出的条目 */
  items(): { id: string; label: string; group: string }[];
  /** 测试用：直接执行（等同于输入 q 后回车第一条） */
  exec(q: string): Promise<string | null>;
}

export function createCmdk(ctx: StepCtx): Cmdk {
  const { session, store, shell, work } = ctx;
  const input = document.getElementById('cmdk') as HTMLInputElement;
  const list = { get hidden() { return !view.get().open; } };
  input.placeholder = '搜命令、零件、引脚';
  input.title = '如：室温 35、GPIO8、重启';

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

  function setTemp(t: number) {
    const v = Math.max(-10, Math.min(45, t));
    const env = { ...store.get().env, temp: v };
    ctx.hist?.op({ k: 'env', env });
    session.setEnv({ temp: v });
    shell.toast(`室温设为 ${v.toFixed(1)} ℃${v !== t ? `（超出 -10–45 ℃，按 ${v} ℃ 算）` : ''}，传感器读数、串口和 OLED 都会跟着变`);
  }
  function powerRerun(ext: boolean) {
    goBench();
    if (!!session.power?.ext5v !== ext) {
      ctx.hist?.op({ k: 'power', ext5v: ext });
      session.setPower(ext);
    }
    session.reboot();
    shell.toast(ext ? '舵机改由外接 5 V 2 A 供电，重新上电' : '舵机改回 USB 5 V 供电，重新上电');
  }
  async function backToRun(n: number) {
    const h = ctx.hist;
    if (!h) return;
    const i = h.steps().findIndex((s) => s.op.k === 'run' && s.op.n === n);
    if (i < 0) {
      shell.toast(`没有第 ${n} 次运行（现在有 ${h.runs().length} 次）`);
      return;
    }
    goBench();
    const r = await h.seek(i);
    if (r) shell.toast(`回到运行 #${r.run} 的 ${(r.untilMs / 1000).toFixed(2)} s${r.same === null ? '' : r.same ? ' · 和当时一模一样' : ' · 和当时不一样'}`);
  }

  /** 按输入算出全部候选（参数命令随输入生成） */
  function candidates(q: string): Item[] {
    const out: Item[] = [];
    const temp = parseTemp(q);
    out.push(
      temp !== null
        ? { id: `temp:${temp}`, group: '命令', label: `把室温设为 ${temp} ℃`, meta: '环境', keys: '室温 温度 temp 设为', run: () => setTemp(temp) }
        : { id: 'temp', group: '命令', label: '把室温设为 … ℃', meta: '输入数字', keys: '室温 温度 temp 设为 环境 shiwen', keep: true, run: () => open('室温 ') },
    );
    const ana = getAnalyzer(ctx);
    out.push(
      { id: 'meter3v3', group: '命令', label: '量 3V3', meta: '万用表', keys: '万用表 电压 3.3 3v3 multimeter liang', run: () => { select('pin', '3V3'); shell.toast('先选中 3V3 引脚；要读电压，按工具条「万用表」再点 3V3'); } },
      { id: 'power:ext', group: '命令', label: '换外接 5 V 并重跑', meta: '供电', keys: '外接 5v 电源 power ext 重跑 舵机', run: () => powerRerun(true) },
      { id: 'power:usb', group: '命令', label: '换回 USB 供电并重跑', meta: '供电', keys: 'usb 电脑 power 重跑', run: () => powerRerun(false) },
      { id: 'rerun', group: '命令', label: '重启（重新上电）', meta: '运行', keys: 'rerun reboot 重新上电 复位 reset', run: () => { goBench(); session.reboot(); } },
      { id: 'analyzer', group: '命令', label: ana.isOpen ? '关闭逻辑分析仪' : '打开逻辑分析仪', meta: '示波器', keys: '逻辑分析仪 示波器 波形 scope analyzer i2c pwm luoji', run: () => { goBench(); ana.toggle(); } },
    );
    for (const [id, name, keys] of STEP_NAMES) out.push({ id: `step:${id}`, group: '命令', label: `切到${name}`, meta: '步骤', keys: `${keys} 切到 去`, run: () => { location.hash = id; } });
    const runs = ctx.hist?.runs() ?? [];
    const rn = parseRun(q);
    for (const r of runs) {
      if (rn !== null && r.n !== rn) continue;
      out.push({ id: `run:${r.n}`, group: '运行', label: `回到第 ${r.n} 次运行`, meta: r.snap ? `${r.snap.simSeconds.toFixed(1)} s` : '运行中', keys: `回到 运行 run #${r.n} 回退 时间线`, run: () => backToRun(r.n) });
    }
    if (rn !== null && !runs.some((r) => r.n === rn)) out.push({ id: `run:${rn}`, group: '运行', label: `回到第 ${rn} 次运行`, meta: '不存在', keys: '回到 运行 run', run: () => backToRun(rn) });
    const board = BOARD_NAME[session.chip];
    out.push({ id: 'part:board', group: '零件', label: board, meta: '开发板', keys: 'board 开发板 esp32', run: () => select('part', 'board') });
    for (const p of session.scene.parts) {
      const info = partInfo(p);
      out.push({ id: `part:${partId(p)}`, group: '零件', label: info.name, meta: info.iface.split(' · ')[0], keys: `${p.type} ${info.model} ${info.iface}`, run: () => select('part', partId(p)) });
    }
    for (const p of session.pick.listPins?.() ?? []) out.push({ id: `pin:${p.id}`, group: '引脚', label: p.id, meta: p.role ?? '', keys: `${p.label} 引脚 针脚 pin`, run: () => select('pin', p.id) });
    for (const id of work.checkpoints) {
      const l = session.levels.find((x) => x.id === id);
      out.push({ id: `cp:${id}`, group: '检查点', label: `${id} ${l?.title ?? ''}`, meta: store.get().checks[id]?.ok ? '✓' : '', keys: '检查点 关卡 checkpoint 验收', run: () => select('checkpoint', id) });
    }
    return out;
  }

  function compute(q: string): Item[] {
    const all = candidates(q);
    if (!q.trim()) {
      const rec = recent.flatMap((id) => {
        const it = all.find((x) => x.id === id) ?? (id.startsWith('temp:') ? candidates(`室温 ${id.slice(5)}`)[0] : undefined);
        return it ? [{ ...it, group: '最近' }] : [];
      });
      const cmds = all.filter((x) => x.group === '命令' && !rec.some((r) => r.id === x.id));
      return [...rec, ...cmds, ...all.filter((x) => x.group === '运行').slice(-3)];
    }
    // 认出了参数（室温 35、第 2 次运行）：参数命令排最前
    const scored = all
      .map((it) => ({ it, m: fuzzy(q, it.label, it.keys) }))
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
            // mousedown 里执行：click 之前输入框会先失焦关框
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
            {shown.length ? rows : <div className="ck-empty p-2.5 text-xs text-muted">没有匹配「{q}」的零件、引脚或命令</div>}
            <div className="ck-foot mt-1 flex gap-3 border-t border-line-soft px-2.5 pt-1.5 pb-1 text-[11px] text-muted">
              <span>↑↓ 选择</span>
              <span>↵ 执行</span>
              <span>Esc 关闭</span>
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
        /* 隐私模式：最近命令只在本页 */
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
    const t = e.target as HTMLElement | null;
    // 焦点在别的输入框里：不抢（那里的 ⌘K 归那个输入框 / 浏览器）
    if (t && t !== input && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
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

/** label 按命中下标包上 <mark>（与 cmdmatch.highlight 同一规则，这里出 JSX） */
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

/** 顶部正中的输入框（非受控；监听在 createCmdk 里挂） */
export function CmdkBox() {
  const { open } = useStore(view);
  return (
    <div role="search" className="cmdk flex h-8 w-[200px] flex-none items-center rounded-lg border border-line bg-field focus-within:border-accent focus-within:bg-surface max-[1100px]:hidden">
      <input
        id="cmdk"
        type="search"
        placeholder="搜命令、零件、引脚"
        aria-label="命令框"
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
