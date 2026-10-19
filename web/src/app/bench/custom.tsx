// Bench section: picked-board projects (U-17): per-checkpoint checks, demo firmware, export, buy card.
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { fetchBuf } from "../../assets";
import { noteSaved } from "../saved";
import { wkey } from "../works";
import type * as Buy from "../buycard";
import { overlay } from "../chrome";
import { replay } from "../bom";
import { ownFirmware, passedCount } from "./progress";
import type { BenchCtx } from "./ctx";

export function mountCustom(b: BenchCtx) {
  /** Generated checkpoints share parameters, so one dropped firmware is checked against all of them. */
  async function verifyAll(buf: ArrayBuffer, who: string, own: boolean) {
    const c = b.ctx;
    if (!c) return;
    for (const id of c.work.checkpoints) {
      const l = c.session.levels.find((x) => x.id === id);
      if (!l || !b.ctx) continue;
      await b.verify(l, buf, who, own);
    }
  }
  async function runDemo() {
    const c = b.ctx!;
    const demo = c.custom?.plan.demo;
    if (!demo || b.demoBusy) return;
    b.demoBusy = true;
    b.renderTree();
    try {
      const buf = await fetchBuf(`./fw/${demo}/flash.bin`);
      c.session.loadFirmware(buf, `${demo}/flash.bin`);
      c.shell.toast(t("Demo firmware {name} powered on; checking each checkpoint", { name: demo }));
      // Demo firmware counts as a ◐ reference pass (DECISIONS U-22 replaces U-17): unlocks the buy card, not "my firmware"
      await verifyAll(buf, t("Demo firmware {name}", { name: demo }), false);
    } finally {
      b.demoBusy = false;
      if (b.ctx) b.renderTree();
    }
  }
  /** Run the whole path on built-in firmware (U-22): each open checkpoint uses its own reference, and the last one stays on the bench. */
  async function runAllRef() {
    const c = b.ctx!;
    if (c.custom) return void runDemo();
    if (b.demoBusy || c.store.get().verifying) return;
    b.demoBusy = true;
    b.renderTree();
    let last: { ref: string; buf: ArrayBuffer } | null = null;
    try {
      for (const id of c.work.checkpoints) {
        const l = c.session.levels.find((x) => x.id === id);
        if (!l?.ref || !b.ctx) continue;
        if (c.store.get().checks[id]?.ok) continue;
        c.store.set({ selection: { kind: "checkpoint", id } });
        const buf = await fetchBuf(`./fw/${l.ref}/flash.bin`);
        await b.verify(l, buf, t("Reference firmware {name}", { name: l.ref }), false);
        last = { ref: l.ref, buf };
        // Stop at the first failure (or stall): later checkpoints usually depend on earlier wiring
        if (!c.store.get().checks[id]?.ok) break;
      }
    } catch (e) {
      c.shell.toast(t("Could not fetch built-in firmware: {err}", { err: String(e) }));
    } finally {
      b.demoBusy = false;
      if (b.ctx) {
        const n = c.work.checkpoints.length;
        const d = passedCount(c);
        if (last) c.session.loadFirmware(last.buf, `${last.ref}/flash.bin`);
        c.shell.toast(
          d === n
            ? t("Built-in firmware passed {n}/{n} (◐): Assemble is unlocked; to use your own firmware, drop a .bin on a checkpoint", { n })
            : t("Built-in firmware stopped at {d}/{n}: look at the checkpoint that failed", { d, n }),
        );
        b.renderTree();
      }
    }
  }
  function exportCheckpoints() {
    const c = b.ctx!;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(c.custom?.levels ?? [], null, 1) + "\n"], { type: "application/json" }));
    a.download = "checkpoints.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    c.shell.toast(t("Exported checkpoints.json: {cmd}", { cmd: "npx tryboard check app.bin --level-json checkpoints.json" }));
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
    // R-12: the buy card is only used by custom works; its chunk loads on first open (or with the idle prefetch)
    void import("../buycard").then((m) => showBuy(m.BuyCard, m.BuyDialog));
  }
  function showBuy(BuyCard: typeof Buy.BuyCard, BuyDialog: typeof Buy.BuyDialog) {
    const c = b.ctx;
    if (!c?.custom) return;
    const { plan, levels } = c.custom;
    const s = c.store.get();
    const have = plan.have;
    const remaining = replay(s.bom)
      .picks.filter((p) => !have.includes(p.partId))
      .map((p) => ({ partId: p.partId, qty: p.qty ?? 1, why: "" }));
    // Ticks are stored by the English text so they survive a language switch; the card shows translations
    const fillEn = (k: string, v: Record<string, string>) => k.replace(/\{(\w+)\}/g, (_, x: string) => v[x] ?? "");
    const NO_MODEL = "{name}: not in the simulator, try it on real hardware";
    const PINS = "Pins on the real board match the page (check each wire against the Wiring table)";
    const manualPairs: [string, string][] = [
      ...levels.filter((l) => l.manual).map((l): [string, string] => [l.title, t(l.title)]),
      ...plan.noModel.map((n): [string, string] => [fillEn(NO_MODEL, { name: n.name }), t(NO_MODEL, { name: t(n.name) })]),
      [PINS, t(PINS)],
    ];
    const manual = manualPairs.map(([, shown]) => shown);
    const toEn = (shown: string) => manualPairs.find(([, x]) => x === shown)?.[0] ?? shown;
    const toShown = (en: string) => manualPairs.find(([k]) => k === en)?.[1] ?? en;
    const fp = c.work.checkpoints.map((id) => s.checks[id]?.fingerprint).find(Boolean) ?? null;
    const own = Object.entries(ownFirmware).find(([id]) => c.work.checkpoints.includes(id))?.[1];
    const bin = own?.buf ?? c.session.fwBuf;
    const key = wkey(c.work);
    const draw = () => {
      const checked = loadBuyChecked(key).map(toShown);
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
              const e = toEn(m);
              const next = cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e];
              try {
                localStorage.setItem(BUY_KEY(key), JSON.stringify(next));
                noteSaved();
              } catch {
                /* If storage fails, the ticks only last for this page */
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

  b.verifyAll = verifyAll;
  b.runDemo = runDemo;
  b.runAllRef = runAllRef;
  b.exportCheckpoints = exportCheckpoints;
  b.openBuy = openBuy;
}

