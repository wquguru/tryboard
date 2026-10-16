// 底部浮动的分组工具条：组之间画竖线；primary 的工具画成蓝色按钮（"再跑一次"）。

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
}

export function createToolbar(el: HTMLElement): Toolbar {
  const cbs: ((id: string) => void)[] = [];
  let active: string | null = null;
  el.classList.add('tb');
  el.setAttribute('role', 'toolbar');
  function sync() {
    el.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === active)));
  }
  return {
    setGroups(groups) {
      el.innerHTML = '';
      groups.forEach((g, gi) => {
        if (gi) el.appendChild(Object.assign(document.createElement('span'), { className: 'tb-sep' }));
        const box = document.createElement('div');
        box.className = 'tb-group';
        box.dataset.group = g.id;
        for (const t of g.tools) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.tool = t.id;
          b.className = 'tb-btn' + (t.primary ? ' primary' : '') + (t.todo ? ' todo' : '');
          b.textContent = t.label;
          b.title = t.label + (t.key ? `（${t.key}）` : '') + (t.todo ? ' · 后续任务实现' : '');
          b.onclick = () => cbs.forEach((f) => f(t.id));
          box.appendChild(b);
        }
        el.appendChild(box);
      });
      sync();
    },
    onTool(cb) {
      cbs.push(cb);
    },
    setActive(id) {
      active = id;
      sync();
    },
  };
}
