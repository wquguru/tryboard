// 底部浮动的分组工具条：组之间画竖线；primary 的工具画成蓝色按钮（"再跑一次"）。
// 状态在一个小 store 里，步骤调 setGroups / setActive / setLabel，组件订阅着画（同步提交，调用返回时 DOM 已是新的）。
import { Fragment } from 'react';
import { cn } from '../ui/cn';
import { commit, useStore } from './react';
import { createStore } from './store';

export interface Tool {
  id: string;
  label: string;
  /** 键盘提示，如 'V' */
  key?: string;
  primary?: boolean;
  /** 尚未实现的工具：可点，但由调用方给出提示 */
  todo?: boolean;
}
export interface ToolGroup {
  id: string;
  tools: Tool[];
}

export interface Toolbar {
  setGroups(groups: ToolGroup[]): void;
  onTool(cb: (id: string) => void): void;
  /** 高亮当前工具（选择 / 转视角 这类互斥工具） */
  setActive(id: string | null): void;
  /** 改一个工具的文字（录像倒计时、外部模型开关） */
  setLabel(id: string, label: string): void;
}

type TbState = { groups: ToolGroup[]; active: string | null; labels: Record<string, string> };

export function createToolbar(): Toolbar & { View: () => React.JSX.Element } {
  const cbs: ((id: string) => void)[] = [];
  const st = createStore<TbState>({ groups: [], active: null, labels: {} });
  const set = (p: Partial<TbState>) => commit(() => st.set(p));
  function View() {
    const { groups, active, labels } = useStore(st);
    return (
      <div
        id="toolbar"
        role="toolbar"
        className={cn(
          'pnl toolbar tb fixed bottom-[calc(var(--dock-h)+12px)] left-[calc((100vw+var(--left-w)-var(--right-w))/2)] z-2 flex -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-(--r) border border-line bg-(--panel) p-1.5 shadow-panel',
          'max-w-[calc(100vw-var(--left-w)-var(--right-w)-24px)]',
          'empty:hidden max-[760px]:hidden!',
        )}
      >
        {groups.map((g, gi) => (
          <Fragment key={g.id}>
            {gi > 0 && <span className="tb-sep mx-0.5 my-0.5 w-px self-stretch bg-line" />}
            <div className="tb-group flex gap-0.5" data-group={g.id}>
              {g.tools.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-tool={t.id}
                  data-key={t.key}
                  aria-pressed={t.id === active}
                  title={t.label + (t.key ? `（${t.key}）` : '') + (t.todo ? ' · 暂未开放' : '')}
                  onClick={() => cbs.forEach((f) => f(t.id))}
                  className={cn(
                    'tb-btn relative cursor-pointer rounded-md border-0 bg-transparent px-[7px] py-[5px] whitespace-nowrap text-fg hover:bg-field aria-pressed:bg-accent-bg aria-pressed:text-accent-ink',
                    t.todo && 'todo text-muted',
                    // 角标字母走 CSS 伪元素：按钮文字保持原样（回归脚本按文字找「万用表」）
                    t.key && !t.primary && 'pr-3 after:absolute after:right-[3px] after:bottom-[2px] after:font-mono after:text-[9px] after:leading-none after:text-muted after:content-[attr(data-key)]',
                    t.primary && 'primary bg-accent-strong px-3.5 font-medium text-on-accent hover:bg-accent-strong',
                  )}
                >
                  {labels[t.id] ?? t.label}
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
