// Placeholder for the Shop / Assemble / Product steps: routes and shell exist, later tasks override the content via registerStep.
import type { StepCtx, StepImpl } from '../types';
import { LockCard, Muted, PhT, Sec, TreeEmpty } from '../../ui/panel';
import { t } from '../../i18n';

export function placeholderStep(title: string, _task: string, about: string): StepImpl {
  return {
    mount(ctx: StepCtx) {
      ctx.shell.layer.render(
        <LockCard role="status" className="placeholder max-w-[360px] pt-1.5">
          <Sec>{t(title)}</Sec>
          <PhT>{t('This step is not open yet')}</PhT>
          <p className="my-3">
            <Muted>{t(about)}</Muted>
          </p>
          <p className="my-3">
            <Muted>{t('The simulation on the Bench keeps running in the background; switch back to “Bench” to keep watching.')}</Muted>
          </p>
        </LockCard>,
      );
      ctx.shell.tree.render(<TreeEmpty>{t('Nothing here yet')}</TreeEmpty>);
      ctx.shell.props.render(
        <>
          <Sec>{t('Properties')}</Sec>
          <TreeEmpty>{t('Nothing to select')}</TreeEmpty>
        </>,
      );
      ctx.shell.toolbar.setGroups([]);
      ctx.shell.setNext(t('Next'), null, t('This step is not done yet'));
    },
    unmount() {},
  };
}
