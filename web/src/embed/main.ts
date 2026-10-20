// Embed page (F-03, RS-4 §4): a poster with the shared work's title; wasm, three.js and the session load only after the click.
// This module stays light (i18n, share format, examples list); everything heavy lives in run.ts behind a dynamic import.
import '../ui/tailwind.css';
import './embed.css';
import { t } from '../i18n';
import { decodeState, ShareDecodeError, type ShareState } from '../app/sharestate';
import { chipOf, loadExamples } from '../app/examples';
import { WORKS } from '../app/works';
import type { WorkDef } from '../app/types';

const CHIP_LABEL: Record<string, string> = { esp32: 'ESP32', esp32c3: 'ESP32-C3', esp32s3: 'ESP32-S3' };

/** Work the state names, mirroring main.tsx (blank:<example>, a named work, or custom with the chip from the state) */
export async function embedWork(st: ShareState): Promise<{ work: WorkDef; chip: string | null }> {
  const exId = st.w.startsWith('blank:') ? st.w.slice(6) : null;
  const ex = exId ? (await loadExamples()).find((e) => e.id === exId) : undefined;
  if (ex) return { work: { ...WORKS.blank, example: ex.id, title: t(ex.title), key: `blank:${ex.id}` }, chip: chipOf(ex) };
  const w = WORKS[st.w] ?? WORKS.blank;
  const wex = w.example ? (await loadExamples()).find((e) => e.id === w.example) : undefined;
  return { work: w, chip: st.chip ?? (wex ? chipOf(wex) : null) };
}

/** Same `s` on the full lab page, in a new tab */
const appLink = (s: string | null) => new URL(s ? `./app?s=${encodeURIComponent(s)}` : './', location.href).href;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Bottom-right "Open in TryBoard" (new window; the host's sandbox must allow popups) */
export function openLink(s: string | null): HTMLAnchorElement {
  const a = el('a', 'tb-embed-open', t('Open in TryBoard'));
  a.id = 'embedOpen';
  a.href = appLink(s);
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

const root = document.getElementById('embed')!;
const s = new URLSearchParams(location.search).get('s');

function fail(msg: string) {
  const box = el('div', 'tb-embed-poster');
  box.append(el('p', 'tb-embed-error', msg), openLink(null));
  root.replaceChildren(box);
  document.body.dataset.state = 'error';
}

async function poster() {
  if (!s) return fail(t('This embed has no shared bench in its link'));
  let st: ShareState;
  try {
    st = await decodeState(s);
  } catch (e) {
    const newer = e instanceof ShareDecodeError && e.reason === 'newer';
    return fail(newer ? t('This share link was made by a newer TryBoard; reload the page to get the latest version') : t('This share link is damaged and cannot be opened'));
  }
  const { work, chip } = await embedWork(st);
  const title = work.id === 'blank' && !work.example ? t('Shared bench') : work.title;
  document.title = t('{title} · TryBoard', { title });
  const box = el('div', 'tb-embed-poster');
  const play = el('button', 'tb-embed-play');
  play.id = 'embedPlay';
  play.type = 'button';
  play.setAttribute('aria-label', t('Run'));
  play.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  const hint = el('p', 'tb-embed-hint', t('Click to load the simulator (about 2 MB) and run the firmware'));
  box.append(el('div', 'tb-embed-brand', 'TryBoard'), el('h1', 'tb-embed-title', title), ...(chip ? [el('div', 'tb-embed-chip', CHIP_LABEL[chip] ?? chip)] : []), play, hint);
  root.replaceChildren(box, openLink(s));
  document.body.dataset.state = 'poster';
  play.addEventListener(
    'click',
    async () => {
      play.disabled = true;
      hint.textContent = t('Loading the simulator…');
      document.body.dataset.state = 'loading';
      try {
        const m = await import('./run');
        await m.runEmbed(root, { state: st, s: s!, work, title, openLink: () => openLink(s) });
      } catch (e) {
        fail(t('Could not start the simulator: {err}', { err: String(e) }));
      }
    },
    { once: true },
  );
}

void poster();
