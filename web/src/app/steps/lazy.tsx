// Lazy steps (R-12): Shop, Assemble and Product load on first visit or idle prefetch, so the first bundle is the bench.
// Until the chunk lands a loading card holds the slot; registerStep then remounts the real step if it is still current.
import type { StepCtx, StepId, StepImpl } from '../types';
import { registerStep } from '../shell';
import { LockCard, Muted, PhT, TreeEmpty, Sec } from '../../ui/panel';
import { t } from '../../i18n';

function loadingCard(ctx: StepCtx, err?: string) {
  ctx.shell.layer.render(
    <LockCard role="status" aria-busy={!err} className="step-loading max-w-[360px] pt-1.5">
      <PhT>{err ? t('This step could not load: {err}', { err }) : t('Loading this step…')}</PhT>
      {err && (
        <p className="my-3">
          <Muted>{t('Check the connection, then open the step again.')}</Muted>
        </p>
      )}
    </LockCard>,
  );
  ctx.shell.tree.render(<TreeEmpty>{t('Loading this step…')}</TreeEmpty>);
  ctx.shell.props.render(<Sec>{t('Properties')}</Sec>);
  ctx.shell.toolbar.setGroups([]);
  ctx.shell.setNext(t('Next'), null, t('Loading this step…'));
}

/** Registers a loading stand-in for step id; returns the prefetch function (idempotent, retried after a failure). */
export function lazyStep(id: StepId, load: () => Promise<StepImpl>): () => Promise<void> {
  let p: Promise<void> | null = null;
  const fetch = () =>
    (p ??= load().then(
      (impl) => registerStep(id, impl),
      (e) => {
        p = null;
        throw e;
      },
    ));
  registerStep(id, {
    mount(ctx) {
      loadingCard(ctx);
      fetch().catch((e) => {
        if (ctx.store.get().step === id) loadingCard(ctx, String(e?.message ?? e));
      });
    },
    unmount() {},
  });
  return fetch;
}

/** Run f when the main thread is idle (setTimeout where requestIdleCallback is missing, e.g. Safari). */
export function whenIdle(f: () => void, timeout = 4000) {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(f, { timeout });
  else setTimeout(f, 1500);
}
