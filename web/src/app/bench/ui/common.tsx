import { Fragment, type ReactNode } from "react";
import { t } from "../../../i18n";

/** t() with React nodes as placeholders, so markup stays inside one translatable sentence. */
export function tn(en: string, nodes: Record<string, ReactNode>): ReactNode {
  return t(en)
    .split(/(\{\w+\})/)
    .map((s, i) => {
      const k = /^\{(\w+)\}$/.exec(s)?.[1];
      return k && k in nodes ? <Fragment key={i}>{nodes[k]}</Fragment> : s;
    });
}

export const btn =

  "inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs text-fg hover:bg-field";
export const btnPri =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-accent-strong bg-accent-strong px-2.5 text-xs font-medium text-on-accent";
