// Step 3 Assemble: 3D view (app/asm3d.ts, P1-07) or the views/assembly.ts SVG fallback without WebGL / with ?asm=svg; both share asmcore rules and templates.
// Undo keeps no snapshots: clear and replay the first i timeline steps (deterministic); the power-on retest runs the same firmware with the assembled offsets in env.
import { isPhone } from '../mobile';
import { createAssembly } from '../../views/assembly';
import { CHIP_HEAT_OFFSET, SONAR_BLOCK_CM, TEMPLATES, effectScript, type Template } from '../../views/templates';
import { bootOptions, type Level } from '../../checks';
import { VerifyStalled, verifyLevel } from '../../verify';
import { fetchBuf } from '../../assets';
import { ownFirmware, passedCount, requestAllRef } from './bench';
import type { AssemblyState, StepCtx, StepImpl } from '../types';
import type { TimelineStep } from '../timeline';
import type { Assembly3D } from '../asm3d';
import { caseFor, layoutFor, layoutKey } from '../casemesh';
import type { CaseLayout } from '../enclosure';
import { OBSTACLE_LABEL, antennaLossDb, i2cLoad, i2cSay, i2cText, loadCaseHarness, saveCaseHarness, wifiSay, wifiText, type CaseHarness, type Obstacle } from '../harness';
import { noteSaved } from '../saved';
import { t } from '../../i18n';

type SvgAsm = ReturnType<typeof createAssembly>;
type AsmView = SvgAsm | Assembly3D;
const is3d = (a: AsmView): a is Assembly3D => (a as Assembly3D).kind === '3d';
/** Only templates with a parametric enclosure layout (enclosure.ts) get 3D; the P2-09 projects stay flat for now */
const HAS_3D = new Set(['weather', 'spin', 'lens']);
/** 3D assembly needs WebGL2; ?asm=svg forces the flat view (tests / fallback) */
function want3d() {
  if (new URLSearchParams(location.search).get('asm') === 'svg') return false;
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

import { type ReactNode } from 'react';
import { cn } from '../../ui/cn';
import { Host, Txt } from '../../ui/native';
import { Btn, Btns, Kv, KvBox, KvT, LinkBtn, LockCard, Mono, Note, Ph, PhT, Res, Sec, Seg, SegB, Slider, TnL, TnM, TnSt, TreeEmpty, TreeGroup, btnClass, tnClass } from '../../ui/panel';
import { lab } from '../../ui/links';
import { Conf, type ConfLevel } from '../../ui/conf';
import { ResultCard, Said, actCls } from '../../ui/result';
import { groupRows, headline, type Verdict } from '../../ui/say';

// ConfLevel values are machine identifiers owned by ui/conf.tsx; <Conf> renders its own label.
const EST: ConfLevel = '估算'; // lint: allow-cjk
const REAL_HW: ConfLevel = '必须上真机'; // lint: allow-cjk
/** Device name of the assembly-warning row: it is not a device, so the "N devices changed" count skips it */
const ASM_DEV = t('Assembly');

type Entry = { kind: 'place'; id: string; spot?: string } | { kind: 'test'; ok: boolean; rows: { ok: boolean; text: string; say?: string; tag?: string; dev?: string }[]; fingerprint: string; who: string; temp: number; offset: number };

const KEY = (work: string) => `tryboard-app-asm:${work}`;
/** Locally saved assembly timeline (what went in, how, retest results; nothing beyond the per-row results) */
function loadEntries(work: string): Entry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(work)) ?? '[]');
    return Array.isArray(v) ? v.filter((e) => e && (e.kind === 'place' || e.kind === 'test')) : [];
  } catch {
    return [];
  }
}
function saveEntries(work: string, list: Entry[]) {
  try {
    localStorage.setItem(KEY(work), JSON.stringify(list));
    noteSaved();
  } catch {
    /* private mode: only lasts for this page */
  }
}
const lastIsTest = (list: Entry[]) => {
  const e = list[list.length - 1];
  return e?.kind === 'test' ? e.ok : null;
};

/** Whether this project's enclosure holds I2C modules (cable length only matters for them) */
export const I2C_DEVICES: Record<string, number> = { weather: 2 };

/** What the harness carries into the product (estimate): I2C cable length, antenna loss dB, and whether they break it */
export function harnessEffects(work: string, h: CaseHarness) {
  const n = I2C_DEVICES[work] ?? 0;
  const i2c = n ? i2cLoad(h.i2cCm, n) : null;
  const antennaDb = antennaLossDb(h.obstacle, h.distMm);
  const wifi = wifiText(antennaDb);
  return { i2c, antennaDb, wifi, ok: (!i2c || i2c.verdict === 'ok') && wifi.level !== 'fail' };
}

/** Computes the assembly result without DOM (Product step, restore after reload); must match createAssembly's clean / effects */
function summarize(T: Template, places: { id: string; spot?: string }[], retest: boolean | null, h: CaseHarness): AssemblyState {
  const placed = places.map((p) => p.id);
  const choice: Record<string, string> = {};
  for (const p of places) if (p.spot) choice[p.id] = p.spot;
  const total = T.parts.length;
  const hx = harnessEffects(T.id, h);
  const clean = placed.length === total && hx.ok && T.parts.every((p) => !p.spots || p.spots.find((s) => s.key === choice[p.id])?.ok);
  const effects = { ...T.effects({ placed, choice }), ...(hx.i2c ? { i2cWireCm: h.i2cCm } : {}), antennaDb: hx.antennaDb };
  return { placed, choice, total, clean, effects, retest };
}

/** Restore the saved assembly on page load (only what went in and how; retest results must be rerun) */
export function restoreAssembly(ctx: StepCtx) {
  const T = TEMPLATES[ctx.work.id];
  if (!T) return;
  const list = loadEntries(ctx.work.id);
  const places = list.filter((e): e is Extract<Entry, { kind: 'place' }> => e.kind === 'place');
  // Saved order must be the template's bottom-up order, otherwise treat it as not assembled
  const okOrder = places.every((p, i) => T.parts[i]?.id === p.id);
  if (places.length && okOrder) ctx.store.set({ assembly: summarize(T, places, lastIsTest(list), loadCaseHarness(ctx.work.id)) });
  else if (list.length) saveEntries(ctx.work.id, []);
}

/** Which checkpoint of this project includes assembly (weather 06, spin 07-spin, lens 07-lens) */
export function assemblyLevel(ctx: StepCtx): Level | undefined {
  return ctx.session.levels.find((l) => ctx.work.checkpoints.includes(l.id) && l.assembly);
}

export function unlocked(ctx: StepCtx) {
  const n = ctx.work.checkpoints.length;
  return n > 0 && passedCount(ctx) === n;
}

/** What the assembly choice changes (estimate), per template and part */
const IMPACT: Record<string, Record<string, string[]>> = {
  weather: {
    shell: [t('USB-C cutout faces back: the cable exits behind and does not block the dial')],
    board: [t('The dev board clip position decides where the chip sits: under full load it is the hottest spot in the enclosure')],
    bme: [
      t('By the vent: it reads room temperature, and the dial, lights and alarm all follow the real temperature'),
      t('Next to the dev board: right against the chip, reads about {d} ℃ high, alarms at 27.5 ℃ room temperature, and checkpoint 06 fails its temperature item', { d: CHIP_HEAT_OFFSET }),
    ],
    servo: [t('Align the servo shaft with the dial center, or the needle cannot reach both ends of the scale')],
    oled: [t('Cable is 8 cm; it needs ≥ 6 cm to reach the front panel')],
    front: [t('With the front panel closed the cavity uses 27 / 32 mm')],
  },
  spin: {
    servo: [t('Center first, then fit the horn: when the firmware says “front” it really faces front'), t('Pressed straight on: the horn may be one tooth off, front shifts by {deg}°', { deg: (360 / 25).toFixed(1) })],
  },
  usbkey: {
    board: [t('USB / OTG port faces the back cutout: the cable fits and the computer sees a keyboard'), t('Rotated 180°: the USB port hits the front wall, the cable does not fit, and the computer sees no device in the product')],
    plate: [t('Use a plastic plate: a metal plate covers the WROOM antenna and Wi-Fi drops by tens of dB (estimate); try it under “Harness and antenna” below')],
  },
  lens: {
    dome: [t('High notch, 8 mm off the screen: about 1.35× magnification, looks more 3D'), t('Low notch, against the screen: about 1.08× magnification, looks flat')],
  },
  lamp: {
    strip: [t('On the light guide: 15 mm from the shade, the light spreads into an even glow on the milky shade'), t('Against the shade wall: a row of 8 glaring hot spots on the shade')],
    knob: [t('The knob shaft must stick out ≥ 6 mm from the panel, or fingers cannot grip or press it')],
  },
  ruler: {
    sonar: [t('Probe through the front panel hole: it measures the object in front'), t('Recessed 6 mm behind the hole: echoes come back from the hole wall first, reads about {cm} cm, the buzzer keeps sounding, same in the retest (estimate)', { cm: SONAR_BLOCK_CM })],
    board: [t('The 1 kΩ / 2 kΩ divider resistors on the Echo line go in with the dev board; do not forget them when closing the enclosure')],
  },
  tilt: {
    imu: [t('Flat on the base, arrow forward: the bean rolls the way you tilt'), t('Rotated 180°: pitch and roll are both reversed, the bean climbs uphill, same in the retest')],
  },
};

export function assembleStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  let T: Template | null = null;
  /** Built once per page: switching steps and back keeps a half-done assembly */
  let node: HTMLElement | null = null;
  let asm: AsmView | null = null;
  /** Enclosure params the view was built from (rebuild on change, replaying the timeline) */
  let builtKey = '';
  let layout: CaseLayout | null = null;
  let section = false;
  let loading = false;
  let entries: Entry[] = [];
  let cur = -1;
  let replaying = false;
  let testing: { at: number; progress: number } | null = null;
  let ruler = false;
  let sel = '';
  /** Harness (P2-11): cable length, metal / battery near the antenna (estimate); kept outside the timeline, saved separately */
  let hz: CaseHarness = loadCaseHarness('weather');

  /** Mount the imperative assembly view into the step layer */
  const showNode = () => ctx?.shell.layer.render(<Host node={node} />);

  /** Hand the harness to the simulator (affects the firmware running on the bench now, plus retest and Product) */
  function applyHarness() {
    const c = ctx!;
    const hx = harnessEffects(c.work.id, hz);
    const want = { i2cWire: hx.i2c ? hz.i2cCm : -1, antenna: hx.antennaDb };
    const cur = c.session.harness;
    const h: { i2cWire?: number; antenna?: number } = {};
    if ((cur.i2cWire ?? -1) !== want.i2cWire) h.i2cWire = want.i2cWire;
    if ((cur.antenna ?? 0) !== want.antenna) h.antenna = want.antenna;
    if (Object.keys(h).length) c.session.setHarness(h);
  }

  const simLine = (s: string) => s.replace(/\[tryboard\] (.*)/g, (_, line: string) => t('Simulator: {line}', { line }));

  function harnessPanel() {
    const c = ctx!;
    const el = c.shell.props.el;
    const hx = harnessEffects(c.work.id, hz);
    const lv = (v: string) => (v === 'ok' ? (['ok', '✓'] as const) : v === 'marginal' ? (['warn', '!'] as const) : (['bad', '✗'] as const));
    const commit = (next: Partial<CaseHarness>) => {
      hz = { ...hz, ...next };
      saveCaseHarness(c.work.id, hz);
      applyHarness();
      publish();
      renderAll();
    };
    const i2c = hx.i2c ? (
      <>
        <KvBox>
          <span className="k">{t('Total I2C cable length (dev board to OLED, BME280)')}</span>
          <Slider
            id="hzWire"
            outId="hzWireV"
            min={8}
            max={150}
            step={1}
            defaultValue={hz.i2cCm}
            aria-label={t('Total I2C cable length')}
            out={`${hz.i2cCm} cm`}
            on={{
              input: (e) => {
                const v = e.currentTarget.value;
                el.querySelector('#hzWireV')!.textContent = `${v} cm`;
                const l = harnessEffects(c.work.id, { ...hz, i2cCm: Number(v) }).i2c!;
                const say = el.querySelector('#hzWireRes [data-say]');
                const raw = el.querySelector('#hzWireRes [data-raw]');
                if (say) say.textContent = i2cSay(l);
                if (raw) raw.textContent = i2cText(l);
              },
              change: (e) => commit({ i2cCm: Number(e.currentTarget.value) }),
            }}
          />
        </KvBox>
        <Res id="hzWireRes" kind={lv(hx.i2c.verdict)[0]} mk={lv(hx.i2c.verdict)[1]}>
          <Said say={i2cSay(hx.i2c)} raw={i2cText(hx.i2c)} />
        </Res>
      </>
    ) : null;
    const sim = c.session.harnessText.trim();
    return (
      <>
        <Sec>
          {t('Harness and antenna')} · <Conf c={EST} size={11} /> · <Conf c={REAL_HW} size={11} />
        </Sec>
        {i2c}
        <KvBox>
          <span className="k">{t('What sits next to the WROOM antenna')}</span>
          <Seg aria-label={t('Next to the antenna')}>
            {(['none', 'battery', 'metal'] as Obstacle[]).map((o) => (
              <SegB key={o} data-obs={o} on={hz.obstacle === o} onClick={() => commit({ obstacle: o })}>
                {o === 'metal' ? t('Metal part') : OBSTACLE_LABEL[o]}
              </SegB>
            ))}
          </Seg>
        </KvBox>
        {hz.obstacle !== 'none' && (
          <KvBox>
            <span className="k">{t('Distance from the antenna area ({what})', { what: OBSTACLE_LABEL[hz.obstacle] })}</span>
            <Slider
              id="hzDist"
              outId="hzDistV"
              min={0}
              max={30}
              step={1}
              defaultValue={hz.distMm}
              aria-label={t('Distance from the antenna')}
              out={`${hz.distMm} mm`}
              on={{
                input: (e) => void (el.querySelector('#hzDistV')!.textContent = `${e.currentTarget.value} mm`),
                change: (e) => commit({ distMm: Number(e.currentTarget.value) }),
              }}
            />
          </KvBox>
        )}
        <Res id="hzAntRes" kind={lv(hx.wifi.level)[0]} mk={lv(hx.wifi.level)[1]}>
          <Said say={wifiSay(hx.antennaDb)} raw={t('Antenna loss {db} dB, {wifi}', { db: hx.antennaDb, wifi: hx.wifi.text })} />
        </Res>
        <Note>
          {t(
            'Fixed-formula estimate: bus capacitance = length × 1 pF/cm + 10 pF per device + 10 pF, rise time = 0.8473 × pull-up × capacitance; antenna: metal right against it loses 45 dB, a battery 30 dB, nothing beyond 20 mm. The simulator uses the same formula, so readings really go wrong and Wi-Fi really fails to connect.',
          )}
        </Note>
        {sim && <Txt as="p" className="note my-2 font-mono text-xs text-muted" data-k="hzSim" text={simLine(sim)} />}
      </>
    );
  }

  const placesUpTo = (i: number) => entries.slice(0, i + 1).filter((e): e is Extract<Entry, { kind: 'place' }> => e.kind === 'place');
  const lastTest = () => (cur >= 0 && entries[cur]?.kind === 'test' ? (entries[cur] as Extract<Entry, { kind: 'test' }>) : null);

  /** Culprit of a failed retest: first part in assembly order on a bad spot; at = the step before it (reinstall rewinds there) */
  function culprit() {
    for (let i = 0; i <= cur; i++) {
      const e = entries[i];
      if (e?.kind !== 'place') continue;
      const p = T!.parts.find((x) => x.id === e.id);
      const sp = p?.spots?.find((x) => x.key === e.spot);
      if (p && sp && !sp.ok) return { part: p, spot: sp, good: p.spots!.find((x) => x.ok), at: i - 1 };
    }
    return null;
  }

  function publish() {
    const c = ctx!;
    const places = placesUpTo(cur);
    const t = lastTest();
    c.store.set({ assembly: places.length ? summarize(T!, places, t ? t.ok : null, hz) : null });
    saveEntries(c.work.id, entries.slice(0, cur + 1));
  }

  /** Go back to step i: clear and replay the first i steps (deterministic) */
  function seek(i: number) {
    if (!asm || testing) return;
    cur = i;
    replaying = true;
    asm.reset();
    for (const p of placesUpTo(i)) asm.place(p.id, p.spot);
    replaying = false;
    const next = T!.parts[asm.state().placed.length];
    sel = next?.id ?? T!.parts[T!.parts.length - 1].id;
    publish();
    renderAll();
  }

  function push(e: Entry) {
    entries = entries.slice(0, cur + 1);
    entries.push(e);
    cur = entries.length - 1;
  }

  function onAsmStep() {
    if (replaying || !asm || !ctx) return;
    const s = asm.state();
    const have = placesUpTo(cur).length;
    if (s.placed.length > have) {
      const id = s.placed[s.placed.length - 1];
      push({ kind: 'place', id, spot: s.choice[id] });
      const next = T!.parts[s.placed.length];
      sel = next?.id ?? id;
      publish();
    } else if (s.placed.length < have) {
      // The engine's own "start over": timeline goes back to the beginning
      entries = [];
      cur = -1;
      publish();
    } else {
      const m = asm.message();
      if (m.bad) ctx.shell.toast(t('{title}: {text}', { title: m.title, text: m.text }));
    }
    renderAll();
  }

  const lvTitle = (id: string) => {
    const s = ctx!.session.levels.find((l) => l.id === id)?.title;
    return s ? t(s) : '';
  };

  // ------------------------------------------------------------ locked
  function renderLocked() {
    const c = ctx!;
    const s = c.store.get();
    const n = c.work.checkpoints.length;
    const d = passedCount(c);
    const left = c.work.checkpoints.filter((id) => !s.checks[id]?.ok);
    const first = left[0] ?? c.work.checkpoints[0];
    // Locked shows a single card (design unify/Steps): missing checkpoints at a glance, side panes and run group collapsed
    c.shell.setBare(true);
    c.shell.layer.render(
      <LockCard role="status">
        <Sec>{t('③ Assemble · locked')}</Sec>
        <PhT>{t('Pass all {n} checkpoints on the Bench before building the enclosure', { n })}</PhT>
        <ul id="lockList" className="my-3 grid list-none gap-1 p-0 text-[13px]">
          {c.work.checkpoints.map((id) => {
            const r = s.checks[id];
            const ok = !!r?.ok;
            return (
              <li key={id} data-cp={id} data-ok={ok ? '' : undefined} data-own={ok && r.own ? '' : undefined} className={ok ? 'text-ok-ink' : 'text-fg'}>
                <span className="inline-block w-5 font-mono">{ok ? (r.own ? '✓' : '◐') : '○'}</span>
                <Mono>{id}</Mono> {lvTitle(id)}
              </li>
            );
          })}
        </ul>
        <p className="my-3 text-xs text-muted">
          {t('Now {d}/{n}. ✓ means your own firmware passed, ◐ means the project’s reference firmware passed; both count.', { d, n })} {t('Verdicts match the command line:')} <Mono>npx tryboard check</Mono>
          {'. '}
          {t('No toolchain? Run the whole way with the bundled firmware first.')}
        </p>
        <Btns>
          <Btn primary id="lockAllRef" onClick={() => requestAllRef()}>
            {t('Run the whole way with the bundled firmware')}
          </Btn>
          <Btn
            id="toBench"
            onClick={() => {
              c.store.set({ selection: { kind: 'checkpoint', id: first } });
              location.hash = 'bench';
            }}
          >
            {t('Back to the Bench, start from {id} {title}', { id: first, title: lvTitle(first) })}
          </Btn>
        </Btns>
      </LockCard>,
    );
    c.shell.toolbar.setGroups([]);
    c.shell.timeline.setSteps([{ id: 'lock', icon: '·', label: t('Checkpoints {d}/{n}, locked', { d, n }) }]);
    c.shell.setVerdict(t('Assemble · locked'), 'idle');
    c.shell.onVerdict(() => (location.hash = 'bench'));
    c.shell.setNext(t('Product · pass the checkpoints before building the enclosure'), null, t('Unlock and finish assembling first'));
  }

  // ------------------------------------------------------------ build tree: assembly layers
  function layerStatus(i: number) {
    const s = asm!.state();
    const p = T!.parts[i];
    if (i < s.placed.length) {
      const sp = p.spots?.find((x) => x.key === s.choice[p.id]);
      return sp && !sp.ok ? 'warn' : 'done';
    }
    return i === s.placed.length ? 'next' : 'todo';
  }
  const STATUS = { done: ['✓', t('Installed'), 'ok'], warn: ['!', t('Has warnings'), 'warn'], next: ['→', t('Next part'), 'run'], todo: ['·', t('To install'), 'muted'] } as const;

  function pick(id: string) {
    sel = id;
    renderTree();
    renderProps();
  }

  function renderTree() {
    const c = ctx!;
    const s = asm!.state();
    const items = T!.parts
      .map((p, i) => {
        const st = STATUS[layerStatus(i)];
        return (
          <button key={p.id} type="button" className={tnClass(sel === p.id)} data-id={p.id} role="treeitem" aria-selected={sel === p.id} onClick={() => pick(p.id)}>
            <TnM>{i + 1}</TnM>
            <TnL>{t(p.name)}</TnL>
            <TnSt kind={st[2]}>{`${st[0]} ${st[1]}`}</TnSt>
          </button>
        );
      })
      .reverse();
    const tst = lastTest();
    const lv = assemblyLevel(c);
    c.shell.tree.render(
      <div role="group" aria-label={t('Assembly layers')}>
        <TreeGroup title={t('Assembly layers · bottom up')} count={`${s.placed.length}/${s.total}`} open>
          {items}
        </TreeGroup>
        <TreeGroup title={t('Retest')} count="" open>
          <button type="button" className={tnClass(sel === 'retest')} data-id="retest" role="treeitem" aria-selected={sel === 'retest'} onClick={() => pick('retest')}>
            <TnL>
              {t('Power-on retest')}
              {lv && (
                <>
                  {` · ${t('Checkpoint')} `}
                  <Mono>{lv.id}</Mono>
                </>
              )}
            </TnL>
            <TnSt kind={testing ? 'run' : tst ? (tst.ok ? 'ok' : 'bad') : 'muted'}>{testing ? '…' : tst ? (tst.ok ? '✓' : '✗') : '—'}</TnSt>
          </button>
        </TreeGroup>
      </div>,
    );
  }

  // ------------------------------------------------------------ properties panel
  function renderProps() {
    const c = ctx!;
    const s = asm!.state();
    const m = asm!.message();
    const head = (
      <>
        <Sec>{t('Current')}</Sec>
        <div className={cn('asm-msg', m.bad && 'bad')}>
          <b>{t(m.title)}</b>
          <span>{t(m.text)}</span>
        </div>
      </>
    );
    if (sel === 'retest') return renderRetest(head);
    const i = T!.parts.findIndex((p) => p.id === sel);
    const p = T!.parts[i];
    if (!p) {
      c.shell.props.render(head);
      return;
    }
    const st = layerStatus(i);
    const chosen = p.spots?.find((x) => x.key === s.choice[p.id]);
    const isNext = st === 'next';
    const choose =
      p.spots && isNext ? (
        <>
          <Sec>{t('How to install')}</Sec>
          <Btns col>
            {p.spots.map((x) => (
              <Btn key={x.key} className={x.ok ? '' : 'warnb'} data-spot={x.key} onClick={() => asm!.place(p.id, x.key)}>
                {t(x.label)}
              </Btn>
            ))}
          </Btns>
          <Note>{t('You can also drag the part card on the bench at left onto the glowing spot.')}</Note>
        </>
      ) : isNext ? (
        <Btns>
          <Btn primary data-place="1" onClick={() => asm!.place(p.id)}>
            {t('Install “{part}”', { part: t(p.short) })}
          </Btn>
        </Btns>
      ) : null;
    const impact = (IMPACT[T!.id]?.[p.id] ?? []).map((txt, k) => {
      const mark = p.spots ? (p.spots[k]?.key === chosen?.key ? '●' : '○') : '·';
      return (
        <Res key={k} kind={p.spots && p.spots[k] && !p.spots[k].ok ? 'bad' : 'na'} mk={mark}>
          {txt}
        </Res>
      );
    });
    const checks = T!.checks(s).map((r, k) => (
      <Res key={k} kind={r.ok === null ? 'na' : r.ok ? 'ok' : 'bad'} mk={r.ok === null ? '·' : r.ok ? '✓' : '!'}>
        {t('{label}: {text}', { label: t(r.label), text: t(r.text.replace(/^[✓!] /, '')) })}
      </Res>
    ));
    const okMsg = p.okMsg && (p.okMsg.length ? p.okMsg.map((x) => t(x)).reduce((a, b) => t('{a}, {b}', { a, b })) : '');
    c.shell.props.render(
      <>
        {head}
        <Sec>{t('Layer {i} of {n}', { i: i + 1, n: T!.parts.length })}</Sec>
        <Ph>{t(p.name)}</Ph>
        <Kv k={t('Status')} v={`${STATUS[st][0]} ${STATUS[st][1]}`} cls={st === 'warn' ? 'warnc' : ''} />
        {chosen && <KvT k={t('Placement')}>{chosen.ok ? t(chosen.label) : t('{label} · has warnings', { label: t(chosen.label) })}</KvT>}
        {!p.spots && okMsg && <KvT k={t('Notes')}>{okMsg}</KvT>}
        {choose}
        {impact.length > 0 && (
          <>
            <Sec>
              {t('What the placement changes')} · <Conf c={EST} size={11} />
            </Sec>
            {impact}
          </>
        )}
        <Sec>
          {t('Assembly check')} · <Conf c={EST} size={11} /> · {t('geometry, not calibrated on real hardware')}
        </Sec>
        {checks}
        {effectsLine()}
        {harnessPanel()}
        {caseLine()}
      </>,
    );
  }

  /** Parametric enclosure size and warnings (same layout as the Shop enclosure details) */
  function caseLine() {
    if (!layout) return null;
    const L = layout;
    const enc = `enclosure-${T!.id}`;
    return (
      <>
        <Sec>
          {t('Enclosure · parametric')} · <Conf c={EST} size={11} />
        </Sec>
        <Kv k={L.shape === 'rect' ? t('Outline') : t('Base')} v={L.shape === 'rect' ? `${L.outer[0]} × ${L.outer[1]} × ${L.outer[2]} mm` : `Ø${L.outer[0]} × ${L.outer[2]} mm`} />
        <Kv k={t('Cavity / needed')} v={`${L.inner} / ${L.need} mm`} cls={L.inner < L.need ? 'bad' : ''} />
        <Kv k={t('Wall · corner radius')} v={`${L.params.wall} · ${L.params.radius} mm`} />
        {L.warnings.map((w, i) => (
          <Res key={i} kind="bad" mk="!">
            {w.text}
          </Res>
        ))}
        <Btns>
          <Btn
            id="toCase"
            data-enc={enc}
            onClick={() => {
              ctx!.store.set({ selection: { kind: 'part', id: enc } });
              location.hash = 'shop';
            }}
          >
            {t('Change height · export STL / 3MF')}
          </Btn>
        </Btns>
      </>
    );
  }

  function effectsLine() {
    const fx = asm!.effects();
    const rows: ReactNode[] = [];
    const row = (k: string, v: string, bad: boolean) => rows.push(<Kv key={k} k={k} v={v} cls={bad ? 'bad' : ''} />);
    if (fx.sensorOffset !== undefined) row(t('Sensor heated high'), fx.sensorOffset ? `+${fx.sensorOffset.toFixed(1)} ℃` : '0 ℃', !!fx.sensorOffset);
    if (fx.hornOffset !== undefined) row(t('Horn offset'), `${fx.hornOffset.toFixed(1)}°`, !!fx.hornOffset);
    if (fx.lensScale !== undefined) row(t('Lens magnification'), `${fx.lensScale.toFixed(2)}×`, fx.lensScale < 1.2);
    if (fx.glare !== undefined) row(t('Shade hot spots'), fx.glare ? t('Yes: 8 hot spots') : t('None'), !!fx.glare);
    if (fx.sonarBlock !== undefined) row(t('Probe reading'), fx.sonarBlock ? t('Cut off by the hole wall at about {cm} cm', { cm: fx.sonarBlock }) : t('Measures the object in front'), !!fx.sonarBlock);
    if (fx.imuFlip !== undefined) row(t('IMU orientation'), fx.imuFlip ? t('Reversed: pitch and roll both flipped') : t('Correct'), !!fx.imuFlip);
    const how =
      T!.id === 'weather'
        ? t('The heat offset affects the simulation: in the retest and the Product, BME280 reads the raised temperature.')
        : T!.id === 'ruler' || T!.id === 'tilt'
          ? t('This affects the simulation: in the retest and the Product, the sensor sees things as assembled.')
          : t('Only changes the Product view, not the simulation.');
    return rows.length ? (
      <>
        <Sec>
          {t('Carried into the Product')} · <Conf c={EST} size={11} />
        </Sec>
        {rows}
        <Note>{how}</Note>
      </>
    ) : null;
  }

  /** Failed retest but the firmware passed on the Bench: the enclosure caused it (DESIGN_V2 §9.2 "changed after enclosure") */
  function retestVerdict(e: Extract<Entry, { kind: 'test' }>): Verdict {
    if (e.ok) return 'ok';
    const lv = assemblyLevel(ctx!);
    return lv && ctx!.store.get().checks[lv.id]?.ok ? 'shifted' : 'bad';
  }
  function retestTitle(e: Extract<Entry, { kind: 'test' }>) {
    if (e.ok) return t('Still works after assembly');
    if (T!.id === 'weather' && e.offset > 0.05) return t('In the enclosure, temperature reads {d} ℃ high', { d: e.offset.toFixed(1) });
    if (retestVerdict(e) !== 'shifted') return headline(e.rows);
    // Count devices, not time windows (one buzzer split into three windows is one item); the assembly row is a placement warning
    const n = groupRows(e.rows).filter((g) => g.bad.length && g.dev !== ASM_DEV).length;
    return n > 1 ? t('In the enclosure, {n} devices changed', { n }) : t('In the enclosure: {what}', { what: headline(e.rows) });
  }
  function retestWhy(e: Extract<Entry, { kind: 'test' }>, fallback: string) {
    if (T!.id === 'weather') {
      const room = t('Sensor reads {t} ℃, room is {room} ℃.', { t: e.temp.toFixed(1), room: (e.temp - e.offset).toFixed(1) });
      return e.offset > 0.05 ? t('The sensor is too close to the chip and gets heated by it. {reading} Move it next to the vent and test again.', { reading: room }) : room;
    }
    if (e.ok) return undefined;
    // State the cause once, as an action: which part is wrong and where to move it (DESIGN_V2 §9.5)
    const k = culprit();
    if (!k) return fallback;
    const why = t(k.spot.msg[0]);
    return k.good ? t('{why}. Change to “{fix}” and test again.', { why, fix: t(k.good.label) }) : t('{why}.', { why });
  }

  function renderRetest(head: ReactNode) {
    const c = ctx!;
    const lv = assemblyLevel(c);
    const tst = lastTest();
    const s = asm!.state();
    const fw = firmwareFor(lv);
    const k = tst && !tst.ok ? culprit() : null;
    const why =
      T!.id === 'weather'
        ? t('BME280 reads the temperature wherever the sensor sits: room {room} ℃, heated high by {d} ℃.', { room: lv ? envOf(lv).temp.toFixed(1) : '—', d: (asm!.effects().sensorOffset ?? 0).toFixed(1) })
        : T!.id === 'ruler'
          ? t('With the probe recessed in the hole, HC-SR04 only measures the hole wall.')
          : T!.id === 'tilt'
            ? t('With the IMU reversed, pitch and roll read reversed too.')
            : t('After assembly it reboots and runs the same firmware.');
    c.shell.props.render(
      <>
        {/* On a failed retest the "Current" line (e.g. "Next: Product") clashes with the result card, which already says why */}
        {!(tst && !tst.ok) && head}
        <Sec>{t('Power-on retest')}</Sec>
        <Ph>
          {t('Verify it again as assembled')}
          {lv && (
            <>
              {' '}
              <Mono>{lv.id}</Mono>
            </>
          )}
        </Ph>
        {!tst && <Note>{why}</Note>}
        <Kv k={t('Firmware')} v={fw.name} />
        <Kv k={t('Assembly')} v={`${s.placed.length}/${s.total}`} cls={s.placed.length < s.total ? 'bad' : ''} />
        <Btns>
          <Txt as="button" type="button" className={btnClass(!(tst && !tst.ok))} id="retestBtn" disabled={!!testing || s.placed.length < s.total || !lv} onClick={() => void retest()} text={testing ? t('Retesting {s} s', { s: testing.progress.toFixed(1) }) : t('Power-on retest')} />
        </Btns>
        {tst && (
          <>
            <Sec>{t('Retest result')}</Sec>
            <ResultCard verdict={retestVerdict(tst)} meta={tst.who} title={retestTitle(tst)} why={retestWhy(tst, why)} rows={tst.rows} runId={tst.fingerprint}>
              {!tst.ok && k && (
                <Btn primary data-act="reinstall" className={actCls} disabled={!!testing} onClick={() => seek(k.at)}>
                  {t('Reinstall {part}', { part: t(k.part.short) })}
                </Btn>
              )}
              {!tst.ok && (
                <Btn primary={!k} data-act="retest" className={actCls} disabled={!!testing} onClick={() => void retest()}>
                  {t('Retest again')}
                </Btn>
              )}
            </ResultCard>
          </>
        )}
      </>,
    );
  }

  const envOf = (lv: Level) => bootOptions(lv).env ?? { temp: 23.5, humidity: 45, pressure: 101325 };
  function firmwareFor(lv: Level | undefined): { name: string; get: () => Promise<ArrayBuffer> } {
    const own = lv ? ownFirmware[lv.id] : undefined;
    if (own) return { name: t('{name} (used when you passed “{level}”)', { name: own.name, level: t(lv!.title) }), get: async () => own.buf.slice(0) };
    const ses = ctx!.session;
    if (ses.fwBuf) return { name: t('{name} (firmware on the bench)', { name: ses.fwName }), get: async () => ses.fwBuf!.slice(0) };
    return { name: t('Reference firmware {ref}', { ref: lv?.ref ?? '' }), get: () => fetchBuf(`./fw/${lv?.ref}/flash.bin`) };
  }

  async function retest() {
    const c = ctx;
    if (!c || !asm || testing) return;
    const lv = assemblyLevel(c);
    const s = asm.state();
    if (!lv) return c.shell.toast(t('This project has no checkpoint with assembly'));
    if (s.placed.length < s.total) return c.shell.toast(t('Not fully assembled yet ({done}/{total})', { done: s.placed.length, total: s.total }));
    const at = cur;
    testing = { at, progress: 0 };
    const base = envOf(lv);
    const offset = asm.effects().sensorOffset ?? 0;
    const env = { ...base, temp: base.temp + offset };
    sel = 'retest';
    renderAll();
    const fw = firmwareFor(lv);
    let entry: Extract<Entry, { kind: 'test' }>;
    try {
      // The placement changed what sensors see (probe blocked, IMU reversed): the retest input script follows
      const hx = harnessEffects(c.work.id, hz);
      const v = await verifyLevel(
        { ...lv, script: effectScript(lv.script, asm.effects()) },
        await fw.get(),
        (sec) => {
          if (!testing || sec - testing.progress < 0.2) return;
          testing.progress = sec;
          const b = ctx?.shell.props.el.querySelector('#retestBtn');
          if (b) b.textContent = t('Retesting {s} s', { s: sec.toFixed(1) });
        },
        env,
        { i2cWire: hx.i2c ? hz.i2cCm : undefined, antenna: hx.antennaDb || undefined },
      );
      const clean = asm.clean() && hx.ok;
      const rows: Extract<Entry, { kind: 'test' }>['rows'] = v.results.map((x) => ({ ok: x.ok, text: x.text, say: x.say, tag: x.tag, dev: x.dev }));
      if (hx.i2c) rows.push({ ok: hx.i2c.verdict === 'ok', text: t('I2C cable {cm} cm: {detail} (estimate, needs real hardware)', { cm: hz.i2cCm, detail: i2cText(hx.i2c) }), say: i2cSay(hx.i2c), tag: EST, dev: t('I2C cable') });
      if (hx.antennaDb) rows.push({ ok: hx.wifi.level !== 'fail', text: t('Antenna loss {db} dB: {wifi} (estimate, needs real hardware)', { db: hx.antennaDb, wifi: hx.wifi.text }), say: wifiSay(hx.antennaDb), tag: EST, dev: t('Wi-Fi antenna') });
      rows.push({
        ok: clean,
        text: clean ? t('Assembly {n}/{n}, no warnings', { n: s.total }) : t('Assembly {n}/{n}, with warnings', { n: s.total }),
        say: clean ? t('All {n} parts are in the right place', { n: s.total }) : t('A part is placed badly; look for the one marked “!” at left'),
        dev: ASM_DEV,
      });
      entry = { kind: 'test', ok: v.ok && clean, rows, fingerprint: v.fingerprint, who: fw.name, temp: env.temp, offset };
    } catch (e) {
      // An unfinished run (worker error / stall) is not a failed retest: restore the button so one more click retries
      if (e instanceof VerifyStalled) {
        testing = null;
        ctx?.shell.toast(t('The power-on retest did not finish this time; that is not a fail, just click again'));
        if (ctx) renderAll();
        return;
      }
      entry = { kind: 'test', ok: false, rows: [{ ok: false, text: t('Run failed: {err}', { err: String(e) }), say: t('The simulator hit an error and did not run this time') }], fingerprint: '—', who: fw.name, temp: env.temp, offset };
    }
    testing = null;
    if (cur !== at) {
      ctx?.shell.toast(t('The assembly changed during the retest; this result is discarded'));
      if (ctx) renderAll();
      return;
    }
    push(entry);
    publish();
    if (ctx) {
      ctx.shell.toast(entry.ok ? t('Power-on retest passed') : isPhone() ? t('Power-on retest failed; the reason is below') : t('Power-on retest failed; the reason is on the right'));
      renderAll();
    }
  }

  // ------------------------------------------------------------ timeline, toolbar, verdict
  function renderTimeline() {
    const c = ctx!;
    const steps: TimelineStep[] = [{ id: 'start', icon: '○', label: t('Empty enclosure') }];
    for (const e of entries) {
      if (e.kind === 'place') {
        const p = T!.parts.find((x) => x.id === e.id)!;
        const sp = p.spots?.find((x) => x.key === e.spot);
        // Strip the zh verb prefix of spot labels so "install X (by the vent)" reads naturally; a no-op in other locales
        const spot = sp ? t(sp.label).replace(/^放/, '') : ''; // lint: allow-cjk
        steps.push({ id: `place:${e.id}`, icon: '+', label: sp ? t('Install {part} ({spot})', { part: t(p.short), spot }) : t('Install {part}', { part: t(p.short) }), status: sp && !sp.ok ? 'bad' : undefined });
      } else steps.push({ id: 'test', icon: '▶', label: t('Power-on retest'), status: e.ok ? 'ok' : 'bad' });
    }
    if (testing) steps.splice(testing.at + 2, steps.length, { id: 'testing', icon: '▶', label: t('Power-on retest'), status: 'run' });
    c.shell.timeline.setSteps(steps);
    c.shell.timeline.setCurrent(testing ? testing.at + 2 : cur + 1);
  }

  function renderRuler() {
    if (is3d(asm!)) {
      if (asm.ruler() !== ruler) asm.setRuler(ruler);
      if (asm.section() !== section) asm.setSection(section);
      return;
    }
    const svg = asm!.svg;
    svg.querySelector('[data-k="ruler"]')?.remove();
    if (!ruler || T!.id !== 'weather') return;
    const s = asm!.state();
    const L = T!.parts.findIndex((p) => p.id === 'bme');
    const bme = T!.parts[L];
    const spot = bme.spots!.find((x) => x.key === s.choice.bme);
    const g = svgEl('g', { 'data-k': 'ruler', 'pointer-events': 'none' });
    // Chip = shield can center on the dev board (board-layer local 102,50); 180 enclosure units = 70 mm
    const chip = asm!.isoPoint(1, 102, 50);
    const label = { fill: '#F24822', 'font-size': 12, 'font-weight': 700, 'text-anchor': 'middle' };
    if (!spot) {
      g.append(svgEl('text', { x: chip[0], y: chip[1] - 16, ...label }, t('BME280 not installed yet; install it to measure its distance to the chip')));
      svg.appendChild(g);
      return;
    }
    const cx = spot.at![0] + bme.spotSize![0] / 2, cy = spot.at![1] + bme.spotSize![1] / 2;
    const b = asm!.isoPoint(L, cx, cy);
    const mm = Math.hypot(cx - 102, cy - 50) * (70 / 180);
    const mid = [(chip[0] + b[0]) / 2, (chip[1] + b[1]) / 2];
    g.append(
      svgEl('line', { x1: chip[0], y1: chip[1], x2: b[0], y2: b[1], stroke: '#F24822', 'stroke-width': 2, 'stroke-dasharray': '5 3' }),
      svgEl('circle', { cx: chip[0], cy: chip[1], r: 4, fill: '#F24822' }),
      svgEl('circle', { cx: b[0], cy: b[1], r: 4, fill: '#F24822' }),
      svgEl('rect', { x: mid[0] - 78, y: mid[1] - 34, width: 156, height: 22, rx: 4, fill: '#FFFFFF', stroke: '#F24822' }),
      svgEl('text', { x: mid[0], y: mid[1] - 18, ...label, class: 'tb-mono' }, t('To chip ≈ {mm} mm (estimate)', { mm: mm.toFixed(0) })),
    );
    svg.appendChild(g);
  }

  function syncChrome() {
    const c = ctx!;
    const s = asm!.state();
    const tst = lastTest();
    const done = s.placed.length === s.total;
    c.shell.setVerdict(testing ? t('Retesting…') : tst ? (tst.ok ? t('Retest passed') : t('Retest failed')) : t('Assembly {done}/{total}', { done: s.placed.length, total: s.total }), tst ? (tst.ok ? 'ok' : 'bad') : 'idle');
    c.shell.onVerdict(() => pick('retest'));
    // Failed retest: the main button becomes the fix (reinstall the culprit); otherwise go on to Product (retest does not gate it)
    const k = tst && !tst.ok && !testing ? culprit() : null;
    if (done && k) c.shell.setNext(t('Reinstall {part}', { part: t(k.part.short) }), 'assemble', '', () => seek(k.at), 'hot');
    else if (done) c.shell.setNext(t('Next: Product →'), 'product', '', undefined, 'hot');
    else c.shell.setNext(t('Product · {n} layers left to install', { n: s.total - s.placed.length }), null, t('Finish assembling before power-on ({done}/{total})', { done: s.placed.length, total: s.total }));
    const explode = { id: 'asm-explode', label: asm!.exploded() ? t('Close up') : t('Explode') };
    const rulerTool = { id: 'asm-ruler', label: ruler ? t('Ruler: on') : t('Ruler') };
    c.shell.toolbar.setGroups([
      { id: 'nav', tools: [{ id: 'asm-select', label: t('Select'), key: 'V' }] },
      {
        id: 'view',
        tools: is3d(asm!) ? [explode, { id: 'asm-section', label: section ? t('Section: on') : t('Section') }, rulerTool, { id: 'asm-home', label: t('Reset view') }] : [explode, ...(T!.id === 'weather' ? [rulerTool] : [])],
      },
      { id: 'edit', tools: [{ id: 'asm-undo', label: t('Step back') }, { id: 'asm-reset', label: t('Start over') }] },
      // Once the main button is the fix, retest drops to a normal button: one blue primary per screen
      { id: 'run', tools: [{ id: 'asm-retest', label: testing ? t('Retesting…') : t('Power-on retest'), primary: !k }] },
    ]);
    c.shell.toolbar.setActive(ruler ? 'asm-ruler' : 'asm-select');
  }

  function renderAll() {
    if (!ctx) return;
    if (!asm) {
      if (loading) {
        ctx.shell.props.render(
          <>
            <Sec>{t('Assemble')}</Sec>
            <TreeEmpty>{t('Generating the enclosure and 3D scene…')}</TreeEmpty>
          </>,
        );
        ctx.shell.setVerdict(t('Assemble · loading'), 'idle');
      }
      return;
    }
    renderTree();
    renderProps();
    renderTimeline();
    renderRuler();
    syncChrome();
  }

  function onTool(id: string) {
    if (!ctx || !asm || ctx.store.get().step !== 'assemble') return;
    if (id === 'asm-explode') {
      asm.setExplode(!asm.exploded());
      renderAll();
    } else if (id === 'asm-ruler') {
      ruler = !ruler;
      renderAll();
    } else if (id === 'asm-section') {
      section = !section;
      renderAll();
    } else if (id === 'asm-home') {
      if (is3d(asm)) asm.resetView();
    } else if (id === 'asm-select') {
      ruler = false;
      renderAll();
    } else if (id === 'asm-undo') {
      if (cur >= 0) seek(cur - 1);
    } else if (id === 'asm-reset') seek(-1);
    else if (id === 'asm-retest') void retest();
  }

  /** Replay the timeline into a (freshly built) view */
  function replayView() {
    if (!asm) return;
    replaying = true;
    asm.reset();
    for (const p of placesUpTo(cur)) asm.place(p.id, p.spot);
    replaying = false;
    const next = T!.parts[asm.state().placed.length];
    sel = next?.id ?? T!.parts[0].id;
  }

  function buildSvg(c: StepCtx) {
    node = document.createElement('div');
    node.className = 'asm-shell';
    const box = document.createElement('div');
    box.className = 'asm-box';
    node.append(box);
    const a = createAssembly(
      box,
      {
        boot: (d) => c.session.pressBoot(d),
        temp: (d) => c.session.setEnv({ temp: c.store.get().env.temp + d }),
        // Heat drift only applies in the Product (as on the old page); the retest adds it to env separately
        offset: () => {},
        step: () => onAsmStep(),
      },
      { servoPin: 4, template: T!.id },
    );
    // The enclosure properties panel replaces the SVG's own right-hand "assembly" panel: crop 300 units off the right
    a.svg.setAttribute('viewBox', '0 0 704 560');
    asm = a;
    builtKey = 'svg';
    layout = HAS_3D.has(T!.id) ? layoutFor(T!.id, c.store.get().bom, c.store.get().caseParams) : null;
    replayView();
  }

  function build3d(c: StepCtx, key: string) {
    node = document.createElement('div');
    node.className = 'asm3d-stage';
    const wait = document.createElement('div');
    wait.className = 'a3-loading';
    wait.textContent = t('Generating the enclosure…');
    node.append(wait);
    const host = node;
    builtKey = key;
    loading = true;
    const s = c.store.get();
    void (async () => {
      try {
        const [{ createAssembly3D }, cm] = await Promise.all([import('../asm3d'), caseFor(T!.id, s.bom, s.caseParams)]);
        if (node !== host) return; // rebuilt meanwhile
        host.replaceChildren();
        const v = createAssembly3D(host, { template: T!, layout: cm.layout, meshes: cm.meshes, onStep: () => onAsmStep() });
        asm = v;
        layout = cm.layout;
        (window as unknown as { __tbAsm3d: unknown }).__tbAsm3d = v;
        replayView();
        if (ctx && ctx.store.get().step === 'assemble') v.start();
      } catch (e) {
        if (node !== host) return;
        c.shell.toast(t('3D enclosure failed to load, using the flat assembly instead: {err}', { err: String(e) }));
        buildSvg(c);
        if (ctx && ctx.store.get().step === 'assemble') showNode();
      } finally {
        if (node === host || builtKey === 'svg') loading = false;
        renderAll();
      }
    })();
  }

  function build(c: StepCtx) {
    // Restore after reload: replay the saved steps
    entries = [];
    cur = -1;
    if (c.store.get().assembly) for (const e of loadEntries(c.work.id)) push(e);
    sel = T!.parts[0].id;
    if (want3d() && HAS_3D.has(T!.id)) build3d(c, currentKey(c));
    else buildSvg(c);
  }
  const currentKey = (c: StepCtx) => {
    const s = c.store.get();
    return layoutKey(layoutFor(T!.id, s.bom, s.caseParams));
  };
  /** Enclosure params / BOM changed: drop the old view and replay the timeline into a new one */
  function rebuildIfStale(c: StepCtx) {
    if (!node || builtKey === 'svg') return;
    const key = currentKey(c);
    if (key === builtKey) return;
    if (asm && is3d(asm)) asm.dispose();
    asm = null;
    layout = null;
    node.remove();
    node = null;
    build3d(c, key);
  }

  const step: StepImpl = {
    mount(c) {
      ctx = c;
      T = TEMPLATES[c.work.id] ?? null;
      hz = loadCaseHarness(c.work.id);
      if (!hooked) {
        hooked = true;
        c.shell.toolbar.onTool(onTool);
        c.shell.timeline.onSeek((i) => {
          if (!ctx || ctx.store.get().step !== 'assemble' || !asm || !unlocked(ctx)) return;
          seek(i - 1);
        });
      }
      if (!T) {
        c.shell.layer.render(
          <LockCard role="status">
            <Sec>{t('③ Assemble')}</Sec>
            <PhT>{t('This project has no assembly template')}</PhT>
            <p className="my-3 text-muted">{t('The blank Bench only runs firmware, with no enclosure. Pick a project to get Assemble and Product.')}</p>
            <Btns>
              <LinkBtn primary href={lab('weather', 'assemble')}>
                {t('Go to the weather station')}
              </LinkBtn>
            </Btns>
          </LockCard>,
        );
        c.shell.tree.render(<TreeEmpty>{t('No assembly layers')}</TreeEmpty>);
        c.shell.props.render(
          <>
            <Sec>{t('Properties')}</Sec>
            <TreeEmpty>{t('Nothing to select')}</TreeEmpty>
          </>,
        );
        c.shell.toolbar.setGroups([]);
        c.shell.timeline.setSteps([]);
        c.shell.setNext(t('Product · this project has no assembly template'), null, t('No assembly template'));
        return;
      }
      if (!unlocked(c)) {
        renderLocked();
        unsubs = [
          c.store.subscribe(() => {
            if (unlocked(c)) {
              // Unlocked (e.g. a check passed in another tab): mount again
              unsubs.forEach((u) => u());
              unsubs = [];
              c.shell.layer.render(null);
              c.shell.setBare(false);
              step.mount(c);
            } else renderLocked();
          }, ['checks']),
        ];
        return;
      }
      if (!node) build(c);
      else rebuildIfStale(c);
      showNode();
      if (asm && is3d(asm)) asm.start();
      applyHarness();
      publish();
      renderAll();
      unsubs.push(
        c.session.onHarness((txt) => {
          const n = c.shell.props.el.querySelector('[data-k="hzSim"]');
          if (n) n.textContent = simLine(txt.trim());
          else if (txt.trim() && sel !== 'retest') renderProps();
        }),
      );
    },
    unmount() {
      if (asm && is3d(asm)) asm.stop();
      unsubs.forEach((u) => u());
      unsubs = [];
      ctx = null;
    },
  };
  return step;
}

/** SVG elements for the ruler annotation (appended imperatively to the assembly SVG) */
function svgEl(tag: string, attrs: Record<string, string | number>, text?: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}
