// Assembly state and rules shared by the SVG view (assembly.ts) and the 3D view (app/asm3d.ts): parts go in bottom-up,
// a part with placement options waits in "choosing" until one is picked, and the template's checks / effects score the choice.
import { t } from '../i18n';
import type { Effects, Part, Picked, Template } from './templates';

export interface AsmCoreState extends Picked {
  msg: [string, string];
  bad: boolean;
  choosing: string | null;
}
export type PlaceResult = { kind: 'rejected' } | { kind: 'choosing' } | { kind: 'placed'; offsetChanged: boolean };

export function createAsmCore(T: Template) {
  const P = T.parts;
  const byId = Object.fromEntries(P.map((p) => [p.id, p])) as Record<string, Part>;
  const st: AsmCoreState = { placed: [], choice: {}, msg: T.intro, bad: false, choosing: null };
  const fx = (): Effects => T.effects(st);
  return {
    T,
    byId,
    st,
    effects: fx,
    next: () => P[st.placed.length]?.id as string | undefined,
    clean: () => st.placed.length === P.length && P.every((p) => !p.spots || p.spots.find((s) => s.key === st.choice[p.id])?.ok),
    place(id: string, spot?: string): PlaceResult {
      const next = P[st.placed.length]?.id;
      if (id !== next) {
        st.bad = true;
        st.choosing = null;
        st.msg = [t('“{part}” can’t go in yet', { part: byId[id].short }), next ? t('Fit “{part}” first, it sits lower', { part: byId[next].short }) : t('Everything is already in')];
        return { kind: 'rejected' };
      }
      const p = byId[id];
      if (p.spots && !spot) {
        st.choosing = id;
        st.bad = false;
        st.msg = [t('How should {part} go in?', { part: p.short }), p.spots.map((s) => s.label).join(t(', or '))];
        return { kind: 'choosing' };
      }
      const before = fx().sensorOffset ?? 0;
      st.placed.push(id);
      const s = p.spots?.find((x) => x.key === spot);
      if (s) st.choice[id] = s.key;
      st.choosing = null;
      st.bad = !!s && !s.ok;
      st.msg = s ? s.msg : p.okMsg ?? [t('Fitted'), ''];
      return { kind: 'placed', offsetChanged: (fx().sensorOffset ?? 0) !== before };
    },
    /** Clear; returns whether there was a temperature offset so the caller can zero the simulator */
    reset(): boolean {
      const before = fx().sensorOffset ?? 0;
      Object.assign(st, { placed: [], choice: {}, msg: T.intro, bad: false, choosing: null });
      return before !== 0;
    },
  };
}
export type AsmCore = ReturnType<typeof createAsmCore>;
