// 实验台 v2 底部坞（DESIGN_V2 §4）：串口 / 代码 / 逻辑分析仪 / 运行记录 / 检查点 / 问题，可拖高度、可收起。
// 串口原文仍追加进隐藏的 #console（文本节点原样，回归脚本和重放对拍读它）；看得见的是这里按行切开的视图：
// 过滤、时间戳（收到这段文字时的模拟时刻）、按 ESP-IDF 级别着色、跟随最新。行视图命令式维护，不经 React——
// 串口一秒能来几百行，整块重画太贵。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { actions, bc, setDock, type DockTab } from './chrome';
import { Icon } from './icons';
import { useStore } from './react';
import { createStore } from './store';

interface Line {
  t: number;
  text: string;
  lv: 'E' | 'W' | 'I' | 'D' | '';
}
const MAX_LINES = 4000;
// ESP-IDF 日志行：可选的 ANSI 颜色头，然后 "E (1234) tag: …"
const ANSI = /\x1b\[[0-9;]*m/g;
const levelOf = (s: string): Line['lv'] => {
  const m = /^([EWID]) \(\d+\)/.exec(s);
  return (m?.[1] as Line['lv']) ?? '';
};

type SerialUi = { filter: string; stamps: boolean; follow: boolean; eol: string };
const ui = createStore<SerialUi>({ filter: '', stamps: true, follow: true, eol: '\r\n' });

function createSerialModel() {
  let lines: Line[] = [];
  let pending = '';
  let pendingT = 0;
  let host: HTMLElement | null = null;
  let tail: HTMLElement | null = null;

  const match = (l: Line) => {
    const f = ui.get().filter.trim().toLowerCase();
    return !f || l.text.toLowerCase().includes(f);
  };
  const lvCls: Record<string, string> = { E: 'text-bad-ink', W: 'text-warn-ink', I: '', D: 'text-muted', '': '' };
  function lineEl(l: Line) {
    const d = document.createElement('div');
    d.className = 'sl ' + lvCls[l.lv];
    if (l.lv) d.dataset.lv = l.lv;
    if (ui.get().stamps) {
      const s = document.createElement('span');
      s.className = 'st mr-2 text-muted select-none';
      s.textContent = l.t.toFixed(3);
      d.append(s);
    }
    d.append(l.text || ' ');
    return d;
  }
  function stick() {
    if (host && ui.get().follow) host.scrollTop = host.scrollHeight;
  }
  function renderAll() {
    if (!host) return;
    host.replaceChildren();
    tail = null;
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const l of lines)
      if (match(l)) {
        frag.append(lineEl(l));
        n++;
      }
    host.append(frag);
    renderTail();
    if (!n && !pending) {
      const e = document.createElement('div');
      e.className = 'sl-empty text-muted';
      e.textContent = lines.length ? `没有包含「${ui.get().filter}」的行` : '还没有串口输出';
      host.append(e);
    }
    stick();
  }
  function renderTail() {
    if (!host) return;
    tail?.remove();
    tail = null;
    if (!pending) return;
    const l: Line = { t: pendingT, text: pending.replace(ANSI, ''), lv: levelOf(pending.replace(ANSI, '')) };
    if (!match(l)) return;
    tail = lineEl(l);
    host.append(tail);
  }
  return {
    attach(el: HTMLElement | null) {
      host = el;
      renderAll();
    },
    push(text: string, tSec: number) {
      if (!pending) pendingT = tSec;
      const parts = (pending + text).split('\n');
      pending = parts.pop()!;
      const add: Line[] = [];
      for (const raw of parts) {
        const s = raw.replace(/\r$/, '').replace(ANSI, '');
        add.push({ t: pendingT, text: s, lv: levelOf(s) });
        pendingT = tSec;
      }
      if (!pending) pendingT = tSec;
      if (!add.length && host) {
        renderTail();
        stick();
        return;
      }
      lines.push(...add);
      if (lines.length > MAX_LINES) {
        lines = lines.slice(-MAX_LINES * 0.75);
        renderAll();
        return;
      }
      if (!host) return;
      host.querySelector('.sl-empty')?.remove();
      tail?.remove();
      tail = null;
      const frag = document.createDocumentFragment();
      for (const l of add) if (match(l)) frag.append(lineEl(l));
      host.append(frag);
      renderTail();
      stick();
    },
    reset(text: string, tSec: number) {
      lines = [];
      pending = '';
      if (text) this.push(text, tSec);
      renderAll();
    },
    text: () => lines.filter(match).map((l) => (ui.get().stamps ? `${l.t.toFixed(3)}  ` : '') + l.text).join('\n') + (pending ? '\n' + pending : ''),
    renderAll,
    count: () => lines.length,
  };
}
export const serial = createSerialModel();
ui.subscribe(() => serial.renderAll(), ['filter', 'stamps']);

const dtab = 'dtab relative inline-flex h-[38px] flex-none cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 text-[13px] whitespace-nowrap text-muted hover:text-fg aria-selected:font-medium aria-selected:text-accent-ink aria-selected:shadow-[inset_0_-2px_0_var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted';
const pill = (warn?: boolean) => cn('rounded-full px-1.5 font-mono text-[11px] leading-[18px]', warn ? 'bg-warn-bg text-warn-ink' : 'bg-field text-muted');
const ib = 'inline-flex size-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field hover:text-fg aria-pressed:text-ok-ink';

function SerialView() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    serial.attach(ref.current);
    return () => serial.attach(null);
  }, []);
  return (
    <div
      id="serialView"
      ref={ref}
      role="log"
      aria-label="串口输出"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        if (ui.get().follow !== bottom) ui.set({ follow: bottom });
      }}
      className="serial-view min-h-0 flex-1 overflow-auto bg-(--scope-bg) px-3 py-1.5 font-mono text-[12.5px] leading-[1.7] break-all whitespace-pre-wrap max-[760px]:h-[150px] max-[760px]:flex-none"
    />
  );
}

const EOLS: [string, string][] = [
  ['\r\n', '\\r\\n'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['', '无'],
];
function SerialInput() {
  const { eol } = useStore(ui);
  const [v, setV] = useState('');
  const can = !!actions.uart;
  return (
    <form
      className="flex h-10 flex-none items-center gap-2 border-t border-line-soft px-3 max-[760px]:hidden"
      onSubmit={(e) => {
        e.preventDefault();
        if (!can) return;
        actions.uart!(v + eol);
        setV('');
      }}
    >
      <span className="font-mono text-muted">›</span>
      <input
        id="serialIn"
        value={v}
        disabled={!can}
        onChange={(e) => setV(e.currentTarget.value)}
        placeholder={can ? '发给串口，回车发送' : '会话还没就绪'}
        aria-label="发给串口"
        autoComplete="off"
        className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[12.5px] text-fg outline-none"
      />
      <select
        id="serialEol"
        aria-label="行尾"
        title="回车时附加的行尾"
        value={eol}
        onChange={(e) => ui.set({ eol: e.currentTarget.value })}
        className="h-7 cursor-pointer rounded-md border border-line bg-surface px-1.5 font-mono text-xs text-fg"
      >
        {EOLS.map(([k, t]) => (
          <option key={t} value={k}>
            {t}
          </option>
        ))}
      </select>
    </form>
  );
}

function SerialTools({ toast }: { toast: (t: string) => void }) {
  const s = useStore(ui);
  return (
    <div className="flex items-center gap-1.5 max-[1180px]:[&_.opt]:hidden">
      <input
        id="serialFilter"
        type="search"
        value={s.filter}
        onChange={(e) => ui.set({ filter: e.currentTarget.value })}
        placeholder="过滤"
        aria-label="过滤串口"
        className="h-7 w-40 rounded-md border border-line bg-field px-2 text-xs text-fg outline-none focus:border-accent max-[1100px]:w-24"
      />
      <button type="button" id="serialStamps" aria-pressed={s.stamps} onClick={() => ui.set({ stamps: !s.stamps })} title="收到这行时的模拟时刻（秒）" className={cn(ib, 'opt w-auto px-1.5 text-xs whitespace-nowrap')}>
        时间戳 {s.stamps ? '开' : '关'}
      </button>
      <button
        type="button"
        id="serialFollow"
        aria-pressed={s.follow}
        onClick={() => {
          ui.set({ follow: !s.follow });
          if (!s.follow) serial.renderAll();
        }}
        title="新输出来了自动滚到最后"
        className={cn(ib, 'opt w-auto px-1.5 text-xs whitespace-nowrap')}
      >
        跟随最新
      </button>
      <span className="opt font-mono text-xs text-muted" title="UART0 波特率（模拟器里不限速，只是标注）">
        115200
      </span>
      <button
        type="button"
        id="serialCopy"
        className={ib}
        title="复制看得到的行"
        aria-label="复制串口"
        onClick={() =>
          void navigator.clipboard?.writeText(serial.text()).then(
            () => toast('已复制串口（按当前过滤）'),
            () => toast('复制失败：浏览器不让写剪贴板'),
          )
        }
      >
        <Icon n="copy" size={15} />
      </button>
      <button
        type="button"
        id="serialClear"
        className={ib}
        title="清空显示（不影响固件和验收）"
        aria-label="清空串口"
        onClick={() => {
          serial.reset('', 0);
          const con = document.getElementById('console');
          if (con) con.textContent = '';
        }}
      >
        <Icon n="trash" size={15} />
      </button>
    </div>
  );
}

function CheckList() {
  const { checkpoints } = useStore(bc);
  if (!checkpoints.length) return <p className="m-0 p-3 text-xs text-muted">这个台面没有检查点（外设实验台）。</p>;
  const mk = { ok: ['✓', 'text-ok-ink'], bad: ['✗', 'text-bad-ink'], run: ['…', 'text-accent-ink'], todo: ['○', 'text-muted'] } as const;
  return (
    <ol className="m-0 list-none p-1.5">
      {checkpoints.map((c, i) => (
        <li key={c.id}>
          <button
            type="button"
            data-cp={c.id}
            onClick={() => actions.selectCheckpoint?.(c.id)}
            className="flex w-full cursor-pointer items-baseline gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-[13px] text-fg hover:bg-field"
          >
            <span className={cn('w-4 flex-none font-mono', mk[c.state][1])}>{mk[c.state][0]}</span>
            <span className="flex-none font-mono text-[11px] text-muted">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            <span className="flex-none text-[11px] text-muted">{c.note}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function IssueList() {
  const { issues } = useStore(bc);
  if (!issues.length) return <p className="m-0 p-3 text-xs text-muted">没有发现问题：接线规则检查通过，也没有欠压复位。</p>;
  return (
    <ul className="m-0 list-none p-1.5">
      {issues.map((x) => (
        <li key={x.id}>
          <button
            type="button"
            data-issue={x.id}
            onClick={() => x.go?.()}
            className="flex w-full cursor-pointer items-baseline gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-[13px] text-fg hover:bg-field"
          >
            <Icon n="warn" size={14} className={cn('flex-none self-center', x.level === 'block' ? 'text-bad-ink' : 'text-warn-ink')} />
            <b className="flex-none font-medium">{x.title}</b>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{x.detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Dock({ step, timeline, simtime, toast }: { step: string; timeline: ReactNode; simtime: ReactNode; toast: (t: string) => void }) {
  const c = useStore(bc);
  const { tab, collapsed } = c.dock;
  const bench = step === 'bench';
  const shop = step === 'shop';
  // 采购没有串口：默认看清单的变更记录
  const cur: DockTab = shop && (tab === 'serial' || tab === 'analyzer') ? 'runs' : !bench && tab === 'analyzer' ? 'serial' : tab;
  const ok = c.checkpoints.filter((x) => x.state === 'ok').length;
  const pick = (t: DockTab) => {
    if (t === 'analyzer') actions.analyzer?.(true);
    else if (cur === 'analyzer') actions.analyzer?.(false);
    setDock({ tab: t, collapsed: false });
  };
  const tabs: { id: DockTab; label: string; pill?: ReactNode; disabled?: boolean; title?: string }[] = [
    { id: 'serial', label: '串口', disabled: shop, title: shop ? '采购步骤没有在跑的固件' : undefined },
    { id: 'code', label: '代码', disabled: true, title: '暂未开放：实验台只有编译好的 flash.bin，没有源码' },
    { id: 'analyzer', label: '逻辑分析仪', disabled: !bench || !actions.analyzer, title: bench ? 'GPIO / PWM / I2C 波形' : '只在实验台' },
    { id: 'runs', label: bench ? '运行记录' : '时间线', pill: bench ? <span className={pill()}>{c.runs}</span> : undefined },
    { id: 'checks', label: '检查点', pill: c.checkpoints.length ? <span className={pill()}>{`${ok}/${c.checkpoints.length}`}</span> : undefined },
    { id: 'issues', label: '问题', pill: c.issues.length ? <span className={pill(true)}>{c.issues.length}</span> : undefined },
  ];
  return (
    <section
      id="dock"
      aria-label="底部坞"
      data-tab={cur}
      data-collapsed={collapsed ? '' : undefined}
      className={cn(
        'dock fixed inset-x-0 bottom-0 z-3 flex h-(--dock-h) flex-col border-t border-line bg-surface',
        'max-[760px]:static max-[760px]:order-7 max-[760px]:h-auto max-[760px]:overflow-hidden max-[760px]:rounded-(--r) max-[760px]:border',
      )}
    >
      <div
        aria-hidden="true"
        title="拖动改高度"
        className="dock-grip absolute top-[-4px] left-1/2 z-1 flex h-3 w-16 -translate-x-1/2 cursor-ns-resize items-center justify-center max-[760px]:hidden"
        onPointerDown={(e) => {
          e.preventDefault();
          const move = (ev: PointerEvent) => setDock({ h: Math.round(Math.min(window.innerHeight * 0.6, Math.max(120, window.innerHeight - ev.clientY))), collapsed: false });
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      >
        <span className="h-1 w-10 rounded-full bg-line" />
      </div>
      <div className="flex h-[38px] flex-none items-center gap-2 border-b border-line-soft pr-2">
        <div role="tablist" aria-label="底部坞" className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" data-dock={t.id} aria-selected={cur === t.id} disabled={t.disabled} title={t.title} onClick={() => pick(t.id)} className={dtab}>
              {t.label}
              {t.pill}
            </button>
          ))}
        </div>
        {cur === 'serial' && !collapsed && <SerialTools toast={toast} />}
        {/* 模拟时间一直挂着（回放对拍读它），只在运行记录页显示 */}
        <span className={cn('contents', cur !== 'runs' && '[&>*]:hidden')}>{simtime}</span>
        <button
          type="button"
          id="dockCollapse"
          className={ib}
          aria-expanded={!collapsed}
          title={collapsed ? '展开底部坞' : '收起底部坞'}
          aria-label={collapsed ? '展开底部坞' : '收起底部坞'}
          onClick={() => {
            if (!collapsed && cur === 'analyzer') actions.analyzer?.(false);
            setDock({ collapsed: !collapsed });
          }}
        >
          <Icon n={collapsed ? 'up' : 'down'} size={15} />
        </button>
      </div>
      <div className={cn('flex min-h-0 flex-1 flex-col', collapsed && 'hidden')}>
        <div hidden={cur !== 'serial'} className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden">
          <SerialView />
          <SerialInput />
        </div>
        <div hidden={cur !== 'runs'} className="flex min-h-0 flex-1 items-start overflow-auto px-3 py-2 [&[hidden]]:hidden">
          {timeline}
        </div>
        <div hidden={cur !== 'checks'} className="min-h-0 flex-1 overflow-auto [&[hidden]]:hidden">
          <CheckList />
        </div>
        <div hidden={cur !== 'issues'} className="min-h-0 flex-1 overflow-auto [&[hidden]]:hidden">
          <IssueList />
        </div>
      </div>
    </section>
  );
}
