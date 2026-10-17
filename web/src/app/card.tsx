// 快捷卡片：点台面上的零件时贴着它弹出的小卡（P0-04 往里放温度滑块、热源等）。
// anchor 是相对容器左上角的 CSS 像素（与 ScenePickApi 的 screen / project 一致）。
// 内容由 React 画（同步提交），位置由 place() 量完尺寸后直接写 style（台面转动时每帧跟着挪，不经 React）。
import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ScreenPoint } from "../scene-api";
import { cn } from "../ui/cn";
import { Icon } from "./icons";
import { isPhone, usePhone } from "./mobile";
import { commit, useStore } from "./react";
import { createStore } from "./store";

export interface Card {
  show(anchor: ScreenPoint, content: ReactNode): void;
  /** 只挪位置（台面转动时跟着目标走），不换内容 */
  place(anchor: ScreenPoint): void;
  hide(): void;
  /** 卡片关掉时（Esc、点空白、换步骤）通知一次 */
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
          // 手机：采购 / 组装 / 成品的台面是隐形的（visibility），卡片改成底部抽屉并自己显形，否则换开发板这类卡看不到也点不到
          phone &&
            "pointer-events-auto visible fixed inset-x-0 top-auto bottom-0 z-50 max-h-[70dvh] max-w-none overflow-y-auto rounded-b-none bg-surface! px-4 pb-[calc(16px+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_#00000026]",
        )}
      >
        {phone && open && (
          <div className="flex justify-end">
            <button
              type="button"
              aria-label="关闭"
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
    // 手机上挂到 body：台面是 fixed 的层叠上下文，留在里面会被正常流里的清单、属性卡盖住
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
      // 手机上是底部抽屉，位置由 class 定；清掉桌面留下的 left / top
      if (isPhone()) {
        el.style.left = el.style.top = "";
        return;
      }
      // 默认放在锚点右下 12px；放不下就翻到左 / 上，保证整张卡在容器里
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
