// Bottom timeline: one cell per step (place part, wire, run #n). This only draws and clicks; deterministic
// replay to a step (P0-03) hangs off onSeek. Steps change rarely (one per action), so React state is fine.
import { Fragment, useLayoutEffect, useRef } from 'react';
import { cn } from '../ui/cn';
import { commit, useStore } from './react';
import { createStore } from './store';

export interface TimelineStep {
  id: string;
  /** A single character or short symbol, no emoji. */
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
      // Scroll only the timeline: scrollIntoView also scrolls the page (on phones the stacked page would jump to the bottom).
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
                // After seeking back, later steps are dimmed (still there, but discarded on the next edit).
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
