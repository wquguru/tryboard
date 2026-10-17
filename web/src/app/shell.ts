// 工作台外壳：路由（?work= + #步骤）、步骤注册、右上结论 / 下一步、提示条（⌘K 在 cmdk.ts）。
// 步骤切换只换面板内容；实时模拟和 3D 台面在 session 里，整页只有一份。
import { STEPS, type Shell, type StepCtx, type StepId, type StepImpl } from './types';
import { createTimeline } from './timeline';
import { createToolbar } from './toolbar';
import { createCard } from './card';

const registry = new Map<StepId, StepImpl>();

/** 步骤注册：后续任务（采购 P0-07、组装 P0-16、成品 P0-17）各自注册一个实现覆盖占位 */
export function registerStep(id: StepId, impl: StepImpl) {
  registry.set(id, impl);
  if (active?.id === id && ctxRef) remount(id);
}

let active: { id: StepId; impl: StepImpl } | null = null;
let ctxRef: StepCtx | null = null;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function stepFromHash(): StepId {
  const h = location.hash.slice(1) as StepId;
  return STEPS.some((s) => s.id === h) ? h : 'bench';
}

export function createShell(): Shell {
  let toastTimer = 0;
  const shell: Shell = {
    tree: $('tree'),
    props: $('props'),
    toolbar: createToolbar($('toolbar')),
    timeline: createTimeline($('timeline')),
    card: createCard($('stage')),
    stage: $('stage'),
    setVerdict(text, state) {
      const b = $('verdict');
      b.textContent = text;
      b.dataset.state = state;
    },
    onVerdict(fn) {
      $('verdict').onclick = fn;
    },
    setNext(label, to, why, onGo) {
      const b = $<HTMLButtonElement>('next');
      b.textContent = label;
      b.disabled = !to;
      b.title = to ? '' : (why ?? '');
      b.onclick = () => to && (onGo ? onGo() : (location.hash = to));
    },
    toast(text) {
      const t = $('toast');
      t.textContent = text;
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
    },
  };
  // ⌘K 命令框要用到 session / 时间线，由 main.ts 在它们建好之后接上（cmdk.ts）
  document.querySelectorAll<HTMLButtonElement>('.viewcube button').forEach((b) => (b.onclick = () => shell.toast(`「${b.title}」视角暂未开放，可以直接拖动旋转`)));
  return shell;
}

function remount(id: StepId) {
  const ctx = ctxRef!;
  const impl = registry.get(id);
  active?.impl.unmount();
  const layer = $('stepLayer');
  layer.replaceChildren();
  ctx.shell.card.hide();
  document.body.dataset.step = id;
  document.querySelectorAll<HTMLButtonElement>('#steps button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.step === id)));
  ctx.store.set({ step: id });
  if (!impl) {
    active = null;
    return;
  }
  active = { id, impl };
  impl.mount(layer, ctx);
}

/** 启动路由：读当前 hash、监听 hashchange。四步都在同一页，切换不重载 */
export function startRouter(ctx: StepCtx) {
  ctxRef = ctx;
  const nav = $('steps');
  nav.innerHTML = STEPS.map((s, i) => `<button type="button" role="tab" data-step="${s.id}"><span class="mono">${i + 1}</span>${s.label}</button>`).join('');
  nav.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => (location.hash = b.dataset.step!)));
  window.addEventListener('hashchange', () => {
    const id = stepFromHash();
    if (id !== active?.id) remount(id);
  });
  remount(stepFromHash());
}
