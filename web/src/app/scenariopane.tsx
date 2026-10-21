// Dock "Script" tab (F-11, docs/plan-F/F-11-timeline.md §3): one lane per track, keyframes dragged on simulated time.
// The pane only edits scenFeed.sc; session.ts compiles it and the worker applies it, so the input log stays the single truth.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { t } from '../i18n';
import { toScriptBody } from '../inputlog';
import { actions } from './chrome';
import { download } from './capture';
import { presetName } from './netcond';
import { useStore } from './react';
import { scenFeed, setScenario } from './scenariofeed';
import {
  applyPreset,
  compileScenario,
  NET_FAULTS,
  NET_PRESETS,
  newTrack,
  parseScenario,
  PRESETS,
  quantize,
  SCENARIO_DEFAULT_MS,
  SCENARIO_MAX_MS,
  scenarioHeader,
  trackKey,
  valueAt,
  type ContKind,
  type Interp,
  type PresetId,
  type ScenarioTrack,
  type ScenarioV1,
  type TrackKind,
} from './scenario';

const SNAP_MS = 100;
const COLORS: Record<TrackKind, string> = { temp: '#e8590c', hum: '#1c7ed6', press: '#7048e8', lux: '#f2b705', dist: '#0ca678', mv: '#c2255c', pir: '#5f3dc4', btn: '#495057', net: '#1098ad' };
const UNIT: Partial<Record<TrackKind, string>> = { temp: '℃', hum: '%', press: 'Pa', lux: 'lx', dist: 'cm', mv: 'mV' };
const ROOM = { temp: 23.5, humidity: 45, pressure: 101325 };
const isCont = (tr: ScenarioTrack): tr is Extract<ScenarioTrack, { kf: unknown }> => 'kf' in tr;
const ctl = (phone?: boolean) => cn('h-7 cursor-pointer rounded-md border border-line bg-surface px-1.5 text-xs text-fg disabled:cursor-not-allowed disabled:text-muted', phone && 'h-11 rounded-xl px-2.5 text-sm');

function kindName(k: TrackKind): string {
  switch (k) {
    case 'temp':
      return t('Temperature');
    case 'hum':
      return t('Humidity');
    case 'press':
      return t('Pressure');
    case 'lux':
      return t('Light level');
    case 'dist':
      return t('Distance');
    case 'mv':
      return t('Potentiometer');
    case 'pir':
      return t('Motion');
    case 'btn':
      return t('Button');
    default:
      return t('Network');
  }
}
const trackName = (tr: { k: TrackKind; pin?: number }) => (tr.pin !== undefined ? `${kindName(tr.k)} IO${tr.pin}` : kindName(tr.k));

function presetLabel(id: PresetId): string {
  switch (id) {
    case 'ac':
      return t('Air conditioner on');
    case 'warm':
      return t('Warming up');
    case 'sunset':
      return t('Sunset to sunrise');
    case 'walk':
      return t('Someone walks by');
    case 'flaky':
      return t('Flaky network');
    case 'silent':
      return t('Network silent 5 s');
    case 'short':
      return t('Short press');
    case 'long':
      return t('Long press');
    default:
      return t('Double click');
  }
}

function interpName(i: Interp): string {
  if (i === 's') return t('Hold until next');
  if (i === 'e') return t('Smooth ramp');
  return t('Linear ramp');
}

function faultName(f: string): string {
  if (f === 'reboot') return t('Router reboot (down 8 s)');
  if (f === 'dns') return t('DNS failure');
  return t('Server not responding');
}

/** One editable item on a lane: a keyframe, a PIR span, a press, a network step or fault */
interface Item {
  t: number;
  /** Lane x end for spans and presses */
  end?: number;
  v?: number;
  label?: string;
}
function itemsOf(tr: ScenarioTrack): Item[] {
  if (isCont(tr)) return tr.kf.map(([at, v]) => ({ t: at, v }));
  if (tr.k === 'pir') return tr.spans.map(([a, b]) => ({ t: a, end: b }));
  if (tr.k === 'btn') return tr.presses.map(([a, h]) => ({ t: a, end: a + h }));
  return [...tr.steps.map(([a, p]) => ({ t: a, label: presetName(p) })), ...tr.faults.map(([a, f]) => ({ t: a, label: faultName(f) }))];
}

/** Move item i of a track to time `at` (and value v for keyframes); returns a new track */
function moveItem(tr: ScenarioTrack, i: number, at: number, v?: number): ScenarioTrack {
  if (isCont(tr)) {
    const kf = tr.kf.map((f, j) => (j === i ? ([at, v === undefined ? f[1] : quantize(tr.k as ContKind | 'mv', v), ...(f[2] ? [f[2]] : [])] as typeof f) : f));
    return { ...tr, kf: kf.sort((a, b) => a[0] - b[0]) } as ScenarioTrack;
  }
  if (tr.k === 'pir') return { ...tr, spans: tr.spans.map((s, j) => (j === i ? ([at, at + (s[1] - s[0])] as [number, number]) : s)) };
  if (tr.k === 'btn') return { ...tr, presses: tr.presses.map((p, j) => (j === i ? ([at, p[1]] as [number, number]) : p)) };
  const n = tr.steps.length;
  if (i < n) return { ...tr, steps: tr.steps.map((s, j) => (j === i ? ([at, s[1]] as [number, string]) : s)) };
  return { ...tr, faults: tr.faults.map((f, j) => (j === i - n ? ([at, ...f.slice(1)] as typeof f) : f)) };
}

function deleteItem(tr: ScenarioTrack, i: number): ScenarioTrack {
  if (isCont(tr)) return tr.kf.length > 1 ? ({ ...tr, kf: tr.kf.filter((_, j) => j !== i) } as ScenarioTrack) : tr;
  if (tr.k === 'pir') return { ...tr, spans: tr.spans.filter((_, j) => j !== i) };
  if (tr.k === 'btn') return { ...tr, presses: tr.presses.filter((_, j) => j !== i) };
  const n = tr.steps.length;
  return i < n ? { ...tr, steps: tr.steps.filter((_, j) => j !== i) } : { ...tr, faults: tr.faults.filter((_, j) => j !== i - n) };
}

/** Add an item at `at`: keyframe with the lane's current value, a 1 s PIR span, a short press, a flaky-network step */
function addItem(tr: ScenarioTrack, at: number): ScenarioTrack {
  if (isCont(tr)) {
    // The new keyframe takes the split segment's interpolation so the ramp keeps its style
    const prev = [...tr.kf].reverse().find((f) => f[0] < at);
    const v = quantize(tr.k as ContKind | 'mv', valueAt(tr.kf, at));
    const kf = (prev?.[2] ? [at, v, prev[2]] : [at, v]) as (typeof tr.kf)[number];
    return { ...tr, kf: [...tr.kf.filter((f) => f[0] !== at), kf].sort((a, b) => a[0] - b[0]) } as ScenarioTrack;
  }
  if (tr.k === 'pir') return { ...tr, spans: [...tr.spans, [at, at + 1000] as [number, number]].sort((a, b) => a[0] - b[0]) };
  if (tr.k === 'btn') return { ...tr, presses: [...tr.presses, [at, 150] as [number, number]].sort((a, b) => a[0] - b[0]) };
  return { ...tr, steps: [...tr.steps, [at, 'flaky'] as [number, string]].sort((a, b) => a[0] - b[0]) };
}

const snap = (ms: number, len: number) => Math.max(0, Math.min(len, Math.round(ms / SNAP_MS) * SNAP_MS));
const sec = (ms: number) => (ms / 1000).toFixed(1);

function range(tr: ScenarioTrack): [number, number] {
  if (!isCont(tr)) return [0, 1];
  const vs = tr.kf.map((f) => f[1]);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  const pad = Math.max((hi - lo) * 0.15, tr.k === 'temp' ? 1 : tr.k === 'press' ? 200 : 5);
  lo -= pad;
  hi += pad;
  return [lo, hi];
}

interface Sel {
  ti: number;
  i: number;
}

function Lane({ tr, ti, sc, now, h, sel, onSel, edit }: { tr: ScenarioTrack; ti: number; sc: ScenarioV1; now: number; h: number; sel: Sel | null; onSel: (s: Sel | null) => void; edit: (tr: ScenarioTrack, at: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(80, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const drag = useRef<{ i: number; rng: [number, number] } | null>(null);
  const [lo, hi] = drag.current?.rng ?? range(tr);
  const x = (ms: number) => (ms / sc.len) * w;
  const y = (v: number) => h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 12);
  const msAt = (e: { clientX: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return snap(((e.clientX - r.left) / r.width) * sc.len, sc.len);
  };
  const vAt = (e: { clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return lo + ((h - 6 - (e.clientY - r.top)) / (h - 12)) * (hi - lo);
  };
  const items = itemsOf(tr);
  const color = COLORS[tr.k];
  const down = (i: number) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { i, rng: [lo, hi] };
    onSel({ ti, i });
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const at = msAt(e);
    const next = moveItem(tr, d.i, at, isCont(tr) ? vAt(e) : undefined);
    // Sorting may move the dragged keyframe: keep following it by its new time
    if (isCont(next)) d.i = next.kf.findIndex((f) => f[0] === at);
    onSel({ ti, i: d.i });
    edit(next, Math.min(at, items[d.i]?.t ?? at));
  };
  const up = () => {
    drag.current = null;
  };
  let path = '';
  if (isCont(tr) && tr.kf.length) {
    const n = Math.max(2, Math.min(240, Math.round(w / 4)));
    for (let j = 0; j <= n; j++) {
      const ms = (j / n) * sc.len;
      path += `${j ? 'L' : 'M'}${x(ms).toFixed(1)},${y(valueAt(tr.kf, ms)).toFixed(1)}`;
    }
  }
  return (
    <div
      ref={ref}
      data-lane={trackKey(tr)}
      className="relative min-w-0 flex-1 touch-none select-none"
      style={{ height: h }}
      onDoubleClick={(e) => {
        const at = msAt(e);
        edit(addItem(tr, at), at);
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).tagName === 'svg') onSel(null);
      }}
    >
      <svg width={w} height={h} className="block" aria-hidden="true">
        <rect x={0} y={0} width={x(Math.min(now, sc.len))} height={h} fill="var(--color-field)" />
        {path && <path d={path} fill="none" stroke={color} strokeWidth={2} opacity={tr.on === false ? 0.35 : 1} />}
        {!isCont(tr) &&
          items.map((it, i) =>
            it.end !== undefined ? (
              <rect key={i} x={x(it.t)} y={h * 0.3} width={Math.max(3, x(it.end) - x(it.t))} height={h * 0.4} rx={3} fill={color} opacity={tr.on === false ? 0.35 : 0.8} />
            ) : (
              <text key={i} x={x(it.t) + 6} y={h / 2 + 4} fontSize={11} fill="var(--color-fg)">
                {it.label}
              </text>
            ),
          )}
        <line x1={x(now)} x2={x(now)} y1={0} y2={h} stroke="var(--color-accent)" strokeWidth={1.5} />
      </svg>
      {items.map((it, i) => {
        const on = sel?.ti === ti && sel.i === i;
        const cy = it.v !== undefined ? y(it.v) : h / 2;
        return (
          <button
            key={i}
            type="button"
            data-kf={i}
            aria-label={`${trackName(tr as { k: TrackKind; pin?: number })} ${sec(it.t)} s`}
            onPointerDown={down(i)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onClick={() => onSel({ ti, i })}
            className={cn("absolute flex -translate-x-1/2", h > 100 ? "size-11" : "size-6", " -translate-y-1/2 cursor-grab items-center justify-center rounded-full")}
            style={{ left: x(it.t), top: cy }}
          >
            <span className={cn('block size-3 rotate-45 border-2 border-surface', on && 'ring-2 ring-accent')} style={{ background: color }} />
          </button>
        );
      })}
    </div>
  );
}

function current(tr: ScenarioTrack, now: number, shown: { pir?: boolean; net?: string }): string {
  if (isCont(tr)) {
    const v = quantize(tr.k as ContKind | 'mv', valueAt(tr.kf, now));
    return `${v} ${UNIT[tr.k] ?? ''}`.trim();
  }
  if (tr.k === 'pir') return tr.spans.some(([a, b]) => now >= a && now < b) || shown.pir ? t('Motion') : '—';
  if (tr.k === 'btn') return tr.presses.some(([a, hd]) => now >= a && now < a + hd) ? t('Pressed') : '—';
  const st = [...tr.steps].reverse().find(([a]) => a <= now);
  return presetName(st?.[1] ?? 'normal');
}

/** Editor row for the selected item: time, value / hold / preset, interpolation, delete */
function SelRow({ tr, i, phone, sc, set }: { tr: ScenarioTrack; i: number; phone?: boolean; sc: ScenarioV1; set: (tr: ScenarioTrack, at: number) => void }) {
  const it = itemsOf(tr)[i];
  if (!it) return null;
  const num = (v: number, on: (n: number) => void, step: number, label: string, id: string) => (
    <label className="inline-flex items-center gap-1 text-muted">
      {label}
      <input id={id} type="number" step={step} defaultValue={v} key={`${id}${v}`} onBlur={(e) => Number.isFinite(e.currentTarget.valueAsNumber) && on(e.currentTarget.valueAsNumber)} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} className={cn(ctl(phone), 'w-20 cursor-text font-mono')} />
    </label>
  );
  const n = tr.k === 'net' ? tr.steps.length : 0;
  return (
    <div id="scenSel" className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-1.5 text-xs">
      {num(it.t / 1000, (s) => set(moveItem(tr, i, snap(s * 1000, sc.len)), Math.min(it.t, s * 1000)), 0.1, t('Time (s)'), 'scenSelT')}
      {isCont(tr) && num(tr.kf[i][1], (v) => set(moveItem(tr, i, it.t, v), it.t), QUANTSTEP[tr.k], UNIT[tr.k] ?? '', 'scenSelV')}
      {isCont(tr) && (
        <select aria-label={t('Interpolation')} value={tr.kf[i][2] ?? 'l'} onChange={(e) => set({ ...tr, kf: tr.kf.map((f, j) => (j === i ? (e.currentTarget.value === 'l' ? [f[0], f[1]] : [f[0], f[1], e.currentTarget.value as Interp]) : f)) } as ScenarioTrack, it.t)} className={ctl(phone)}>
          {(['s', 'l', 'e'] as Interp[]).map((k) => (
            <option key={k} value={k}>
              {interpName(k)}
            </option>
          ))}
        </select>
      )}
      {tr.k === 'pir' && num((tr.spans[i][1] - tr.spans[i][0]) / 1000, (s) => set({ ...tr, spans: tr.spans.map((p, j) => (j === i ? ([p[0], p[0] + Math.max(100, Math.round(s * 1000))] as [number, number]) : p)) }, it.t), 0.1, t('Duration (s)'), 'scenSelD')}
      {tr.k === 'btn' && num(tr.presses[i][1], (ms) => set({ ...tr, presses: tr.presses.map((p, j) => (j === i ? ([p[0], Math.max(20, Math.round(ms))] as [number, number]) : p)) }, it.t), 10, t('Hold (ms)'), 'scenSelH')}
      {tr.k === 'net' && i < n && (
        <select aria-label={t('Network')} value={tr.steps[i][1]} onChange={(e) => set({ ...tr, steps: tr.steps.map((s, j) => (j === i ? ([s[0], e.currentTarget.value] as [number, string]) : s)) }, it.t)} className={ctl(phone)}>
          {NET_PRESETS.map((p) => (
            <option key={p} value={p}>
              {presetName(p)}
            </option>
          ))}
        </select>
      )}
      {tr.k === 'net' && i >= n && (
        <select aria-label={t('Network')} value={tr.faults[i - n][1]} onChange={(e) => set({ ...tr, faults: tr.faults.map((f, j) => (j === i - n ? ([f[0], e.currentTarget.value, ...(f[2] !== undefined ? [f[2]] : [])] as typeof f) : f)) }, it.t)} className={ctl(phone)}>
          {NET_FAULTS.map((f) => (
            <option key={f} value={f}>
              {faultName(f)}
            </option>
          ))}
        </select>
      )}
      <button type="button" id="scenSelDel" onClick={() => set(deleteItem(tr, i), it.t)} className={cn(ctl(phone), 'text-bad-ink')}>
        {t('Delete keyframe')}
      </button>
    </div>
  );
}
const QUANTSTEP: Record<string, number> = { temp: 0.1, hum: 1, press: 1, lux: 1, dist: 1, mv: 1 };

export function ScenarioPane({ phone }: { phone?: boolean }) {
  const f = useStore(scenFeed);
  const sc: ScenarioV1 = f.sc ?? { len: SCENARIO_DEFAULT_MS, tracks: [] };
  const [sel, setSel] = useState<Sel | null>(null);
  const [cur, setCur] = useState(0);
  const [msg, setMsg] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const offeredKeys = new Set(f.offered.map(trackKey));
  const now = f.now;
  // Rounded up so a preset or keyframe added "now" lands ahead of the playhead (now lags up to 50 ms) and still plays this run
  const playAt = Math.min(sc.len, Math.ceil((now + 50) / SNAP_MS) * SNAP_MS);
  // An edit before the playhead cannot change the past: it waits for a restart
  const put = (next: ScenarioV1, at: number) => setScenario(next, { stale: f.stale || at < now });
  const editTrack = (ti: number) => (tr: ScenarioTrack, at: number) => put({ ...sc, tracks: sc.tracks.map((x, j) => (j === ti ? tr : x)) }, at);
  const present = new Set(sc.tracks.map(trackKey));
  const addable: { k: TrackKind; pin?: number; ok: boolean }[] = [];
  for (const k of ['temp', 'hum', 'press', 'lux', 'dist', 'pir', 'net'] as TrackKind[]) addable.push({ k, ok: offeredKeys.has(k) });
  for (const o of f.offered) if (o.k === 'mv' || o.k === 'btn') addable.push({ ...o, ok: true });
  const exportAll = () => {
    // Same bench filter as session.ts scenBench (network always offered there)
    const evs = compileScenario(sc, f.room ?? ROOM, { has: new Set([...offeredKeys, 'net']) });
    download(new Blob([scenarioHeader(sc.len) + toScriptBody(evs)], { type: 'text/plain' }), 'scenario-inputs.txt');
  };
  const onExport = (v: string) => {
    if (v === 'file') exportAll();
    else if (v === 'copy') void navigator.clipboard?.writeText(JSON.stringify(sc)).then(() => setMsg(t('Copied')), () => setMsg(''));
    else if (v === 'import') file.current?.click();
  };
  const ti = phone ? Math.min(cur, sc.tracks.length - 1) : -1;
  const row = (tr: ScenarioTrack, i: number, h: number, head: ReactNode) => (
    <div key={trackKey(tr)} data-track={trackKey(tr)} className={cn("flex items-stretch border-b border-line-soft", phone && "flex-col")}>
      {head}
      <Lane tr={tr} ti={i} sc={sc} now={now} h={h} sel={sel} onSel={setSel} edit={editTrack(i)} />
    </div>
  );
  const missing = (tr: ScenarioTrack) => !offeredKeys.has(trackKey(tr));
  const head = (tr: ScenarioTrack, i: number) => (
    <div className={cn("flex w-40 flex-none flex-col justify-center gap-0.5 border-r border-line-soft px-2 py-1 text-xs", phone && "w-full border-r-0 text-sm")}>
      <div className="flex items-center gap-1.5">
        <span className="size-2 flex-none rounded-full" style={{ background: COLORS[tr.k] }} />
        <span className="min-w-0 flex-1 truncate font-semibold" title={missing(tr) ? t('Part removed: this track will not be exported') : undefined}>
          {trackName(tr as { k: TrackKind; pin?: number })}
        </span>
        <input type="checkbox" aria-label={t('Enabled')} checked={tr.on !== false} onChange={(e) => editTrack(i)((e.currentTarget.checked ? (({ on: _on, ...r }) => r)(tr) : { ...tr, on: false }) as ScenarioTrack, 0)} className={cn("cursor-pointer", phone && "m-3 size-5")} />
        <button type="button" aria-label={t('Delete track')} title={t('Delete track')} onClick={() => (setSel(null), put({ ...sc, tracks: sc.tracks.filter((_, j) => j !== i) }, 0))} className={cn("cursor-pointer px-0.5 text-muted hover:text-bad-ink", phone && "size-11 text-lg")}>
          ×
        </button>
      </div>
      <span className={cn('font-mono', missing(tr) ? 'text-warn-ink' : 'text-muted')}>{missing(tr) ? t('Part removed: this track will not be exported') : current(tr, now, f.shown)}</span>
    </div>
  );
  const selTr = sel ? sc.tracks[sel.ti] : null;
  return (
    <div id="scenPane" className="flex min-h-0 flex-1 flex-col text-xs">
      <div className={cn('flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-1.5', phone && 'gap-1.5 px-2')}>
        <select
          id="scenPreset"
          aria-label={t('Presets')}
          value=""
          onChange={(e) => {
            const id = e.currentTarget.value as PresetId;
            if (id) put(applyPreset(sc, id, playAt, f.offered), playAt);
          }}
          className={ctl(phone)}
        >
          <option value="">{t('Presets')}</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.needs.some((k) => f.offered.some((o) => o.k === k))}>
              {presetLabel(p.id)}
            </option>
          ))}
        </select>
        <select
          id="scenAdd"
          aria-label={t('Add track')}
          value=""
          onChange={(e) => {
            const a = addable[Number(e.currentTarget.value)];
            if (!a) return;
            const v0 = a.k === 'temp' ? 24 : a.k === 'hum' ? 45 : a.k === 'press' ? 101325 : a.k === 'lux' ? 300 : a.k === 'dist' ? 100 : 1650;
            put({ ...sc, tracks: [...sc.tracks, newTrack(a.k, a.pin, v0)] }, sc.len);
            setCur(sc.tracks.length);
          }}
          className={ctl(phone)}
        >
          <option value="">{t('Add track')}</option>
          {addable.map((a, i) => (
            <option key={i} value={i} disabled={!a.ok || present.has(trackKey(a))} title={a.ok ? undefined : t('No {part} on the bench', { part: kindName(a.k) })}>
              {a.ok ? trackName(a) : `${trackName(a)} — ${t('No {part} on the bench', { part: kindName(a.k) })}`}
            </option>
          ))}
        </select>
        <select id="scenExport" aria-label={t('Export')} value="" onChange={(e) => onExport(e.currentTarget.value)} className={ctl(phone)}>
          <option value="">{t('Export')}</option>
          <option value="file" disabled={!sc.tracks.length}>
            {t('Export whole scenario')}
          </option>
          <option value="copy" disabled={!sc.tracks.length}>
            {t('Copy scenario JSON')}
          </option>
          <option value="import">{t('Import scenario JSON…')}</option>
        </select>
        <input
          ref={file}
          type="file"
          accept=".json,application/json,text/plain"
          hidden
          onChange={async (e) => {
            const fl = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (!fl) return;
            try {
              setSel(null);
              put(parseScenario(JSON.parse(await fl.text())), 0);
              setMsg('');
            } catch (err) {
              setMsg(String(err));
            }
          }}
        />
        <label className="inline-flex items-center gap-1 text-muted">
          {t('Length (s)')}
          <input
            id="scenLen"
            type="number"
            min={1}
            max={SCENARIO_MAX_MS / 1000}
            defaultValue={sc.len / 1000}
            key={sc.len}
            onBlur={(e) => {
              const s = e.currentTarget.valueAsNumber;
              if (Number.isFinite(s)) put({ ...sc, len: Math.max(1000, Math.min(SCENARIO_MAX_MS, Math.round(s) * 1000)) }, sc.len);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            className={cn(ctl(phone), 'w-16 cursor-text font-mono')}
          />
        </label>
        <span id="scenLines" className="text-muted">
          {t('{n} lines in this scenario', { n: f.lines })}
        </span>
        {msg && <span className="text-muted">{msg}</span>}
      </div>
      {f.stale && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-warn-bg px-3 py-1.5 text-warn-ink">
          <span className="flex-1">{t('Changes take effect after a restart')}</span>
          <button type="button" id="scenRestart" onClick={() => actions.reboot?.()} className={ctl(phone)}>
            {t('Restart')}
          </button>
        </div>
      )}
      {!sc.tracks.length ? (
        <p className="m-0 p-3 text-muted">{t('No tracks yet: pick a preset or add a track, then run the firmware; values change at simulated time and land in the input log.')}</p>
      ) : phone ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div role="tablist" className="flex gap-1.5 overflow-x-auto px-2 py-1.5">
            {sc.tracks.map((tr, i) => (
              <button key={trackKey(tr)} type="button" role="tab" aria-selected={i === ti} onClick={() => (setCur(i), setSel(null))} className={cn('flex h-11 flex-none cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm', i === ti ? 'border-accent-line bg-accent-bg text-accent-ink' : 'border-line bg-surface text-fg')}>
                <span className="size-2 rounded-full" style={{ background: COLORS[tr.k] }} />
                {trackName(tr as { k: TrackKind; pin?: number })}
              </button>
            ))}
          </div>
          {sc.tracks[ti] && row(sc.tracks[ti], ti, 160, head(sc.tracks[ti], ti))}
          <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
            <button type="button" id="scenAddKf" onClick={() => sc.tracks[ti] && editTrack(ti)(addItem(sc.tracks[ti], playAt), playAt)} className={ctl(true)}>
              {t('Add keyframe at {t} s', { t: sec(playAt) })}
            </button>
          </div>
          {selTr && sel!.ti === ti && <SelRow tr={selTr} i={sel!.i} phone sc={sc} set={editTrack(sel!.ti)} />}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {sc.tracks.map((tr, i) => row(tr, i, 44, head(tr, i)))}
          {selTr && <SelRow tr={selTr} i={sel!.i} sc={sc} set={editTrack(sel!.ti)} />}
          <p className="m-0 px-3 py-1 text-muted">{t('Double-click a lane to add a keyframe; drag to move it (snaps to {ms} ms)', { ms: SNAP_MS })}</p>
        </div>
      )}
    </div>
  );
}
