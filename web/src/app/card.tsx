// Quick card popping up next to a clicked part (P0-04 puts temperature sliders, heat sources... in it). anchor is in CSS px
// from the container's top-left (as ScenePickApi). React draws content; place() writes style directly, per frame while orbiting.
import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n/index.ts";
import type { ScreenPoint } from "../scene-api";
import { cn } from "../ui/cn";
import { Icon } from "./icons";
import { isPhone, usePhone } from "./mobile";
import { commit, useStore } from "./react";
import { createStore } from "./store";

export interface Card {
  show(anchor: ScreenPoint, content: ReactNode): void;
  /** Move only (follows the target while the bench rotates); content unchanged. */
  place(anchor: ScreenPoint): void;
  hide(): void;
  /** Called once when the card closes (Esc, click outside, step change). */
  onHide(cb: () => void): void;
  readonly open: boolean;
}

export function createCard(
  container: () => HTMLElement,
): Card & { View: () => React.JSX.Element } {
  const st = createStore<{ content: ReactNode; n: number; open: boolean }>({
    content: null,
    n: 0,
    open: false,
  });
  let el: HTMLDivElement | null = null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") card.hide();
  };
  const hideCbs: (() => void)[] = [];
  function View() {
    const { content, n, open } = useStore(st);
    const phone = usePhone();
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      el = ref.current;
    });
    const box = (
      <div
        ref={ref}
        role="dialog"
        hidden={!open}
        className={cn(
          "qcard absolute z-4 max-w-[260px] min-w-[160px] rounded-[10px] border border-line bg-(--panel) px-3 pt-0.5 pb-2.5 shadow-[0_4px_16px_#0000001a] [&_.kv]:mt-1.5 [&_.sec]:mt-2 [&_.sec]:text-[13px] [&_.sec]:text-fg [&_.seg]:mt-1.5 [&_.slider]:mt-1.5 [&_.slider]:mb-0.5",
          // Phone: the shop/assemble/product bench is visibility-hidden, so the card becomes a visible bottom sheet or it can't be reached.
          phone &&
            "pointer-events-auto visible fixed inset-x-0 top-auto bottom-0 z-50 max-h-[70dvh] max-w-none overflow-y-auto rounded-b-none bg-surface! px-4 pb-[calc(16px+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_#00000026]",
        )}
      >
        {phone && open && (
          <div className="flex justify-end">
            <button
              type="button"
              aria-label={t("Close")}
              data-card-close
              onClick={() => card.hide()}
              className="-mr-2 inline-flex size-11 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-fg"
            >
              <Icon n="x" size={18} />
            </button>
          </div>
        )}
        <Fragment key={n}>{content}</Fragment>
      </div>
    );
    // Phone: portal to body; inside the fixed bench stacking context it would sit under the in-flow lists and inspector.
    return phone ? createPortal(box, document.body) : box;
  }
  const card = {
    View,
    get open() {
      return st.get().open;
    },
    show(anchor: ScreenPoint, content: ReactNode) {
      commit(() => st.set({ content, n: st.get().n + 1, open: true }));
      card.place(anchor);
      document.addEventListener("keydown", onKey);
    },
    place(anchor: ScreenPoint) {
      if (!st.get().open || !el) return;
      // Phone bottom sheet is positioned by class; clear desktop left/top.
      if (isPhone()) {
        el.style.left = el.style.top = "";
        return;
      }
      // 12px below-right of the anchor; flip left/up if it doesn't fit so the card stays inside the container.
      const c = container();
      const W = c.clientWidth,
        H = c.clientHeight;
      const w = el.offsetWidth,
        h = el.offsetHeight;
      let x = anchor.x + 12,
        y = anchor.y + 12;
      if (x + w > W - 12) x = anchor.x - 12 - w;
      if (y + h > H - 12) y = anchor.y - 12 - h;
      el.style.left = `${Math.max(12, Math.min(x, W - w - 12))}px`;
      el.style.top = `${Math.max(12, Math.min(y, H - h - 12))}px`;
    },
    hide() {
      const was = st.get().open;
      commit(() => st.set({ content: null, open: false }));
      document.removeEventListener("keydown", onKey);
      if (was) hideCbs.forEach((f) => f());
    },
    onHide(cb: () => void) {
      hideCbs.push(cb);
    },
  };
  return card;
}
