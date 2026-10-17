// 最底的时间线条：每一步是一个格子（放零件、连线、运行 #n）。本组件只负责画和点；
// 回到某一步的确定性重算由 P0-03 接在 onSeek 上。步数是低频的（一次操作一格），走 React 状态。
import { Fragment, useLayoutEffect, useRef } from 'react';
import { cn } from '../ui/cn';
import { commit, useStore } from './react';
import { createStore } from './store';

export interface TimelineStep {
  id: string;
  /** 单个字符或短符号，不用 emoji */
  icon: string;
  label: string;
  status?: 'ok' | 'bad' | 'run';
}

export interface Timeline {
  setSteps(steps: TimelineStep[]): void;
  setCurrent(i: number): void;
  onSeek(cb: (i: number, step: TimelineStep) => void): void;
}

const mark = { ok: '✓', bad: '✗', run: '…' } as const;

export function createTimeline(): Timeline & { View: () => React.JSX.Element } {
  const st = createStore<{ steps: TimelineStep[]; cur: number }>({ steps: [], cur: -1 });
  const cbs: ((i: number, s: TimelineStep) => void)[] = [];
  function View() {
    const { steps, cur } = useStore(st);
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      // 只横向滚时间线自己：scrollIntoView 会连带滚整页（手机上面板堆叠、整页可滚，一跑起来就被拽到页底）
      const el = ref.current;
      const on = el?.querySelector<HTMLElement>('.tl-step.on');
      if (!el || !on) return;
      const l = on.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft, r = l + on.offsetWidth;
      if (l < el.scrollLeft) el.scrollLeft = l;
      else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth;
    });
    return (
      <div id="timeline" ref={ref} className="tl flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]">
        {steps.map((s, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="tl-sep h-px w-3.5 flex-none bg-line" />}
            <button
              type="button"
              data-id={s.id}
              onClick={() => cbs.forEach((f) => f(i, s))}
              className={cn(
                'tl-step inline-flex flex-none cursor-pointer items-center gap-[5px] rounded-md border border-transparent bg-transparent px-2 py-[3px] text-xs whitespace-nowrap text-fg hover:bg-field',
                i === cur && 'on border-accent-line bg-accent-bg hover:bg-accent-bg',
                // 点回中间某步后，后面的步骤画淡（还在，接着改会被丢掉）
                cur >= 0 && i > cur && 'after border-dashed border-line text-muted',
                s.status,
                s.status === 'bad' && 'text-bad-ink',
              )}
            >
              <span className="tl-ic font-mono text-[11px] text-muted">{s.icon}</span>
              <span className="tl-t">{s.label}</span>
              {s.status && <span className={cn('tl-st font-mono text-[11px]', { ok: 'text-ok-ink', bad: 'text-bad-ink', run: 'text-accent-ink' }[s.status])}>{mark[s.status]}</span>}
            </button>
          </Fragment>
        ))}
      </div>
    );
  }
  return {
    View,
    setSteps(s) {
      const cur = st.get().cur;
      commit(() => st.set({ steps: s.slice(), cur: cur >= s.length ? s.length - 1 : cur }));
    },
    setCurrent(i) {
      commit(() => st.set({ cur: i }));
    },
    onSeek(cb) {
      cbs.push(cb);
    },
  };
}
