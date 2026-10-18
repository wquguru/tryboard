// 顶栏「已存在本机 · 刚刚」的数据源：各步骤把作品数据写进 localStorage 时顺手记一下时刻。
// 时刻本身也存进 localStorage，刷新后显示的仍是真正的上次保存时间，而不是打开页面的时间。
import { bc, setBc } from './chrome';

const KEY = (work: string) => `tryboard-app-saved:${work}`;
let cur = '';

export function initSaved(work: string) {
  cur = work;
  let t: number | null = null;
  try {
    const v = Number(localStorage.getItem(KEY(work)));
    if (v > 0) t = v;
  } catch {
    /* 隐私模式 */
  }
  setBc({ saved: t });
  window.addEventListener('tb-saved', noteSaved);
}

export function noteSaved() {
  const t = Date.now();
  if (cur) {
    try {
      localStorage.setItem(KEY(cur), String(t));
    } catch {
      /* 隐私模式：只在本页显示 */
    }
  }
  if (bc.get().saved !== t) setBc({ saved: t });
}

/** 「刚刚 / 3 分钟前 / 昨天 14:05」 */
export function savedText(t: number | null, now = Date.now()): string {
  if (t == null) return '未修改';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return '已存在本机 · 刚刚';
  if (s < 3600) return `已存在本机 · ${Math.round(s / 60)} 分钟前`;
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now).toDateString() === d.toDateString();
  return `已存在本机 · ${today ? '今天' : `${d.getMonth() + 1} 月 ${d.getDate()} 日`} ${hm}`;
}
