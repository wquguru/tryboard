// ② 实验台：构建树（零件 / 引脚 / 连线 / 供电 / 环境 / 固件 / 运行 / 检查点）+ 属性面板 + 检查点验收
// + 快捷卡片（P0-04）+ 针脚实时值与示波器（P0-11）+ 接线规则检查（P0-12）+ 尺子与运行历史（P0-13）。
// 点树和点台面（ScenePickApi.onPick）改的是同一个 selection；属性面板只跟着 selection 走。
// 面板由 React 画（选中变了整块重画）；实时读数（每帧）仍按 data-live 直接改文字，不经 React 状态。
import { openFwMenu } from "../fwmenu";
import { useState, type ReactNode } from "react";
import type { PickTarget, ScreenPoint } from "../../scene-api";
import { CHIP_HEAT_OFFSET } from "../../views/templates";
import {
  benchI2cWire,
  i2cBuses,
  partId,
  partInfo,
  usedPins,
  wiresOf,
  type WireMods,
} from "../wiring";
import { i2cLoad, i2cSay, i2cText } from "../harness";
import { checkWiring, faultByWire, type WireFault } from "../wirecheck";
import { applyCached, enrichFaults } from "../faultsolve";
import {
  PinTrace,
  bit,
  drawScope,
  meterVolts,
  pinKind,
  powerVolts,
  pwmText,
} from "../pinscope";
import { diffRuns, summarize, type BenchStep } from "../history";
import { checkCommand, type Level } from "../../checks";
import { Conf, confOfRule } from "../../ui/conf";
import { ResultCard, RunningCard, actCls } from "../../ui/result";
import { headline } from "../../ui/say";
import { VerifyStalled, verifyLevel } from "../../verify";
import { fetchBuf } from "../../assets";
import { servoAngle, ledCss } from "../../views/common";
import type {
  AppState,
  CheckOutcome,
  Selection,
  StepCtx,
  StepImpl,
  WorkDef,
} from "../types";
import { getAnalyzer } from "../analyzer";
import { extModelsOn, setExtModels } from "../../extmodels";
import {
  RECORD_SECONDS,
  recordCanvas,
  takePhoto,
  type Recording,
} from "../capture";
import { angDiff, gravity } from "../../imupose";
import { cn } from "../../ui/cn";
import { Live, useInitText } from "../../ui/native";
import {
  Bad,
  Brief,
  Btn,
  Btns,
  Code,
  Drop,
  Field,
  Kv,
  KvBox,
  KvT,
  Meter,
  Mono,
  LinkBtn,
  Muted,
  Note,
  Ok,
  Ph,
  Res,
  Sec,
  Seg,
  SegB,
  Slider,
  TnSt,
  TreeEmpty,
  TreeGroup,
  TreeNode,
} from "../../ui/panel";
import { noteSaved } from "../saved";
import { CHIP_NAME, chipOf, loadExamples, type AnalogControl, type Example } from "../examples";
import { HOME_WORKS, wkey } from "../works";
import { CustomCheckCard, CustomPlacedCard } from "../customui";
import { BuyCard, BuyDialog } from "../buycard";
import { actions, bc, overlay, setBc, setDock, type Issue } from "../chrome";
import { replay } from "../bom";
import { isPhone, phoneProps, setMui } from "../mobile";
import { bleFeed, phoneStateText, PhonePanel } from "../blepane";
import { setLeft } from "../leftcol";
import {
  buildPlaced,
  mergeMods,
  pinOk,
  placeConflict,
  placeDef,
  type PlaceDef,
} from "../place";
import {
  AllPassedCard,
  CheckpointCard,
  ConfBadge,
  EmptyBench,
  LIB_DRAG,
  MeterCard,
  PART_CONF,
  PartLib,
  PinRings,
  PlaceBanner,
  WireBanner,
  WireTable,
  WrongWireCard,
  type RingPin,
} from "../benchv2";
import { HOME, lab } from "../../ui/links";

const hex = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(2, "0");

/** 验收没跑完的关（Worker 出错 / 卡住）：不记成"未通过"，留着固件给「重试」 */
const stalled: Record<
  string,
  { why: string; buf: ArrayBuffer; who: string; own: boolean }
> = {};

/** 别的步骤（组装锁住卡）要「用内置固件走完全程」：先切到实验台，挂载后再跑 */
let pendingAllRef = false;
export function requestAllRef() {
  if (actions.runAllRef) return actions.runAllRef();
  pendingAllRef = true;
  location.hash = "bench";
}

/** 本页里用户自己验收过的固件（组装的"开机复测"用同一份固件；刷新后丢失，回落到台面上的固件） */
export const ownFirmware: Record<string, { buf: ArrayBuffer; name: string }> =
  {};

const PROGRESS_KEY = (work: string) => `tryboard-app-checks:${work}`;
function loadProgress(
  work: string,
): Record<string, { fp: string; at: string; own?: boolean }> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY(work)) ?? "{}");
  } catch {
    return {};
  }
}
function saveProgress(work: string, id: string, fp: string, own: boolean) {
  try {
    const p = loadProgress(work);
    // 参考固件的通过不覆盖自己的通过（旧记录没有 own 字段，当作自己的）
    if (!own && p[id] && p[id].own !== false) return;
    p[id] = {
      fp,
      at: new Date().toLocaleString("zh-CN", { hour12: false }),
      own,
    };
    localStorage.setItem(PROGRESS_KEY(work), JSON.stringify(p));
    noteSaved();
  } catch {
    /* 隐私模式存不了，进度只在本页有效 */
  }
}

/** 页面启动时把本机存过的进度放进 store（只记了通过与指纹，没有逐条结果） */
export function restoreChecks(ctx: StepCtx) {
  const p = loadProgress(wkey(ctx.work));
  const checks: Record<string, CheckOutcome> = {};
  for (const [id, v] of Object.entries(p))
    if (ctx.work.checkpoints.includes(id))
      checks[id] = {
        ok: true,
        own: v.own !== false,
        who:
          v.own !== false ? `你的固件（${v.at} 通过）` : `参考固件（${v.at} 跑通）`,
        rows: [],
        fingerprint: v.fp,
        sim: 0,
      };
  ctx.store.set({ checks });
}

/** 解锁组装 / 成品只看是否通过：参考固件跑通（◐）与自己的固件通过（✓）都算 */
export function passedCount(ctx: StepCtx, s: AppState = ctx.store.get()) {
  return ctx.work.checkpoints.filter((id) => s.checks[id]?.ok).length;
}

/** 用自己的固件通过的检查点数（界面上单独显示「我的固件 n/N」） */
export function ownCount(ctx: StepCtx, s: AppState = ctx.store.get()) {
  return ctx.work.checkpoints.filter(
    (id) => s.checks[id]?.ok && s.checks[id].own,
  ).length;
}

const selEq = (a: Selection | null, b: Selection | null) =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;
const toPick = (s: Selection | null): PickTarget | null =>
  s &&
  (s.kind === "part" ||
    s.kind === "pin" ||
    s.kind === "wire" ||
    s.kind === "button")
    ? { kind: s.kind, id: s.id }
    : null;

type NEv = Event & { currentTarget: HTMLInputElement };
/** 滑块旁的读数（同一个 label 里的 output） */
const outOf = (inp: HTMLInputElement) =>
  inp.parentElement?.querySelector("output");

/** OLED 实时画面（每帧由 updateLive 直接画） */
const OledCanvas = () => (
  <canvas
    className="oled mb-1 block w-full rounded-md bg-(--oled-bg) [image-rendering:pixelated]"
    width={128}
    height={64}
    data-live="oledc"
  />
);

/** 复制任务书：按钮文字由点击结果直接改（命令式，与原来一致） */
function CopyBrief({ onCopy }: { onCopy: (b: HTMLButtonElement) => void }) {
  const ref = useInitText<HTMLButtonElement>("复制任务书");
  return (
    <button
      ref={ref}
      type="button"
      id="copyBrief"
      className="btn hidden"
      onClick={(e) => onCopy(e.currentTarget)}
    />
  );
}

export function benchStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  const openGroups: Record<string, boolean> = {
    part: true,
    pin: false,
    wire: false,
    power: true,
    env: true,
    firmware: true,
    run: true,
    checkpoint: true,
    ble: true,
  };
  /** 选中的那根针的采样（示波器小窗） */
  const trace = new PinTrace();
  /** 空白实验台跑示例时（?example=）：右栏没选中东西就显示「这个示例」说明卡（DESIGN_V2 §6.1） */
  let exInfo: { ex: Example; work: WorkDef | null } | null = null;
  /** 选板作品：「摆好、连好了」说明卡关掉了；演示固件正在逐条验收 */
  let customClosed = false;
  let demoBusy = false;
  /** 本页刚跑出一条自己的通过：只有这时全过才自动弹真买卡（刷新后恢复进度、重放时间线都不弹） */
  let buyArmed = false;
  /** 尺子：工具条"尺子"按下后，台面上点两个目标 */
  let ruler: {
    a: PickTarget | null;
    b: PickTarget | null;
    mm: number | null;
  } | null = null;
  /** 万用表（P1-04）：工具条"万用表"按下后，台面上点一根针量对地电压 */
  let meter: { target: string | null } | null = null;
  /** 运行历史里点的第二条（和选中的那条对比） */
  let cmpRun: number | null = null;
  /** 快捷卡片跟着的目标 */
  let cardFor: PickTarget | null = null;
  let cardRaf = 0;
  /** 热源：放上去之前的室温（拿开时回到它） */
  let heatRoom: number | null = null;
  let faults: WireFault[] = [];
  let shownFaults = new Set<string>();
  /** 接线检查第几次（网络求解是异步的，回来时还是这一次才用） */
  let faultGen = 0;
  /** 开着的接错线卡片：估算到了重画它 */
  let wwShow: ((f: WireFault) => void) | null = null;
  /** 台面上画着的板针到板针跳线（P2-14） */
  let shownBridge = new Set<string>();
  /** ?debug=1&wiring= 只造一次 */
  let injected = false;
  /** 连线工具（U-04）：先点一根线，再点开发板上的新针；wire 是选中的那根 */
  let wiring: { wire: string | null } | null = null;
  /** 台面上画成改接过的线（和 wireMods.retarget 对齐） */
  let shownRewire = new Set<string>();
  /** 台面直接放零件（P2-16）：放下后逐根接线；接完才进场景（没接完的件不进模拟，也就不画） */
  let placing: {
    def: PlaceDef;
    cur: number;
    got: Record<string, string>;
    skipped: Set<string>;
  } | null = null;

  function select(sel: Selection | null) {
    // 从台面点中的东西，在构建树里展开它所在的分组
    if (sel && sel.kind in openGroups) openGroups[sel.kind] = true;
    // 选了别的东西：卡片和"量到芯片"的尺子标注收起（尺子工具自己管自己的标注）
    if (cardFor && !(sel && sel.kind === cardFor.kind && sel.id === cardFor.id))
      closeCard();
    if (!ruler) ctx!.session.pick.measure?.(null);
    ctx!.store.set({ selection: sel });
  }
  const benchWires = () =>
    wiresOf(
      ctx!.session.scene.parts,
      !!ctx!.session.power?.ext5v,
      ctx!.session.wireMods,
    );

  // ------------------------------------------------------------ 接线规则检查（P0-12）
  function recheckWiring() {
    const c = ctx!;
    const s3 = c.session.chip === "esp32s3";
    const fresh = checkWiring(c.session.scene.parts, benchWires());
    const cached = applyCached(fresh, s3);
    faults = cached.faults;
    const gen = ++faultGen;
    // 错接电流走 wasm 里的 elec 求解（P2-14）：第一次要实例化 wasm，算完补到面板和接错线卡片上
    if (!cached.done)
      void enrichFaults(fresh, s3)
        .then((fs) => {
          if (gen !== faultGen || !ctx) return;
          faults = fs;
          renderTree();
          renderProps();
          const f = wwShow && bc.get().overlays.wrongWire ? wwShow : null;
          if (f) f(faults[0]);
        })
        .catch((e) => console.warn("接线错误求解失败", e));
    const by = faultByWire(faults);
    for (const id of shownFaults)
      if (!by.has(id)) c.session.pick.setWireFault?.(id, null);
    for (const [id, f] of by) c.session.pick.setWireFault?.(id, f.short);
    shownFaults = new Set(by.keys());
    // 改接过的线在 3D 里挪到新针上；改回或被 setScene 重建的由 rewire 自己判断
    const moved = benchWires().filter((w) => w.from);
    const now = new Set(moved.map((w) => w.id));
    for (const id of shownRewire)
      if (!now.has(id)) c.session.pick.rewire?.(id, null);
    for (const w of moved) c.session.pick.rewire?.(w.id, w.a);
    shownRewire = now;
    const jumps = benchWires().filter((w) => w.part === "jumper");
    const nowJ = new Set(jumps.map((w) => w.id));
    for (const id of shownBridge)
      if (!nowJ.has(id)) c.session.pick.bridge?.(id, "", null);
    for (const w of jumps) c.session.pick.bridge?.(w.id, w.a, w.b);
    shownBridge = nowJ;
    // 问题页签：接线检查的结论（wire: 前缀；欠压那几条由 main.tsx 写）
    const issues: Issue[] = faults.map((f, i) => ({
      id: `wire:${f.rule}:${i}`,
      level: f.level,
      title: f.title,
      detail: f.short,
      go: () => select({ kind: "wire", id: f.wires[0] }),
    }));
    const keep = bc.get().issues.filter((x) => !x.id.startsWith("wire:"));
    if (
      JSON.stringify(issues.map((x) => [x.id, x.detail])) !==
      JSON.stringify(
        bc
          .get()
          .issues.filter((x) => x.id.startsWith("wire:"))
          .map((x) => [x.id, x.detail]),
      )
    )
      setBc({ issues: [...keep, ...issues] });
  }

  // ------------------------------------------------------------ 左栏：元件库、接线表、检查点卡（U-04）
  /** 检查点"带我去接"对准的东西：关卡判的那根针，没有针就是 I2C 器件 */
  function cpTarget(l: Level | undefined): Selection | null {
    if (!l) return null;
    const pin = l.pwm?.pin ?? l.gpio_toggles?.pin ?? l.ws2812?.pin;
    if (pin !== undefined) return { kind: "pin", id: `GPIO${pin}` };
    const parts = ctx!.session.scene.parts;
    if (
      (l.oled_min_pixels || l.expect?.length) &&
      parts.some((p) => p.type === "oled")
    )
      return { kind: "part", id: "oled" };
    if (l.numeric?.length && parts.some((p) => p.type === "bme280"))
      return { kind: "part", id: "bme280" };
    return null;
  }
  function renderLeft() {
    const c = ctx!;
    const s = c.store.get();
    const wires = benchWires();
    const bad = new Map<string, string>();
    for (const f of faults)
      for (const w of f.wires) if (!bad.has(w)) bad.set(w, f.short);
    const n = c.work.checkpoints.length;
    const d = passedCount(c, s);
    let card: ReactNode = null;
    if (c.custom)
      card = (
        <CustomCheckCard
          levels={c.custom.levels}
          done={d}
          total={n}
          state={(id) => {
            const r = s.checks[id];
            return s.verifying === id ? "run" : r?.ok ? (r.own ? "ok" : "ref") : r && !r.ok ? "bad" : "todo";
          }}
          onPick={(id) => select({ kind: "checkpoint", id })}
          onExport={exportCheckpoints}
          onBuy={n && d === n ? openBuy : null}
        />
      );
    else if (n && d === n)
      card = (
        <AllPassedCard total={n} own={ownCount(c, s)} retest={s.assembly?.retest} onNext={() => (location.hash = "assemble")} />
      );
    else if (n) {
      const id =
        c.work.checkpoints.find((x) => !s.checks[x]?.ok) ??
        c.work.checkpoints[0];
      const l = c.session.levels.find((x) => x.id === id);
      const t = cpTarget(l);
      card = (
        <CheckpointCard
          id={id}
          title={l?.title ?? ""}
          pass={l?.pass ?? ""}
          done={d}
          total={n}
          go={t ? (t.kind === "pin" ? t.id : partName(t.id)) : null}
          onGo={() => {
            select(t ?? { kind: "checkpoint", id });
            if (t)
              requestAnimationFrame(() => ctx?.session.bench.view?.("fit", t));
          }}
          onAll={() => setDock({ tab: "checks", collapsed: false })}
          own={ownCount(c, s)}
          allBusy={demoBusy || !!s.verifying}
          onAllRef={actions.runAllRef ?? null}
          onMine={() => select({ kind: "checkpoint", id })}
        />
      );
    }
    const sel = s.selection?.kind === "wire" ? s.selection.id : null;
    setLeft({
      lib: (
        <PartLib
          chip={c.session.chip === "esp32s3" ? "esp32s3" : "esp32c3"}
          inBom={new Set(replay(s.bom).picks.map((p) => p.partId))}
          onPlace={startPlace}
        />
      ),
      wires: (
        <WireTable
          wires={wires}
          bad={bad}
          sel={sel}
          onSel={(id) => select({ kind: "wire", id })}
        />
      ),
      wireCount: wires.length,
      card,
    });
  }

  // ------------------------------------------------------------ 连线工具（U-04）：改接一根线的开发板那一端
  function wireUi() {
    const c = ctx!;
    if (!wiring) {
      overlay("wire", null);
      overlay("rings", null);
      return;
    }
    const w = wiring.wire
      ? benchWires().find((x) => x.id === wiring!.wire)
      : null;
    const pickable = benchWires().filter((x) => !x.missing);
    overlay(
      "wire",
      <WireBanner
        wire={w ? `${w.b}（现在 ${w.a}）` : null}
        onCancel={() => setWiring(false)}
        wires={pickable.map((x) => ({ id: x.id, label: `${x.b} · ${x.a}` }))}
        onWire={(id) => {
          if (!wiring) return;
          wiring.wire = id;
          c.session.pick.highlight?.({ kind: "wire", id });
          wireUi();
        }}
        onUndo={bc.get().undo && actions.undo ? () => actions.undo?.() : null}
      />,
    );
    if (!w) return overlay("rings", null);
    const wires = benchWires().filter((x) => !x.missing);
    const pins: RingPin[] = (c.session.pick.listPins?.() ?? []).map((p) => ({
      ...p,
      used: wires.filter((x) => x.a === p.id && x.id !== w.id).map((x) => x.b),
    }));
    overlay(
      "rings",
      <PinRings
        pins={pins}
        cur={w.a}
        project={ringProject}
        onPin={(id) => retarget(w.id, id)}
      />,
    );
  }
  const ringProject = (id: string) =>
    ctx?.session.pick.project?.({ kind: "pin", id }) ?? null;
  function setWiring(on: boolean, wire: string | null = null) {
    const c = ctx!;
    if (on) {
      if (ruler) setRuler(false);
      if (meter) setMeter(false);
      closeCard();
    }
    wiring = on ? { wire } : null;
    c.shell.toolbar.setActive(on ? "wire" : "select");
    if (on && wire) c.session.pick.highlight?.({ kind: "wire", id: wire });
    else if (!on) c.session.pick.highlight?.(toPick(c.store.get().selection));
    wireUi();
  }
  /** 写一步改接线进时间线（不重新上电：模拟器里的器件仍按场景接法，改的是台面和接线检查） */
  function applyMods(mods: WireMods, label: string) {
    const c = ctx!;
    c.hist?.op({ k: "wiring", mods, scene: c.session.scene, label });
    c.session.setWireMods(mods);
    recheckWiring();
  }
  function retarget(wireId: string, to: string) {
    const c = ctx!;
    const prev = c.session.wireMods;
    const w = benchWires().find((x) => x.id === wireId);
    if (!w) return;
    const orig = w.from ?? w.a;
    if (to === w.a) {
      c.shell.toast(`${w.b} 本来就接在 ${to}`);
      return;
    }
    const rt = { ...prev.retarget };
    if (to === orig) delete rt[wireId];
    else rt[wireId] = to;
    applyMods({ ...prev, retarget: rt }, `${w.b} 改接 ${to}`);
    setWiring(false);
    select({ kind: "wire", id: wireId });
    const fs = faults.filter((f) => f.wires.includes(wireId));
    if (!fs.length) {
      c.shell.toast(
        to === orig
          ? `${w.b} 改回 ${to}，接线检查没发现问题`
          : `${w.b} 改接到 ${to}，接线检查没发现问题（模拟器里仍按原接法跑）`,
      );
      return;
    }
    showWrongWire(
      fs[0],
      wireId,
      `${w.b}：${w.a} → ${to}`,
      () => {
        applyMods(prev, `撤销 ${w.b} 改接`);
      },
      () => {
        applyMods(prev, `撤销 ${w.b} 改接`);
        setWiring(true, wireId);
      },
    );
  }
  /** 接错线卡片（U-04）；网络求解的估算异步到了会用同一根线的新结论重画（P2-14） */
  function showWrongWire(
    first: WireFault,
    wireId: string,
    label: string,
    undo: () => void,
    retry: () => void,
  ) {
    const close = () => {
      wwShow = null;
      overlay("wrongWire", null);
    };
    const show = (f: WireFault) =>
      overlay(
        "wrongWire",
        <WrongWireCard
          title={f.title}
          detail={f.detail}
          wire={label}
          estimate={f.estimate}
          sim={`可信度：${confOfRule(f.confidence)}（${f.confidence}）。模拟器里的器件仍按原来的接法跑，这里只做接线检查。`}
          onUndo={() => {
            close();
            undo();
          }}
          onRetry={() => {
            close();
            retry();
          }}
          onKeep={close}
        />,
      );
    wwShow = () => {
      const f = faults.find(
        (x) => x.wires.includes(wireId) && x.rule === first.rule,
      );
      if (f) show(f);
    };
    show(first);
  }

  // ------------------------------------------------------------ 台面直接放零件（P2-16）
  function startPlace(id: string) {
    const c = ctx;
    if (!c || c.store.get().step !== "bench") return;
    const d = placeDef(id);
    if ("why" in d) return c.shell.toast(d.why);
    const clash = placeConflict(d, c.session.scene);
    if (clash) return c.shell.toast(clash);
    if (wiring) setWiring(false);
    if (ruler) setRuler(false);
    if (meter) setMeter(false);
    closeCard();
    overlay("wrongWire", null);
    placing = { def: d, cur: 0, got: {}, skipped: new Set() };
    overlay("empty", null);
    c.shell.toolbar.setActive("place");
    placeUi();
  }
  function endPlace() {
    placing = null;
    overlay("place", null);
    overlay("rings", null);
    if (ctx) renderTree();
    ctx?.shell.toolbar.setActive("select");
  }
  function placeUi() {
    const c = ctx!;
    const p = placing;
    if (!p) return endPlace();
    const step = p.def.steps[p.cur];
    overlay(
      "place",
      <PlaceBanner
        name={p.def.name}
        steps={p.def.steps}
        cur={p.cur}
        got={p.got}
        onStep={(i) => {
          if (!placing) return;
          placing.cur = i;
          placing.skipped.delete(placing.def.steps[i].pin);
          placeUi();
        }}
        onSkip={
          step.optional
            ? () => {
                if (!placing) return;
                placing.skipped.add(step.pin);
                delete placing.got[step.pin];
                placeNext();
              }
            : null
        }
        onBack={
          p.cur > 0
            ? () => {
                if (!placing) return;
                placing.cur--;
                placeUi();
              }
            : null
        }
        onCancel={() => {
          endPlace();
          c.shell.toast(`没放 ${p.def.name}`);
        }}
      />,
    );
    const wires = benchWires().filter((x) => !x.missing);
    const pins: RingPin[] = (c.session.pick.listPins?.() ?? [])
      .filter((x) => pinOk(step.want, x.id))
      .map((x) => ({
        ...x,
        used: [
          ...wires.filter((w) => w.a === x.id).map((w) => w.b),
          ...Object.entries(p.got)
            .filter(([k, v]) => v === x.id && k !== step.pin)
            .map(([k]) => `${p.def.name} ${k}`),
        ],
      }));
    overlay(
      "rings",
      <PinRings
        pins={pins}
        cur={p.got[step.pin] ?? null}
        project={ringProject}
        onPin={placePin}
      />,
    );
  }
  function placePin(id: string) {
    const c = ctx!;
    const p = placing;
    if (!p) return;
    const step = p.def.steps[p.cur];
    if (!pinOk(step.want, id))
      return c.shell.toast(
        step.want === "gnd"
          ? `${step.label} 要接 GND`
          : step.want === "power"
            ? `${step.label} 要接 3V3 或 5V`
            : `${step.label} 要接一根 GPIO`,
      );
    // 同一个零件的两根信号线接到同一根 GPIO（SDA、SCL 接一起）没有意义：直接拦
    const dup = Object.entries(p.got).find(([k, v]) => v === id && k !== step.pin);
    if (step.want === "gpio" && dup)
      return c.shell.toast(`${id} 已经接了 ${p.def.name} 的 ${dup[0]}`);
    p.got[step.pin] = id;
    placeNext();
  }
  function placeNext() {
    const p = placing;
    if (!p) return;
    const next = p.def.steps.findIndex(
      (s) => !p.got[s.pin] && !p.skipped.has(s.pin),
    );
    if (next >= 0) {
      p.cur = next;
      return placeUi();
    }
    finishPlace();
  }
  function finishPlace() {
    const c = ctx!;
    const p = placing!;
    const ext5v = !!c.session.power?.ext5v;
    const { spec, retarget } = buildPlaced(p.def, p.got, ext5v);
    const pid = partId(spec);
    if (c.session.scene.parts.some((x) => partId(x) === pid)) {
      // LED / 按键按引脚区分：同一根 GPIO 上已经有一颗了
      const i = p.def.steps.findIndex((s) => s.want === "gpio");
      c.shell.toast(`${p.got[p.def.steps[i].pin]} 上已经有一个${p.def.name}了：换一根 GPIO`);
      delete p.got[p.def.steps[i].pin];
      p.cur = i;
      return placeUi();
    }
    const sum = p.def.steps
      .filter((s) => p.got[s.pin] && s.want === "gpio")
      .map((s) => `${s.pin}→${p.got[s.pin]}`)
      .join(" ");
    endPlace();
    c.session.applyScene(
      { ...c.session.scene, parts: [...c.session.scene.parts, spec] },
      c.session.power ?? { ext5v: false },
      `放 ${p.def.name}${sum ? `（${sum}）` : ""}`,
    );
    const rt = Object.entries(retarget);
    if (rt.length)
      applyMods(
        mergeMods(c.session.wireMods, retarget),
        `${p.def.name} 电源接 ${rt.map(([, v]) => v).join("、")}`,
      );
    recheckWiring();
    renderLeft();
    select({ kind: "part", id: pid });
    const fs = faults.filter((f) => f.wires.some((w) => w.includes(`~${pid}:`)));
    c.shell.toast(
      fs.length
        ? `已放 ${p.def.name}：接线检查发现「${fs[0].title}」，看问题页签`
        : `已放 ${p.def.name}，接线检查没发现问题`,
    );
  }

  // ------------------------------------------------------------ 构建树
  function renderTree() {
    const c = ctx!;
    const s = c.store.get();
    const ses = c.session;
    const parts = ses.scene.parts;
    const wires = benchWires();
    const byWire = faultByWire(faults);
    const item = (
      sel: Selection,
      label: ReactNode,
      meta: ReactNode = "",
      status: ReactNode = null,
    ) => (
      <TreeNode
        key={`${sel.kind}:${sel.id}`}
        on={selEq(s.selection, sel)}
        data-kind={sel.kind}
        data-id={sel.id}
        label={label}
        meta={meta}
        st={status}
        onClick={() => {
          select(sel);
          phoneProps();
        }}
      />
    );
    const group = (
      key: string,
      title: string,
      count: ReactNode,
      body: ReactNode,
    ) => (
      <TreeGroup
        g={key}
        title={title}
        count={count}
        open={!!openGroups[key]}
        onToggle={(o) => (openGroups[key] = o)}
      >
        {body}
      </TreeGroup>
    );
    const board =
      ses.chip === "esp32s3" ? "ESP32-S3-DevKitC-1" : "ESP32-C3-DevKitM-1";
    const partItems = [
      item(
        { kind: "part", id: "board" },
        board,
        ses.chip === "esp32s3" ? "S3" : "C3",
      ),
      ...parts.map((p) =>
        item(
          { kind: "part", id: partId(p) },
          partInfo(p).name,
          p.type === "bme280" || p.type === "oled"
            ? hex(p.addr)
            : "pin" in p
              ? `GPIO${p.pin}`
              : p.type === "encoder"
                ? `GPIO${p.a}/${p.b}`
                : p.type === "hcsr04"
                  ? `GPIO${p.trig}/${p.echo}`
                  : "",
        ),
      ),
    ];
    // 引脚：只列用到的针（接了线的 + 板上自带用途的，如 BOOT、板载彩灯）
    const pinInfo = ses.pick.listPins?.() ?? [];
    const used = new Set(usedPins(wires));
    const pins = pinInfo.filter((p) => used.has(p.id) || p.role);
    const pinItems = pins.length ? (
      pins.map((p) =>
        item(
          { kind: "pin", id: p.id },
          <Mono>{p.id}</Mono>,
          p.role ?? wires.find((w) => w.a === p.id)?.role ?? "",
        ),
      )
    ) : (
      <TreeEmpty>没有用到的引脚</TreeEmpty>
    );
    const wireItems = wires.length ? (
      wires.map((w) =>
        item(
          { kind: "wire", id: w.id },
          `${w.a} → ${w.b}`,
          w.color,
          byWire.has(w.id) ? <TnSt kind="bad">✗</TnSt> : null,
        ),
      )
    ) : (
      <TreeEmpty>没有外接线</TreeEmpty>
    );
    const nBad = new Set(faults.flatMap((f) => f.wires)).size;
    const wireCount = nBad ? (
      <Bad>{`${wires.length} · ${faults.length} 处问题`}</Bad>
    ) : (
      `${wires.length} · ✓`
    );
    const env = s.env;
    const cps = c.work.checkpoints.map((id) => {
      const l = ses.levels.find((x) => x.id === id);
      const r = s.checks[id];
      const st =
        s.verifying === id ? (
          <TnSt kind="run">…</TnSt>
        ) : r ? (
          r.ok ? (
            <TnSt kind="ok">{r.own ? "✓" : "◐"}</TnSt>
          ) : (
            <TnSt kind="bad">✗</TnSt>
          )
        ) : null;
      return item(
        { kind: "checkpoint", id },
        <>
          <Mono>{id}</Mono> {l?.title ?? ""}
        </>,
        "",
        st,
      );
    });
    const runs = c.hist?.runs() ?? [];
    const runItems = runs.length ? (
      runs.map((r) =>
        item(
          { kind: "run", id: String(r.n) },
          `运行 #${r.n}`,
          r.snap ? `${r.snap.simSeconds.toFixed(1)} s` : "运行中",
          r.n === s.runNo && s.hist.seeked ? <TnSt kind="run">◂</TnSt> : null,
        ),
      )
    ) : (
      <TreeEmpty>还没运行过</TreeEmpty>
    );
    const ext = !!ses.power?.ext5v;
    const hasServo = parts.some((p) => p.type === "servo");
    c.shell.tree.render(
      <div role="group" aria-label="构建树">
        {group("part", "零件", String(parts.length + 1), partItems)}
        {group("pin", "引脚", String(pins.length), pinItems)}
        {group("wire", "连线", wireCount, wireItems)}
        {group(
          "power",
          "供电",
          ext ? "USB 和外接" : "USB",
          <>
            {item({ kind: "power", id: "usb" }, "USB 5 V（电脑）", "5V")}
            {ext
              ? item(
                  { kind: "power", id: "ext5v" },
                  "外接 5 V 2 A（舵机）",
                  "EXT5V",
                )
              : hasServo
                ? item(
                    { kind: "power", id: "ext5v" },
                    <Muted>外接 5 V（没接）</Muted>,
                    "",
                  )
                : null}
          </>,
        )}
        {group(
          "env",
          "环境",
          "",
          item(
            { kind: "env", id: "room" },
            "室内",
            <Mono>{`${env.temp.toFixed(1)} °C`}</Mono>,
            ses.heat ? <TnSt kind="bad">热</TnSt> : null,
          ),
        )}
        {bleFeed.get().state !== 0 &&
          group(
            "ble",
            "无线",
            "",
            item(
              { kind: "ble", id: "phone" },
              "虚拟手机",
              phoneStateText(bleFeed.get()),
              bleFeed.get().state === 2 ? <TnSt kind="warn">!</TnSt> : null,
            ),
          )}
        {group(
          "firmware",
          "固件",
          "",
          ses.fwName
            ? item(
                { kind: "firmware", id: "main" },
                ses.fwName,
                ses.fwSize ? `${(ses.fwSize / 1024).toFixed(0)} KB` : "",
              )
            : item(
                { kind: "firmware", id: "main" },
                "还没有固件",
                "拖 .bin 进来",
              ),
        )}
        {group("run", "运行历史", String(runs.length), runItems)}
        {c.work.checkpoints.length
          ? group(
              "checkpoint",
              "检查点",
              `${passedCount(c, s)}/${c.work.checkpoints.length}`,
              cps,
            )
          : null}
      </div>,
    );
    renderLeft();
    // 空台面引导：只有开发板、没摆零件（空白实验台刚打开）
    overlay(
      "empty",
      // 放零件接线时让开（引导卡片会盖住开发板上的针）
      parts.length || placing ? null : (
        <EmptyBench
          hasFw={!!ses.fwName}
          onFirmware={openFwMenu}
        />
      ),
    );
    // 选板作品：自动摆好之后先说明摆了什么、下一步放固件（上过固件、关掉、在放零件时不挡台面）
    if (c.custom)
      overlay(
        "customPlaced",
        parts.length && !placing && !customClosed && !ses.fwBuf ? (
          <CustomPlacedCard
            n={parts.length}
            sub={c.custom.plan.sub}
            demo={c.custom.plan.demo}
            busy={demoBusy}
            onFirmware={openFwMenu}
            onBrief={() => void actions.brief?.()}
            onDemo={() => void runDemo()}
            onClose={() => {
              customClosed = true;
              renderTree();
            }}
          />
        ) : null,
      );
  }

  // ------------------------------------------------------------ 属性面板
  /** 停在回退点时，属性面板顶上的一条：回到了哪、指纹对不对、从这里继续 */
  function seekBanner(): ReactNode {
    const c = ctx!;
    const h = c.store.get().hist;
    const cls =
      "seekbar mt-2.5 mb-1 flex flex-col gap-[3px] rounded-lg border border-accent-line bg-accent-bg px-2.5 py-2 text-xs [&_.btns]:mt-1 [&>b]:text-[13px] [&>b]:font-medium [&>b]:text-fg";
    if (h.busy)
      return (
        <div className={cls}>
          <b>正在回退…</b>
          <Live k="sim" className="font-mono" />
          <Muted>按记录重放</Muted>
        </div>
      );
    const r = c.hist?.lastSeek();
    if (!h.seeked || !r) return null;
    const same =
      r.same === null ? (
        <Muted>
          同一次运行里后面还有操作：停在下一步发生之前，所以不和整次运行比对
        </Muted>
      ) : r.same ? (
        <Ok>✓ 和当时一模一样</Ok>
      ) : (
        <Bad>✗ 和当时不一样</Bad>
      );
    return (
      <div className={cls} data-seek={r.run}>
        <b>{`回到运行 #${r.run} 的 ${(r.untilMs / 1000).toFixed(2)} s · 已暂停`}</b>
        <Mono>运行编号 {r.fingerprint}</Mono>
        {same}
        <Btns>
          <Btn primary id="resume" onClick={() => c.hist?.resume()}>
            从这里继续
          </Btn>
          <Btn id="seekRerun" onClick={() => c.session.reboot()}>
            重新上电
          </Btn>
        </Btns>
        <Muted>接着改、接着跑，后面的步骤会被丢掉</Muted>
      </div>
    );
  }

  /** 属性面板整块换内容（顶上带回退条），之后补一次实时字段 */
  function show(body: ReactNode, live = true) {
    ctx!.shell.props.render(
      <>
        {seekBanner()}
        {body}
      </>,
    );
    if (live) updateLive();
  }

  function renderProps() {
    const c = ctx!;
    const s = c.store.get();
    const sel = s.selection;
    if (!sel && exInfo) renderExample();
    else if (!sel)
      show(
        <>
          <Sec>属性</Sec>
          <TreeEmpty>点左边的构建树或台面上的零件</TreeEmpty>
        </>,
        false,
      );
    else if (sel.kind === "checkpoint") renderCheckpoint(sel.id);
    else if (sel.kind === "env") renderEnv();
    else if (sel.kind === "firmware") renderFirmware();
    else if (sel.kind === "power") renderPower(sel.id);
    else if (sel.kind === "wire") renderWire(sel.id);
    else if (sel.kind === "pin") renderPin(sel.id);
    else if (sel.kind === "button") renderButton(sel.id);
    else if (sel.kind === "run") renderRuns(Number(sel.id));
    else if (sel.kind === "tool")
      sel.id === "meter" ? renderMeter() : renderRuler();
    // 虚拟手机自己订阅 bleFeed 刷新，属性面板只在选中时挂一次
    else if (sel.kind === "ble")
      show(<PhonePanel send={(cmd) => actions.ble?.(cmd)} />, false);
    else renderPart(sel.id);
  }

  /** 供电网络的实时读数（tryboard-elec 的节点电压 / 电流；本次上电以来的最低 / 峰值 / 复位次数） */
  const elecRows = (
    ext: boolean,
    hasServo: boolean,
    hasAmp = ctx!.session.scene.parts.some((p) => p.type === "max98357a"),
  ) => (
    <>
      <Sec>供电 · 实时</Sec>
      <Kv k="5V 轨" live="e5" />
      <Kv k="3V3" live="e33" />
      <Kv k="3V3 最低（本次上电）" live="emin" />
      <Kv k="USB 电流" live="eiu" />
      <Kv k="USB 峰值电流" live="epu" />
      {ext && <Kv k="外接 5 V" live="eext" />}
      {hasServo && (
        <>
          <Kv k="舵机电流" live="eis" />
          <Kv k="舵机峰值电流" live="eps" />
        </>
      )}
      {hasAmp && <Kv k="功放电流（5 V，随音量）" live="eia" />}
      <Kv k="欠压复位" live="ers" />
      <Kv k="可信度" v="估算" />
    </>
  );
  /** 舵机供电二选一（属性面板、快捷卡片共用） */
  const powerSeg = (ext: boolean) => (
    <Seg aria-label="舵机供电">
      <SegB data-power="usb" on={!ext} onClick={() => setPower(false)}>
        USB 5 V
      </SegB>
      <SegB data-power="ext" on={ext} onClick={() => setPower(true)}>
        外接 5 V 2 A
      </SegB>
    </Seg>
  );
  function renderPower(id: string) {
    const c = ctx!;
    const ext = !!c.session.power?.ext5v;
    const hasServo = c.session.scene.parts.some((p) => p.type === "servo");
    const toggle = hasServo ? (
      <>
        <Sec>舵机从哪取电</Sec>
        {powerSeg(ext)}
        <Note>
          运行中可切换。选外接后，采购清单会加上 5 V 2 A 电源和 DC 母座。
        </Note>
      </>
    ) : null;
    show(
      id === "ext5v" ? (
        <>
          <Sec>供电</Sec>
          <Ph>外接 5 V 2 A</Ph>
          {ext ? (
            <>
              <KvT k="来源">
                5 V 2 A 电源适配器经 DC 母座接到面包板电源轨，内阻约 0.15
                Ω（估算）
              </KvT>
              <KvT k="给谁">舵机；地线和开发板 GND 接在一起</KvT>
            </>
          ) : (
            <Note>还没接外接电源，舵机从 USB 5V 取电。</Note>
          )}
          {ext ? <Kv k="电压" live="eext" /> : <Kv k="电压" v="—" />}
          {elecRows(ext, hasServo)}
          {toggle}
        </>
      ) : (
        <>
          <Sec>供电</Sec>
          <Ph>USB 5 V（电脑）</Ph>
          <KvT k="来源">
            USB-C 接电脑，5 V，限流约 0.5 A（USB 2.0 规范值）；接口内阻加 1 m
            线阻约 0.5 Ω（估算）
          </KvT>
          <KvT k="3V3">
            板载 LDO SGM2212，800 mA 时压差 420 mV，给芯片、BME280、OLED
            供电；低于 2.44 V 欠压复位（IDF 默认档）
          </KvT>
          <KvT k="5V 轨">
            {ext
              ? "只给开发板；舵机走外接 5 V"
              : hasServo
                ? "直通 USB，舵机也从这里取电"
                : "直通 USB"}
          </KvT>
          {elecRows(ext, hasServo)}
          {!ext && hasServo && (
            <Note bad>
              舵机只靠 USB 时，起步电流约 0.7 A，超过 0.5 A 限流，5V 轨掉到约
              3.5 V（估算）。大幅来回扫、没转到位就反向，5V 轨会被拉垮，3V3 跌破
              2.44 V 后欠压复位，串口打出 rst:0xf。
            </Note>
          )}
          {toggle}
        </>
      ),
    );
  }
  function setPower(ext: boolean) {
    const c = ctx!;
    if (!!c.session.power?.ext5v === ext) return;
    c.hist?.op({ k: "power", ext5v: ext });
    c.session.setPower(ext);
    c.shell.toast(
      ext
        ? "舵机改由外接 5 V 2 A 供电，采购清单加上了电源适配器和 DC 母座"
        : "舵机改回 USB 5 V 供电，采购清单去掉了外接电源",
    );
  }

  function renderWire(id: string) {
    const c = ctx!;
    const w = benchWires().find((x) => x.id === id);
    if (!w) {
      show(
        <>
          <Sec>连线</Sec>
          <Ph mono>{id}</Ph>
        </>,
        false,
      );
      return;
    }
    const fs = faults.filter((f) => f.wires.includes(id));
    const power = w.part === "servo" && w.pinRole === "power";
    // I2C 线可以拉长（P2-11）：同一条总线上所有模块的 SDA 线加起来算总线电容
    const bus =
      w.pinRole === "bus"
        ? i2cBuses(c.session.scene.parts, benchWires()).find((b) =>
            b.parts.includes(w.part),
          )
        : undefined;
    const others = bus ? bus.wireCm - w.lenCm : 0;
    const lenEl = bus ? (
      <>
        <Sec>线长 · 估算，必须上真机</Sec>
        <Slider
          id="wireLen"
          outId="wireLenV"
          min={5}
          max={150}
          step={1}
          defaultValue={w.lenCm}
          aria-label={`${partInfo(c.session.scene.parts.find((p) => partId(p) === w.part)!).name} 的线长`}
          out={`${w.lenCm} cm`}
          on={{
            input: (e) => {
              const v = Number(e.currentTarget.value);
              const props = c.shell.props.el;
              props.querySelector("#wireLenV")!.textContent = `${v} cm`;
              const l = i2cLoad(others + v, bus.parts.length);
              props.querySelector("#wireLenSay")!.textContent = i2cSay(l);
              props.querySelector("#wireLenNote")!.textContent = i2cText(l);
            },
            change: (e) => setWireLen(w.part, Number(e.currentTarget.value)),
          }}
        />
        <Kv
          k="这条总线"
          v={`${bus.parts.length} 个模块 · SDA 共 ${bus.wireCm.toFixed(0)} cm`}
        />
        <SayLive
          id="wireLenSay"
          init={i2cSay(i2cLoad(bus.wireCm, bus.parts.length))}
        />
        <NoteLive
          id="wireLenNote"
          init={i2cText(i2cLoad(bus.wireCm, bus.parts.length))}
        />
      </>
    ) : null;
    show(
      <>
        <Sec>连线</Sec>
        <Ph>{`${w.a} → ${w.b}`}</Ph>
        <Kv k="作用" v={w.role} />
        <Kv k="颜色" v={w.color + "色杜邦线"} />
        <Kv k="开发板一端" v={w.a} cls={w.from ? "bad" : ""} />
        {w.from && <Kv k="原来接在" v={w.from} />}
        <Kv k="零件一端" v={w.b} />
        {w.ohm !== undefined && (
          <Kv
            k="限流电阻"
            v={w.ohm ? `${w.ohm} Ω` : "没有"}
            cls={w.ohm ? "" : "bad"}
          />
        )}
        {w.missing && <Kv k="状态" v="没插上" cls="bad" />}
        <Sec>{fs.length ? `接线检查 · ${fs.length} 处问题` : "接线检查"}</Sec>
        {fs.length ? fs.map(faultEl) : <Res kind="ok">这根线没发现问题</Res>}
        {lenEl}
        {power && powerInline()}
      </>,
      false,
    );
  }

  /** 拉长 / 缩短一个模块的线（进时间线；模拟器里在线换总线负载，固件下一次读就受影响） */
  function setWireLen(part: string, cm: number) {
    const c = ctx!;
    const ses = c.session;
    const mods: WireMods = {
      ...ses.wireMods,
      lenCm: { ...ses.wireMods.lenCm, [part]: cm },
    };
    const name = partInfo(
      ses.scene.parts.find((p) => partId(p) === part)!,
    ).name;
    c.hist?.op({
      k: "wiring",
      mods,
      scene: ses.scene,
      label: `${name} 线长 ${cm} cm`,
    });
    ses.setWireMods(mods);
    applyBenchHarness();
  }

  /** 实验台的线束交给模拟器：只在改过线长时才算总线负载；天线在面包板上没有遮挡 */
  function applyBenchHarness() {
    const ses = ctx!.session;
    const cm = benchI2cWire(ses.scene.parts, ses.wireMods);
    const h: { i2cWire?: number; antenna?: number } = {};
    if ((ses.harness.i2cWire ?? -1) !== cm) h.i2cWire = cm;
    if ((ses.harness.antenna ?? 0) !== 0) h.antenna = 0;
    if (Object.keys(h).length) ses.setHarness(h);
  }
  const faultEl = (f: WireFault, i: number) => (
    <Res key={i} kind="bad">
      <b>{f.title}</b> · {f.detail}
      {f.estimate && (
        <span
          data-est={f.rule}
          className="mt-1 flex flex-wrap items-center gap-1.5"
        >
          <b className="font-mono">≈ {f.estimate.mA} mA</b>
          <ConfBadge c="估算" />
          <span>{f.estimate.text}</span>
        </span>
      )}
      <br />
      <Muted className="inline-flex flex-wrap items-center gap-1">
        <Conf c={confOfRule(f.confidence)} /> · {f.source}
      </Muted>
    </Res>
  );
  const powerInline = () => (
    <>
      <Sec>舵机从哪取电</Sec>
      {powerSeg(!!ctx!.session.power?.ext5v)}
    </>
  );

  // ------------------------------------------------------------ 针脚（P0-11）
  function renderPin(id: string) {
    const c = ctx!;
    const pin = c.session.pick.listPins?.().find((p) => p.id === id);
    const wires = benchWires().filter((w) => w.a === id && !w.missing);
    const kind = pinKind(id, wires);
    const gpio = /^GPIO(\d+)$/.exec(id);
    trace.watch(gpio ? Number(gpio[1]) : -1);
    const to = wires.map((w) => `${partName(w.part)} · ${w.pin}`).join("；");
    const fs = faults.filter((f) =>
      f.wires.some((x) => wires.some((w) => w.id === x)),
    );
    show(
      <>
        <Sec>引脚</Sec>
        <Ph mono>{id}</Ph>
        <Kv k="丝印" v={pin?.label ?? id} />
        <Kv k="角色" v={pin?.role ?? (wires[0]?.role || "没接东西")} />
        {to && <KvT k="接到">{to}</KvT>}
        <Sec>实时值</Sec>
        {kind === "gpio" ? (
          <>
            <Kv k="方向" live="pdir" />
            <Kv k="电平" live="plv" />
            <Kv k="PWM 频率" live="pf" />
            <Kv k="脉宽" live="pw2" />
            <Kv k="占空比" live="pd" />
          </>
        ) : kind === "i2c" ? (
          <>
            <Kv
              k="I2C 角色"
              v={wires
                .map(
                  (w) =>
                    `${w.pin === "SDA" ? "SDA 数据" : "SCL 时钟"} → ${partName(w.part)}`,
                )
                .join("；")}
            />
            <Kv k="电平" live="plv" />
            <Kv k="总线" v="开漏，模块上拉到 3V3" />
          </>
        ) : (
          <>
            <Kv
              k="电压"
              live="pv"
              v={powerVolts(id, !!c.session.power?.ext5v, c.session.frame.elec)}
            />
            {id === "3V3" && <Kv k="最低（本次上电）" live="emin" />}
            <Kv k="可信度" v="估算" />
          </>
        )}
        <Sec>示波器</Sec>
        <canvas
          className="scope block h-24 w-full rounded-md border border-line bg-(--scope-bg)"
          data-live="scope"
          width={280}
          height={96}
          aria-label={`${id} 波形`}
        />
        <Live as="p" k="scopeNote" className="note my-2 text-xs text-muted" />
        {(kind === "gpio" || kind === "i2c") && (
          <>
            <Btns>
              <Btn data-ana={id} onClick={() => getAnalyzer(c).open(id)}>
                在分析仪里打开
              </Btn>
            </Btns>
            <Note>
              {kind === "i2c"
                ? "逻辑分析仪按 I2C 事务解码（起始、地址、每个字节和应答），带寄存器注释。"
                : "逻辑分析仪里能看电平变化和 PWM 占空比、频率，波形精确到时钟周期。"}
            </Note>
          </>
        )}
        {fs.length > 0 && (
          <>
            <Sec>接线检查</Sec>
            {fs.map(faultEl)}
          </>
        )}
      </>,
    );
  }
  /** BOOT 键接的 GPIO：C3 是 GPIO9，S3 是 GPIO0 */
  const bootGpio = () => (ctx!.session.chip === "esp32s3" ? 0 : 9);
  const partName = (pid: string) => {
    const p = ctx!.session.scene.parts.find((x) => partId(x) === pid);
    return p ? partInfo(p).name : pid;
  };

  /** 按下 / 松开 BOOT：两个按钮的按下态直接改属性（不重画面板） */
  const pressBootBtn = (
    e: React.MouseEvent<HTMLButtonElement>,
    down: boolean,
  ) => {
    ctx!.session.pressBoot(down);
    e.currentTarget
      .parentElement!.querySelectorAll<HTMLButtonElement>("[data-boot]")
      .forEach((x) =>
        x.setAttribute(
          "aria-pressed",
          String((x.dataset.boot === "down") === down),
        ),
      );
    ctx!.shell.toast(
      down
        ? `BOOT 按下了（GPIO${bootGpio()} 接地），点「松开」松手`
        : "BOOT 松开了",
    );
  };
  const bootBtns = () => (
    <Btns>
      <Btn data-boot="down" onClick={(e) => pressBootBtn(e, true)}>
        按下
      </Btn>
      <Btn data-boot="up" onClick={(e) => pressBootBtn(e, false)}>
        松开
      </Btn>
    </Btns>
  );

  function renderButton(id: string) {
    const c = ctx!;
    show(
      <>
        <Sec>按键</Sec>
        <Ph mono>{id}</Ph>
        <Kv
          k="接了"
          v={id === "BOOT" ? `GPIO${bootGpio()}，按下接地` : "EN，松开重新上电"}
        />
        {id === "BOOT" ? (
          bootBtns()
        ) : (
          <Btns>
            <Btn id="rstBtn" onClick={() => c.session.reboot()}>
              按一下 RST
            </Btn>
          </Btns>
        )}
      </>,
      false,
    );
  }

  // ------------------------------------------------------------ 运行历史（P0-13）
  function renderRuns(n: number) {
    const c = ctx!;
    const runs = c.hist?.runs() ?? [];
    const a = runs.find((r) => r.n === n);
    if (!a) {
      show(
        <>
          <Sec>运行历史</Sec>
          <TreeEmpty>没有运行 #{n}</TreeEmpty>
        </>,
        false,
      );
      return;
    }
    const sa = summarize(a);
    const b =
      cmpRun !== null && cmpRun !== n
        ? runs.find((r) => r.n === cmpRun)
        : undefined;
    const list = runs.map((r) => {
      const x = summarize(r);
      const tag = r.n === n ? "A" : r.n === cmpRun ? "B" : "";
      return (
        <button
          key={r.n}
          type="button"
          className={cn(
            "runrow flex cursor-pointer items-start gap-2 rounded-md border border-line-soft bg-field px-2 py-1.5 text-left text-xs text-fg hover:border-hover-line",
            tag && "on border-accent-line bg-accent-bg",
          )}
          data-run={r.n}
          onClick={() => {
            if (r.n === n) return;
            cmpRun = r.n;
            renderProps();
          }}
        >
          <span className="rk w-3 flex-none font-mono font-medium text-accent-ink">
            {tag || "·"}
          </span>
          <span className="rt min-w-0 break-all">
            <b className="font-medium">运行 #{r.n}</b> <Muted>{x.fw}</Muted>
            <br />
            <Mono>{x.env0}</Mono> · {x.power}
            <br />
            <span className="fp font-mono text-[11px] text-muted">
              {x.fingerprint}
            </span>
          </span>
        </button>
      );
    });
    let cmp: ReactNode = null;
    if (b) {
      const d = diffRuns(sa, summarize(b));
      const nCh = d.filter((x) => x.changed).length;
      const drow =
        "drow grid grid-cols-[72px_1fr_1fr] gap-1.5 rounded-md bg-field px-2 py-1 [&>span]:min-w-0 [&>span]:[overflow-wrap:anywhere]";
      cmp = (
        <>
          <Sec>{`${nCh} 项不同（标 ≠）`}</Sec>
          <div className="diff flex flex-col gap-0.5 text-xs">
            <div
              className={cn(
                drow,
                "hd bg-transparent py-0 text-[11px] text-muted",
              )}
            >
              <span className="k" />
              <span>A #{a.n}</span>
              <span>B #{b.n}</span>
            </div>
            {d.map((x) => {
              const mono =
                x.key === "fingerprint" || x.key === "result"
                  ? "font-mono text-[11px]"
                  : "";
              return (
                <div
                  key={x.key}
                  className={cn(drow, x.changed && "ch bg-(--ch-bg)")}
                >
                  <span
                    className={cn(
                      "k text-muted",
                      x.changed && "font-medium text-warn-ink",
                    )}
                  >
                    {x.changed ? "≠ " : ""}
                    {x.label}
                  </span>
                  <span className={mono}>{x.a}</span>
                  <span className={mono}>{x.b}</span>
                </div>
              );
            })}
          </div>
        </>
      );
    }
    const step = (c.hist?.steps() ?? []).findIndex(
      (s: BenchStep) => s.op.k === "run" && s.op.n === n,
    );
    // 有对比时先给差异项（结论先说），单条详情收进下面的列表
    const detail = b ? null : (
      <>
        <Kv k="固件" v={sa.fw} />
        <Kv k="上电时环境" v={sa.env0} />
        <Kv k="运行中改环境" v={`${sa.envChanges} 次`} />
        <Kv k="供电" v={sa.power} />
        <Kv k="热源" v={sa.heat} />
        <Kv k="模拟时长" v={sa.seconds} />
        <KvT k="最后一行">
          <Mono>{sa.result}</Mono>
        </KvT>
        <Kv k="运行编号" v={sa.fingerprint} cls="fp" />
      </>
    );
    show(
      <>
        <Sec>运行历史</Sec>
        <Ph>
          运行 #{a.n}
          {b ? ` ↔ 运行 #${b.n}` : ""}
        </Ph>
        {detail}
        {cmp}
        <Btns>
          <Btn
            id="gotoRun"
            disabled={step < 0}
            onClick={() => step >= 0 && c.hist?.seek(step)}
          >
            回到运行 #{a.n}
          </Btn>
          {b && (
            <Btn
              id="cmpOff"
              onClick={() => {
                cmpRun = null;
                renderProps();
              }}
            >
              不对比
            </Btn>
          )}
        </Btns>
        <Sec>全部运行 · 点一条和 A 对比</Sec>
        <div className="runs flex flex-col gap-1">{list}</div>
      </>,
      false,
    );
  }

  // ------------------------------------------------------------ 万用表（P1-04）
  function renderMeter() {
    const m = meter;
    const pickPin = (t: string) => {
      meter = { target: t };
      renderMeter();
      meterCard();
    };
    show(
      <>
        <Sec>万用表 · 直流电压</Sec>
        <Ph>
          {m?.target ? (
            <>
              <Mono>{m.target}</Mono> 对 GND
            </>
          ) : (
            "点台面上的一个引脚"
          )}
        </Ph>
        <Meter />
        <Live
          as="p"
          k="mnote"
          init="黑表笔接 GND，红表笔点电源脚或信号脚。读数为估算。"
          className="note my-2 text-xs text-muted"
        />
        <Kv k="3V3 最低（本次上电）" live="emin" />
        <Kv k="欠压复位" live="ers" />
        <Btns>
          <Btn data-mpin="3V3" onClick={() => pickPin("3V3")}>
            量 3V3
          </Btn>
          <Btn data-mpin="5V" onClick={() => pickPin("5V")}>
            量 5V
          </Btn>
          {ctx!.session.scene.parts.some((p) => p.type === "servo") && (
            <Btn data-mpin="servo:VCC" onClick={() => pickPin("servo:VCC")}>
              量舵机红线
            </Btn>
          )}
        </Btns>
      </>,
    );
  }
  function setMeter(on: boolean) {
    const c = ctx!;
    if (on && ruler) setRuler(false);
    if (on && wiring) setWiring(false);
    meter = on ? { target: meter?.target ?? null } : null;
    meterCard();
    c.shell.toolbar.setActive(on ? "meter" : "select");
    closeCard();
    if (on) select({ kind: "tool", id: "meter" });
    else if (c.store.get().selection?.kind === "tool") select(null);
  }
  /** 万用表常驻读数卡（台面右下）：读数由 updateLive 填 */
  function meterCard() {
    overlay(
      "meter",
      meter ? (
        <MeterCard target={meter.target} onClose={() => setMeter(false)} />
      ) : null,
    );
    if (meter) updateLive();
  }
  /** 拾取到的东西 → 万用表点在哪根针（导线按它在开发板上的那一端；舵机红线单独一个节点） */
  function meterTarget(t: PickTarget): string | null {
    if (t.kind === "pin") return t.id;
    if (t.kind === "wire") {
      if (/servo:VCC/.test(t.id)) return "servo:VCC";
      return benchWires().find((w) => w.id === t.id)?.a ?? null;
    }
    return null;
  }
  function meterReading() {
    const c = ctx!;
    const id = meter?.target;
    if (!id) return null;
    return meterVolts(
      id,
      c.session.frame.elec,
      c.session.frame,
      !!c.session.power?.ext5v,
    );
  }

  // ------------------------------------------------------------ 尺子（P0-13）
  const pickName = (t: PickTarget) =>
    t.kind === "part"
      ? t.id === "board"
        ? "开发板芯片"
        : partName(t.id)
      : t.id;
  function renderRuler() {
    const r = ruler;
    const drift =
      r?.mm != null &&
      r.a &&
      r.b &&
      [r.a.id, r.b.id].includes("bme280") &&
      [r.a.id, r.b.id].includes("board")
        ? driftText(r.mm)
        : "";
    show(
      <>
        <Sec>尺子</Sec>
        <Note>
          在台面上依次点两个零件、引脚或导线；量完再点就重新开始。点工具条「选择」退出。
        </Note>
        <Kv k="起点" v={r?.a ? pickName(r.a) : "点第一个目标"} />
        <Kv k="终点" v={r?.b ? pickName(r.b) : r?.a ? "点第二个目标" : "—"} />
        <Kv
          k="距离"
          v={r?.mm != null ? `${r.mm.toFixed(1)} mm` : "—"}
          cls="fp"
        />
        {drift && <KvT k="受热偏高">{drift}</KvT>}
        <Btns>
          <Btn id="rulerChip" onClick={() => measureChip()}>
            量 BME280 到芯片
          </Btn>
        </Btns>
      </>,
      false,
    );
  }
  /** 传感器离芯片越近读数越高：组装步骤用的同一个数（贴着芯片 +2.5 ℃），这里按距离线性收到 30 mm 为 0，估算 */
  const driftOf = (mm: number) =>
    Math.max(0, Math.min(1, (30 - mm) / 25)) * CHIP_HEAT_OFFSET;
  const driftText = (mm: number) => {
    const d = driftOf(mm);
    return d < 0.05
      ? `离芯片 ${mm.toFixed(1)} mm：芯片发热影响可以忽略。贴着芯片（5 mm 以内）读数约偏高 ${CHIP_HEAT_OFFSET} ℃（估算）`
      : `离芯片 ${mm.toFixed(1)} mm：受热偏高约 ${d.toFixed(1)} ℃（估算，未经真机标定）`;
  };
  function measureChip(): number | null {
    const mm =
      ctx!.session.pick.measure?.(
        { kind: "part", id: "bme280" },
        { kind: "part", id: "board" },
      ) ?? null;
    if (ruler) {
      ruler = {
        a: { kind: "part", id: "bme280" },
        b: { kind: "part", id: "board" },
        mm,
      };
      renderProps();
    }
    return mm;
  }

  // ------------------------------------------------------------ 编码器 / 超声波（P2-01 / P2-04）
  const encRows = () => (
    <>
      <Kv k="旋钮位置" live="encpos" />
      <Kv k="PCNT 计数（单元 0）" live="pcnt" />
      <Kv k="固件读数" live="encfw" />
    </>
  );
  const turn = (n: number) => {
    const c = ctx!;
    c.session.turnEncoder(n);
    c.session.bench.setEncoder((c.session.frame.pins?.encPos ?? 0) + n);
  };
  const encRelease = (b: HTMLButtonElement) => {
    if (b.getAttribute("aria-pressed") !== "true") return;
    ctx!.session.pressEncoder(false);
    b.setAttribute("aria-pressed", "false");
  };
  const encButtons = () => (
    <Btns>
      <Btn data-enc="-1" onClick={() => turn(-1)}>
        逆时针 1 格
      </Btn>
      <Btn data-enc="1" onClick={() => turn(1)}>
        顺时针 1 格
      </Btn>
      <Btn data-enc="5" onClick={() => turn(5)}>
        顺时针 5 格
      </Btn>
      <Btn
        data-encsw="hold"
        onPointerDown={(e) => {
          ctx!.session.pressEncoder(true);
          e.currentTarget.setAttribute("aria-pressed", "true");
        }}
        onPointerUp={(e) => encRelease(e.currentTarget)}
        onPointerLeave={(e) => encRelease(e.currentTarget)}
      >
        按住旋钮
      </Btn>
    </Btns>
  );
  const sonarRows = () => (
    <>
      <Kv k="设定距离" live="dist" />
      <Kv k="最近一次 Echo" live="echo" />
      <Kv k="触发次数" live="pings" />
      <Kv k="固件读数" live="sonfw" />
    </>
  );
  const sonarControls = () => {
    const d = ctx!.session.distance;
    const set = (v: number) => {
      ctx!.session.setDistance(v);
      updateLive();
    };
    return (
      <>
        <Slider
          min={2}
          max={400}
          step={0.5}
          defaultValue={d < 0 ? 400 : d}
          data-dist=""
          aria-label="障碍物距离"
          out={d < 0 ? "没有障碍物" : `${d.toFixed(1)} cm`}
          on={{
            input: (e) => {
              const v = Number(e.currentTarget.value);
              outOf(e.currentTarget)!.textContent = `${v.toFixed(1)} cm`;
              ctx!.session.setDistance(v);
            },
          }}
        />
        <Btns>
          {[10, 50, 200].map((v) => (
            <Btn key={v} data-distset={v} onClick={() => set(v)}>
              {v} cm
            </Btn>
          ))}
          <Btn data-distset="-1" onClick={() => set(-1)}>
            拿走障碍物
          </Btn>
        </Btns>
      </>
    );
  };
  function toggleDivider() {
    const c = ctx!;
    const off = (c.session.wireMods.noDivider ?? []).includes("hcsr04");
    const mods = { ...c.session.wireMods, noDivider: off ? [] : ["hcsr04"] };
    c.hist?.op({
      k: "wiring",
      mods,
      scene: c.session.scene,
      label: off ? "装回 Echo 分压电阻" : "拆掉 Echo 分压电阻",
    });
    c.session.setWireMods(mods);
    c.shell.toast(
      off
        ? "Echo 经 1k、2k 分压，约 3.3 V 进 GPIO"
        : "Echo 5 V 直接进 GPIO，接线检查报「5 V 进 GPIO」",
    );
  }
  /** 串口最近的读数行（固件打印格式见 firmware/s3-encoder、s3-ultrasonic） */
  const lastLine = (re: RegExp) => {
    const t = ctx!.session.consoleText().slice(-3000);
    let m: RegExpExecArray | null = null;
    for (const x of t.matchAll(re)) m = x;
    return m;
  };

  /** 环境滑块（属性面板、快捷卡片）：一次手势只记一步（第一下 input 时记，后面改这一步的值），松手结束 */
  const gestures = new WeakMap<HTMLInputElement, BenchStep>();
  const fmtEnv: Record<string, (v: number) => string> = {
    temp: (v) => `${v.toFixed(1)} °C`,
    humidity: (v) => `${v.toFixed(0)} %`,
    pressure: (v) => `${(v / 100).toFixed(1)} hPa`,
  };
  const envOn = (k: "temp" | "humidity" | "pressure") => ({
    input: (e: NEv) => {
      const c = ctx!;
      const inp = e.currentTarget;
      const v = Number(inp.value);
      outOf(inp)!.textContent = fmtEnv[k](v);
      const env = { ...c.store.get().env, [k]: v };
      let st = gestures.get(inp);
      if (!st && c.store.get().env[k] === v) return;
      if (!st) {
        st = c.hist?.op({ k: "env", env });
        if (st) gestures.set(inp, st);
      } else if (st.op.k === "env") st.op.env = env;
      c.session.setEnv({ [k]: v });
      c.hist?.render();
    },
    change: (e: NEv) => void gestures.delete(e.currentTarget),
  });
  const ENV_ROWS: [
    "temp" | "humidity" | "pressure",
    string,
    number,
    number,
    number,
  ][] = [
    ["temp", "温度", -10, 45, 0.5],
    ["humidity", "湿度", 0, 100, 1],
    ["pressure", "气压", 90000, 110000, 50],
  ];
  const envSlider = (
    k: "temp" | "humidity" | "pressure",
    label: string,
    min: number,
    max: number,
    step: number,
  ) => {
    const v = ctx!.store.get().env[k];
    return (
      <Slider
        min={min}
        max={max}
        step={step}
        defaultValue={v}
        data-env={k}
        aria-label={label}
        out={fmtEnv[k](v)}
        on={envOn(k)}
      />
    );
  };

  /** 热源、量到芯片（属性面板与快捷卡片共用）；量到的距离只在这一块里显示 */
  function HeatActs() {
    const [mm, setMm] = useState<number | null | undefined>(undefined);
    const heat = !!ctx!.session.heat;
    return (
      <>
        <Btns>
          <Btn data-act="heat" aria-pressed={heat} onClick={() => toggleHeat()}>
            {heat ? "拿开热源" : "放上热源"}
          </Btn>
          <Btn data-act="chip" onClick={() => setMm(measureChip())}>
            量到芯片
          </Btn>
        </Btns>
        <KvBox data-live="chipmm" hidden={mm === undefined}>
          {mm !== undefined && (
            <>
              <span className="k flex-none text-muted">量到芯片</span>
              {mm === null ? (
                <span className="v txt text-[13px] break-all">
                  看不到这两个目标
                </span>
              ) : (
                <>
                  <span className="v fp font-mono text-xs font-medium break-all">
                    {mm.toFixed(1)} mm
                  </span>
                  <span className="v txt text-[13px] break-all text-muted">
                    {driftText(mm)}
                  </span>
                </>
              )}
            </>
          )}
        </KvBox>
      </>
    );
  }
  const levelBtn = () => (
    <Btns>
      <Btn
        data-act="level"
        onClick={() => ctx!.session.setPose({ pitch: 0, roll: 0, yaw: 0 })}
      >
        放平
      </Btn>
    </Btns>
  );

  /** 直接设一个温度（数字框、预设）：一下就是时间线上一步 */
  function setTempNow(v: number) {
    const c = ctx!;
    const t = Math.min(45, Math.max(-10, Math.round(v * 10) / 10));
    if (!Number.isFinite(t) || t === c.store.get().env.temp) return;
    c.hist?.op({ k: "env", env: { ...c.store.get().env, temp: t } });
    c.session.setEnv({ temp: t });
    c.hist?.render();
  }
  function TempExact() {
    const v = ctx!.store.get().env.temp;
    return (
      <div className="mt-1.5 mb-1 flex items-center gap-1.5">
        <label className="flex items-center gap-1 text-xs text-muted">
          <input
            type="number"
            data-envnum="temp"
            aria-label="环境温度（°C）"
            min={-10}
            max={45}
            step={0.1}
            defaultValue={v}
            onKeyDown={(e) =>
              e.key === "Enter" && setTempNow(Number(e.currentTarget.value))
            }
            onBlur={(e) => setTempNow(Number(e.currentTarget.value))}
            className="h-8 w-[72px] rounded-md border border-line bg-field px-2 font-mono text-xs text-fg outline-none focus:border-accent"
          />
          °C
        </label>
        <span className="flex-1" />
        {[18, 32, 4].map((t) => (
          <button
            key={t}
            type="button"
            data-preset={t}
            onClick={() => setTempNow(t)}
            className="h-8 cursor-pointer rounded-md border border-line bg-surface px-2 font-mono text-xs text-fg hover:bg-field"
          >
            {t}°
          </button>
        ))}
      </div>
    );
  }

  function renderPart(id: string) {
    const c = ctx!;
    const ses = c.session;
    if (id === "board") {
      const s3 = ses.chip === "esp32s3";
      show(
        <>
          <Sec>开发板</Sec>
          <PartHead
            name={s3 ? "ESP32-S3-DevKitC-1" : "ESP32-C3-DevKitM-1"}
            type="board"
          />
          <Kv
            k="芯片"
            v={s3 ? "ESP32-S3 · 双核 160 MHz" : "ESP32-C3 · 160 MHz"}
          />
          <Kv k="供电" v="USB 5 V 经 LDO 降到 3V3" />
          <Kv k="3V3" live="e33" />
          <Kv k="3V3 总电流（估算）" live="eic" />
          <Kv k="欠压复位" live="ers" />
          <Sec>实时</Sec>
          <Kv k="运行" live="run" />
          <Kv k="模拟时间" live="sim" />
          <Kv k={`板载 RGB（GPIO${s3 ? 48 : 8}）`} live="rgb" />
          <Btns>
            <Btn
              id="bootBtn"
              onPointerDown={() => ses.pressBoot(true)}
              onPointerUp={() => ses.pressBoot(false)}
              onPointerLeave={() => ses.pressBoot(false)}
            >
              按 BOOT（GPIO{s3 ? 0 : 9}）
            </Btn>
            <Btn id="rstBtn" onClick={() => ses.reboot()}>
              RST 重新上电
            </Btn>
          </Btns>
        </>,
      );
      return;
    }
    const p = ses.scene.parts.find(
      (x) => partId(x) === (id === "obstacle" ? "hcsr04" : id),
    );
    if (!p) {
      show(
        <>
          <Sec>零件</Sec>
          <Ph mono>{id}</Ph>
          <TreeEmpty>这个零件不在当前台面上</TreeEmpty>
        </>,
        false,
      );
      return;
    }
    // 拆掉了 Echo 分压（改接线）：接口说明跟着改
    const noDiv = (ses.wireMods.noDivider ?? []).includes("hcsr04");
    const info = partInfo(
      p.type === "hcsr04" && noDiv ? { ...p, divider: false } : p,
      !!ses.power?.ext5v,
    );
    let live: ReactNode = null;
    if (p.type === "bme280") {
      live = (
        <>
          <Sec>实时读数 · 固件串口最近一行</Sec>
          <Kv k="温度" live="rt" />
          <Kv k="湿度" live="rh" />
          <Kv k="气压" live="rp" />
          <Sec>环境温度</Sec>
          {envSlider("temp", "环境温度", -10, 45, 0.5)}
          <TempExact />
          <HeatActs />
          <Note>湿度、气压在构建树「环境」里调。可信度：仿真验证。</Note>
        </>
      );
    } else if (p.type === "oled") {
      live = (
        <>
          <Sec>实时画面</Sec>
          <OledCanvas />
          <Kv k="点亮像素" live="oledn" />
        </>
      );
    } else if (p.type === "servo") {
      live = (
        <>
          <Sec>实时</Sec>
          <Kv k="脉宽" live="pw" />
          <Kv k="角度" live="ang" />
        </>
      );
    } else if (p.type === "encoder") {
      live = (
        <>
          <Sec>实时</Sec>
          {encRows()}
          <Sec>转一转</Sec>
          {encButtons()}
          <Note>
            台面上左右拖旋钮或滚轮转一格，按住就是按下。可信度：仿真验证；没模拟触点抖动。
          </Note>
        </>
      );
    } else if (p.type === "hcsr04") {
      live = (
        <>
          <Sec>实时</Sec>
          {sonarRows()}
          <Sec>障碍物距离</Sec>
          {sonarControls()}
          <Note>
            台面上：按住障碍物沿探头方向拖（3D 里最远摆到 100
            cm，更远用滑块）。Trig 收到 10 µs 以上的高电平，250 µs 后 Echo
            拉高，高电平时长就是来回距离除以声速 343
            m/s；距离按探头到障碍物的直线算。声速按 20 ℃ 固定，未经真机标定。
          </Note>
          <Sec>电平</Sec>
          <KvT k="Echo">
            {p.divider === false || noDiv ? (
              <Bad>5 V 直接进 GPIO：S3 的 GPIO 不耐 5 V，会伤引脚</Bad>
            ) : (
              "Echo 输出 5 V，经 1 kΩ / 2 kΩ 分压到约 3.3 V 再进 GPIO"
            )}
          </KvT>
          <Btns>
            <Btn data-div="" aria-pressed={!noDiv} onClick={toggleDivider}>
              {noDiv ? "装回分压电阻" : "拆掉分压电阻（看接线检查报警）"}
            </Btn>
          </Btns>
        </>
      );
    } else if (p.type === "mpu6050" || p.type === "qmi8658") {
      live = (
        <>
          <Sec>姿态 · 端起面包板</Sec>
          {poseSliders()}
          {levelBtn()}
          <Sec>传感器应读到 · 重力分量</Sec>
          <Kv k="ax / ay / az" live="gacc" />
          <Sec>实时读数 · 固件串口最近一行</Sec>
          <Kv k="俯仰 pitch" live="ipitch" />
          <Kv k="横滚 roll" live="iroll" />
          <Kv k="陀螺" live="igyro" />
          <Note>
            也可以在 3D
            里按住这块模块拖动，整块台面跟着转；拖动时陀螺读到角速度，松手 150
            ms
            后回零。只靠加速度计算不出航向（yaw），它只影响陀螺。可信度：行为模拟，寄存器按数据手册、读数按姿态算出；噪声和零偏必须上真机确认。
          </Note>
        </>
      );
    } else if (
      p.type === "cst816s" ||
      (p.type === "gc9a01" && ses.scene.parts.some((x) => x.type === "cst816s"))
    ) {
      live = (
        <>
          <Sec>触摸 · 在 3D 里点或拖圆屏</Sec>
          <Kv k="手指" live="tch" />
          <Kv k="INT 电平" live="tint" />
          <Note>
            点屏幕就是按下，拖动就是移动，松开就是抬起；芯片自己判手势：单击、滑动、长按
            1 秒。真机的自动睡眠、扫描噪声没模拟，必须上真机确认。
          </Note>
        </>
      );
    }
    show(
      <>
        <Sec>零件</Sec>
        <PartHead name={info.name} type={p.type} />
        <KvT k="型号">{info.model}</KvT>
        <KvT k="接口">{info.iface}</KvT>
        <Kv k="供电" v={info.power} />
        {live}
        {p.type === "servo" && powerInline()}
      </>,
    );
  }

  // ------------------------------------------------------------ 姿态（P2-03）
  const POSE_AXES: ["pitch" | "roll" | "yaw", string, number][] = [
    ["pitch", "俯仰", 90],
    ["roll", "横滚", 180],
    ["yaw", "航向", 180],
  ];
  function poseSliders(axes = POSE_AXES) {
    const pz = ctx!.store.get().pose;
    return axes.map(([k, n, lim]) => (
      <KvBox key={k}>
        <span className="k">{n}</span>
        <Slider
          min={-lim}
          max={lim}
          step={1}
          defaultValue={pz[k]}
          data-pose={k}
          aria-label={n}
          out={`${pz[k].toFixed(0)}°`}
          on={{
            input: (e) => {
              const c = ctx!;
              const v = Number(e.currentTarget.value);
              outOf(e.currentTarget)!.textContent = `${v.toFixed(0)}°`;
              c.session.setPose({ ...c.store.get().pose, [k]: v });
            },
          }}
        />
      </KvBox>
    ));
  }

  function renderEnv() {
    show(
      <>
        <Sec>环境</Sec>
        <Ph>室内</Ph>
        <Note>改这里，传感器读数、串口和 OLED 都会跟着变。</Note>
        {ENV_ROWS.map(([k, n, min, max, step]) => (
          <KvBox key={k}>
            <span className="k">{n}</span>
            {envSlider(k, n, min, max, step)}
          </KvBox>
        ))}
        <Sec>传感器读到</Sec>
        <Kv k="温度" live="rt" />
        <Kv k="湿度" live="rh" />
        <Kv k="气压" live="rp" />
      </>,
    );
  }

  /** 「这个示例」：说明、标签、模拟输入滑块（.env 里的滑块是回归脚本拖的那几个），再指一个用同类器件的作品 */
  /** 麦克风声源（与旧实验台同一组：测试 WAV 进验收，浏览器麦克风只玩） */
  const MIC_SOURCES: [string, string][] = [
    ["sine1k.wav", "1 kHz 正弦（测试 WAV）"],
    ["sweep.wav", "扫频 200→2000 Hz（测试 WAV）"],
    ["silence", "安静"],
    ["live", "浏览器麦克风（要授权，只玩不进验收）"],
  ];

  function renderExample() {
    const c = ctx!;
    const { ex, work } = exInfo!;
    const ctl = ex.controls ?? [];
    const analogs = ctl.filter((k): k is AnalogControl => typeof k === "object" && k.type === "analog");
    show(
      <>
        <Sec>这个示例</Sec>
        <Ph>{ex.title}</Ph>
        <Note>{ex.about}</Note>
        <div className="mb-1 flex flex-wrap gap-1.5" data-ex-tags>
          {[CHIP_NAME[chipOf(ex)], ...ex.tags].map((t) => (
            <span
              key={t}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px]",
                t.startsWith("✓") ? "bg-ok-bg text-ok-ink" : "bg-field text-muted",
              )}
            >
              {t}
            </span>
          ))}
        </div>
        {(ctl.includes("env") || analogs.length > 0 || (ctl.includes("imu") && c.session.hasImu())) && (
          <div className="env">
            {ctl.includes("env") && (
              <>
                <Sec>环境 · 拖动看读数跟着变</Sec>
                {ENV_ROWS.map(([k, n, min, max, step]) => (
                  <KvBox key={k}>
                    <span className="k">{n}</span>
                    {envSlider(k, n, min, max, step)}
                  </KvBox>
                ))}
                <Kv k="固件读数" live="rt" />
              </>
            )}
            {analogs.map((a) => {
              const mv = c.session.analog.get(a.pin) ?? a.value;
              return (
                <KvBox key={a.pin}>
                  <span className="k">{a.label}</span>
                  <Slider
                    min={0}
                    max={a.max_mv}
                    step={10}
                    defaultValue={mv}
                    data-analog={a.pin}
                    aria-label={a.label}
                    out={`${mv} mV`}
                    on={{
                      input: (e) => {
                        const v = Number(e.currentTarget.value);
                        outOf(e.currentTarget)!.textContent = `${v} mV`;
                        c.session.setAnalog(a.pin, v);
                      },
                    }}
                  />
                </KvBox>
              );
            })}
            {ctl.includes("imu") && c.session.hasImu() && (
              <>
                <Sec>倾斜台面</Sec>
                {poseSliders()}
                <Kv k="固件读数" live="ipr" />
              </>
            )}
          </div>
        )}
        {c.session.scene.parts.some((p) => p.type === "inmp441") && (
          <>
            <Sec>麦克风声源</Sec>
            <select
              id="micSource"
              aria-label="麦克风声源"
              defaultValue={c.session.micSource}
              className="h-9 w-full cursor-pointer rounded-md border border-line bg-surface px-2 text-[13px] text-fg max-md:h-11"
              onChange={(e) => {
                const st = document.getElementById("micStatus");
                if (st) st.textContent = "";
                void c.session.setMicSource(e.currentTarget.value).then((msg) => {
                  if (st) st.textContent = msg;
                  if (msg) e.currentTarget.value = c.session.micSource;
                });
              }}
            >
              {MIC_SOURCES.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
            <div id="micStatus" className="mt-1 text-xs text-muted" />
          </>
        )}
        {work && (
          <>
            <Sec>做成成品</Sec>
            <a
              className="text-accent-ink hover:underline"
              href={lab(work.id, 'shop')}
              data-ex-work={work.id}
            >
              {work.title} · {work.card?.chip ?? ""} →
            </a>
          </>
        )}
        <Note>点左边的构建树或台面上的零件看它的属性。</Note>
      </>,
    );
  }

  /** 文件读不出来（被移走、没权限）时给提示，不抛到页面上 */
  const safeFile = (handle: (f: File) => Promise<void>) => (f: File) =>
    void handle(f).catch((e) =>
      ctx?.shell.toast(
        `读不了 ${f.name}：${e instanceof Error ? e.message : e}`,
      ),
    );

  function renderFirmware() {
    const c = ctx!;
    const ses = c.session;
    show(
      <>
        <Sec>固件</Sec>
        <Ph mono>{ses.fwName || "还没有固件"}</Ph>
        {ses.fwName && (
          <>
            <Kv k="大小" v={`${(ses.fwSize / 1024).toFixed(0)} KB`} />
            <Kv k="芯片" v={ses.chip === "esp32s3" ? "ESP32-S3" : "ESP32-C3"} />
          </>
        )}
        <Kv k="运行" live="run" />
        <Kv k="模拟时间" live="sim" />
        <Drop
          kind="bench"
          title="把 .bin 拖到这里"
          sub="换成你的固件在台面上跑，要 ESP-IDF 或 Arduino 导出的完整 flash 镜像"
          onFile={safeFile(async (f) => {
            ses.loadFirmware(await f.arrayBuffer(), f.name);
            renderTree();
            renderFirmware();
          })}
        />
      </>,
    );
  }

  function renderCheckpoint(id: string) {
    const c = ctx!;
    const s = c.store.get();
    const l = c.session.levels.find((x) => x.id === id);
    if (!l) {
      show(
        <>
          <Sec>检查点</Sec>
          <TreeEmpty>没有这个检查点：{id}</TreeEmpty>
        </>,
        false,
      );
      return;
    }
    const r = s.checks[id];
    const busy = s.verifying === id;
    const other = !!s.verifying && !busy;
    const st = busy ? undefined : stalled[id];
    // 一张卡只有一个主动作（DESIGN_V2 §9.5）：没过 → 复制给 AI 修；自己的固件过了 → 下一个检查点
    const idx = c.session.levels.findIndex((x) => x.id === id);
    const nextLv = c.session.levels
      .slice(idx + 1)
      .find((x) => !s.checks[x.id]?.ok || (r?.own && !s.checks[x.id]?.own));
    const runRef = async () => verify(l, await fetchBuf(`./fw/${l.ref}/flash.bin`), `参考固件 ${l.ref}`, false);
    const stall = st ? (
      <>
        <Sec>验收结果</Sec>
        <ResultCard
          verdict="stall"
          title="这次没跑完"
          why={`模拟卡住，已经停下。这不算没通过，你的代码可能没问题${r ? "；上一次的结果留在下面" : ""}。`}
          extra={
            <p className="mt-1 mb-0 text-xs text-muted">
              原因：{st.why} · 固件 <Mono>{st.who}</Mono> 已留着
            </p>
          }
          rows={[]}
        >
          <Btn id="retryCheck" primary className={actCls} disabled={other} onClick={() => verify(l, st.buf, st.who, st.own)}>
            再跑一次
          </Btn>
        </ResultCard>
      </>
    ) : null;
    const result = busy ? (
      <>
        <Sec>验收结果</Sec>
        <RunningCard title={l.title} progress={<>已模拟 <Live k="vp" className="font-mono" /></>} />
      </>
    ) : r ? (
      <>
        <Sec>验收结果</Sec>
        <ResultCard
          verdict={r.ok ? "ok" : "bad"}
          meta={`${r.who}${r.sim ? `，模拟 ${r.sim.toFixed(1)} 秒` : ""}`}
          title={headline(r.rows)}
          why={
            r.ok && !r.own
              ? "参考固件跑通（◐）：同样解锁组装和成品；换成你自己的固件通过后变成 ✓。"
              : undefined
          }
          rows={r.rows}
          runId={r.fingerprint}
          rawNote={
            <Note>
              同一固件、同样输入，网页和命令行 <Mono>npx tryboard check</Mono>{" "}
              得到同一个运行编号。
            </Note>
          }
        >
          {!r.ok && (
            <Btn primary data-act="fix" className={actCls} onClick={(e) => void copyFix(e.currentTarget, r.rows)}>
              复制给 AI 修
            </Btn>
          )}
          {!r.ok && r.own && l.ref && (
            <Btn data-act="compare" className={actCls} disabled={!!s.verifying} onClick={() => void runRef()}>
              用参考固件对比
            </Btn>
          )}
          {r.ok && nextLv && (
            <Btn primary data-act="nextcp" className={actCls} onClick={() => select({ kind: "checkpoint", id: nextLv.id })}>
              下一个检查点：{nextLv.title}
            </Btn>
          )}
        </ResultCard>
      </>
    ) : null;
    /** 任务书 + 没过的结论原文（和命令行看到的一致），AI 拿去就能改 */
    const copyFix = async (b: HTMLButtonElement, rows: { ok: boolean | null; text: string }[]) => {
      const bad = rows.filter((x) => x.ok === false).map((x) => `- ${x.text}`).join("\n");
      const text = `${l.brief}\n\n通过条件：${l.pass}\n验收：${checkCommand(l)}（退出码 0 表示通过）\n\n上次验收没过的几条：\n${bad}`;
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "已复制，贴给 AI";
      } catch {
        b.textContent = "复制不了，请从下面的任务书手动复制";
      }
    };
    const copy = async (b: HTMLButtonElement) => {
      const text = `${l.brief}\n\n通过条件：${l.pass}\n验收：${checkCommand(l)}（退出码 0 表示通过）`;
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "已复制";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(c.shell.props.el.querySelector(".brief")!);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        b.textContent = "已选中，按 ⌘C / Ctrl+C 复制";
      }
    };
    show(
      <>
        <Sec>检查点 {l.id}</Sec>
        <Ph>{l.title}</Ph>
        <p className="goal mt-0 mb-1 text-muted">{l.goal}</p>
        <Sec>通过条件</Sec>
        <Field>{l.pass}</Field>
        <Sec className="edit-only">验收</Sec>
        <Drop
          kind="check"
          busy={busy || other}
          disabled={busy || other}
          title={
            busy ? (
              <>
                模拟中 <Live k="vp" className="font-mono" />
              </>
            ) : (
              "把 .bin 拖到这里"
            )
          }
          sub={
            busy
              ? "跑完再判定"
              : other
                ? "另一个检查点正在验收，稍等"
                : "或点这里选文件"
          }
          onFile={
            busy || other
              ? undefined
              : safeFile(async (f) =>
                  verify(l, await f.arrayBuffer(), f.name, true),
                )
          }
        />
        <Btns>
          {l.ref && (
            <Btn
              id="runRef"
              disabled={!!s.verifying}
              onClick={() => void runRef()}
            >
              用参考固件试
            </Btn>
          )}
          {l.ref && (
            <LinkBtn id="dlBin" href={`./fw/${l.ref}/flash.bin`} download={`${l.ref}.bin`} title="烧到真板子：esptool.py write_flash 0x0">
              下载参考 .bin
            </LinkBtn>
          )}
          {l.ref && (
            <LinkBtn id="dlSrc" href={`./fw/${l.ref}/src.zip`} download={`${l.ref}-src.zip`} title="ESP-IDF 5.5 工程，解压后 idf.py build">
              下载源码 zip
            </LinkBtn>
          )}
        </Btns>
        {stall}
        {result}
        <Sec>交给 AI 的任务书</Sec>
        <Brief>{l.brief}</Brief>
        <Btns>
          <CopyBrief onCopy={(b) => void copy(b)} />
        </Btns>
        <Sec>验收命令</Sec>
        <Code>{checkCommand(l)}</Code>
        <Note>命令行跑出的结论和运行编号与网页相同；退出码 0 表示通过。tryboard 命令行包还没发布到 npm，现在要从仓库的 packages/tryboard 本地安装。</Note>
      </>,
    );
  }

  async function verify(l: Level, buf: ArrayBuffer, who: string, own: boolean) {
    const c = ctx!;
    if (c.store.get().verifying) return;
    if (own) ownFirmware[l.id] = { buf: buf.slice(0), name: who };
    delete stalled[l.id];
    // -1：还在加载模拟器（wasm / ROM），Worker 还没开始跑
    c.store.set({ verifying: l.id, verifyProgress: -1 });
    let out: CheckOutcome;
    try {
      const v = await verifyLevel(l, buf, (t) => {
        if (t - c.store.get().verifyProgress >= 0.1)
          c.store.set({ verifyProgress: t });
      });
      const rows: CheckOutcome["rows"] = v.results.map((x) => ({
        ok: x.ok,
        text: x.text,
        say: x.say,
        tag: x.tag,
        dev: x.dev,
      }));
      // 装配检查是几何估算，命令行不判；实验台上也不判，留给「组装」步骤
      if (l.assembly)
        rows.push({
          ok: null,
          text: "装配检查（估算）在「组装」步骤判定，这里不计",
          say: "装配在「组装」那一步检查，这里不判",
          dev: "装配",
        });
      out = {
        ok: v.ok,
        who,
        own,
        rows,
        fingerprint: v.fingerprint,
        sim: v.sim,
      };
    } catch (e) {
      if (e instanceof VerifyStalled) {
        stalled[l.id] = { why: e.message, buf: buf.slice(0), who, own };
        c.store.set({ verifying: null });
        c.shell.toast(`检查点 ${l.id} 这次没跑完，不算没通过，可以再跑一次`);
        return;
      }
      out = {
        ok: false,
        who,
        own,
        rows: [{ ok: false, text: `运行失败：${e}`, say: "模拟器出错，这次没跑起来" }],
        fingerprint: "—",
        sim: 0,
      };
    }
    // 参考固件跑通也记进度（◐，同样解锁组装 / 成品）；saveProgress 自己保证不覆盖自己的通过
    if (out.ok) {
      saveProgress(wkey(c.work), l.id, out.fingerprint, own);
      buyArmed = true;
    }
    // 参考固件的结果不覆盖你已经通过的记录
    const prev = c.store.get().checks[l.id];
    const keep = prev?.own && prev.ok && !own;
    if (!keep) c.hist?.op({ k: "check", id: l.id, outcome: out });
    c.store.set((s) => ({
      verifying: null,
      checks: keep ? s.checks : { ...s.checks, [l.id]: out },
    }));
    if (keep)
      c.shell.toast(
        `参考固件${out.ok ? "通过了" : "没通过"}（运行编号 ${out.fingerprint}，不覆盖你的记录）`,
      );
  }

  // ------------------------------------------------------------ 实时字段（不重建面板，免得拖滑块时被打断）
  function updateLive() {
    const c = ctx!;
    const s = c.store.get();
    const el = c.shell.props.el;
    // 快捷卡片里的读数和属性面板用同一套 data-live
    const card = c.shell.stage.querySelector<HTMLElement>(
      ".qcard:not([hidden])",
    );
    // 台面浮层里的常驻卡（万用表）也按 data-live 填
    const extra = [
      ...c.shell.stage.querySelectorAll<HTMLElement>("[data-live-root]"),
    ];
    const set = (k: string, v: string, bad = false) => {
      for (const root of card ? [el, card, ...extra] : [el, ...extra]) {
        // 同一字段可能出现多处（拖放框和跑中卡都显示「已模拟」），全填
        for (const n of root.querySelectorAll<HTMLElement>(`[data-live="${k}"]`)) {
          n.textContent = v;
          n.classList.toggle("bad", bad);
        }
      }
    };
    set(
      "run",
      s.run
        ? `#${s.runNo || s.run}${s.hist.seeked ? " · 回退点（暂停）" : s.running ? " · 运行中" : " · 停止"}`
        : "未上电",
    );
    set("sim", `${s.simSeconds.toFixed(2)} s`);
    const rd = s.reading;
    // 读数和设定差太多（超过第 06 关的容差）标红：通常是固件换算错了
    set(
      "rt",
      rd ? `${rd.t.toFixed(2)} °C` : "等固件打印…",
      !!rd && Math.abs(rd.t - s.env.temp) > 0.5,
    );
    set("rh", rd ? `${rd.h.toFixed(1)} %` : "—");
    set("rp", rd ? `${rd.p.toFixed(2)} hPa` : "—");
    set(
      "vp",
      s.verifyProgress < 0 ? "· 加载模拟器…" : `${s.verifyProgress.toFixed(1)} s`,
    );
    const e = c.session.frame.elec;
    if (e) {
      const V = (x: number) => (Number.isFinite(x) ? `${x.toFixed(3)} V` : "—");
      const A = (x: number) => `${(x * 1000).toFixed(0)} mA`;
      set("e5", V(e.v5), e.v5 < 4.0);
      set("e33", `${V(e.v3v3)}${e.held ? " · 欠压复位中" : ""}`, e.v3v3 < 3.0);
      set("emin", V(e.min3v3), e.min3v3 < 2.44);
      set("eiu", A(e.iUsb), e.iUsb > 0.5);
      set("epu", A(e.peakUsb), e.peakUsb > 0.5);
      set("eext", V(e.vExt));
      set("eis", A(e.iServo));
      set("eps", A(e.peakServo));
      set("eia", A(e.iAmp ?? 0));
      set("ers", `${e.resets} 次`, e.resets > 0);
      set("eic", A(e.i3v3));
      set(
        "pv",
        s.selection?.kind === "pin"
          ? powerVolts(s.selection.id, !!c.session.power?.ext5v, e)
          : "",
      );
    }
    const pd = c.session.frame.pins;
    if (pd) {
      set("encpos", pd.encPos === null ? "—" : `${pd.encPos} 格（顺时针为正）`);
      set("pcnt", pd.pcnt === null ? "—" : String(pd.pcnt));
      set("pings", pd.pings === null ? "—" : `${pd.pings} 次`);
      set(
        "echo",
        pd.echoUs === null || !pd.pings ? "—" : `${pd.echoUs.toFixed(1)} µs`,
      );
    }
    const em = lastLine(/ENC count=(-?\d+) detents=(-?\d+)/g);
    set("encfw", em ? `count=${em[1]}（${em[2]} 格）` : "等固件打印…");
    const sm = lastLine(/DIST (?:([\d.]+) cm|out of range|no echo)/g);
    set("sonfw", sm ? (sm[1] ? `${sm[1]} cm` : sm[0].slice(5)) : "等固件打印…");
    const dist = c.session.distance;
    set("dist", dist < 0 ? "没有障碍物（超量程）" : `${dist.toFixed(1)} cm`);
    for (const root of card ? [el, card] : [el])
      root
        .querySelectorAll<HTMLInputElement>("input[data-dist]")
        .forEach((inp) => {
          if (
            inp === document.activeElement ||
            dist < 0 ||
            Number(inp.value) === dist
          )
            return;
          inp.value = String(dist);
          const o = outOf(inp);
          if (o) o.textContent = `${dist.toFixed(1)} cm`;
        });
    // 姿态与 IMU 读数（P2-03）
    const pz = s.pose;
    const [gx, gy, gz] = gravity(pz);
    set("gacc", `${gx.toFixed(3)} / ${gy.toFixed(3)} / ${gz.toFixed(3)} g`);
    const im = s.imu;
    set(
      "ipitch",
      im ? `${im.pitch.toFixed(1)}°` : "等固件打印…",
      !!im && Math.abs(im.pitch - pz.pitch) > 1.5 && Math.abs(pz.pitch) < 85,
    );
    set(
      "iroll",
      im ? `${im.roll.toFixed(1)}°` : "—",
      !!im &&
        Math.abs(angDiff(im.roll, pz.roll)) > 1.5 &&
        Math.abs(pz.pitch) < 85,
    );
    set(
      "igyro",
      im?.gyro ? `${im.gyro.map((v) => v.toFixed(1)).join(" / ")} °/s` : "—",
    );
    set(
      "ipr",
      im
        ? `俯仰 ${im.pitch.toFixed(1)}° · 横滚 ${im.roll.toFixed(1)}°`
        : "等固件打印…",
    );
    for (const root of card ? [el, card] : [el])
      root
        .querySelectorAll<HTMLInputElement>("input[data-pose]")
        .forEach((inp) => {
          if (inp === document.activeElement) return;
          const k = inp.dataset.pose as "pitch" | "roll" | "yaw";
          const v = Math.round(pz[k]);
          if (Number(inp.value) === v) return;
          inp.value = String(v);
          const o = outOf(inp);
          if (o) o.textContent = `${v}°`;
        });
    const tpart = c.session.scene.parts.find((x) => x.type === "cst816s");
    if (tpart && tpart.type === "cst816s") {
      set(
        "tch",
        s.touch
          ? `${s.touch.down ? "按着" : "抬起"} · x ${s.touch.x} y ${s.touch.y}`
          : "还没点过",
      );
      const fr = c.session.frame;
      const lv =
        tpart.int < 32
          ? (fr.gpio >>> tpart.int) & 1
          : (fr.gpioHi >>> (tpart.int - 32)) & 1;
      set("tint", `GPIO${tpart.int} ${lv ? "高（没按）" : "低（按着）"}`);
    }
    const mr = meterReading();
    if (mr) {
      set("mv", mr.v === null ? "—" : `${mr.v.toFixed(3)} V`);
      set("mnote", mr.note);
    }
    for (const root of [el, ...(card ? [card] : [])])
      root
        .querySelectorAll<HTMLInputElement>("input[data-envnum]")
        .forEach((inp) => {
          if (
            inp !== document.activeElement &&
            Number(inp.value) !== s.env.temp
          )
            inp.value = String(s.env.temp);
        });
    // 别处改了环境（卡片 / 热源 / 回退），没在拖的滑块跟上
    for (const root of card ? [el, card] : [el])
      root
        .querySelectorAll<HTMLInputElement>("input[data-env]")
        .forEach((inp) => {
          if (inp === document.activeElement) return;
          const k = inp.dataset.env as "temp" | "humidity" | "pressure";
          if (Number(inp.value) === s.env[k]) return;
          inp.value = String(s.env[k]);
          const o = outOf(inp);
          if (o) o.textContent = fmtEnv[k](s.env[k]);
        });
    const f = c.session.frame;
    const rgbN = el.querySelector<HTMLElement>('[data-live="rgb"]');
    if (rgbN) {
      const css = ledCss(f.rgb);
      if (f.rgb)
        rgbN.replaceChildren(
          swatch(css ?? "#000"),
          `#${f.rgb.map((x) => x.toString(16).padStart(2, "0")).join("")}`,
        );
      else rgbN.textContent = "灭";
    }
    const servo = c.session.scene.parts.find((p) => p.type === "servo");
    if (servo && "pin" in servo) {
      const d = f.pwm[servo.pin];
      set(
        "pw",
        d !== undefined && d >= 0 ? `${(d * 20).toFixed(3)} ms` : "没有 PWM",
      );
      const a = servoAngle(f.pwm, servo.pin);
      // 舵盘实际角度来自内核的二阶动力学（有加速、过冲）；括号里是 PWM 换算的目标角
      const phys = f.elec?.servoAngle;
      set(
        "ang",
        phys != null
          ? `${phys.toFixed(1)}°${a === null ? "" : `（目标 ${a.toFixed(1)}°）`}`
          : a === null
            ? "—"
            : `${a.toFixed(1)}°`,
      );
    }
    // 针脚实时值 + 示波器
    const sel = s.selection;
    if (sel?.kind === "pin") {
      const g = /^GPIO(\d+)$/.exec(sel.id);
      const pin = g ? Number(g[1]) : -1;
      if (pin >= 0) {
        const duty = f.pwm[pin] ?? -1;
        const freq = f.pwmFreq[pin] ?? 0;
        const out = !!bit(f.enable, f.enableHi, pin);
        const lv = bit(f.gpio, f.gpioHi, pin);
        set(
          "pdir",
          duty >= 0 ? "输出（LEDC PWM）" : out ? "输出" : "输入或未驱动",
        );
        set("plv", duty >= 0 ? "方波" : lv ? "高（3.3 V）" : "低（0 V）");
        if (duty >= 0 && freq > 0) {
          const t = pwmText(duty, freq);
          set("pf", t.freq);
          set("pw2", t.width);
          set("pd", t.duty);
        } else {
          set("pf", "没有 PWM");
          set("pw2", "—");
          set("pd", "—");
        }
      }
      const cv = el.querySelector<HTMLCanvasElement>("canvas.scope");
      if (cv) {
        const wires = benchWires().filter((w) => w.a === sel.id && !w.missing);
        const kind = pinKind(sel.id, wires);
        const v =
          sel.id === "3V3"
            ? 3.3
            : sel.id === "5V" || sel.id === "EXT5V"
              ? 5
              : 0;
        set(
          "scopeNote",
          drawScope(cv, kind, trace, trace.latest()?.t ?? s.simSeconds, v),
        );
      }
    }
    const cv = el.querySelector<HTMLCanvasElement>("canvas.oled");
    if (cv && f.oled) {
      const g = cv.getContext("2d")!;
      const img = g.createImageData(128, 64);
      let lit = 0;
      for (let i = 0; i < 128 * 64; i++) {
        const on = f.oled[i] > 0;
        lit += on ? 1 : 0;
        img.data.set(on ? [120, 200, 255, 255] : [8, 14, 24, 255], i * 4);
      }
      g.putImageData(img, 0, 0);
      set("oledn", String(lit));
    }
  }

  // ------------------------------------------------------------ 选板作品（U-17）：逐条验收、演示固件、导出检查点、真买卡
  /** 一份固件把所有要判的检查点挨个跑一遍（生成检查点都是同样的参数，一次拖入就全判） */
  async function verifyAll(buf: ArrayBuffer, who: string, own: boolean) {
    const c = ctx;
    if (!c) return;
    for (const id of c.work.checkpoints) {
      const l = c.session.levels.find((x) => x.id === id);
      if (!l || !ctx) continue;
      await verify(l, buf, who, own);
    }
  }
  async function runDemo() {
    const c = ctx!;
    const demo = c.custom?.plan.demo;
    if (!demo || demoBusy) return;
    demoBusy = true;
    renderTree();
    try {
      const buf = await fetchBuf(`./fw/${demo}/flash.bin`);
      c.session.loadFirmware(buf, `${demo}/flash.bin`);
      c.shell.toast(`演示固件 ${demo} 上电，同时逐条验收检查点`);
      // 演示固件记 ◐ 参考跑通（DECISIONS U-22 取代 U-17）：同样解锁真买卡，但不算「我的固件」
      await verifyAll(buf, `演示固件 ${demo}`, false);
    } finally {
      demoBusy = false;
      if (ctx) renderTree();
    }
  }
  /** 用内置固件走完全程（U-22）：没过的检查点挨个取各自的参考固件验收，最后把最后一个参考固件放上台面 */
  async function runAllRef() {
    const c = ctx!;
    if (c.custom) return void runDemo();
    if (demoBusy || c.store.get().verifying) return;
    demoBusy = true;
    renderTree();
    let last: { ref: string; buf: ArrayBuffer } | null = null;
    try {
      for (const id of c.work.checkpoints) {
        const l = c.session.levels.find((x) => x.id === id);
        if (!l?.ref || !ctx) continue;
        if (c.store.get().checks[id]?.ok) continue;
        c.store.set({ selection: { kind: "checkpoint", id } });
        const buf = await fetchBuf(`./fw/${l.ref}/flash.bin`);
        await verify(l, buf, `参考固件 ${l.ref}`, false);
        last = { ref: l.ref, buf };
        // 某一关没跑通（或卡住）就停：后面的关通常依赖前面的接线
        if (!c.store.get().checks[id]?.ok) break;
      }
    } catch (e) {
      c.shell.toast(`内置固件取不到：${e}`);
    } finally {
      demoBusy = false;
      if (ctx) {
        const n = c.work.checkpoints.length;
        const d = passedCount(c);
        if (last) c.session.loadFirmware(last.buf, `${last.ref}/flash.bin`);
        c.shell.toast(
          d === n
            ? `内置固件跑通 ${n}/${n}（◐）：组装解锁了；想换成自己的固件，拖 .bin 到检查点`
            : `内置固件跑到 ${d}/${n} 停下：看没过的那个检查点`,
        );
        renderTree();
      }
    }
  }
  function exportCheckpoints() {
    const c = ctx!;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(c.custom?.levels ?? [], null, 1) + "\n"], { type: "application/json" }));
    a.download = "checkpoints.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    c.shell.toast("已导出 checkpoints.json：npx tryboard check app.bin --level-json checkpoints.json");
  }
  const BUY_KEY = (w: string) => `tryboard-buy-manual:${w}`;
  const loadBuyChecked = (w: string): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem(BUY_KEY(w)) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  function openBuy() {
    const c = ctx;
    if (!c?.custom) return;
    const { plan, levels } = c.custom;
    const s = c.store.get();
    const have = plan.have;
    const remaining = replay(s.bom)
      .picks.filter((p) => !have.includes(p.partId))
      .map((p) => ({ partId: p.partId, qty: p.qty ?? 1, why: "" }));
    const manual = [
      ...levels.filter((l) => l.manual).map((l) => l.title),
      ...plan.noModel.map((n) => `${n.name}：模拟器里没有，接上真机试`),
      "真板上的引脚与网页一致（按接线表逐根对）",
    ];
    const fp = c.work.checkpoints.map((id) => s.checks[id]?.fingerprint).find(Boolean) ?? null;
    const own = Object.entries(ownFirmware).find(([id]) => c.work.checkpoints.includes(id))?.[1];
    const bin = own?.buf ?? c.session.fwBuf;
    const key = wkey(c.work);
    const draw = () => {
      const checked = loadBuyChecked(key);
      overlay(
        "buy",
        <BuyDialog onClose={() => overlay("buy", null)}>
          <BuyCard
            title={plan.title}
            checks={c.work.checkpoints.length}
            remaining={remaining}
            extra={plan.noModel.map((n) => ({ name: n.name, price: n.price }))}
            fingerprint={fp}
            manual={manual}
            checked={checked}
            onToggleManual={(m) => {
              const cur = loadBuyChecked(key);
              const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
              try {
                localStorage.setItem(BUY_KEY(key), JSON.stringify(next));
                noteSaved();
              } catch {
                /* 存不了就只在本页有效 */
              }
              draw();
            }}
            onDownloadBin={
              bin
                ? () => {
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(new Blob([bin], { type: "application/octet-stream" }));
                    a.download = "flash.bin";
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                  }
                : null
            }
            onClose={() => overlay("buy", null)}
          />
        </BuyDialog>,
      );
    };
    draw();
  }

  // ------------------------------------------------------------ 结论、下一步、工具条
  function syncChrome() {
    const c = ctx!;
    const n = c.work.checkpoints.length;
    const done = passedCount(c);
    // 选板作品只有采购 → 实验台两步：检查点全过后右上是「做成真的」（真买卡）
    if (c.custom)
      return n && done === n
        ? c.shell.setNext("下一步：做成真的 →", "bench", "", openBuy, "hot")
        : c.shell.setNext(`做成真的 · 还差 ${n - done} 个检查点`, null, `检查点全部跑通（${done}/${n}，演示固件也算）才出真买卡`);
    // 空白作品没有组装 / 成品（步骤条只有两步）：右上换成去挑一个作品
    if (c.work.id === "blank")
      return c.shell.setNext("需要外壳？选一个作品 →", "bench", "", () =>
        location.assign(`${HOME}#works`),
      );
    // 倾角仪没有检查点和组装模版：成品（端在手里转的盒子）随时能看
    if (c.work.id === "imu") return c.shell.setNext("下一步：成品 →", "product");
    if (n && done === n)
      return c.shell.setNext("下一步：组装 →", "assemble", "", undefined, "hot");
    c.shell.setNext(
      `组装 · 还差 ${n - done} 个检查点`,
      null,
      `检查点全部跑通（${done}/${n}，内置固件也算）才能组装`,
    );
  }

  // ------------------------------------------------------------ 热源 / 量到芯片（P0-04）
  function toggleHeat() {
    const c = ctx!;
    if (!c.session.scene.parts.some((p) => p.type === "bme280")) {
      c.shell.toast("台面上没有 BME280，热源没有可靠近的传感器");
      return;
    }
    const on = !c.session.heat;
    const room = c.store.get().env.temp;
    const temp = on ? room + 8 : (heatRoom ?? room - 8);
    heatRoom = on ? room : null;
    c.hist?.op({
      k: "heat",
      part: on ? "bme280" : null,
      env: { ...c.store.get().env, temp },
    });
    c.session.setEnv({ temp });
    c.session.setHeat(on ? "bme280" : null);
    c.shell.toast(
      on
        ? `热源放到 BME280 旁边：传感器周围从 ${room.toFixed(1)} °C 升到 ${temp.toFixed(1)} °C（示意，固定加 8 °C）`
        : `热源拿开：回到 ${temp.toFixed(1)} °C`,
    );
  }

  // ------------------------------------------------------------ 快捷卡片（P0-04）
  function cardContent(t: PickTarget): ReactNode | null {
    const c = ctx!;
    if (t.kind === "part" && t.id === "bme280") {
      return (
        <div>
          <Sec>BME280 · 温度 / 湿度 / 气压</Sec>
          <Kv k="读到" live="rt" />
          {envSlider("temp", "环境温度", -10, 45, 0.5)}
          <HeatActs />
        </div>
      );
    }
    if (t.kind === "part" && (t.id === "mpu6050" || t.id === "qmi8658")) {
      return (
        <div>
          <Sec>{t.id === "mpu6050" ? "MPU6050" : "QMI8658"} · 倾斜台面</Sec>
          {poseSliders(POSE_AXES.slice(0, 2))}
          <Kv k="固件读数" live="ipr" />
          {levelBtn()}
          <Note>按住模块拖动也能转。</Note>
        </div>
      );
    }
    if (
      t.kind === "part" &&
      (t.id === "cst816s" ||
        (t.id === "gc9a01" &&
          c.session.scene.parts.some((x) => x.type === "cst816s")))
    ) {
      return (
        <div>
          <Sec>触摸圆屏 · CST816S</Sec>
          <Kv k="手指" live="tch" />
          <Kv k="INT 电平" live="tint" />
          <Note>直接在 3D 屏幕上点或拖。</Note>
        </div>
      );
    }
    const isServoPower =
      (t.kind === "wire" && /servo:VCC/.test(t.id)) ||
      (t.kind === "pin" &&
        t.id === "5V" &&
        c.session.scene.parts.some((p) => p.type === "servo"));
    if (isServoPower) {
      return (
        <div>
          <Sec>
            舵机供电 · 现在{c.session.power?.ext5v ? "外接 5 V" : " USB 5 V"}
          </Sec>
          {powerSeg(!!c.session.power?.ext5v)}
          <Kv k="5V 轨" live="e5" />
          <Kv k="3V3" live="e33" />
          <Kv k="欠压复位" live="ers" />
          <Note>
            只靠 USB 时，舵机大幅扫动会把 3V3 拉到欠压门限以下，板子复位。
          </Note>
        </div>
      );
    }
    if (t.kind === "part" && t.id === "encoder") {
      return (
        <div>
          <Sec>EC11 编码器 · 拖动或滚轮转旋钮</Sec>
          {encRows()}
          {encButtons()}
        </div>
      );
    }
    if (t.kind === "part" && (t.id === "hcsr04" || t.id === "obstacle")) {
      return (
        <div>
          <Sec>HC-SR04 · 拖障碍物或滑块</Sec>
          {sonarRows()}
          {sonarControls()}
        </div>
      );
    }
    if (t.kind === "button" && t.id === "BOOT") {
      return (
        <div>
          <Sec>BOOT 键 · GPIO{bootGpio()}</Sec>
          {bootBtns()}
          <Note>气象站固件：按一下在 ℃ 和 ℉ 之间切换。</Note>
        </div>
      );
    }
    if (t.kind === "part") {
      const p = c.session.scene.parts.find((x) => partId(x) === t.id);
      return (
        <div>
          <Sec>{p ? partInfo(p).name : t.id === "board" ? "开发板" : t.id}</Sec>
        </div>
      );
    }
    return null;
  }
  function openCard(t: PickTarget, screen: ScreenPoint) {
    const c = ctx!;
    const box = cardContent(t);
    if (!box) {
      closeCard();
      return;
    }
    cardFor = t;
    c.shell.card.show(c.session.pick.project?.(t) ?? screen, box);
    updateLive();
    // 台面转动时卡片跟着目标走；目标转到看不见就关掉
    cancelAnimationFrame(cardRaf);
    const follow = () => {
      if (!cardFor || !c.shell.card.open) return;
      const p = c.session.pick.project?.(cardFor);
      if (!p) return closeCard();
      c.shell.card.place(p);
      cardRaf = requestAnimationFrame(follow);
    };
    cardRaf = requestAnimationFrame(follow);
  }
  function closeCard() {
    cancelAnimationFrame(cardRaf);
    cardFor = null;
    ctx?.shell.card.hide();
  }

  function onPick(t: PickTarget | null, screen: ScreenPoint) {
    if (!ctx || ctx.store.get().step !== "bench") return;
    if (placing) {
      if (!t) return;
      if (t.kind === "pin") placePin(t.id);
      else ctx.shell.toast("点开发板上发蓝的针");
      return;
    }
    if (wiring) {
      if (!t) return;
      if (t.kind === "wire") {
        if (!benchWires().some((w) => w.id === t.id))
          return ctx.shell.toast("这根线两头都在零件上，改不了开发板那一端");
        wiring.wire = t.id;
        ctx.session.pick.highlight?.(t);
        wireUi();
      } else if (t.kind === "pin" && wiring.wire) retarget(wiring.wire, t.id);
      else
        ctx.shell.toast(
          wiring.wire ? "点开发板上的一根针（蓝圈）" : "先点一根要改接的线",
        );
      return;
    }
    if (meter) {
      if (!t) return;
      const id = meterTarget(t);
      if (!id) {
        ctx.shell.toast("万用表：点一个引脚（电源脚或 GPIO）或一根导线");
        return;
      }
      meter = { target: id };
      if (ctx.store.get().selection?.kind !== "tool")
        select({ kind: "tool", id: "meter" });
      renderMeter();
      meterCard();
      cardFor = t;
      ctx.shell.card.show(
        ctx.session.pick.project?.(t) ?? screen,
        <div>
          <Sec>
            万用表 · <Mono>{id}</Mono>
          </Sec>
          <Meter sm />
          <Live as="p" k="mnote" className="note my-2 text-xs text-muted" />
        </div>,
      );
      updateLive();
      return;
    }
    if (ruler) {
      if (!t) return;
      if (!ruler.a || ruler.b) ruler = { a: t, b: null, mm: null };
      else {
        ruler.b = t;
        ruler.mm = ctx.session.pick.measure?.(ruler.a, t) ?? null;
      }
      if (!ruler.b) ctx.session.pick.measure?.(null);
      renderProps();
      return;
    }
    if (!t) {
      closeCard();
      if (isPhone()) setMui({ props: false });
      return select(null);
    }
    select({ kind: t.kind, id: t.id });
    // 手机上不弹台面卡片（会挡住大半个台面），改开属性抽屉，同一份 selection
    if (isPhone()) {
      closeCard();
      phoneProps();
    } else openCard(t, screen);
  }

  function setRuler(on: boolean) {
    const c = ctx!;
    ruler = on ? { a: null, b: null, mm: null } : null;
    c.shell.toolbar.setActive(on ? "ruler" : "select");
    if (!on) c.session.pick.measure?.(null);
    closeCard();
    if (on) select({ kind: "tool", id: "ruler" });
    else if (c.store.get().selection?.kind === "tool") select(null);
  }

  function onTool(id: string) {
    if (!ctx || ctx.store.get().step !== "bench") return;
    const c = ctx;
    // 手机：连线 / 测量要看台面，先收起属性抽屉
    if ((id === "wire" || id === "meter" || id === "ruler") && isPhone())
      setMui({ props: false, more: false });
    if (placing && id !== "place" && /^(select|orbit|wire|meter|ruler)$/.test(id))
      endPlace();
    if (id === "place") {
      if (placing) {
        endPlace();
        return;
      }
      c.shell.toolbar.setActive("select");
      c.shell.toast("从左栏元件库把零件拖到台面上，或点它后面的「放」");
      (document.querySelector('[data-left="lib"]') as HTMLElement | null)?.click();
      requestAnimationFrame(() =>
        (document.querySelector("#partLib input") as HTMLInputElement | null)?.focus(),
      );
      return;
    }
    if (id === "select" || id === "orbit") {
      if (ruler) setRuler(false);
      if (meter) setMeter(false);
      if (wiring) setWiring(false);
      c.shell.toolbar.setActive(id);
    } else if (id === "wire") {
      const sel = c.store.get().selection;
      setWiring(
        !wiring,
        sel?.kind === "wire" && benchWires().some((w) => w.id === sel.id)
          ? sel.id
          : null,
      );
    } else if (id === "ruler") {
      if (meter) setMeter(false);
      if (wiring) setWiring(false);
      setRuler(!ruler);
    } else if (id === "meter") setMeter(!meter);
    else if (id === "heat") toggleHeat();
    else if (id === "scope") getAnalyzer(c).toggle();
    else if (id === "ext") {
      // 外部模型（P1-09）：舵机 / USB-C / 蜂鸣器换成 KiCad、Adafruit 的 glb，来源见第三方授权页；默认程序生成
      const on = !extModelsOn();
      setExtModels(on);
      c.shell.toolbar.setLabel("ext", on ? "外部模型：开" : "外部模型：关");
      c.shell.toast(
        on
          ? "外部模型：舵机、USB-C 口、蜂鸣器换成 KiCad / Adafruit 的 3D 模型（署名见第三方授权页）"
          : "外部模型：关，全部换回程序生成的模型",
      );
    } else if (id === "photo") {
      // 拍照（P2-10）：台面当前视角的 2× 静帧
      void takePhoto(
        c.session.bench.capture(),
        `${c.work.id}-bench`,
        `${c.work.title} · 实验台`,
      )
        .then((r) =>
          c.shell.toast(`已下载 ${r.name}（${r.width}×${r.height}）`),
        )
        .catch((e) => c.shell.toast(`拍照失败：${e}`));
    } else if (id === "rec") {
      if (benchRec) return benchRec.stop();
      try {
        const r = recordCanvas(
          c.session.bench.capture().renderer.domElement,
          `${c.work.id}-bench`,
          c.session.audio.recordStream(),
        );
        benchRec = r;
        setRecLabel(`停止 0/${RECORD_SECONDS} s`);
        const tick = setInterval(
          () =>
            benchRec === r &&
            setRecLabel(
              `停止 ${Math.min(RECORD_SECONDS, r.elapsed()).toFixed(0)}/${RECORD_SECONDS} s`,
            ),
          500,
        );
        void r.done
          .then((v) =>
            ctx?.shell.toast(
              `已下载 ${v.name}（${(v.bytes / 1024).toFixed(0)} KB${v.audio ? "，含声音" : ""}）`,
            ),
          )
          .catch((e) => ctx?.shell.toast(`录像失败：${e}`))
          .finally(() => {
            clearInterval(tick);
            if (benchRec === r) benchRec = null;
            setRecLabel("录像");
          });
      } catch (e) {
        c.shell.toast(`录像失败：${e}`);
      }
    } else if (id === "button") {
      c.session.pressBoot(true);
      setTimeout(() => c.session.pressBoot(false), 150);
      c.shell.toast(`按了一下 BOOT（GPIO${bootGpio()}）`);
    } else c.shell.toast("这个工具暂未开放");
  }

  /** 实验台正在录的 10 秒（P2-10） */
  let benchRec: Recording | null = null;
  let toolbarRef: StepCtx["shell"]["toolbar"] | null = null;
  const setRecLabel = (t: string) => toolbarRef?.setLabel("rec", t);

  // ------------------------------------------------------------ 造错误接线（验收用的 debug 钩子，?debug=1 才挂出）
  function injectWiring(
    kind:
      | "drive"
      | "5v"
      | "nores"
      | "nognd"
      | "addr"
      | "nodiv"
      | "short3v3"
      | "short5v"
      | "clamp"
      | "clear",
  ): string[] {
    const c = ctx!;
    const ses = c.session;
    let scene = ses.scene;
    let mods: WireMods = {};
    let label = "";
    const servo = scene.parts.find((p) => p.type === "servo");
    if (kind === "drive") {
      // 电位器滑片接到舵机信号脚上：滑片在推电平，GPIO 又在出 PWM
      const pin = servo && "pin" in servo ? servo.pin : 4;
      scene = {
        ...scene,
        parts: [
          ...scene.parts.filter((p) => p.type !== "pot"),
          { type: "pot", pin },
        ],
      };
      label = `电位器接到 GPIO${pin}`;
    } else if (kind === "5v") {
      mods = { retarget: { "wire:3V3~bme280:VIN": "5V" } };
      label = "BME280 供电改接 5V";
    } else if (kind === "nores") {
      scene = {
        ...scene,
        parts: [
          ...scene.parts.filter((p) => !(p.type === "led" && p.pin === 6)),
          { type: "led", pin: 6 },
        ],
      };
      mods = { noResistor: ["led:6"] };
      label = "LED 不串电阻";
    } else if (kind === "nognd") {
      mods = { drop: ["wire:GND~bme280:GND"] };
      label = "拔掉 BME280 地线";
    } else if (kind === "nodiv") {
      mods = { noDivider: ["hcsr04"] };
      label = "拆掉 Echo 分压电阻";
    } else if (kind === "clamp") {
      // 加一个 HC-SR04（Trig GPIO2、Echo GPIO3）并拆掉 Echo 分压：5 V 直接进 GPIO3 的钳位二极管
      scene = {
        ...scene,
        parts: [
          ...scene.parts.filter((p) => !(p.type === "hcsr04" && p.trig === 2)),
          { type: "hcsr04", trig: 2, echo: 3 },
        ],
      };
      mods = { noDivider: ["hcsr04"] };
      label = "超声波 Echo 不分压直连";
    } else if (kind === "short3v3" || kind === "short5v") {
      const r = kind === "short3v3" ? "3V3" : "5V";
      mods = { jumpers: [[r, "GND"]] };
      label = `跳线把 ${r} 接到 GND`;
    } else if (kind === "addr") {
      scene = {
        ...scene,
        parts: scene.parts.map((p) =>
          p.type === "oled" ? { ...p, addr: 0x76 } : p,
        ),
      };
      label = "OLED 地址改成 0x76";
    } else {
      label = "接线复原";
    }
    if (kind === "clear")
      scene = {
        ...scene,
        parts: scene.parts
          .filter(
            (p) =>
              p.type !== "pot" &&
              !(p.type === "led" && p.pin === 6) &&
              !(p.type === "hcsr04" && p.trig === 2),
          )
          .map((p) => (p.type === "oled" ? { ...p, addr: 0x3c } : p)),
      };
    c.hist?.op({ k: "wiring", mods, scene, label });
    // 只改台面和规则检查，不重新上电（模拟器里的器件不变）：这里验的是接线检查
    ses.restoreScene(scene, ses.power);
    ses.setWireMods(mods);
    return faults.flatMap((f) => f.wires);
  }

  return {
    mount(c) {
      ctx = c;
      toolbarRef = c.shell.toolbar;
      // 「换固件 → 上传」也算你自己的固件：和拖到检查框一样验收（2026-10-18 走查：菜单写着"检查点只认你自己上传的"，以前却不验收）
      actions.openBuy = c.custom ? openBuy : undefined;
      // 检查点定义（session.levels）可能还在加载：只看作品本身，跑的时候再按关取 ref
      actions.runAllRef = c.work.checkpoints.length && (!c.custom || c.custom.plan.demo) ? () => void runAllRef() : undefined;
      actions.checkUpload = (buf, name) => {
        const s = c.store.get();
        if (s.verifying) return null;
        if (c.custom) {
          const first = c.work.checkpoints[0];
          if (!first) return null;
          void verifyAll(buf, name, true);
          return c.work.checkpoints.join("、");
        }
        const sel = s.selection?.kind === "checkpoint" ? s.selection.id : null;
        const id =
          sel ??
          c.work.checkpoints.find((x) => !(s.checks[x]?.ok && s.checks[x].own));
        const l = id && c.session.levels.find((x) => x.id === id);
        if (!l) return null;
        c.store.set({ selection: { kind: "checkpoint", id: l.id } });
        void verify(l, buf, name, true);
        return l.id;
      };
      if (!hooked) {
        hooked = true;
        if (c.work.id === "blank" && c.work.example)
          void loadExamples().then((list) => {
            const ex = list.find((e) => e.id === c.work.example);
            if (!ex) return;
            exInfo = { ex, work: relatedWork(ex, list) };
            if (ctx && ctx.store.get().step === "bench" && !ctx.store.get().selection) renderProps();
          });
        c.session.pick.onPick?.(onPick);
        c.shell.toolbar.onTool(onTool);
        c.shell.card.onHide(() => {
          cancelAnimationFrame(cardRaf);
          cardFor = null;
        });
        c.session.onTick((m) => {
          if (trace.pin < 0) return;
          const p = trace.pin;
          trace.push({
            t: m.simSeconds,
            duty: m.pwm[p] ?? -1,
            freq: m.pwmFreq[p] ?? 0,
            level: bit(m.gpio, m.gpioHi, p),
            out: !!bit(m.enable, m.enableHi, p),
          });
        });
        // 工具快捷键（工具条角标）：输入框里不拦；Esc 先退出当前工具
        window.addEventListener("keydown", (e) => {
          if (
            !ctx ||
            ctx.store.get().step !== "bench" ||
            e.metaKey ||
            e.ctrlKey ||
            e.altKey
          )
            return;
          if (
            (e.target as HTMLElement).closest(
              "input,textarea,select,[contenteditable]",
            )
          )
            return;
          const k = e.key.toLowerCase();
          if (k === "escape") {
            if (placing) {
              const n = placing.def.name;
              endPlace();
              ctx.shell.toast(`没放 ${n}`);
            } else if (bc.get().overlays.wrongWire) overlay("wrongWire", null);
            else if (wiring) setWiring(false);
            else if (ruler) setRuler(false);
            else if (meter) setMeter(false);
            return;
          }
          const tool = (
            {
              v: "select",
              h: "orbit",
              w: "wire",
              m: "meter",
              r: "ruler",
            } as Record<string, string>
          )[k];
          if (tool) onTool(tool);
        });
        // 元件库拖到台面（P2-16）：只认元件库的拖动类型，拖 .bin 文件不归这里管
        const stage = document.getElementById("stage");
        stage?.addEventListener("dragover", (e) => {
          if (!ctx || ctx.store.get().step !== "bench") return;
          if (!e.dataTransfer?.types.includes(LIB_DRAG)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        });
        stage?.addEventListener("drop", (e) => {
          const id = e.dataTransfer?.getData(LIB_DRAG);
          if (!id || !ctx || ctx.store.get().step !== "bench") return;
          e.preventDefault();
          startPlace(id);
        });
        if (new URLSearchParams(location.search).has("debug")) {
          const w = window as unknown as { __tbApp?: Record<string, unknown> };
          w.__tbApp ??= {};
          w.__tbApp.injectWiring = (k: Parameters<typeof injectWiring>[0]) =>
            ctx ? injectWiring(k) : [];
          w.__tbApp.faults = () =>
            faults.map((f) => ({
              rule: f.rule,
              wires: f.wires,
              short: f.short,
              mA: f.estimate?.mA ?? null,
              est: f.estimate?.text ?? null,
            }));
          // 打开某根线的接错线卡片（验收截图用；和改接后弹出的是同一张）
          w.__tbApp.showWrongWire = (wireId: string) => {
            const f = faults.find((x) => x.wires.includes(wireId));
            if (!ctx || !f) return false;
            showWrongWire(
              f,
              wireId,
              `${wireId.replace(/^wire:/, "")}`,
              () => {},
              () => {},
            );
            return true;
          };
          w.__tbApp.setWireLen = (part: string, cm: number) =>
            ctx && setWireLen(part, cm);
        }
      }
      c.shell.toolbar.setGroups([
        {
          id: "nav",
          tools: [
            { id: "select", label: "选择", key: "V" },
            { id: "orbit", label: "转视角", key: "H" },
          ],
        },
        {
          id: "edit",
          tools: [
            { id: "place", label: "放置" },
            { id: "wire", label: "连线", key: "W" },
          ],
        },
        {
          id: "measure",
          tools: [
            { id: "meter", label: "万用表", key: "M" },
            { id: "ruler", label: "尺子", key: "R" },
            { id: "scope", label: "示波器" },
          ],
        },
        {
          id: "look",
          tools: [
            {
              id: "ext",
              label: extModelsOn() ? "外部模型：开" : "外部模型：关",
            },
          ],
        },
        {
          id: "media",
          tools: [
            { id: "photo", label: "拍照" },
            { id: "rec", label: benchRec ? "停止录像" : "录像" },
          ],
        },
        {
          id: "act",
          tools: [
            { id: "heat", label: "热源" },
            { id: "button", label: "按 BOOT" },
          ],
        },
        // 重跑在顶栏运行组（重启），工具条不再重复放（DESIGN_V2 §6.3）
      ]);
      c.shell.toolbar.setActive(
        ruler ? "ruler" : meter ? "meter" : wiring ? "wire" : "select",
      );
      const pinDev = c.session.scene.parts.find(
        (p) => p.type === "encoder" || p.type === "hcsr04",
      );
      // 跑示例时右栏默认是「这个示例」卡（说明 + 滑块），不抢先选中固件；编码器 / 超声波的调节在零件属性里，照旧选中
      if (!c.store.get().selection && !(c.work.example && !pinDev))
        c.store.set({
          selection: c.work.checkpoints.length
            ? { kind: "part", id: "bme280" }
            : pinDev
              ? { kind: "part", id: pinDev.type }
              : { kind: "firmware", id: "main" },
        });
      if (
        !c.session.scene.parts.some((p) => partId(p) === "bme280") &&
        c.store.get().selection?.id === "bme280"
      )
        c.store.set({ selection: { kind: "part", id: "board" } });
      recheckWiring();
      applyBenchHarness();
      // ?debug=1&wiring=<种类>：打开就造一种错接，再弹出它的接错线卡片（人眼验收用，和 __tbApp.injectWiring 同一入口）
      const q = new URLSearchParams(location.search);
      const inj = q.has("debug") ? q.get("wiring") : null;
      if (inj) {
        // 只造一次；台面重新挂载（切步骤回来）时只把卡片和选中再开出来
        if (!injected) injectWiring(inj as Parameters<typeof injectWiring>[0]);
        injected = true;
        recheckWiring();
        const f = faults.find((x) => x.net) ?? faults[0];
        if (f) {
          c.store.set({ selection: { kind: "wire", id: f.wires[0] } });
          showWrongWire(
            f,
            f.wires[0],
            f.wires[0].replace(/^wire:/, ""),
            () => {},
            () => {},
          );
        }
      }
      meterCard();
      renderTree();
      renderProps();
      syncChrome();
      if (pendingAllRef) {
        pendingAllRef = false;
        actions.runAllRef?.();
      }
      unsubs = [
        c.store.subscribe(() => {
          renderTree();
          renderProps();
          c.session.pick.highlight?.(toPick(c.store.get().selection));
          syncChrome();
        }, ["selection", "checks", "verifying"]),
        // 选板作品：最后一个检查点刚通过时把真买卡打开（恢复进度时不弹）
        c.store.subscribe(
          (s, prev) => {
            const n = c.work.checkpoints.length;
            if (!buyArmed) return;
            buyArmed = false;
            if (c.custom && n && passedCount(c, s) === n && passedCount(c, prev) < n) openBuy();
          },
          ["checks"],
        ),
        c.store.subscribe(
          (s, prev) => {
            recheckWiring();
            renderTree();
            // 拖滑块时不重建面板（会打断拖动）：时间线只是多了一步不重画；编辑状态变了（供电、热源、改接线、回退）才重画
            const h = s.hist,
              p = prev.hist;
            if (s.editRev !== prev.editRev && cardFor && c.shell.card.open) {
              const box = cardContent(cardFor);
              if (box)
                c.shell.card.show(
                  c.session.pick.project?.(cardFor) ?? { x: 0, y: 0 },
                  box,
                );
            }
            if (
              s.editRev !== prev.editRev ||
              s.sceneRev !== prev.sceneRev ||
              h.seeked !== p.seeked ||
              h.busy !== p.busy ||
              h.runs !== p.runs ||
              (h.seeked && h.cur !== p.cur) ||
              s.selection?.kind === "run"
            )
              renderProps();
          },
          ["editRev", "sceneRev", "hist"],
        ),
        c.store.subscribe(() => renderTree(), ["env", "run", "runNo"]),
        // 构建树「无线」组：BLE 出现 / 消失、手机状态字变了才重画（通知每秒都来，不能每条都重画整棵树）
        (() => {
          let label = "";
          return bleFeed.subscribe(() => {
            const b = bleFeed.get();
            const l = `${b.state}|${phoneStateText(b)}`;
            if (l === label) return;
            label = l;
            renderTree();
            if (b.state === 0 && c.store.get().selection?.kind === "ble") select(null);
          });
        })(),
        c.store.subscribe(
          () => updateLive(),
          [
            "simSeconds",
            "reading",
            "running",
            "run",
            "verifyProgress",
            "env",
            "pose",
            "imu",
            "touch",
          ],
        ),
      ];
      c.session.pick.highlight?.(toPick(c.store.get().selection));
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      closeCard();
      // 分析仪属于实验台：离开时由 CSS 藏起来（body[data-step]），状态保留，回来接着看
      if (ruler) {
        ruler = null;
        ctx?.session.pick.measure?.(null);
      }
      meter = null;
      wiring = null;
      placing = null;
      for (const k of ["wire", "rings", "wrongWire", "meter", "empty", "place", "customPlaced", "buy"])
        overlay(k, null);
      setLeft({ lib: null, wires: null, wireCount: 0, card: null });
      ctx?.session.pick.highlight?.(null);
      actions.checkUpload = undefined;
      actions.openBuy = undefined;
      actions.runAllRef = undefined;
      ctx = null;
    },
  };
}

/** 彩灯色块（实时字段里由命令式代码拼） */
function swatch(bg: string) {
  const i = document.createElement("i");
  i.className =
    "sw mr-1.5 inline-block size-2.5 rounded-[3px] border border-[#0002] align-[-1px]";
  i.style.background = bg;
  return i;
}

/** 文字由命令式代码改的说明行（线长换算） */
function NoteLive({ id, init }: { id: string; init: string }) {
  const ref = useInitText<HTMLParagraphElement>(init);
  return <p ref={ref} id={id} className="note my-2 text-xs text-muted" />;
}

/** 一句人话结论（拖滑块时由事件直接改字，不重渲染） */
function SayLive({ id, init }: { id: string; init: string }) {
  const ref = useInitText<HTMLParagraphElement>(init);
  return <p ref={ref} id={id} className="mt-2 mb-0 text-[13px] font-medium text-fg" />;
}

/** 属性面板的零件标题：名字 + 可信度徽章（依据见 benchv2 PART_CONF） */
function PartHead({ name, type }: { name: string; type: string }) {
  const conf = PART_CONF[type];
  return (
    <div className="mb-2 flex items-center gap-2">
      <Ph className="mb-0 min-w-0">{name}</Ph>
      {conf && <ConfBadge c={conf} />}
    </div>
  );
}

/** 用到同一类主要器件的作品（灯、按键这类常见件不算），没有就不指 */
function relatedWork(ex: Example, list: Example[]): WorkDef | null {
  const common = new Set(["led", "button", "key", "buzzer"]);
  const types = new Set((ex.scene?.parts ?? []).map((p) => p.type).filter((t) => !common.has(t)));
  if (!types.size) return null;
  return (
    HOME_WORKS.find((w) => {
      if (!w.checkpoints.length || !w.example) return false;
      if (w.example === ex.id) return true;
      const we = list.find((e) => e.id === w.example);
      return (we?.scene?.parts ?? []).some((p) => types.has(p.type));
    }) ?? null
  );
}
