// 快捷卡片：点台面上的零件时贴着它弹出的小卡（P0-04 往里放温度滑块、热源等）。
// anchor 是相对容器左上角的 CSS 像素（与 ScenePickApi 的 screen / project 一致）。
import type { ScreenPoint } from '../scene-api';

export interface Card {
  show(anchor: ScreenPoint, content: HTMLElement): void;
  hide(): void;
  readonly open: boolean;
}

export function createCard(container: HTMLElement): Card {
  const el = document.createElement('div');
  el.className = 'qcard';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  container.appendChild(el);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') card.hide();
  };
  const card: Card = {
    get open() {
      return !el.hidden;
    },
    show(anchor, content) {
      el.replaceChildren(content);
      el.hidden = false;
      // 默认放在锚点右下 12px；放不下就翻到左 / 上，保证整张卡在容器里
      const W = container.clientWidth, H = container.clientHeight;
      const w = el.offsetWidth, h = el.offsetHeight;
      let x = anchor.x + 12, y = anchor.y + 12;
      if (x + w > W - 12) x = anchor.x - 12 - w;
      if (y + h > H - 12) y = anchor.y - 12 - h;
      el.style.left = `${Math.max(12, Math.min(x, W - w - 12))}px`;
      el.style.top = `${Math.max(12, Math.min(y, H - h - 12))}px`;
      document.addEventListener('keydown', onKey);
    },
    hide() {
      el.hidden = true;
      el.replaceChildren();
      document.removeEventListener('keydown', onKey);
    },
  };
  return card;
}
