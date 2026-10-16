// 采购 / 组装 / 成品 三步的占位：路由和外壳已经在，内容由后续任务用 registerStep 覆盖。
import type { StepCtx, StepImpl } from '../types';

export function placeholderStep(title: string, task: string, about: string): StepImpl {
  return {
    mount(el: HTMLElement, ctx: StepCtx) {
      el.innerHTML = `<div class="pnl placeholder" role="status"><div class="sec">${title}</div><p class="ph-t">这一步由后续任务实现（${task}）</p><p class="muted"></p><p class="muted">实验台上的模拟在后台继续运行，切回「实验台」接着看。</p></div>`;
      el.querySelector('.muted')!.textContent = about;
      ctx.shell.tree.innerHTML = `<div class="tree-empty">${title}的构建树由 ${task} 实现</div>`;
      ctx.shell.props.innerHTML = `<div class="sec">属性</div><div class="tree-empty">没有可选中的对象</div>`;
      ctx.shell.toolbar.setGroups([]);
      ctx.shell.setNext('下一步', null, '这一步还没做');
    },
    unmount() {},
  };
}
