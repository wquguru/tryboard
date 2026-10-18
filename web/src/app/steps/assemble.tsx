// ③ 组装：3D 视图（app/asm3d.ts，参数化外壳 + 拖到槽位吸附，P1-07）；WebGL 不可用或 ?asm=svg 时用
// views/assembly.ts 的 SVG 等轴测兜底。两种视图共用 views/asmcore.ts 的规则和 templates.ts 的模板：
// 左树 = 装配层（从下往上）；右栏 = 选中层说明 + "装法会改变什么"（估算）；时间线 = 每装一层一步 + 开机复测，可回退。
// 回退不存快照：清空后按时间线重放前 i 步（确定性重算）。开机复测用装好的状态（传感器偏移进 env）跑同一份固件验收。
import { createAssembly } from '../../views/assembly';
import { CHIP_HEAT_OFFSET, SONAR_BLOCK_CM, TEMPLATES, effectScript, type Template } from '../../views/templates';
import { bootOptions, type Level } from '../../checks';
import { VerifyStalled, verifyLevel } from '../../verify';
import { fetchBuf } from '../../assets';
import { ownFirmware, passedCount } from './bench';
import type { AssemblyState, StepCtx, StepImpl } from '../types';
import type { TimelineStep } from '../timeline';
import type { Assembly3D } from '../asm3d';
import { caseFor, layoutFor, layoutKey } from '../casemesh';
import type { CaseLayout } from '../enclosure';
import { OBSTACLE_LABEL, antennaLossDb, i2cLoad, i2cText, loadCaseHarness, saveCaseHarness, wifiText, type CaseHarness, type Obstacle } from '../harness';
import { noteSaved } from '../saved';

type SvgAsm = ReturnType<typeof createAssembly>;
type AsmView = SvgAsm | Assembly3D;
const is3d = (a: AsmView): a is Assembly3D => (a as Assembly3D).kind === '3d';
/** 有参数化外壳布局（enclosure.ts）的模板才走 3D；P2-09 的新作品先用平面装配 */
const HAS_3D = new Set(['weather', 'spin', 'lens']);
/** 3D 装配要 WebGL2；?asm=svg 强制用平面视图（测试 / 兜底） */
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
import { Btn, Btns, Kv, KvBox, KvT, LinkBtn, LockCard, Mono, Muted, Note, Ph, PhT, Res, Sec, Seg, SegB, Slider, TnL, TnM, TnSt, TreeEmpty, TreeGroup, VerdictLine, btnClass, tnClass } from '../../ui/panel';
import { lab } from '../../ui/links';

type Entry = { kind: 'place'; id: string; spot?: string } | { kind: 'test'; ok: boolean; rows: { ok: boolean; text: string }[]; fingerprint: string; who: string; temp: number };

const KEY = (work: string) => `tryboard-app-asm:${work}`;
/** 本机存的装配时间线（装了哪些、怎么装、复测结果；不存逐条结果以外的东西） */
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
    /* 隐私模式：只在本页有效 */
  }
}
const lastIsTest = (list: Entry[]) => {
  const e = list[list.length - 1];
  return e?.kind === 'test' ? e.ok : null;
};

/** 不建 DOM 也能算出装配结果（成品步骤、刷新后恢复用），与 createAssembly 的 clean / effects 一致 */
/** 这个作品壳里有没有 I2C 模块（排线长度只对它们有意义） */
export const I2C_DEVICES: Record<string, number> = { weather: 2 };

/** 线束带进成品的东西（估算）：I2C 排线总长、天线遮挡 dB；以及它们会不会让成品出问题 */
export function harnessEffects(work: string, h: CaseHarness) {
  const n = I2C_DEVICES[work] ?? 0;
  const i2c = n ? i2cLoad(h.i2cCm, n) : null;
  const antennaDb = antennaLossDb(h.obstacle, h.distMm);
  const wifi = wifiText(antennaDb);
  return { i2c, antennaDb, wifi, ok: (!i2c || i2c.verdict === 'ok') && wifi.level !== 'fail' };
}

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

/** 页面启动时恢复本机存过的装配（只存装了哪些、怎么装；复测结果不存，要重新测） */
export function restoreAssembly(ctx: StepCtx) {
  const T = TEMPLATES[ctx.work.id];
  if (!T) return;
  const list = loadEntries(ctx.work.id);
  const places = list.filter((e): e is Extract<Entry, { kind: 'place' }> => e.kind === 'place');
  // 存的顺序必须是模板的从下往上顺序，否则当作没装
  const okOrder = places.every((p, i) => T.parts[i]?.id === p.id);
  if (places.length && okOrder) ctx.store.set({ assembly: summarize(T, places, lastIsTest(list), loadCaseHarness(ctx.work.id)) });
  else if (list.length) saveEntries(ctx.work.id, []);
}

/** 这个作品的哪个检查点带装配（weather 06、spin 07-spin、lens 07-lens） */
export function assemblyLevel(ctx: StepCtx): Level | undefined {
  return ctx.session.levels.find((l) => ctx.work.checkpoints.includes(l.id) && l.assembly);
}

export function unlocked(ctx: StepCtx) {
  const n = ctx.work.checkpoints.length;
  return n > 0 && passedCount(ctx) === n;
}

/** 装法会改变什么（估算）：按模板、按零件说清后果 */
const IMPACT: Record<string, Record<string, string[]>> = {
  weather: {
    shell: ['USB-C 开孔朝后：线从背后出，不挡表盘'],
    board: ['开发板卡扣位置决定了芯片在哪：芯片满载时是壳里最热的地方'],
    bme: [`放通风口旁：读到的就是室温，表盘、彩灯、报警都按真实温度`, `放开发板旁：贴着芯片，读数偏高约 ${CHIP_HEAT_OFFSET} ℃，室温 27.5 ℃ 就会报警，检查点 06 的温度项过不了`],
    servo: ['舵机轴要对准表盘中心，否则指针扫不到刻度两端'],
    oled: ['排线 8 cm，需要 ≥ 6 cm 才够得到前面板'],
    front: ['前面板合上后内腔用了 27 / 32 mm'],
  },
  spin: {
    servo: ['先回中位再装舵盘：固件说「正面」就是正面', `直接按上去：舵盘可能错一个齿，正面偏 ${(360 / 25).toFixed(1)}°`],
  },
  usbkey: {
    board: ['USB / OTG 口朝背面开孔：线插得进去，电脑认出键盘', '装反 180°：USB 口顶着前墙，线插不进去，成品里电脑看不到设备'],
    plate: ['定位板用塑料：金属定位板盖住 WROOM 天线，Wi-Fi 信号会掉几十 dB（估算），可以在下面「线束与天线」里试'],
  },
  lens: {
    dome: ['高档离屏 8 mm：放大约 1.35×，看着更立体', '低档贴着屏：放大约 1.08×，看着是平的'],
  },
  lamp: {
    strip: ['贴在导光柱上：离灯罩 15 mm，光在乳白罩上散成均匀的一片', '贴着灯罩内壁：罩子上一排 8 个刺眼亮点'],
    knob: ['旋钮轴要露出面板 ≥ 6 mm，不然手指捏不住、按不下去'],
  },
  ruler: {
    sonar: ['探头伸出前面板孔：量到的就是前方物体', `缩在孔后 6 mm：回波先从孔壁回来，读数约 ${SONAR_BLOCK_CM} cm，蜂鸣器一直响，复测也一样（估算）`],
    board: ['Echo 线上的 1 kΩ / 2 kΩ 分压电阻跟着开发板一起装，别装壳时漏掉'],
  },
  tilt: {
    imu: ['平贴底板、箭头朝前：小豆跟着歪斜方向运动', '装反 180°：俯仰、横滚方向全反，小豆往高处爬，复测里也一样'],
  },
};

export function assembleStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  let T: Template | null = null;
  /** 装配视图整页只建一次：切到别的步骤再回来，装到一半的进度还在 */
  let node: HTMLElement | null = null;
  let asm: AsmView | null = null;
  /** 当前视图按哪份外壳参数建的（参数 / 清单变了就重建，装配步骤按时间线重放） */
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
  /** 线束（P2-11）：排线长度、天线旁边有没有金属件 / 电池（估算）；不进装配时间线，单独存 */
  let hz: CaseHarness = loadCaseHarness('weather');

  /** 装配视图（命令式节点）挂进步骤层 */
  const showNode = () => ctx?.shell.layer.render(<Host node={node} />);

  /** 线束交给模拟器（台面上正在跑的那份固件马上受影响；开机复测、成品也用它） */
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
          <span className="k">I2C 排线总长（开发板到 OLED、BME280）</span>
          <Slider
            id="hzWire"
            outId="hzWireV"
            min={8}
            max={150}
            step={1}
            defaultValue={hz.i2cCm}
            aria-label="I2C 排线总长"
            out={`${hz.i2cCm} cm`}
            on={{
              input: (e) => {
                const v = e.currentTarget.value;
                el.querySelector('#hzWireV')!.textContent = `${v} cm`;
                const l = harnessEffects(c.work.id, { ...hz, i2cCm: Number(v) }).i2c!;
                const r = el.querySelector('#hzWireRes span:last-child');
                if (r) r.textContent = i2cText(l);
              },
              change: (e) => commit({ i2cCm: Number(e.currentTarget.value) }),
            }}
          />
        </KvBox>
        <Res id="hzWireRes" kind={lv(hx.i2c.verdict)[0]} mk={lv(hx.i2c.verdict)[1]}>
          {i2cText(hx.i2c)}
        </Res>
      </>
    ) : null;
    const sim = c.session.harnessText.trim();
    return (
      <>
        <Sec>线束与天线 · 估算，必须上真机</Sec>
        {i2c}
        <KvBox>
          <span className="k">WROOM 天线旁边放了什么</span>
          <Seg aria-label="天线旁边">
            {(['none', 'battery', 'metal'] as Obstacle[]).map((o) => (
              <SegB key={o} data-obs={o} on={hz.obstacle === o} onClick={() => commit({ obstacle: o })}>
                {o === 'metal' ? '金属件' : OBSTACLE_LABEL[o]}
              </SegB>
            ))}
          </Seg>
        </KvBox>
        {hz.obstacle !== 'none' && (
          <KvBox>
            <span className="k">离天线区多远（{OBSTACLE_LABEL[hz.obstacle]}）</span>
            <Slider
              id="hzDist"
              outId="hzDistV"
              min={0}
              max={30}
              step={1}
              defaultValue={hz.distMm}
              aria-label="离天线多远"
              out={`${hz.distMm} mm`}
              on={{
                input: (e) => void (el.querySelector('#hzDistV')!.textContent = `${e.currentTarget.value} mm`),
                change: (e) => commit({ distMm: Number(e.currentTarget.value) }),
              }}
            />
          </KvBox>
        )}
        <Res id="hzAntRes" kind={lv(hx.wifi.level)[0]} mk={lv(hx.wifi.level)[1]}>
          天线遮挡 {hx.antennaDb} dB，{hx.wifi.text}
        </Res>
        <Note>按固定公式估算：总线电容 = 线长 × 1 pF/cm + 每个器件 10 pF + 10 pF，上升时间 = 0.8473 × 上拉 × 电容；天线：金属件贴着衰减 45 dB、电池 30 dB，20 mm 外不算。模拟器也用这个公式，读数会真的出错，Wi-Fi 会真的连不上。</Note>
        {sim && <Txt as="p" className="note my-2 font-mono text-xs text-muted" data-k="hzSim" text={sim.replace(/\[tryboard\] /g, '模拟器：')} />}
      </>
    );
  }

  const placesUpTo = (i: number) => entries.slice(0, i + 1).filter((e): e is Extract<Entry, { kind: 'place' }> => e.kind === 'place');
  const lastTest = () => (cur >= 0 && entries[cur]?.kind === 'test' ? (entries[cur] as Extract<Entry, { kind: 'test' }>) : null);

  function publish() {
    const c = ctx!;
    const places = placesUpTo(cur);
    const t = lastTest();
    c.store.set({ assembly: places.length ? summarize(T!, places, t ? t.ok : null, hz) : null });
    saveEntries(c.work.id, entries.slice(0, cur + 1));
  }

  /** 回到第 i 步：清空，按时间线重放前 i 步（确定性重算） */
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
      // 引擎内部"重来"：时间线回到开头
      entries = [];
      cur = -1;
      publish();
    } else {
      const m = asm.message();
      if (m.bad) ctx.shell.toast(`${m.title}：${m.text}`);
    }
    renderAll();
  }

  const lvTitle = (id: string) => ctx!.session.levels.find((l) => l.id === id)?.title ?? '';

  // ------------------------------------------------------------ 锁住时
  function renderLocked() {
    const c = ctx!;
    const s = c.store.get();
    const n = c.work.checkpoints.length;
    const d = passedCount(c);
    const left = c.work.checkpoints.filter((id) => !(s.checks[id]?.ok && s.checks[id].own));
    const first = left[0] ?? c.work.checkpoints[0];
    // 锁着只给一张卡（设计稿 unify/Steps）：差哪几个检查点一眼看全，左右两栏和运行组收起，不铺空壳
    c.shell.setBare(true);
    c.shell.layer.render(
      <LockCard role="status">
        <Sec>③ 组装 · 还没解锁</Sec>
        <PhT>{`实验台的 ${n} 个检查点过了才能装壳`}</PhT>
        <ul id="lockList" className="my-3 grid list-none gap-1 p-0 text-[13px]">
          {c.work.checkpoints.map((id) => {
            const ok = s.checks[id]?.ok && s.checks[id].own;
            return (
              <li key={id} data-cp={id} data-ok={ok ? '' : undefined} className={ok ? 'text-ok-ink' : 'text-fg'}>
                <span className="inline-block w-5 font-mono">{ok ? '✓' : '○'}</span>
                <Mono>{id}</Mono> {lvTitle(id)}
              </li>
            );
          })}
        </ul>
        <p className="my-3 text-xs text-muted">
          {`现在 ${d}/${n}。`}只有你自己上传的固件通过才算，参考固件不算；判定和命令行 <Mono>npx tryboard check</Mono> 相同。
        </p>
        <Btns>
          <Btn
            primary
            id="toBench"
            onClick={() => {
              c.store.set({ selection: { kind: 'checkpoint', id: first } });
              location.hash = 'bench';
            }}
          >
            {`回实验台，从 ${first} ${lvTitle(first)}开始`}
          </Btn>
        </Btns>
      </LockCard>,
    );
    c.shell.toolbar.setGroups([]);
    c.shell.timeline.setSteps([{ id: 'lock', icon: '·', label: `检查点 ${d}/${n}，未解锁` }]);
    c.shell.setVerdict(`组装 · 未解锁`, 'idle');
    c.shell.onVerdict(() => (location.hash = 'bench'));
    c.shell.setNext('成品 · 先过完检查点再装壳', null, '先解锁并装完');
  }

  // ------------------------------------------------------------ 构建树：装配层
  function layerStatus(i: number) {
    const s = asm!.state();
    const p = T!.parts[i];
    if (i < s.placed.length) {
      const sp = p.spots?.find((x) => x.key === s.choice[p.id]);
      return sp && !sp.ok ? 'warn' : 'done';
    }
    return i === s.placed.length ? 'next' : 'todo';
  }
  const STATUS = { done: ['✓', '已装', 'ok'], warn: ['!', '有警告', 'warn'], next: ['→', '下一件', 'run'], todo: ['·', '待装', 'muted'] } as const;

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
            <TnL>{p.name}</TnL>
            <TnSt kind={st[2]}>{`${st[0]} ${st[1]}`}</TnSt>
          </button>
        );
      })
      .reverse();
    const t = lastTest();
    const lv = assemblyLevel(c);
    c.shell.tree.render(
      <div role="group" aria-label="装配层">
        <TreeGroup title="装配层 · 从下往上" count={`${s.placed.length}/${s.total}`} open>
          {items}
        </TreeGroup>
        <TreeGroup title="复测" count="" open>
          <button type="button" className={tnClass(sel === 'retest')} data-id="retest" role="treeitem" aria-selected={sel === 'retest'} onClick={() => pick('retest')}>
            <TnL>
              开机复测
              {lv && (
                <>
                  {' · 检查点 '}
                  <Mono>{lv.id}</Mono>
                </>
              )}
            </TnL>
            <TnSt kind={testing ? 'run' : t ? (t.ok ? 'ok' : 'bad') : 'muted'}>{testing ? '…' : t ? (t.ok ? '✓' : '✗') : '—'}</TnSt>
          </button>
        </TreeGroup>
      </div>,
    );
  }

  // ------------------------------------------------------------ 属性面板
  function renderProps() {
    const c = ctx!;
    const s = asm!.state();
    const m = asm!.message();
    const head = (
      <>
        <Sec>当前</Sec>
        <div className={cn('asm-msg', m.bad && 'bad')}>
          <b>{m.title}</b>
          <span>{m.text}</span>
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
          <Sec>怎么装</Sec>
          <Btns col>
            {p.spots.map((x) => (
              <Btn key={x.key} className={x.ok ? '' : 'warnb'} data-spot={x.key} onClick={() => asm!.place(p.id, x.key)}>
                {x.label}
              </Btn>
            ))}
          </Btns>
          <Note>也可以把左边台面上的零件卡片拖到发亮的位置。</Note>
        </>
      ) : isNext ? (
        <Btns>
          <Btn primary data-place="1" onClick={() => asm!.place(p.id)}>
            装上「{p.short}」
          </Btn>
        </Btns>
      ) : null;
    const impact = (IMPACT[T!.id]?.[p.id] ?? []).map((t, k) => {
      const mark = p.spots ? (p.spots[k]?.key === chosen?.key ? '●' : '○') : '·';
      return (
        <Res key={k} kind={p.spots && p.spots[k] && !p.spots[k].ok ? 'bad' : 'na'} mk={mark}>
          {t}
        </Res>
      );
    });
    const checks = T!.checks(s).map((r, k) => (
      <Res key={k} kind={r.ok === null ? 'na' : r.ok ? 'ok' : 'bad'} mk={r.ok === null ? '·' : r.ok ? '✓' : '!'}>
        {r.label}：{r.text.replace(/^[✓!] /, '')}
      </Res>
    ));
    c.shell.props.render(
      <>
        {head}
        <Sec>{`第 ${i + 1} 层 / 共 ${T!.parts.length} 层`}</Sec>
        <Ph>{p.name}</Ph>
        <Kv k="状态" v={`${STATUS[st][0]} ${STATUS[st][1]}`} cls={st === 'warn' ? 'warnc' : ''} />
        {chosen && <KvT k="装法">{chosen.label + (chosen.ok ? '' : ' · 有警告')}</KvT>}
        {!p.spots && p.okMsg && <KvT k="说明">{p.okMsg.join('，')}</KvT>}
        {choose}
        {impact.length > 0 && (
          <>
            <Sec>装法会改变什么 · 估算</Sec>
            {impact}
          </>
        )}
        <Sec>装配检查 · 几何估算，未经真机标定</Sec>
        {checks}
        {effectsLine()}
        {harnessPanel()}
        {caseLine()}
      </>,
    );
  }

  /** 参数化外壳的尺寸与警告（与采购页外壳详情同一份布局） */
  function caseLine() {
    if (!layout) return null;
    const L = layout;
    const enc = `enclosure-${T!.id}`;
    return (
      <>
        <Sec>外壳 · 参数化，估算</Sec>
        <Kv k={L.shape === 'rect' ? '外形' : '底座'} v={L.shape === 'rect' ? `${L.outer[0]} × ${L.outer[1]} × ${L.outer[2]} mm` : `Ø${L.outer[0]} × ${L.outer[2]} mm`} />
        <Kv k="内腔 / 需要" v={`${L.inner} / ${L.need} mm`} cls={L.inner < L.need ? 'bad' : ''} />
        <Kv k="壁厚 · 圆角" v={`${L.params.wall} · ${L.params.radius} mm`} />
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
            改高度 · 导出 STL / 3MF
          </Btn>
        </Btns>
      </>
    );
  }

  function effectsLine() {
    const fx = asm!.effects();
    const rows: ReactNode[] = [];
    const row = (k: string, v: string, bad: boolean) => rows.push(<Kv key={k} k={k} v={v} cls={bad ? 'bad' : ''} />);
    if (fx.sensorOffset !== undefined) row('传感器受热偏高', fx.sensorOffset ? `+${fx.sensorOffset.toFixed(1)} ℃` : '0 ℃', !!fx.sensorOffset);
    if (fx.hornOffset !== undefined) row('舵盘偏角', `${fx.hornOffset.toFixed(1)}°`, !!fx.hornOffset);
    if (fx.lensScale !== undefined) row('透镜放大', `${fx.lensScale.toFixed(2)}×`, fx.lensScale < 1.2);
    if (fx.glare !== undefined) row('灯罩亮点', fx.glare ? '有：8 个亮点' : '没有', !!fx.glare);
    if (fx.sonarBlock !== undefined) row('探头读数', fx.sonarBlock ? `被孔壁截到约 ${fx.sonarBlock} cm` : '量到前方物体', !!fx.sonarBlock);
    if (fx.imuFlip !== undefined) row('六轴方向', fx.imuFlip ? '反了：俯仰、横滚方向全反' : '正', !!fx.imuFlip);
    const how =
      T!.id === 'weather'
        ? '受热偏高会影响模拟结果：开机复测和成品里，BME280 读到的就是偏高后的温度。'
        : T!.id === 'ruler' || T!.id === 'tilt'
          ? '这一项会影响模拟结果：开机复测和成品里，传感器看到的就是装好以后的样子。'
          : '只改成品画面，不影响模拟结果。';
    return rows.length ? (
      <>
        <Sec>装法带进成品 · 估算</Sec>
        {rows}
        <Note>{how}</Note>
      </>
    ) : null;
  }

  function renderRetest(head: ReactNode) {
    const c = ctx!;
    const lv = assemblyLevel(c);
    const t = lastTest();
    const s = asm!.state();
    const fw = firmwareFor(lv);
    const why =
      T!.id === 'weather'
        ? `传感器放在哪，BME280 就读到哪儿的温度：室温 ${lv ? envOf(lv).temp.toFixed(1) : '—'} ℃，受热偏高 ${(asm!.effects().sensorOffset ?? 0).toFixed(1)} ℃。`
        : T!.id === 'ruler'
          ? '探头缩在孔里时，HC-SR04 只能量到孔壁。'
          : T!.id === 'tilt'
            ? '六轴装反时，读到的俯仰、横滚也是反的。'
            : '装好后重启，跑的还是同一份固件。';
    c.shell.props.render(
      <>
        {head}
        <Sec>开机复测</Sec>
        <Ph>
          装好的样子再验一次
          {lv && (
            <>
              {' '}
              <Mono>{lv.id}</Mono>
            </>
          )}
        </Ph>
        <Note>{why}</Note>
        <Kv k="固件" v={fw.name} />
        <Kv k="装配" v={`${s.placed.length}/${s.total}`} cls={s.placed.length < s.total ? 'bad' : ''} />
        <Btns>
          <Txt as="button" type="button" className={btnClass(true)} id="retestBtn" disabled={!!testing || s.placed.length < s.total || !lv} onClick={() => void retest()} text={testing ? `复测中 ${testing.progress.toFixed(1)} s` : '开机复测'} />
        </Btns>
        {t && (
          <>
            <Sec>复测结果</Sec>
            <VerdictLine kind={t.ok ? 'ok' : 'bad'}>
              {t.ok ? '✓ 通过' : '✗ 未通过'}
              {T!.id === 'weather' && (
                <>
                  {' '}
                  <Muted className="font-normal">· 传感器读到 {t.temp.toFixed(1)} ℃</Muted>
                </>
              )}
            </VerdictLine>
            {t.rows.map((x, i) => (
              <Res key={i} kind={x.ok ? 'ok' : 'bad'}>
                {x.text}
              </Res>
            ))}
            <Kv k="运行指纹" v={t.fingerprint} cls="fp" />
          </>
        )}
      </>,
    );
  }

  const envOf = (lv: Level) => bootOptions(lv).env ?? { temp: 23.5, humidity: 45, pressure: 101325 };
  function firmwareFor(lv: Level | undefined): { name: string; get: () => Promise<ArrayBuffer> } {
    const own = lv ? ownFirmware[lv.id] : undefined;
    if (own) return { name: `${own.name}（你通过「${lv!.title}」时用的）`, get: async () => own.buf.slice(0) };
    const ses = ctx!.session;
    if (ses.fwBuf) return { name: `${ses.fwName}（台面上的固件）`, get: async () => ses.fwBuf!.slice(0) };
    return { name: `参考固件 ${lv?.ref}`, get: () => fetchBuf(`./fw/${lv?.ref}/flash.bin`) };
  }

  async function retest() {
    const c = ctx;
    if (!c || !asm || testing) return;
    const lv = assemblyLevel(c);
    const s = asm.state();
    if (!lv) return c.shell.toast('这个作品没有带装配的检查点');
    if (s.placed.length < s.total) return c.shell.toast(`还没装完（${s.placed.length}/${s.total}）`);
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
      // 装法改了传感器看到的东西（探头被挡、六轴装反）：复测的输入脚本跟着改
      const hx = harnessEffects(c.work.id, hz);
      const v = await verifyLevel(
        { ...lv, script: effectScript(lv.script, asm.effects()) },
        await fw.get(),
        (t) => {
          if (!testing || t - testing.progress < 0.2) return;
          testing.progress = t;
          const b = ctx?.shell.props.el.querySelector('#retestBtn');
          if (b) b.textContent = `复测中 ${t.toFixed(1)} s`;
        },
        env,
        { i2cWire: hx.i2c ? hz.i2cCm : undefined, antenna: hx.antennaDb || undefined },
      );
      const clean = asm.clean() && hx.ok;
      const rows = v.results.map((x) => ({ ok: x.ok, text: x.text }));
      if (hx.i2c) rows.push({ ok: hx.i2c.verdict === 'ok', text: `I2C 排线 ${hz.i2cCm} cm：${i2cText(hx.i2c)}（估算，必须上真机）` });
      if (hx.antennaDb) rows.push({ ok: hx.wifi.level !== 'fail', text: `天线遮挡 ${hx.antennaDb} dB：${hx.wifi.text}（估算，必须上真机）` });
      rows.push({ ok: clean, text: clean ? `装配 ${s.total}/${s.total}，没有警告` : `装配 ${s.total}/${s.total}，有警告` });
      entry = { kind: 'test', ok: v.ok && clean, rows, fingerprint: v.fingerprint, who: fw.name, temp: env.temp };
    } catch (e) {
      // 没跑完（Worker 出错 / 卡住）不记成"复测没过"：按钮恢复，直接再点一次
      if (e instanceof VerifyStalled) {
        testing = null;
        ctx?.shell.toast(`开机复测没跑完：${e.message}，可以再点一次`);
        if (ctx) renderAll();
        return;
      }
      entry = { kind: 'test', ok: false, rows: [{ ok: false, text: `运行失败：${e}` }], fingerprint: '—', who: fw.name, temp: env.temp };
    }
    testing = null;
    if (cur !== at) {
      ctx?.shell.toast('复测期间装配变了，这次结果作废');
      if (ctx) renderAll();
      return;
    }
    push(entry);
    publish();
    if (ctx) {
      ctx.shell.toast(entry.ok ? '开机复测通过' : '开机复测没过：看右边哪一项');
      renderAll();
    }
  }

  // ------------------------------------------------------------ 时间线、工具条、结论
  function renderTimeline() {
    const c = ctx!;
    const steps: TimelineStep[] = [{ id: 'start', icon: '○', label: '空壳' }];
    for (const e of entries) {
      if (e.kind === 'place') {
        const p = T!.parts.find((x) => x.id === e.id)!;
        const sp = p.spots?.find((x) => x.key === e.spot);
        steps.push({ id: `place:${e.id}`, icon: '+', label: `装 ${p.short}${sp ? `（${sp.label.replace(/^放/, '')}）` : ''}`, status: sp && !sp.ok ? 'bad' : undefined });
      } else steps.push({ id: 'test', icon: '▶', label: '开机复测', status: e.ok ? 'ok' : 'bad' });
    }
    if (testing) steps.splice(testing.at + 2, steps.length, { id: 'testing', icon: '▶', label: '开机复测', status: 'run' });
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
    // 芯片 = 开发板上的屏蔽罩中心（板层局部坐标 102,50）；外壳 180 单位 = 70 mm
    const chip = asm!.isoPoint(1, 102, 50);
    const label = { fill: '#F24822', 'font-size': 12, 'font-weight': 700, 'text-anchor': 'middle' };
    if (!spot) {
      g.append(svgEl('text', { x: chip[0], y: chip[1] - 16, ...label }, 'BME280 还没装，装上后量它到芯片的距离'));
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
      svgEl('text', { x: mid[0], y: mid[1] - 18, ...label, class: 'tb-mono' }, `到芯片 ≈ ${mm.toFixed(0)} mm（估算）`),
    );
    svg.appendChild(g);
  }

  function syncChrome() {
    const c = ctx!;
    const s = asm!.state();
    const t = lastTest();
    const done = s.placed.length === s.total;
    c.shell.setVerdict(testing ? '复测中…' : t ? (t.ok ? '复测 ✓' : '复测 ✗') : `装配 ${s.placed.length}/${s.total}`, t ? (t.ok ? 'ok' : 'bad') : 'idle');
    c.shell.onVerdict(() => pick('retest'));
    if (done) c.shell.setNext('下一步：成品 →', 'product', '', undefined, 'hot');
    else c.shell.setNext(`成品 · 还差 ${s.total - s.placed.length} 层没装`, null, `装完才能开机（${s.placed.length}/${s.total}）`);
    c.shell.toolbar.setGroups([
      { id: 'nav', tools: [{ id: 'asm-select', label: '选择', key: 'V' }] },
      {
        id: 'view',
        tools: is3d(asm!)
          ? [{ id: 'asm-explode', label: asm!.exploded() ? '合上' : '炸开' }, { id: 'asm-section', label: section ? '剖面：开' : '剖面' }, { id: 'asm-ruler', label: ruler ? '尺子：开' : '尺子' }, { id: 'asm-home', label: '复位视角' }]
          : [{ id: 'asm-explode', label: asm!.exploded() ? '合上' : '炸开' }, ...(T!.id === 'weather' ? [{ id: 'asm-ruler', label: ruler ? '尺子：开' : '尺子' }] : [])],
      },
      { id: 'edit', tools: [{ id: 'asm-undo', label: '退一步' }, { id: 'asm-reset', label: '重来' }] },
      { id: 'run', tools: [{ id: 'asm-retest', label: testing ? '复测中…' : '开机复测', primary: true }] },
    ]);
    c.shell.toolbar.setActive(ruler ? 'asm-ruler' : 'asm-select');
  }

  function renderAll() {
    if (!ctx) return;
    if (!asm) {
      if (loading) {
        ctx.shell.props.render(
          <>
            <Sec>组装</Sec>
            <TreeEmpty>正在生成外壳和 3D 场景…</TreeEmpty>
          </>,
        );
        ctx.shell.setVerdict('组装 · 加载中', 'idle');
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

  /** 按时间线把装配重放进（新建的）视图 */
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
        // 温漂只在成品里生效（与旧页面一致）；复测时单独算进 env
        offset: () => {},
        step: () => onAsmStep(),
      },
      { servoPin: 4, template: T!.id },
    );
    // 右边的"装配"小面板由外壳的属性面板代替：裁掉 SVG 右侧 300 宽
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
    wait.textContent = '正在生成外壳…';
    node.append(wait);
    const host = node;
    builtKey = key;
    loading = true;
    const s = c.store.get();
    void (async () => {
      try {
        const [{ createAssembly3D }, cm] = await Promise.all([import('../asm3d'), caseFor(T!.id, s.bom, s.caseParams)]);
        if (node !== host) return; // 期间又重建了
        host.replaceChildren();
        const v = createAssembly3D(host, { template: T!, layout: cm.layout, meshes: cm.meshes, onStep: () => onAsmStep() });
        asm = v;
        layout = cm.layout;
        (window as unknown as { __tbAsm3d: unknown }).__tbAsm3d = v;
        replayView();
        if (ctx && ctx.store.get().step === 'assemble') v.start();
      } catch (e) {
        if (node !== host) return;
        c.shell.toast(`3D 外壳加载失败，改用平面装配：${e}`);
        buildSvg(c);
        if (ctx && ctx.store.get().step === 'assemble') showNode();
      } finally {
        if (node === host || builtKey === 'svg') loading = false;
        renderAll();
      }
    })();
  }

  function build(c: StepCtx) {
    // 刷新后恢复：按存下的步骤重放
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
  /** 外壳参数 / 清单变了：丢掉旧视图，按时间线重放进新视图 */
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
            <Sec>③ 组装</Sec>
            <PhT>这个作品没有组装模板</PhT>
            <p className="my-3 text-muted">空白实验台只跑固件，不装壳。选一个作品，才有组装和成品。</p>
            <Btns>
              <LinkBtn primary href={lab('weather', 'assemble')}>
                去气象站
              </LinkBtn>
            </Btns>
          </LockCard>,
        );
        c.shell.tree.render(<TreeEmpty>没有装配层</TreeEmpty>);
        c.shell.props.render(
          <>
            <Sec>属性</Sec>
            <TreeEmpty>没有可选中的对象</TreeEmpty>
          </>,
        );
        c.shell.toolbar.setGroups([]);
        c.shell.timeline.setSteps([]);
        c.shell.setNext('成品 · 这个作品没有组装模板', null, '没有组装模板');
        return;
      }
      if (!unlocked(c)) {
        renderLocked();
        unsubs = [
          c.store.subscribe(() => {
            if (unlocked(c)) {
              // 解锁了（比如另一个标签页里验收通过）：重新挂载
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
        c.session.onHarness((t) => {
          const n = c.shell.props.el.querySelector('[data-k="hzSim"]');
          if (n) n.textContent = t.trim().replace(/\[tryboard\] /g, '模拟器：');
          else if (t.trim() && sel !== 'retest') renderProps();
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

/** 尺子标注用的 SVG 元素（命令式加进装配视图的 SVG） */
function svgEl(tag: string, attrs: Record<string, string | number>, text?: string) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}
