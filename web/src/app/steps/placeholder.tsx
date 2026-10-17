// 采购 / 组装 / 成品 三步的占位：路由和外壳已经在，内容由后续任务用 registerStep 覆盖。
import type { StepCtx, StepImpl } from '../types';
import { LockCard, Muted, PhT, Sec, TreeEmpty } from '../../ui/panel';

export function placeholderStep(title: string, _task: string, about: string): StepImpl {
  return {
    mount(ctx: StepCtx) {
      ctx.shell.layer.render(
        <LockCard role="status" className="placeholder max-w-[360px] pt-1.5">
          <Sec>{title}</Sec>
          <PhT>这一步暂未开放</PhT>
          <p className="my-3">
            <Muted>{about}</Muted>
          </p>
          <p className="my-3">
            <Muted>实验台上的模拟在后台继续运行，切回「实验台」接着看。</Muted>
          </p>
        </LockCard>,
      );
      ctx.shell.tree.render(<TreeEmpty>还没有内容</TreeEmpty>);
      ctx.shell.props.render(
        <>
          <Sec>属性</Sec>
          <TreeEmpty>没有可选中的对象</TreeEmpty>
        </>,
      );
      ctx.shell.toolbar.setGroups([]);
      ctx.shell.setNext('下一步', null, '这一步还没做');
    },
    unmount() {},
  };
}
