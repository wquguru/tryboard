// Bench section: Left column: Parts, Wiring table, checkpoint card (U-04).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { afterFrame } from "../../ui/frame";
import { type ReactNode } from "react";
import { type Level } from "../../checks";
import { type Selection } from "../types";
import { CustomCheckCard } from "../customui";
import { actions, setDock } from "../chrome";
import { replay } from "../bom";
import { setLeft } from "../leftcol";
import { AllPassedCard, CheckpointCard, PartLib, WireTable } from "./ui";
import { passedCount, ownCount } from "./progress";
import type { BenchCtx } from "./ctx";
import { COURSE, lessonKey } from "../course";

export function mountLeft(b: BenchCtx) {
  // H-16: a lesson without a checkpoint (lesson 0) has no selection to carry it, so the course link names it (?cp=lesson-0)
  const urlCp = new URLSearchParams(location.search).get("cp");
  if (urlCp && COURSE.some((e) => !e.cp && lessonKey(e) === urlCp)) b.lessonPin = urlCp;
  /** What the checkpoint "take me there" targets: the judged pin, else the I2C device. */
  function cpTarget(l: Level | undefined): Selection | null {
    if (!l) return null;
    const pin = l.pwm?.pin ?? l.gpio_toggles?.pin ?? l.ws2812?.pin;
    if (pin !== undefined) return { kind: "pin", id: `GPIO${pin}` };
    const parts = b.ctx!.session.scene.parts;
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
    const c = b.ctx!;
    const s = c.store.get();
    const wires = b.shownWires();
    const bad = new Map<string, string>();
    for (const f of b.faults)
      for (const w of f.wires) if (!bad.has(w)) bad.set(w, f.short);
    const n = c.work.checkpoints.length;
    const d = passedCount(c, s);
    let card: ReactNode = null;
    // Beginner mode swaps the checkpoint card for this lesson's steps (H-01); null keeps the card
    let lesson: ReactNode | null = null;
    // A picked checkpoint keeps its lesson up while the beginner clicks parts on the bench
    const picked = s.selection?.kind === "checkpoint" ? s.selection.id : null;
    if (picked && c.work.checkpoints.includes(picked)) b.lessonPin = picked;
    // Lessons with no checkpoint in this work: the pinned one, else the first when the work has no checkpoints at all
    const free = COURSE.filter((e) => e.work === c.work.id && !e.cp).map(lessonKey);
    const freeKey = b.lessonPin && free.includes(b.lessonPin) ? b.lessonPin : n ? undefined : free[0];
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
          onPick={(id) => b.select({ kind: "checkpoint", id })}
          onExport={b.exportCheckpoints}
          onBuy={n && d === n ? b.openBuy : null}
        />
      );
    else if (freeKey && (lesson = b.lessonCard(freeKey, undefined))) card = lesson;
    else if (n && d === n) {
      // A pinned lesson outlives "all passed": the capstone (lesson 11) needs assembly, which only unlocks then
      const lid = b.lessonPin && c.work.checkpoints.includes(b.lessonPin) ? b.lessonPin : null;
      if (lid) lesson = b.lessonCard(lid, c.session.levels.find((x) => x.id === lid));
      card = lesson ?? (
        <AllPassedCard total={n} own={ownCount(c, s)} retest={s.assembly?.retest} onNext={() => (location.hash = "assemble")} />
      );
    } else if (n) {
      const id =
        c.work.checkpoints.find((x) => !s.checks[x]?.ok) ??
        c.work.checkpoints[0];
      const l = c.session.levels.find((x) => x.id === id);
      const tg = cpTarget(l);
      const lid = b.lessonPin && c.work.checkpoints.includes(b.lessonPin) ? b.lessonPin : id;
      lesson = b.lessonCard(lid, c.session.levels.find((x) => x.id === lid));
      card = lesson ?? (
        <CheckpointCard
          id={id}
          title={l?.title ? t(l.title) : ""}
          pass={l?.pass ? t(l.pass) : ""}
          done={d}
          total={n}
          go={tg ? (tg.kind === "pin" ? tg.id : b.partName(tg.id)) : null}
          onGo={() => {
            b.select(tg ?? { kind: "checkpoint", id });
            if (tg)
              afterFrame(() => b.ctx?.session.bench.view?.("fit", tg));
          }}
          onAll={() => setDock({ tab: "checks", collapsed: false })}
          own={ownCount(c, s)}
          allBusy={b.demoBusy || !!s.verifying}
          onAllRef={actions.runAllRef ?? null}
          onMine={() => b.select({ kind: "checkpoint", id })}
        />
      );
    }
    if (!lesson) b.lessonCard(null, undefined);
    const sel = s.selection?.kind === "wire" ? s.selection.id : null;
    setLeft({
      lib: (
        <PartLib
          chip={c.session.chip}
          inBom={new Set(replay(s.bom).picks.map((p) => p.partId))}
          onPlace={b.startPlace}
        />
      ),
      wires: (
        <WireTable
          wires={wires}
          bad={bad}
          sel={sel}
          onSel={(id) => b.select({ kind: "wire", id })}
        />
      ),
      wireCount: wires.length,
      card,
    });
  }

  b.renderLeft = renderLeft;
}

