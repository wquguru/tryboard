// Bench section: Run history (P0-13).
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { type ReactNode } from "react";
import { diffRuns, summarize, type BenchStep } from "../history";
import { cn } from "../../ui/cn";
import { Btn, Btns, Kv, KvT, Mono, Muted, Ph, Sec, TreeEmpty } from "../../ui/panel";
import type { BenchCtx } from "./ctx";

export function mountRuns(b: BenchCtx) {
  /** Second run picked in history (compared with the selected one). */
  let cmpRun: number | null = null;

  function renderRuns(n: number) {
    const c = b.ctx!;
    const runs = c.hist?.runs() ?? [];
    const a = runs.find((r) => r.n === n);
    if (!a) {
      b.show(
        <>
          <Sec>{t("Run history")}</Sec>
          <TreeEmpty>{t("No run #{n}", { n })}</TreeEmpty>
        </>,
        false,
      );
      return;
    }
    const sa = summarize(a);
    const rb =
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
            b.renderProps();
          }}
        >
          <span className="rk w-3 flex-none font-mono font-medium text-accent-ink">
            {tag || "·"}
          </span>
          <span className="rt min-w-0 break-all">
            <b className="font-medium">{t("Run #{n}", { n: r.n })}</b> <Muted>{x.fw}</Muted>
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
    if (rb) {
      const d = diffRuns(sa, summarize(rb));
      const nCh = d.filter((x) => x.changed).length;
      const drow =
        "drow grid grid-cols-[72px_1fr_1fr] gap-1.5 rounded-md bg-field px-2 py-1 [&>span]:min-w-0 [&>span]:[overflow-wrap:anywhere]";
      cmp = (
        <>
          <Sec>{t("Differences: {n} (marked ≠)", { n: nCh })}</Sec>
          <div className="diff flex flex-col gap-0.5 text-xs">
            <div
              className={cn(
                drow,
                "hd bg-transparent py-0 text-[11px] text-muted",
              )}
            >
              <span className="k" />
              <span>A #{a.n}</span>
              <span>B #{rb.n}</span>
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
    // With a comparison, differences come first; single-run details stay in the list below.
    const detail = rb ? null : (
      <>
        <Kv k={t("Firmware")} v={sa.fw} />
        <Kv k={t("Environment at power-on")} v={sa.env0} />
        <Kv k={t("Environment changes while running")} v={`${sa.envChanges}×`} />
        <Kv k={t("Power supply")} v={sa.power} />
        <Kv k={t("Heat source")} v={sa.heat} />
        <Kv k={t("Simulated time")} v={sa.seconds} />
        <KvT k={t("Last line")}>
          <Mono>{sa.result}</Mono>
        </KvT>
        <Kv k={t("Run ID")} v={sa.fingerprint} cls="fp" />
      </>
    );
    b.show(
      <>
        <Sec>{t("Run history")}</Sec>
        <Ph>
          {rb ? t("Run #{a} ↔ run #{b}", { a: a.n, b: rb.n }) : t("Run #{n}", { n: a.n })}
        </Ph>
        {detail}
        {cmp}
        <Btns>
          <Btn
            id="gotoRun"
            disabled={step < 0}
            onClick={() => step >= 0 && c.hist?.seek(step)}
          >
            {t("Back to run #{n}", { n: a.n })}
          </Btn>
          {rb && (
            <Btn
              id="cmpOff"
              onClick={() => {
                cmpRun = null;
                b.renderProps();
              }}
            >
              {t("Stop comparing")}
            </Btn>
          )}
        </Btns>
        <Sec>{t("All runs · click one to compare with A")}</Sec>
        <div className="runs flex flex-col gap-1">{list}</div>
      </>,
      false,
    );
  }

  b.renderRuns = renderRuns;
}

