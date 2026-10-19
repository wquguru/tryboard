// D-06 checklist card (docs/design-v2/depth/Checklist.dc.html): ticks live in localStorage per project
import { useState } from 'react';
import { t } from '../i18n';
import { btnClass } from '../ui/panel';
import { checklistText, type CheckItem } from './checklist';

const KEY = (w: string) => `tryboard-checklist:${w}`;
function load(w: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(w)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function save(w: string, v: string[]) {
  try {
    localStorage.setItem(KEY(w), JSON.stringify(v));
  } catch {
    /* Private mode: ticks only last for this page */
  }
}

/** Print only this card: a body-level copy escapes the scrolling drawer, the print stylesheet in lab.css hides the rest */
function printCard(card: HTMLElement | null) {
  if (!card) return;
  const root = document.createElement('div');
  root.id = 'checklist-print';
  const copy = card.cloneNode(true) as HTMLElement;
  // React sets `checked` as a property, which cloneNode drops
  const src = card.querySelectorAll('input');
  copy.querySelectorAll('input').forEach((x, i) => (x.checked = src[i].checked));
  root.appendChild(copy);
  document.body.appendChild(root);
  document.body.classList.add('print-checklist');
  const off = () => {
    document.body.classList.remove('print-checklist');
    root.remove();
    window.removeEventListener('afterprint', off);
  };
  window.addEventListener('afterprint', off);
  window.print();
}

export function Checklist({ work, title, items, toast }: { work: string; title: string; items: CheckItem[]; toast: (s: string) => void }) {
  const [done, setDone] = useState(() => load(work));
  if (!items.length) return null;
  const head = t('Test these {n} things first when the board arrives', { n: items.length });
  const toggle = (k: string) => {
    const next = done.includes(k) ? done.filter((x) => x !== k) : [...done, k];
    save(work, next);
    setDone(next);
  };
  const copy = () => {
    const text = checklistText(`TryBoard · ${title} · ${head}`, items, done);
    void navigator.clipboard?.writeText(text).then(
      () => toast(t('Checklist copied')),
      () => toast(t('Copy failed: the browser blocked clipboard access')),
    );
  };
  return (
    <section className="checklist" aria-labelledby="checklist-h">
      <div className="text-xs text-[var(--muted)]">{t('{work} · after it runs', { work: title })}</div>
      <h3 id="checklist-h" className="mt-1 text-[15px] leading-[22px] font-semibold">
        {head}
      </h3>
      <p className="mt-1 text-xs leading-[18px] text-[var(--muted)]">{t("The simulator can't verify these for you. Test them in order and you'll know where you stand.")}</p>
      <ul className="mt-2 flex flex-col">
        {items.map((it, n) => {
          const id = `cl-${n}`;
          return (
            <li key={it.key} className="flex gap-2.5 border-t border-[var(--line-soft)] py-2.5" data-key={it.key}>
              {/* 44px tap target on phones wraps a 20px box */}
              <label className="-m-3 flex size-11 flex-none items-start justify-center p-3 md:m-0 md:size-auto md:p-0">
                <input type="checkbox" id={id} className="size-5 accent-[var(--accent)]" checked={done.includes(it.key)} onChange={() => toggle(it.key)} />
              </label>
              <div className="min-w-0 flex-1">
                <label htmlFor={id} className="flex items-baseline gap-1.5 font-semibold">
                  <span className="font-mono font-medium text-[var(--muted)]">{n + 1}</span>
                  <span className={done.includes(it.key) ? 'text-[var(--muted)] line-through' : ''}>{it.title}</span>
                </label>
                <div className="mt-0.5 leading-5">{it.how}</div>
                <div className="mt-0.5 text-xs leading-[18px] text-[var(--muted)]">{t("Why it can't be simulated: {why}", { why: it.why })}</div>
              </div>
              <span className="flex-none text-[11px] text-[var(--muted)]">{t('{n} min', { n: it.minutes })}</span>
            </li>
          );
        })}
      </ul>
      <div className="checklist-acts flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-3">
        <button type="button" className={btnClass(true)} onClick={copy}>
          {t('Copy list')}
        </button>
        <button type="button" className={btnClass()} onClick={(e) => printCard(e.currentTarget.closest('.checklist'))}>
          {t('Print')}
        </button>
        <span className="flex-1 text-right text-[11px] text-[var(--muted)]">{t("Generated from this project's parts and result cards")}</span>
      </div>
    </section>
  );
}
