// Floating grouped bottom toolbar. On narrow desktops (1280, both panels open) it wraps to two rows instead of
// scrolling: a hidden scrollbar would hide the trailing tools. Steps drive it via setGroups / setActive / setLabel (sync commit).
import { Fragment, useLayoutEffect, useRef } from 'react';
import { t } from '../i18n';
import { cn } from '../ui/cn';
import { commit, useStore } from './react';
import { createStore } from './store';
import { PhoneToolbar, usePhone } from './mobile';

export interface Tool {
  id: string;
  label: string;
  /** Keyboard hint, e.g. 'V' */
  key?: string;
  primary?: boolean;
  /** Not implemented yet: clickable, the caller shows a hint */
  todo?: boolean;
  /** Phone only (DESIGN_V2 §10.2): icon name, live on/off read at render, how the state shows, label without the state */
  icon?: string;
  on?: () => boolean;
  kind?: 'switch' | 'tag';
  offTag?: string;
  phoneLabel?: string;
}
export interface ToolGroup {
  id: string;
  tools: Tool[];
}

export interface Toolbar {
  setGroups(groups: ToolGroup[]): void;
  onTool(cb: (id: string) => void): void;
  /** Highlight the current tool (mutually exclusive ones like select / orbit) */
  setActive(id: string | null): void;
  /** Change a tool's text (recording countdown, external model toggle) */
  setLabel(id: string, label: string): void;
}

function toolTitle(tool: Tool) {
  const base = tool.key ? t('{label} ({key})', { label: tool.label, key: tool.key }) : tool.label;
  return tool.todo ? t('{title} · not available yet', { title: base }) : base;
}

type TbState = { groups: ToolGroup[]; active: string | null; labels: Record<string, string> };

export function createToolbar(): Toolbar & { View: (p: { step: string }) => React.JSX.Element | null } {
  const cbs: ((id: string) => void)[] = [];
  const st = createStore<TbState>({ groups: [], active: null, labels: {} });
  const set = (p: Partial<TbState>) => commit(() => st.set(p));
  function View({ step }: { step: string }) {
    const { groups, active, labels } = useStore(st);
    const phone = usePhone();
    const ref = useRef<HTMLDivElement>(null);
    // Publish the real height (it wraps to two rows in en / ja at 1280) so floating cards like the multimeter sit above it
    useLayoutEffect(() => {
      const el = ref.current;
      const root = document.documentElement.style;
      if (!el) return;
      const sync = () => root.setProperty('--tb-h', `${el.offsetHeight ? el.offsetHeight + 12 : 0}px`);
      sync();
      const ro = new ResizeObserver(sync);
      ro.observe(el);
      return () => {
        ro.disconnect();
        root.removeProperty('--tb-h');
      };
    }, [phone]);
    // Phone: the bench gets a docked five-button bar + More, other steps a button grid under the 3D view (mobile.tsx)
    if (phone)
      return (
        <PhoneToolbar
          step={step}
          groups={groups.map((g) => ({ ...g, tools: g.tools.map((tool) => ({ ...tool, label: labels[tool.id] ?? tool.label })) }))}
          active={active}
          fire={(id) => cbs.forEach((f) => f(id))}
        />
      );
    return (
      <div
        id="toolbar"
        ref={ref}
        role="toolbar"
        className={cn(
          'pnl toolbar tb fixed bottom-[calc(var(--dock-h)+12px)] left-[calc((100vw+var(--left-w)-var(--right-w))/2)] z-2 flex -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-(--r) border border-line bg-(--panel) p-1.5 shadow-panel',
          'max-w-[calc(100vw-var(--left-w)-var(--right-w)-24px)]',
          'empty:hidden',
        )}
      >
        {groups.map((g, gi) => (
          <Fragment key={g.id}>
            {gi > 0 && <span className="tb-sep mx-0.5 my-0.5 w-px self-stretch bg-line" />}
            <div className="tb-group flex min-w-0 flex-wrap justify-center gap-0.5" data-group={g.id}>
              {g.tools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  data-tool={tool.id}
                  data-key={tool.key}
                  aria-pressed={tool.kind === 'switch' && tool.on ? tool.on() : tool.id === active}
                  title={toolTitle(tool)}
                  onClick={() => cbs.forEach((f) => f(tool.id))}
                  className={cn(
                    'tb-btn relative cursor-pointer rounded-md border-0 bg-transparent px-[7px] py-[5px] whitespace-nowrap text-fg hover:bg-field aria-pressed:bg-accent-bg aria-pressed:text-accent-ink',
                    tool.todo && 'todo text-muted',
                    // Key badge is a CSS pseudo-element so the button text stays exact (regression scripts find tools by text)
                    tool.key && !tool.primary && 'pr-3 after:absolute after:right-[3px] after:bottom-[2px] after:font-mono after:text-[9px] after:leading-none after:text-muted after:content-[attr(data-key)]',
                    tool.primary && 'primary bg-accent-strong px-3.5 font-medium text-on-accent hover:bg-accent-strong',
                  )}
                >
                  {labels[tool.id] ?? tool.label}
                </button>
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    );
  }
  return {
    View,
    setGroups(groups) {
      set({ groups, labels: {} });
    },
    onTool(cb) {
      cbs.push(cb);
    },
    setActive(id) {
      set({ active: id });
    },
    setLabel(id, label) {
      set({ labels: { ...st.get().labels, [id]: label } });
    },
  };
}
