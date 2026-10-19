// "Make it real" card (DESIGN_V2 §8.3, draft LoopB): after it works in the browser, buy, flash, tick off on hardware.
// Shown after all bench checkpoints pass (bench.tsx) and after the product step (product.tsx); one shared component.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BuyLine } from '../catalog/templates.ts';
import { getPart } from '../catalog/parts.ts';
import { ConfIcon } from '../ui/conf.tsx';
import { Icon } from './icons.tsx';
import { t } from '../i18n';

export interface BuyCardProps {
  /** Still to buy (lines ticked "I have it" are left out) */
  remaining: BuyLine[];
  /** Run fingerprint once all checkpoints pass (shown as "Run ID") */
  fingerprint: string | null;
  /** Items the browser cannot prove, ticked on real hardware (the work's "needs hardware" list) */
  manual: string[];
  /** Ticked items (stored locally by the caller) */
  checked: string[];
  onToggleManual: (item: string) => void;
  /** Download flash.bin; null when there is no user firmware (button hidden) */
  onDownloadBin: (() => void) | null;
  /** Work name for the heading; omitted means a generic heading */
  title?: string;
  /** Parts not in the catalog (relay, PIR...): still bought, counted in items and price */
  extra?: { name: string; price: [number, number]; keywords?: string }[];
  /** Checkpoint count for the "N checkpoints passed" line; omitted means no number */
  checks?: number;
  /** When set, a close button shows top right */
  onClose?: () => void;
}

const yuan = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Catalog parts expand to keywords and price; parts without a model use their name as keyword */
function rowsOf(p: BuyCardProps) {
  const cat = p.remaining.map((l) => {
    const part = getPart(l.partId);
    return { name: t(part.name), model: part.model, qty: l.qty, lo: part.price.lo * l.qty, hi: part.price.hi * l.qty, kw: part.keywords, url: part.searchUrl.taobao };
  });
  const ext = (p.extra ?? []).map((e) => ({ name: t(e.name), model: '', qty: 1, lo: e.price[0], hi: e.price[1], kw: e.keywords ?? t(e.name), url: '' }));
  return [...cat, ...ext];
}

export function BuyCard(p: BuyCardProps) {
  const rows = rowsOf(p);
  const lo = rows.reduce((a, r) => a + r.lo, 0);
  const hi = rows.reduce((a, r) => a + r.hi, 0);
  const [copied, setCopied] = useState('');
  const copy = async () => {
    const text = rows.map((r) => `${r.name}${r.qty > 1 ? ` ×${r.qty}` : ''}: ${r.kw}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(t('Search terms copied'));
    } catch {
      setCopied(t('The browser blocked the clipboard: the CSV has the same search terms'));
    }
    // The CSV downloads too (one button in the draft); the leading BOM makes Excel read UTF-8
    const csv = [[t('Part'), t('Model'), t('Qty'), t('Price low'), t('Price high'), t('Search terms'), t('Taobao search')].map(csvCell).join(','), ...rows.map((r) => [r.name, r.model, String(r.qty), yuan(r.lo), yuan(r.hi), r.kw, r.url].map(csvCell).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'tryboard-buy.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // Equal-height columns, buttons pinned to the bottom, solid border (DESIGN_V2 §9.5): dashed reads as "drop here"
  const card = 'flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-4';
  // One verb and one number per step (DESIGN_V2 §9); numbers in body colour, blue is only for clickables
  const head = (n: number, verb: string, big: string | number, unit: string) => (
    <div>
      <span className="block text-xs font-medium text-muted">
        {n} · {verb}
      </span>
      <span className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[28px] leading-9 font-bold text-fg tabular-nums">{big}</span>
        <span className="text-[13px] text-muted">{unit}</span>
      </span>
    </div>
  );
  const shown = rows.slice(0, 3);
  const rest = rows.slice(3);
  const line = (r: (typeof rows)[number], i: number) => (
    <li key={i} className="flex justify-between gap-2 border-b border-line-soft py-1.5 text-[13px] leading-5">
      <span className="min-w-0">
        {r.name}
        {r.qty > 1 ? ` ×${r.qty}` : ''}
      </span>
      <span className="flex-none font-mono text-xs leading-5 text-muted tabular-nums">
        ¥{yuan(r.lo)}–{yuan(r.hi)}
      </span>
    </li>
  );
  const btn = 'inline-flex min-h-10 cursor-pointer items-center justify-center gap-1 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-fg hover:bg-field max-md:min-h-11';
  const btnPri = 'inline-flex min-h-10 cursor-pointer items-center justify-center gap-1 rounded-lg border border-accent-strong bg-accent-strong px-3 text-[13px] font-semibold text-on-accent max-md:min-h-11';
  return (
    <section id="buyCard" aria-label={t('Make it real')} className="@container text-fg">
      <div className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-7 flex-none items-center justify-center rounded-full bg-ok-bg text-ok-ink">
          <Icon n="check" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-ok-ink">{p.checks ? t('All {n} checkpoints passed', { n: p.checks }) : t('All checkpoints passed')}</span>
          <h2 className="m-0 text-xl leading-7 font-semibold">{p.title ? t('{title} works in the browser.', { title: t(p.title) }) : t('It works in the browser.')}</h2>
          <p className="m-0 text-[15px] leading-6 text-muted">{t('Next, make it real.')}</p>
        </div>
        {p.onClose && (
          <button type="button" className="inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-md text-muted hover:bg-field" aria-label={t('Close')} onClick={p.onClose}>
            <Icon n="x" size={16} />
          </button>
        )}
      </div>
      {/* Container query: the product page's right column is ~300px, a viewport breakpoint would cram three columns */}
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
        <div className={card} data-buy="buy">
          {head(1, t('Buy parts'), rows.length, t('items · about ¥{lo}–{hi}', { lo: yuan(lo), hi: yuan(hi) }))}
          {/* Show 3, the rest expand: no nested scroll and names are never truncated */}
          <ul className="m-0 list-none p-0">{shown.map(line)}</ul>
          {rest.length > 0 && (
            <details className="group">
              <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1 text-[13px] text-muted select-none max-md:min-h-11 [&::-webkit-details-marker]:hidden">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="-rotate-90 transition-transform group-open:rotate-0">
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t('{n} more', { n: rest.length })}
              </summary>
              <ul className="m-0 list-none p-0">{rest.map((r, i) => line(r, i + 3))}</ul>
            </details>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
            <button type="button" className={btnPri} data-buy-copy="" onClick={() => void copy()}>
              {t('Copy search terms · Export CSV')}
            </button>
            {copied && <span className="text-[11px] text-muted">{copied}</span>}
          </div>
        </div>
        <div className={card} data-buy="flash">
          {head(2, t('Flash the board'), 1, t('command'))}
          <p className="m-0 text-xs text-muted">{t('The same firmware that worked in the browser')}</p>
          <pre className="m-0 rounded-md bg-field px-2.5 py-2 font-mono text-xs whitespace-pre-wrap">{t('idf.py -p [PORT] flash monitor')}</pre>
          <p className="m-0 text-xs text-muted">{t('Or download flash.bin and use the Espressif flash tool')}</p>
          {p.onDownloadBin && (
            <div className="mt-auto pt-1">
              <button type="button" className={btn} data-buy-bin="" onClick={p.onDownloadBin}>
                {t('Download flash.bin')}
              </button>
            </div>
          )}
        </div>
        <div className={card} data-buy="manual">
          {head(3, t('Confirm on hardware'), p.manual.length, p.manual.length ? t('items') : t('to confirm'))}
          {p.manual.length > 0 && <p className="m-0 text-xs text-muted">{t('What the browser cannot prove: tick each off once you have the board')}</p>}
          {p.manual.length ? (
            p.manual.map((m) => (
              <label key={m} className="flex min-h-8 cursor-pointer items-start gap-2 text-xs max-md:min-h-11">
                <input type="checkbox" className="mt-0.5 accent-(--accent)" checked={p.checked.includes(m)} onChange={() => p.onToggleManual(m)} />
                <ConfIcon c="必须上真机" size={13} className="mt-0.5" /> {/* lint: allow-cjk */}
                <span>{t(m)}</span>
              </label>
            ))
          ) : (
            <p className="m-0 text-xs text-muted">{t('This work has nothing that needs real hardware.')}</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-line-soft pt-2 text-[11px] text-muted">
        <span>{t('Prices are estimates; parts you already have are not listed.')}</span>
        {p.fingerprint && (
          <span title={t('Same firmware and inputs give the same run ID in the browser and the CLI: the result is reproducible')}>
            {t('Run ID')}{' '}
            <span className="font-mono" data-buy-fp="">
              {p.fingerprint}
            </span>
          </span>
        )}
      </div>
    </section>
  );
}

/** Bench pop-up: backdrop + dialog (backdrop / Esc / close). The product page embeds the card without it */
export function BuyDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);
  // Portal to body: the backdrop must cover the whole bench incl. side columns, or they look clickable
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/48" onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={t('Make it real')}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-3 overflow-auto rounded-2xl border border-line bg-surface p-4 shadow-[0_24px_48px_rgba(0,0,0,0.24)] outline-none md:inset-x-[max(12px,calc(50%-440px))] md:top-6 md:bottom-auto md:max-h-[calc(100%-48px)] md:p-7"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
