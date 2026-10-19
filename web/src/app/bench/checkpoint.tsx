// Bench section: Checkpoint panel and verification.
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { checkCommand, type Level } from "../../checks";
import { ResultCard, RunningCard, actCls } from "../../ui/result";
import { headline } from "../../ui/say";
import { VerifyStalled, verifyLevel } from "../../verify";
import { realnetSwitch } from "../netfeed";
import { fetchBuf } from "../../assets";
import { type CheckOutcome } from "../types";
import { Live } from "../../ui/native";
import { Brief, Btn, Btns, Code, Drop, Field, Mono, LinkBtn, Note, Ph, Sec, TreeEmpty } from "../../ui/panel";
import { wkey } from "../works";
import { tn } from "../benchv2";
import { stalled, ownFirmware, saveProgress } from "./progress";
import { CopyBrief } from "./shared";
import type { BenchCtx } from "./ctx";

export function mountCheckpoint(b: BenchCtx) {
  function renderCheckpoint(id: string) {
    const c = b.ctx!;
    const s = c.store.get();
    const l = c.session.levels.find((x) => x.id === id);
    if (!l) {
      b.show(
        <>
          <Sec>{t("Checkpoint")}</Sec>
          <TreeEmpty>{t("No such checkpoint: {id}", { id })}</TreeEmpty>
        </>,
        false,
      );
      return;
    }
    const r = s.checks[id];
    const busy = s.verifying === id;
    const other = !!s.verifying && !busy;
    const st = busy ? undefined : stalled[id];
    // One primary action per card (DESIGN_V2 §9.5): failed → copy for AI to fix; own pass → next checkpoint.
    const idx = c.session.levels.findIndex((x) => x.id === id);
    const nextLv = c.session.levels
      .slice(idx + 1)
      .find((x) => !s.checks[x.id]?.ok || (r?.own && !s.checks[x.id]?.own));
    const runRef = async () => verify(l, await fetchBuf(`./fw/${l.ref}/flash.bin`), t("Reference firmware {name}", { name: l.ref ?? "" }), false);
    const stall = st ? (
      <>
        <Sec>{t("Check result")}</Sec>
        <ResultCard
          verdict="stall"
          title={t("This run did not finish")}
          why={
            r
              ? t("The simulation stalled and was stopped. This is not a fail; your code may be fine. The previous result is kept below.")
              : t("The simulation stalled and was stopped. This is not a fail; your code may be fine.")
          }
          extra={
            <p className="mt-1 mb-0 text-xs text-muted">
              {tn("Reason: {why} · firmware {fw} kept", { why: st.why, fw: <Mono>{st.who}</Mono> })}
            </p>
          }
          rows={[]}
        >
          <Btn id="retryCheck" primary className={actCls} disabled={other} onClick={() => verify(l, st.buf, st.who, st.own)}>
            {t("Run again")}
          </Btn>
        </ResultCard>
      </>
    ) : null;
    const result = busy ? (
      <>
        <Sec>{t("Check result")}</Sec>
        <RunningCard title={t(l.title)} progress={tn("Simulated {t}", { t: <Live k="vp" className="font-mono" /> })} />
      </>
    ) : r ? (
      <>
        <Sec>{t("Check result")}</Sec>
        <ResultCard
          verdict={r.ok ? "ok" : "bad"}
          meta={(r.realnet && r.sim ? t("Needs internet · ") : "") + (r.sim ? t("{who}, simulated {s} s", { who: r.who, s: r.sim.toFixed(1) }) : r.who)}
          title={headline(r.rows)}
          why={
            r.ok && !r.own
              ? t("Reference firmware ran through (◐): it also unlocks Assemble and Product; passing with your own firmware turns it into ✓.")
              : undefined
          }
          rows={r.rows}
          runId={r.fingerprint || undefined}
          rawNote={
            r.realnet ? (
              <Note id="realnetNote">
                {t("Needs internet · no run ID; replays use the recorded replies (Network tab: Save replies, replay offline).")}
              </Note>
            ) : (
              <Note>
                {tn("Same firmware and same inputs give the same run ID on the web and in the CLI {cmd}.", { cmd: <Mono>npx tryboard check</Mono> })}
              </Note>
            )
          }
        >
          {!r.ok && (
            <Btn primary data-act="fix" className={actCls} onClick={(e) => void copyFix(e.currentTarget, r.rows)}>
              {t("Copy for AI to fix")}
            </Btn>
          )}
          {!r.ok && r.own && l.ref && (
            <Btn data-act="compare" className={actCls} disabled={!!s.verifying} onClick={() => void runRef()}>
              {t("Compare with reference firmware")}
            </Btn>
          )}
          {r.ok && nextLv && (
            <Btn primary data-act="nextcp" className={actCls} onClick={() => b.select({ kind: "checkpoint", id: nextLv.id })}>
              {t("Next checkpoint: {title}", { title: t(nextLv.title) })}
            </Btn>
          )}
        </ResultCard>
      </>
    ) : null;
    /** Brief + raw failing lines (same as the CLI) so an AI can fix it directly. */
    const briefText = () =>
      t("{brief}\n\nPass condition: {pass}\nCheck: {cmd} (exit code 0 means pass)", { brief: t(l.brief), pass: t(l.pass), cmd: checkCommand(l) });
    const copyFix = async (btn: HTMLButtonElement, rows: { ok: boolean | null; text: string }[]) => {
      const bad = rows.filter((x) => x.ok === false).map((x) => `- ${x.text}`).join("\n");
      const text = t("{brief}\n\nFailed in the last check:\n{bad}", { brief: briefText(), bad });
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = t("Copied, paste it to the AI");
      } catch {
        btn.textContent = t("Cannot copy; copy the brief below by hand");
      }
    };
    const copy = async (btn: HTMLButtonElement) => {
      const text = briefText();
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = t("Copied");
      } catch {
        const range = document.createRange();
        range.selectNodeContents(c.shell.props.el.querySelector(".brief")!);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        btn.textContent = t("Selected, press ⌘C / Ctrl+C to copy");
      }
    };
    b.show(
      <>
        <Sec>{t("Checkpoint {id}", { id: l.id })}</Sec>
        <Ph>{t(l.title)}</Ph>
        <p className="goal mt-0 mb-1 text-muted">{t(l.goal)}</p>
        <Sec>{t("Pass condition")}</Sec>
        <Field>{t(l.pass)}</Field>
        <Sec className="edit-only">{t("Check")}</Sec>
        <Drop
          kind="check"
          busy={busy || other}
          disabled={busy || other}
          title={
            busy ? (
              tn("Simulating {t}", { t: <Live k="vp" className="font-mono" /> })
            ) : (
              t("Drop a .bin here")
            )
          }
          sub={
            busy
              ? t("Judged once it finishes")
              : other
                ? t("Another checkpoint is being checked, please wait")
                : t("Or click here to choose a file")
          }
          onFile={
            busy || other
              ? undefined
              : b.safeFile(async (f) =>
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
              {t("Try reference firmware")}
            </Btn>
          )}
          {l.ref && (
            <LinkBtn id="dlBin" href={`./fw/${l.ref}/flash.bin`} download={`${l.ref}.bin`} title={t("Flash to a real board: esptool.py write_flash 0x0")}>
              {t("Download reference .bin")}
            </LinkBtn>
          )}
          {l.ref && (
            <LinkBtn id="dlSrc" href={`./fw/${l.ref}/src.zip`} download={`${l.ref}-src.zip`} title={t("ESP-IDF 5.5 project; unzip and run idf.py build")}>
              {t("Download source zip")}
            </LinkBtn>
          )}
        </Btns>
        {stall}
        {result}
        <Sec>{t("Brief for the AI")}</Sec>
        <Brief>{t(l.brief)}</Brief>
        <Btns>
          <CopyBrief onCopy={(btn) => void copy(btn)} />
        </Btns>
        <Sec>{t("Check command")}</Sec>
        <Code>{checkCommand(l)}</Code>
        <Note>
          {t(
            "The command line gives the same verdict and run ID as the page; exit code 0 means pass. The tryboard CLI package is not on npm yet, so install it locally from packages/tryboard in the repository.",
          )}
        </Note>
      </>,
    );
  }

  async function verify(l: Level, buf: ArrayBuffer, who: string, own: boolean) {
    const c = b.ctx!;
    if (c.store.get().verifying) return;
    if (own) ownFirmware[l.id] = { buf: buf.slice(0), name: who };
    delete stalled[l.id];
    // -1 means the simulator (wasm / ROM) is still loading and the Worker has not started
    c.store.set({ verifying: l.id, verifyProgress: -1 });
    let out: CheckOutcome;
    // Real network on (C-03): checks go online too, so the verdict says "needs internet" and keeps no run ID
    const net = realnetSwitch.get();
    try {
      const v = await verifyLevel(l, buf, (t) => {
        if (t - c.store.get().verifyProgress >= 0.1)
          c.store.set({ verifyProgress: t });
      }, undefined, undefined, net);
      const rows: CheckOutcome["rows"] = v.results.map((x) => ({
        ok: x.ok,
        text: x.text,
        say: x.say,
        tag: x.tag,
        dev: x.dev,
        conf: x.conf,
        note: x.note,
      }));
      // Assembly checks are geometric estimates the CLI cannot judge, so the Assemble step owns them
      if (l.assembly)
        rows.push({
          ok: null,
          text: t("Assembly check (estimate) is judged in the Assemble step and not counted here"),
          say: t("Assembly is checked in the Assemble step, not here"),
          dev: t("Assembly"),
        });
      out = {
        ok: v.ok,
        who,
        own,
        rows,
        fingerprint: net ? "" : v.fingerprint,
        sim: v.sim,
        ...(net ? { realnet: true } : {}),
      };
    } catch (e) {
      if (e instanceof VerifyStalled) {
        stalled[l.id] = { why: e.message, buf: buf.slice(0), who, own };
        c.store.set({ verifying: null });
        c.shell.toast(
          t("Checkpoint {id} did not finish this time; that is not a fail, run it again", { id: l.id }),
        );
        return;
      }
      out = {
        ok: false,
        who,
        own,
        rows: [
          {
            ok: false,
            text: t("Run failed: {err}", { err: String(e) }),
            say: t("The simulator hit an error and could not run this time"),
          },
        ],
        fingerprint: "—",
        sim: 0,
      };
    }
    // A reference pass still records progress (◐, unlocks Assemble / Product); saveProgress never overwrites your own pass
    if (out.ok) {
      saveProgress(wkey(c.work), l.id, out.fingerprint, own, !!out.realnet);
      b.buyArmed = true;
    }
    // A reference result must not replace a pass you earned yourself
    const prev = c.store.get().checks[l.id];
    const keep = prev?.own && prev.ok && !own;
    if (!keep) c.hist?.op({ k: "check", id: l.id, outcome: out });
    c.store.set((s) => ({
      verifying: null,
      checks: keep ? s.checks : { ...s.checks, [l.id]: out },
    }));
    if (keep)
      c.shell.toast(
        out.realnet
          ? out.ok ? t("Reference firmware passed (needs internet; your record is kept)") : t("Reference firmware did not pass (needs internet; your record is kept)")
          : out.ok
            ? t("Reference firmware passed (run ID {fp}; your record is kept)", { fp: out.fingerprint })
            : t("Reference firmware did not pass (run ID {fp}; your record is kept)", { fp: out.fingerprint }),
      );
  }

  b.renderCheckpoint = renderCheckpoint;
  b.verify = verify;
}

