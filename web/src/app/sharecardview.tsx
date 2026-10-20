// Share card dialog (F-02): preview, record progress, download video / PNG, copy link. Mounted on body like realnet.tsx.
// window.__tbCardLast holds the last card (PNG data URL, QR placement, video info) for tools/webtest/sharecard.mjs.
import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { t } from '../i18n';
import { download } from './capture';
import { CARD_SECONDS, makeCard, recordCard, type CardResult, type CardVideo } from './sharecard';
import { Icon } from './icons';
import type { StepCtx } from './types';

interface CardLast {
  url?: string;
  truncated?: boolean;
  run?: boolean;
  qr?: CardResult['qr'];
  png?: string;
  video?: { name: string; mime: string; bytes: number; seconds: number };
  error?: string;
}
const hook = globalThis as { __tbCardLast?: CardLast };

const dataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

function Dialog({ ctx, onClose }: { ctx: StepCtx; onClose: () => void }) {
  const [card, setCard] = useState<CardResult | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [video, setVideo] = useState<CardVideo | null>(null);
  const [vurl, setVurl] = useState<string | null>(null);
  const [sec, setSec] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    hook.__tbCardLast = {};
    (async () => {
      try {
        const c = await makeCard(ctx);
        if (!alive) return;
        setCard(c);
        const png = await dataUrl(c.png);
        setImg(png);
        hook.__tbCardLast = { url: c.url, truncated: c.truncated, run: c.run, qr: c.qr, png };
        const r = recordCard(ctx.session.bench.capture(), c.base, c.slug, CARD_SECONDS, (s) => alive && setSec(Math.min(CARD_SECONDS, s)));
        stop.current = r.stop;
        const v = await r.done;
        if (!alive) return;
        setVideo(v);
        setVurl(URL.createObjectURL(v.blob));
        hook.__tbCardLast = { ...hook.__tbCardLast, video: { name: v.name, mime: v.mime, bytes: v.blob.size, seconds: v.seconds } };
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (alive) setErr(m);
        hook.__tbCardLast = { ...hook.__tbCardLast, error: m };
      }
    })();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => {
      alive = false;
      stop.current?.();
      removeEventListener('keydown', esc);
    };
  }, [ctx, onClose]);
  useEffect(() => () => void (vurl && URL.revokeObjectURL(vurl)), [vurl]);
  useEffect(() => box.current?.querySelector<HTMLButtonElement>('[data-act="close"]')?.focus(), []);
  const btn = 'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] text-fg disabled:cursor-default disabled:opacity-50 max-md:h-11';
  const ext = video ? (video.name.endsWith('.mp4') ? 'MP4' : 'WebM') : 'MP4';
  return (
    <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose}>
      <div
        ref={box}
        id="cardDlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cardTitle"
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-x-3 top-14 flex max-h-[calc(100dvh-72px)] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-surface p-4 text-[13px] text-fg shadow-panel md:left-1/2 md:w-[420px] md:-translate-x-1/2"
      >
        <div className="flex items-center gap-2">
          <b id="cardTitle" className="flex-1 text-[15px]">
            {t('Share card')}
          </b>
          <button type="button" data-act="close" aria-label={t('Close')} className="flex size-9 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted max-md:size-11" onClick={onClose}>
            <Icon n="x" size={16} />
          </button>
        </div>
        <div className="flex aspect-[4/5] max-h-[52dvh] w-full items-center justify-center self-center overflow-hidden rounded-lg bg-field">
          {vurl ? (
            <video src={vurl} autoPlay loop muted playsInline className="size-full object-contain" />
          ) : img ? (
            <img src={img} alt={t('Share card preview')} className="size-full object-contain" />
          ) : (
            <span className="text-muted">{err ? '' : t('Making the card…')}</span>
          )}
        </div>
        <p id="cardStatus" className="m-0 leading-5 text-fg/80" aria-live="polite">
          {err
            ? t('Could not make the share card: {err}', { err })
            : video
              ? t('Ready: a {s} s {fmt} clip and a PNG still; the QR code opens the same bench', { s: CARD_SECONDS, fmt: ext })
              : card
                ? t('Recording {n}/{max} s…', { n: sec.toFixed(0), max: CARD_SECONDS })
                : t('Making the card…')}
        </p>
        {card?.notes.map((n) => (
          <p key={n} className="m-0 leading-5 text-warn-ink">
            {n}
          </p>
        ))}
        <div className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
          <button type="button" data-act="video" className={btn} disabled={!video} onClick={() => video && download(video.blob, video.name)}>
            <Icon n="download" size={15} />
            {t('Video ({fmt})', { fmt: ext })}
          </button>
          <button type="button" data-act="png" className={btn} disabled={!card} onClick={() => card && download(card.png, card.pngName)}>
            <Icon n="download" size={15} />
            {t('Image (PNG)')}
          </button>
          <button
            type="button"
            data-act="copy"
            className={btn}
            disabled={!card}
            onClick={() =>
              card &&
              void navigator.clipboard?.writeText(card.url).then(
                () => ctx.shell.toast(t('Share link copied')),
                () => ctx.shell.toast(t('Copy failed: the browser blocked clipboard access')),
              )
            }
          >
            <Icon n="link" size={15} />
            {t('Copy link')}
          </button>
        </div>
      </div>
    </div>
  );
}

let host: { root: Root; el: HTMLElement } | null = null;
/** Top bar ⋯ "Share card": goes to the bench first (the card films the bench view). */
export async function openShareCard(ctx: StepCtx) {
  if (host) return;
  if (ctx.store.get().step !== 'bench') {
    location.hash = 'bench';
    await new Promise((r) => setTimeout(r, 600));
  }
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  host = { root, el };
  const close = () => {
    const h = host;
    host = null;
    setTimeout(() => {
      h?.root.unmount();
      h?.el.remove();
    });
  };
  root.render(<Dialog ctx={ctx} onClose={close} />);
}
