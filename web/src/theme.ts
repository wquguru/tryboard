// 暗色模式（DESIGN §2：同一套变量反转）。默认跟随系统 prefers-color-scheme；用户点过切换就存 localStorage，
// 以后以它为准。页面 <head> 里的一行内联脚本在首帧前就设好 data-theme，避免先白后黑闪一下（见各页 html）。

export type Theme = 'light' | 'dark';

const KEY = 'tb-theme';
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

const subs = new Set<(t: Theme) => void>();

function apply(t: Theme) {
  if (document.documentElement.dataset.theme === t) return;
  document.documentElement.dataset.theme = t;
  for (const f of subs) f(t);
}

/** 主题变了（切换按钮或系统设置）就回调；返回取消订阅 */
export function onTheme(f: (t: Theme) => void) {
  subs.add(f);
  return () => subs.delete(f);
}

/** 用户切换：存下来 */
export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // 无痕模式等存不了：只对本页生效
  }
  apply(t);
}

export type ThemePref = Theme | 'system';

/** 当前偏好：用户手动选过的亮 / 暗，没选过就是跟随系统（手机菜单里的三段切换用） */
export const themePref = (): ThemePref => stored() ?? 'system';

/** 三段切换：'system' 清掉存储、回到跟随系统 */
export function setThemePref(p: ThemePref) {
  if (p !== 'system') return setTheme(p);
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 存不了也没关系：本页照样按系统走
  }
  apply(media?.matches ? 'dark' : 'light');
  for (const f of subs) f(currentTheme());
}

let inited = false;
/** 每页调一次：按存的 / 系统的设好主题，并在系统切换时跟随（用户没手动选过时） */
export function initTheme() {
  if (inited) return;
  inited = true;
  apply(stored() ?? (media?.matches ? 'dark' : 'light'));
  media?.addEventListener('change', (e) => {
    if (!stored()) apply(e.matches ? 'dark' : 'light');
  });
}

/** 一个切换按钮：文字 + 图形一起表达当前状态（不只靠颜色） */
export function themeToggle(cls = 'theme-btn') {
  initTheme();
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  const sync = () => {
    const dark = currentTheme() === 'dark';
    b.textContent = dark ? '☾ 暗' : '☀ 亮';
    b.title = dark ? '切到亮色' : '切到暗色';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(dark));
  };
  sync();
  onTheme(sync);
  b.onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  return b;
}
