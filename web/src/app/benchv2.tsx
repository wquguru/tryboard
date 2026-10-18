// 实验台 v2 的台面卡片和左栏内容（U-04）：连线横幅、可连引脚圈、接错线确认、万用表常驻卡、
// 检查点提示卡、接线表、元件库、可信度徽章、空台面引导、欠压解释。
// 这里只管画；数据和动作都由 steps/bench.tsx（或 main.tsx）传进来，不碰 Session。
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ScreenPoint } from "../scene-api";
import { PARTS, type Kind } from "../catalog/parts";
import { cn } from "../ui/cn";
import { Live } from "../ui/native";
import { Icon } from "./icons";
import { isPhone, setMui, usePhone } from "./mobile";
import type { BenchWire } from "./wiring";
import { placeDef } from "./place";

const btn =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs text-fg hover:bg-field";
const btnPri =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1 rounded-md border border-accent-strong bg-accent-strong px-2.5 text-xs font-medium text-on-accent";

// ------------------------------------------------------------ 可信度
export type Conf = "仿真验证" | "行为模拟" | "估算" | "必须上真机";
const CONF_CLS: Record<Conf, string> = {
  仿真验证: "bg-ok-bg text-ok-ink",
  行为模拟: "bg-accent-bg text-accent-ink",
  估算: "bg-warn-bg text-warn-ink",
  必须上真机: "bg-bad-bg text-bad-ink",
};
const CONF_TIP: Record<Conf, string> = {
  仿真验证: "有验收固件在模拟器里跑过，读数按数据手册的寄存器和公式算出",
  行为模拟: "寄存器接口按数据手册，物理量按规则近似；噪声、时序细节没模拟",
  估算: "没有模型，只按规格书估算",
  必须上真机: "这一项模拟不了，结论要上真机才算数",
};
/** 台面零件的可信度：依据见 docs/STATUS.md 各外设一行（有固件验收 = 仿真验证） */
export const PART_CONF: Record<string, Conf> = {
  board: "仿真验证",
  bme280: "仿真验证",
  oled: "仿真验证",
  gc9a01: "仿真验证",
  pot: "仿真验证",
  led: "仿真验证",
  key: "仿真验证",
  encoder: "仿真验证",
  servo: "行为模拟",
  buzzer: "行为模拟",
  hcsr04: "行为模拟",
  mpu6050: "行为模拟",
  qmi8658: "行为模拟",
  cst816s: "行为模拟",
  max98357a: "行为模拟",
  inmp441: "行为模拟",
};
export function ConfBadge({ c }: { c: Conf }) {
  return (
    <span
      data-conf={c}
      title={CONF_TIP[c]}
      className={cn(
        "inline-flex h-5 flex-none items-center rounded-full px-2 text-[11px] whitespace-nowrap",
        CONF_CLS[c],
      )}
    >
      {c}
    </span>
  );
}

// ------------------------------------------------------------ 连线横幅 + 引脚圈
/** wires / onWire / onUndo：手机上细线很难点中，横幅里直接列出能改接的线；撤销和接线表也放这（DESIGN_V2 §5） */
export function WireBanner({
  wire,
  onCancel,
  wires,
  onWire,
  onUndo,
}: {
  wire: string | null;
  onCancel: () => void;
  wires?: { id: string; label: string }[];
  onWire?: (id: string) => void;
  onUndo?: (() => void) | null;
}) {
  const phone = usePhone();
  if (phone)
    return (
      <div
        id="wireBanner"
        role="status"
        className="absolute top-2 right-2 left-2 z-5 rounded-xl bg-accent-strong p-2 pl-3 text-[13px] text-on-accent shadow-panel"
      >
        <div className="flex items-center gap-2">
          <Icon n="wire" size={16} className="flex-none" />
          <span className="min-w-0 flex-1 leading-snug">
            {wire ? (
              <>
                已选：<b className="font-mono">{wire}</b>，再点一个发蓝的引脚
              </>
            ) : (
              "先点一根要改接的线："
            )}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-3 text-[13px] text-on-accent"
          >
            取消
          </button>
        </div>
        {!wire && !!wires?.length && (
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {wires.map((w) => (
              <button
                key={w.id}
                type="button"
                data-wpick={w.id}
                onClick={() => onWire?.(w.id)}
                className="min-h-11 flex-none cursor-pointer rounded-lg border-0 bg-surface px-3 font-mono text-xs whitespace-nowrap text-fg"
              >
                {w.label}
              </button>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex gap-1.5">
          <button
            type="button"
            data-wire-undo=""
            disabled={!onUndo}
            onClick={() => onUndo?.()}
            className="min-h-11 flex-1 cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-2 text-[13px] text-on-accent disabled:opacity-50"
          >
            撤销上一步
          </button>
          <button
            type="button"
            data-wire-table=""
            onClick={() => setMui({ lib: "wires", props: false, more: false })}
            className="min-h-11 flex-1 cursor-pointer rounded-lg border-0 bg-[#ffffff2e] px-2 text-[13px] text-on-accent"
          >
            看接线表
          </button>
        </div>
      </div>
    );
  return (
    <div
      id="wireBanner"
      role="status"
      className="absolute top-14 left-1/2 z-4 flex -translate-x-1/2 items-center gap-2 rounded-full bg-accent-strong py-1 pr-1 pl-3.5 text-xs text-on-accent shadow-panel"
    >
      <Icon n="wire" size={14} />
      <span>
        {wire ? (
          <>
            改接 <b className="font-mono">{wire}</b>：点一根新的引脚
          </>
        ) : (
          "连线中… 先点一根要改接的线"
        )}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="h-6 cursor-pointer rounded-full border-0 bg-[#ffffff2e] px-2.5 text-xs text-on-accent hover:bg-[#ffffff47]"
      >
        Esc 取消
      </button>
    </div>
  );
}

/** 放零件后的逐根接线引导（P2-16）：零件这头的针一根根列出来，当前那根高亮；点开发板上发蓝的圈接上 */
export function PlaceBanner({
  name,
  steps,
  cur,
  got,
  onStep,
  onSkip,
  onBack,
  onCancel,
}: {
  name: string;
  steps: { pin: string; label: string; want: string; optional?: boolean }[];
  cur: number;
  got: Record<string, string>;
  onStep: (i: number) => void;
  onSkip: (() => void) | null;
  onBack: (() => void) | null;
  onCancel: () => void;
}) {
  const phone = usePhone();
  const s = steps[cur];
  const what =
    s.want === "gnd" ? "GND" : s.want === "power" ? "3V3 或 5V" : "一根 GPIO";
  return (
    <div
      id="placeBanner"
      role="status"
      data-step={s.pin}
      className={cn(
        "absolute z-5 rounded-xl bg-accent-strong text-on-accent shadow-panel",
        phone
          ? "top-2 right-2 left-2 p-2 pl-3 text-[13px]"
          : "top-14 left-1/2 w-[min(560px,calc(100%-24px))] -translate-x-1/2 px-3.5 py-2 text-xs",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon n="wire" size={14} className="flex-none" />
        <span className="min-w-0 flex-1 leading-snug">
          接 <b>{name}</b> 的 <b className="font-mono">{s.label}</b>
          {s.optional ? "（可不接）" : ""}：点开发板上{what}（蓝圈）
        </span>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "flex-none cursor-pointer rounded-full border-0 bg-[#ffffff2e] px-2.5 text-on-accent hover:bg-[#ffffff47]",
            phone ? "min-h-11 text-[13px]" : "h-6 text-xs",
          )}
        >
          {phone ? "不放了" : "Esc 不放了"}
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {steps.map((x, i) => (
          <button
            key={x.pin}
            type="button"
            data-pstep={x.pin}
            aria-current={i === cur ? "step" : undefined}
            onClick={() => onStep(i)}
            className={cn(
              "cursor-pointer rounded-md border-0 px-2 font-mono text-[11px] whitespace-nowrap",
              phone ? "min-h-11" : "h-6",
              i === cur
                ? "bg-surface text-fg"
                : got[x.pin]
                  ? "bg-[#ffffff2e] text-on-accent"
                  : "bg-transparent text-on-accent opacity-75 outline outline-1 outline-[#ffffff47]",
            )}
          >
            {x.label}
            {got[x.pin] ? ` → ${got[x.pin]}` : ""}
          </button>
        ))}
        <span className="flex-1" />
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className={cn(
              "cursor-pointer rounded-md border-0 bg-[#ffffff2e] px-2 text-on-accent",
              phone ? "min-h-11 text-[13px]" : "h-6 text-[11px]",
            )}
          >
            上一根
          </button>
        )}
        {onSkip && (
          <button
            type="button"
            data-pskip=""
            onClick={onSkip}
            className={cn(
              "cursor-pointer rounded-md border-0 bg-[#ffffff2e] px-2 text-on-accent",
              phone ? "min-h-11 text-[13px]" : "h-6 text-[11px]",
            )}
          >
            这根不接
          </button>
        )}
      </div>
    </div>
  );
}

export interface RingPin {
  id: string;
  label: string;
  role?: string;
  /** 这根针上已经接着的线（零件端） */
  used: string[];
}
/** 可连引脚：每根针一个圈，位置每帧按 3D 投影跟着相机走（直接改 style，不重画） */
export function PinRings({
  pins,
  cur,
  project,
  onPin,
}: {
  pins: RingPin[];
  cur: string | null;
  project: (id: string) => ScreenPoint | null;
  onPin: (id: string) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      for (const p of pins) {
        const el = refs.current[p.id];
        if (!el) continue;
        const s = project(p.id);
        // 相机不动时不改 DOM：每帧写 style 会让页面一直"在变"
        if (el.hidden !== !s) el.hidden = !s;
        const tf = s
          ? `translate(${Math.round(s.x - 9)}px, ${Math.round(s.y - 9)}px)`
          : "";
        if (s && el.style.transform !== tf) el.style.transform = tf;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [pins, project]);
  const h = hover ? pins.find((p) => p.id === hover) : null;
  const lens = useLens(pins, refs, onPin);
  return (
    <div id="pinRings" className="pointer-events-none absolute inset-0 z-3">
      {pins.map((p) => (
        <button
          key={p.id}
          ref={(el) => void (refs.current[p.id] = el)}
          type="button"
          data-ring={p.id}
          aria-label={`接到 ${p.id}`}
          onClick={() => onPin(p.id)}
          onPointerEnter={() => setHover(p.id)}
          onPointerLeave={() => setHover((x) => (x === p.id ? null : x))}
          className={cn(
            "pointer-events-auto absolute top-0 left-0 size-[18px] cursor-pointer rounded-full border-2 bg-transparent p-0",
            // 手机：圈画大一点；点按交给放大镜（useLens）找最近的针，相邻针 2.54 mm 在屏上只有几像素
            "max-md:scale-125",
            p.id === cur
              ? "border-warn-ink"
              : p.used.length
                ? "border-muted"
                : "border-accent",
            "hover:bg-accent-bg",
          )}
        />
      ))}
      {h && (
        <div
          role="tooltip"
          className="absolute rounded-md border border-line bg-surface px-2 py-1 text-[11px] whitespace-nowrap text-fg shadow-panel"
          style={{
            transform: refs.current[h.id]?.style.transform,
            marginTop: 24,
          }}
        >
          <b className="font-mono">{h.id}</b>
          {h.label !== h.id && (
            <span className="text-muted">（丝印 {h.label}）</span>
          )}
          <span className="ml-1.5">
            {h.id === cur
              ? "现在接在这"
              : h.used.length
                ? `占用：${h.used.join("、")}`
                : "空闲"}
          </span>
          {h.role && <span className="block text-muted">{h.role}</span>}
        </div>
      )}
      {lens}
    </div>
  );
}

const ringCenter = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
/** 手机连线的放大镜：手指按在台面上时，在指尖上方画一个 140px 的圆，把指尖附近的针放大 2.5 倍画出来，
 *  高亮离指尖最近的那根；松手就接到它。不截 WebGL 画面（要 preserveDrawingBuffer，拖慢每一帧），只画针位示意。 */
function useLens(
  pins: RingPin[],
  refs: React.RefObject<Record<string, HTMLButtonElement | null>>,
  onPin: (id: string) => void,
) {
  const [st, setSt] = useState<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    id: string | null;
  } | null>(null);
  const live = useRef(st);
  live.current = st;
  useEffect(() => {
    const stage = document.getElementById("stage");
    if (!stage) return;
    const near = (x: number, y: number, max: number) => {
      let best: string | null = null;
      let bd = max;
      for (const p of pins) {
        const el = refs.current[p.id];
        if (!el || el.hidden) continue;
        const c = ringCenter(el);
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < bd) {
          bd = d;
          best = p.id;
        }
      }
      return best;
    };
    const down = (e: PointerEvent) => {
      if (!isPhone() || e.button > 0) return;
      // 只在针附近按下才接管（别处照常转视角）
      const id = near(e.clientX, e.clientY, 40);
      if (!id) return;
      e.stopPropagation();
      e.preventDefault();
      const o = stage.getBoundingClientRect();
      setSt({ x: e.clientX, y: e.clientY, ox: o.left, oy: o.top, id });
      const move = (ev: PointerEvent) => {
        ev.preventDefault();
        setSt(
          (s) =>
            s && {
              ...s,
              x: ev.clientX,
              y: ev.clientY,
              id: near(ev.clientX, ev.clientY, 48),
            },
        );
      };
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        const pick = live.current?.id;
        setSt(null);
        if (pick) onPin(pick);
      };
      const cancel = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        setSt(null);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
    };
    // 圈上的 click 也会触发 onPin：手机上由松手接，吞掉随后的 click 免得接两次
    const click = (e: MouseEvent) => {
      if (isPhone() && (e.target as HTMLElement).closest?.("[data-ring]")) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    stage.addEventListener("pointerdown", down, true);
    stage.addEventListener("click", click, true);
    return () => {
      stage.removeEventListener("pointerdown", down, true);
      stage.removeEventListener("click", click, true);
    };
  }, [pins, refs, onPin]);
  if (!st) return null;
  const R = 70;
  const K = 2.5;
  const hit = st.id ? pins.find((p) => p.id === st.id) : null;
  const dots = pins
    .map((p) => {
      const el = refs.current[p.id];
      if (!el || el.hidden) return null;
      const c = ringCenter(el);
      const dx = (c.x - st.x) * K,
        dy = (c.y - st.y) * K;
      return Math.hypot(dx, dy) < R - 8 ? { p, dx, dy } : null;
    })
    .filter((d) => !!d);
  // 圆放在指尖正上方（手指不挡住），顶到台面上沿就放到旁边
  const lx = st.x - st.ox,
    ly = st.y - st.oy;
  const top = ly - 2 * R - 36 < 0 ? ly - R : ly - 2 * R - 36;
  const left =
    ly - 2 * R - 36 < 0 ? (lx > 200 ? lx - 2 * R - 40 : lx + 40) : lx - R;
  return (
    <div
      id="pinLens"
      aria-live="polite"
      className="pointer-events-none absolute z-6"
      style={{ left, top }}
    >
      <div className="relative size-[140px] overflow-hidden rounded-full border-2 border-accent-strong bg-surface shadow-panel">
        <span className="absolute top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full bg-muted" />
        {dots.map(({ p, dx, dy }) => (
          <span
            key={p.id}
            className={cn(
              "absolute top-1/2 left-1/2 size-4 rounded-full border-2",
              p.id === st.id
                ? "border-accent-strong bg-accent-strong"
                : p.used.length
                  ? "border-muted"
                  : "border-accent",
            )}
            style={{ transform: `translate(${dx - 8}px, ${dy - 8}px)` }}
          />
        ))}
      </div>
      <div className="mt-1 w-[140px] rounded-md bg-fg px-2 py-1 text-center text-[11px] leading-tight text-surface">
        {hit ? (
          <>
            <b className="font-mono">{hit.id}</b>
            <span className="block opacity-80">
              {hit.used.length
                ? `占用：${hit.used.join("、")}`
                : (hit.role ?? "空闲")}
            </span>
          </>
        ) : (
          "挪近一根针"
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 接错线确认
export function WrongWireCard({
  title,
  detail,
  wire,
  sim,
  estimate,
  onUndo,
  onRetry,
  onKeep,
}: {
  title: string;
  detail: string;
  wire: string;
  sim: string;
  /** 网络求解出的电流和后果（P2-14，估算；算出来之前不显示） */
  estimate?: { mA: number; text: string; what: string };
  onUndo: () => void;
  onRetry: () => void;
  onKeep: () => void;
}) {
  return (
    <div
      id="wrongWire"
      role="alertdialog"
      aria-label="接错线"
      className="absolute top-14 left-1/2 z-5 w-[380px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) max-md:top-2 max-md:z-6 bg-surface p-3.5 text-fg shadow-panel"
    >
      <div className="flex items-start gap-2">
        <Icon n="warn" size={18} className="mt-0.5 flex-none text-bad-ink" />
        <div className="min-w-0 flex-1">
          <b className="block text-sm">这样接会出问题：{title}</b>
          <span className="block font-mono text-[11px] text-muted">{wire}</span>
        </div>
      </div>
      <p className="mt-2 mb-0 text-xs">{detail}</p>
      {estimate && (
        <div
          data-ww="estimate"
          className="mt-2 rounded-(--r) border border-(--bad-line) bg-bad-bg px-2.5 py-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <b className="font-mono text-sm text-bad-ink">≈ {estimate.mA} mA</b>
            <ConfBadge c="估算" />
          </div>
          <p className="mt-1 mb-0">{estimate.text}</p>
          <p className="mt-0.5 mb-0 text-[11px] text-muted">
            按最坏情况：{estimate.what}
          </p>
        </div>
      )}
      <p className="mt-1.5 mb-0 text-[11px] text-muted">{sim}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          data-ww="undo"
          className={btnPri}
          onClick={onUndo}
        >
          撤销这次改接
        </button>
        <button type="button" data-ww="retry" className={btn} onClick={onRetry}>
          改接到别的针
        </button>
        <button type="button" data-ww="keep" className={btn} onClick={onKeep}>
          我知道，保留
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 万用表常驻卡
/** 读数由实验台的 updateLive 按 data-live 填（data-live-root 让它找到这张卡） */
export function MeterCard({
  target,
  onClose,
}: {
  target: string | null;
  onClose: () => void;
}) {
  return (
    <div
      id="meterCard"
      data-live-root=""
      role="region"
      aria-label="万用表"
      className="absolute right-3 bottom-[calc(var(--tb-h,52px)+12px)] z-3 w-[220px] rounded-(--r) border border-line bg-surface p-3 text-fg shadow-panel max-md:right-2 max-md:bottom-2 max-md:w-[200px]"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">万用表 · 直流电压</span>
        <button
          type="button"
          aria-label="收起万用表"
          onClick={onClose}
          className="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field max-md:-my-2 max-md:-mr-2 max-md:size-11"
        >
          <Icon n="x" size={13} />
        </button>
      </div>
      <Live
        k="mv"
        init="—"
        className="mt-1 block font-mono text-2xl font-semibold tabular-nums"
      />
      <span className="block text-xs text-muted">
        {target ? (
          <>
            <span className="font-mono">{target}</span> 对 GND
          </>
        ) : (
          "点台面上的一根针或一根线"
        )}
      </span>
      <Live as="p" k="mnote" className="mt-1.5 mb-0 text-[11px] text-muted" />
    </div>
  );
}

// ------------------------------------------------------------ 检查点提示卡（左栏底部）
export function CheckpointCard({
  id,
  title,
  pass,
  done,
  total,
  go,
  onGo,
  onAll,
}: {
  id: string;
  title: string;
  pass: string;
  done: number;
  total: number;
  go: string | null;
  onGo: () => void;
  onAll: () => void;
}) {
  return (
    <div
      id="cpCard"
      className="rounded-lg border border-line bg-surface p-2.5 text-xs"
    >
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>当前检查点</span>
        <span className="font-mono">
          {done}/{total}
        </span>
      </div>
      <b className="mt-1 block text-[13px]">
        <span className="font-mono">{id}</span> {title}
      </b>
      <p className="mt-1 mb-2 line-clamp-3 text-muted">{pass}</p>
      <div className="flex gap-1.5">
        <button
          type="button"
          id="cpGo"
          className={btnPri}
          onClick={onGo}
          title={go ? `选中并对准 ${go}` : "打开这个检查点"}
        >
          带我去接
        </button>
        <button type="button" id="cpAll" className={btn} onClick={onAll}>
          看全部检查点
        </button>
      </div>
    </div>
  );
}
export function AllPassedCard({
  total,
  retest,
  onNext,
}: {
  total: number;
  /** 组装后开机复测：false = 没过（台面上通过不代表装进外壳也行，不能还写"全部通过"） */
  retest?: boolean | null;
  onNext: () => void;
}) {
  if (retest === false)
    return (
      <div
        id="cpCard"
        className="rounded-lg border border-(--warn-line) bg-warn-bg p-2.5 text-xs text-warn-ink"
      >
        <b className="block text-[13px]">
          检查点 {total}/{total} 通过 · 开机复测 ✗
        </b>
        <p className="mt-1 mb-2">台面上没问题，装进外壳后复测没过：回组装看哪里要改。</p>
        <button type="button" className={btnPri} onClick={onNext}>
          回组装 →
        </button>
      </div>
    );
  return (
    <div
      id="cpCard"
      className="rounded-lg border border-line bg-ok-bg p-2.5 text-xs text-ok-ink"
    >
      <b className="block text-[13px]">{total} 个检查点全部通过</b>
      <p className="mt-1 mb-2">组装已经解锁：把台面上的东西装进外壳。</p>
      <button type="button" className={btnPri} onClick={onNext}>
        下一步：组装 →
      </button>
    </div>
  );
}

// ------------------------------------------------------------ 接线表
export function WireTable({
  wires,
  bad,
  sel,
  onSel,
}: {
  wires: BenchWire[];
  bad: Map<string, string>;
  sel: string | null;
  onSel: (id: string) => void;
}) {
  if (!wires.length)
    return <p className="m-2 text-xs text-muted">台面上没有外接线</p>;
  return (
    <table id="wireTable" className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-left text-[11px] text-muted">
          <th className="px-1 py-1 font-normal">开发板</th>
          <th className="px-1 py-1 font-normal">零件</th>
          <th className="px-1 py-1 font-normal">线</th>
        </tr>
      </thead>
      <tbody>
        {wires.map((w) => {
          const b = bad.get(w.id);
          return (
            <tr
              key={w.id}
              data-wire={w.id}
              aria-selected={sel === w.id}
              onClick={() => onSel(w.id)}
              title={b ? `✗ ${b}` : w.role}
              className={cn(
                "cursor-pointer border-t border-line-soft hover:bg-field aria-selected:bg-accent-bg",
                w.missing && "opacity-50",
              )}
            >
              <td className="px-1 py-1.5 font-mono">
                {w.a}
                {w.from && (
                  <span className="block text-[10px] text-muted">
                    原 {w.from}
                  </span>
                )}
              </td>
              <td className="px-1 py-1.5">
                <span className="font-mono">{w.b}</span>
                {b && (
                  <span className="block text-[11px] text-bad-ink">✗ {b}</span>
                )}
                {w.missing && (
                  <span className="block text-[11px] text-muted">拔掉了</span>
                )}
              </td>
              <td className="px-1 py-1.5 text-muted">
                {w.color} · {w.lenCm} cm
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------ 元件库
const KIND_NAMES: Partial<Record<Kind, string>> = {
  sensor: "传感器",
  display: "屏幕",
  actuator: "执行器",
  input: "输入",
  audio: "音频",
  module: "模块",
  power: "电源",
  passive: "分立元件",
};
/** 元件库拖到台面时 dataTransfer 里的类型（台面 drop 只认它，不和拖 .bin 混） */
export const LIB_DRAG = "application/x-tryboard-part";
const SIM_NAMES = {
  verified: "仿真验证",
  estimated: "估算",
  none: "无模型",
} as const;
/** inBom：已在采购清单里的零件 id（手机整页库里标「在清单」） */
export function PartLib({
  chip,
  inBom,
  onPlace,
}: {
  chip: "esp32c3" | "esp32s3";
  inBom?: ReadonlySet<string>;
  /** 桌面：点「放到台面」或拖到台面上（P2-16）；没给就只能去采购加 */
  onPlace?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind | null>(null);
  const phone = usePhone();
  const all = PARTS.filter(
    (p) =>
      KIND_NAMES[p.kind] &&
      p.chips.includes(chip) &&
      (!q ||
        (p.name + p.model + p.keywords)
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  const list = phone && kind ? all.filter((p) => p.kind === kind) : all;
  const kinds = [...new Set(list.map((p) => p.kind))];
  if (phone)
    return (
      <div id="partLib" className="text-[14px]">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="找零件：BME280、舵机…"
          aria-label="找零件"
          className="h-11 w-full rounded-xl border border-line bg-field px-3 text-[16px] text-fg outline-none focus:border-accent"
        />
        <div
          role="group"
          aria-label="分类"
          className="-mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]"
        >
          {([null, ...new Set(all.map((p) => p.kind))] as (Kind | null)[]).map(
            (k) => (
              <button
                key={k ?? "all"}
                type="button"
                data-kind={k ?? "all"}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className="h-11 flex-none cursor-pointer rounded-full border border-line bg-surface px-3.5 text-[13px] whitespace-nowrap text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg aria-pressed:font-medium aria-pressed:text-accent-ink"
              >
                {k ? KIND_NAMES[k] : "全部"}
              </button>
            ),
          )}
        </div>
        <p className="mt-1 mb-2 text-xs text-muted">
          零件从采购清单摆上台面：点一个去采购里勾上它。价格是人工参考区间。
        </p>
        {list.map((p) => {
          const has = inBom?.has(p.id);
          return (
            <a
              key={p.id}
              href="#shop"
              data-lib={p.id}
              className="flex min-h-14 items-center gap-3 border-b border-line-soft py-1.5 text-fg no-underline"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-xs text-muted">
                  {KIND_NAMES[p.kind]} · ¥{p.price.lo}–{p.price.hi} ·{" "}
                  <span
                    className={p.sim.level === "verified" ? "text-ok-ink" : ""}
                  >
                    {SIM_NAMES[p.sim.level]}
                  </span>
                </span>
              </span>
              <span
                className={cn(
                  "flex-none rounded-full px-3 py-1.5 text-xs",
                  has
                    ? "bg-ok-bg text-ok-ink"
                    : "bg-accent-strong text-on-accent",
                )}
              >
                {has ? "在清单" : "去加"}
              </span>
            </a>
          );
        })}
        {!list.length && <p className="text-muted">没有匹配的零件</p>}
      </div>
    );
  return (
    <div id="partLib" className="text-xs">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        placeholder="找零件：BME280、舵机…"
        aria-label="找零件"
        className="mb-2 h-8 w-full rounded-md border border-line bg-field px-2 text-xs text-fg outline-none focus:border-accent"
      />
      <p className="mt-0 mb-2 text-[11px] text-muted">
        {onPlace
          ? "拖到台面上，或点「放」，再一根根接到开发板；灰的放不了，悬停看原因。整套零件仍可从采购清单摆。"
          : "零件从采购清单摆上台面：点一个去采购里勾上它。"}
      </p>
      {kinds.map((k) => (
        <section key={k} className="mb-2">
          <h4 className="m-0 mb-1 text-[11px] font-medium text-muted">
            {KIND_NAMES[k]}
          </h4>
          {list
            .filter((p) => p.kind === k)
            .map((p) => {
              const d = onPlace ? placeDef(p.id) : null;
              const why = d && "why" in d ? d.why : null;
              return (
                <div
                  key={p.id}
                  data-lib={p.id}
                  data-placeable={d ? String(!why) : undefined}
                  draggable={!!d && !why}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(LIB_DRAG, p.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={why ?? (d ? "拖到台面上，或点「放」" : undefined)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-field",
                    d && !why && "cursor-grab",
                  )}
                >
                  <a
                    href="#shop"
                    title="去采购里看它"
                    className={cn(
                      "min-w-0 flex-1 truncate no-underline",
                      why ? "text-muted" : "text-fg",
                    )}
                  >
                    {p.name}
                  </a>
                  <span
                    className={cn(
                      "flex-none text-[10px]",
                      p.sim.level === "verified" ? "text-ok-ink" : "text-muted",
                    )}
                  >
                    {SIM_NAMES[p.sim.level]}
                  </span>
                  {d && (
                    <button
                      type="button"
                      data-place={p.id}
                      disabled={!!why}
                      aria-label={why ? `${p.name} 放不了：${why}` : `把 ${p.name} 放到台面`}
                      onClick={() => onPlace?.(p.id)}
                      className="h-6 flex-none cursor-pointer rounded-md border border-line bg-surface px-2 text-[11px] text-fg hover:border-accent hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg"
                    >
                      放
                    </button>
                  )}
                </div>
              );
            })}
        </section>
      ))}
      {!list.length && <p className="text-muted">没有匹配的零件</p>}
    </div>
  );
}

// ------------------------------------------------------------ 空台面引导
export function EmptyBench({
  onFirmware,
  hasFw,
}: {
  onFirmware: () => void;
  hasFw: boolean;
}) {
  return (
    <div
      id="emptyBench"
      className="absolute top-1/2 left-1/2 z-3 w-[340px] max-w-[calc(100%-24px)] -translate-x-1/2 -translate-y-1/2 rounded-(--r) border border-line bg-surface p-4 text-fg shadow-panel"
    >
      {/* 没固件时只有一个主按钮「换固件…」（设计稿 unify/Steps）；有固件了主按钮让给采购 */}
      {!hasFw && <span className="block text-[11px] font-medium text-muted">没有固件</span>}
      <b className="block text-sm">台面上只有一块开发板</b>
      <p className="mt-1 mb-3 text-xs text-muted">
        {hasFw
          ? "去采购挑零件摆上来，或者从元件库拖单个零件接线。"
          : "拖一个 ESP-IDF / Arduino 导出的 .bin 进来，或者先跑个示例。"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {hasFw ? (
          <a href="#shop" className={cn(btnPri, "no-underline")}>
            去采购挑零件
          </a>
        ) : (
          <button type="button" id="emptyFw" data-fw-open="" className={btnPri} onClick={onFirmware}>
            换固件…
          </button>
        )}
        {hasFw ? (
          <button type="button" data-fw-open="" className={btn} onClick={onFirmware}>
            换固件…
          </button>
        ) : (
          <a href="#shop" className={cn(btn, "no-underline")}>
            去采购挑零件
          </a>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 欠压复位解释
export function BrownoutBanner({
  t,
  v,
  servo,
  onPower,
  onClose,
}: {
  t: number;
  v: number | null;
  servo: boolean;
  onPower: (() => void) | null;
  onClose: () => void;
}): ReactNode {
  return (
    <div
      id="brownBanner"
      role="alert"
      className="absolute top-14 left-1/2 z-4 w-[420px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) bg-bad-bg p-3 text-xs text-bad-ink shadow-panel"
    >
      <div className="flex items-start gap-2">
        <Icon n="warn" size={16} className="mt-px flex-none" />
        <div className="min-w-0 flex-1">
          <b className="block text-[13px]">
            掉电复位：{t.toFixed(2)} s 时芯片重启了
          </b>
          <p className="mt-1 mb-0">
            3V3 {v != null ? `最低掉到 ${v.toFixed(2)} V，` : ""}
            低于欠压门限，芯片自动复位，串口会重新打印启动信息。
            {servo
              ? "常见原因：舵机和芯片共用 USB 的 5 V，舵机启动电流把电压拉下来了。"
              : "常见原因：外设电流太大，USB 供不上。"}
          </p>
          <div className="mt-2 flex gap-1.5">
            {onPower && (
              <button type="button" className={btnPri} onClick={onPower}>
                看供电
              </button>
            )}
            <button type="button" className={btn} onClick={onClose}>
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
