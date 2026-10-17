// 装配的状态与规则（SVG 视图 assembly.ts 和 3D 视图 app/asm3d.ts 共用一份）：
// 必须从下往上装；有装法选择的零件不给装法就进入"选择中"；装法影响由模板的 checks / effects 算。
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
        st.msg = [`还不能装「${byId[id].short}」`, next ? `先装「${byId[next].short}」，它在更下面` : '已经装完了'];
        return { kind: 'rejected' };
      }
      const p = byId[id];
      if (p.spots && !spot) {
        st.choosing = id;
        st.bad = false;
        st.msg = [`${p.short}怎么装？`, p.spots.map((s) => s.label).join('，还是')];
        return { kind: 'choosing' };
      }
      const before = fx().sensorOffset ?? 0;
      st.placed.push(id);
      const s = p.spots?.find((x) => x.key === spot);
      if (s) st.choice[id] = s.key;
      st.choosing = null;
      st.bad = !!s && !s.ok;
      st.msg = s ? s.msg : p.okMsg ?? ['装好了', ''];
      return { kind: 'placed', offsetChanged: (fx().sensorOffset ?? 0) !== before };
    },
    /** 清空；返回清空前有没有温漂（调用方据此通知模拟器归零） */
    reset(): boolean {
      const before = fx().sensorOffset ?? 0;
      Object.assign(st, { placed: [], choice: {}, msg: T.intro, bad: false, choosing: null });
      return before !== 0;
    },
  };
}
export type AsmCore = ReturnType<typeof createAsmCore>;
