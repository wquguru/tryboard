// Bench section: Build tree.
// Moved out of benchStep() (R-08); talks to other sections only through BenchCtx.
import { t } from "../../i18n";
import { openFwMenu } from "../fwmenu";
import { type ReactNode } from "react";
import { partId, partInfo, usedPins } from "../wiring";
import { faultByWire } from "../wirecheck";
import { BOARD_NAME, CHIP_SHORT } from "../../chips";
import { boardDevs } from "../../bench3d/boarddevs";
import { type Selection } from "../types";
import { Bad, Mono, Muted, TnSt, TreeEmpty, TreeGroup, TreeNode } from "../../ui/panel";
import { CustomPlacedCard } from "../customui";
import { actions, overlay } from "../chrome";
import { phoneProps } from "../mobile";
import { bleFeed, phoneStateText } from "../blefeed";
import { EmptyBench } from "./ui";
import { passedCount } from "./progress";
import { hex, selEq } from "./shared";
import type { BenchCtx } from "./ctx";

export function mountTree(b: BenchCtx) {
  /** Custom-board project: "placed and wired" card dismissed; demo firmware being verified check by check. */
  let customClosed = false;

  function renderTree() {
    const c = b.ctx!;
    const s = c.store.get();
    const ses = c.session;
    const parts = ses.scene.parts;
    const wires = b.benchWires();
    const byWire = faultByWire(b.faults);
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
          b.select(sel);
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
        open={!!b.openGroups[key]}
        onToggle={(o) => (b.openGroups[key] = o)}
      >
        {body}
      </TreeGroup>
    );
    const board = boardDevs(ses.scene.board)?.name ?? BOARD_NAME[ses.chip];
    const partItems = [
      item(
        { kind: "part", id: "board" },
        board,
        CHIP_SHORT[ses.chip],
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
    // Pins: only used ones (wired, or with an on-board role such as BOOT or the RGB LED).
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
      <TreeEmpty>{t("No pins in use")}</TreeEmpty>
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
      <TreeEmpty>{t("No external wires")}</TreeEmpty>
    );
    const nBad = new Set(b.faults.flatMap((f) => f.wires)).size;
    const wireCount = nBad ? (
      <Bad>{t("{n} · issues: {m}", { n: wires.length, m: b.faults.length })}</Bad>
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
          <Mono>{id}</Mono> {l?.title ? t(l.title) : ""}
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
          t("Run #{n}", { n: r.n }),
          r.snap ? `${r.snap.simSeconds.toFixed(1)} s` : t("Running"),
          r.n === s.runNo && s.hist.seeked ? <TnSt kind="run">◂</TnSt> : null,
        ),
      )
    ) : (
      <TreeEmpty>{t("Not run yet")}</TreeEmpty>
    );
    const ext = !!ses.power?.ext5v;
    const hasServo = parts.some((p) => p.type === "servo");
    c.shell.tree.render(
      <div role="group" aria-label={t("Build tree")}>
        {group("part", t("Parts"), String(parts.length + 1), partItems)}
        {group("pin", t("Pins"), String(pins.length), pinItems)}
        {group("wire", t("Wires"), wireCount, wireItems)}
        {group(
          "power",
          t("Power supply"),
          ext ? t("USB and external") : "USB",
          <>
            {item({ kind: "power", id: "usb" }, t("USB 5 V (computer)"), "5V")}
            {ext
              ? item(
                  { kind: "power", id: "ext5v" },
                  t("External 5 V 2 A (servo)"),
                  "EXT5V",
                )
              : hasServo
                ? item(
                    { kind: "power", id: "ext5v" },
                    <Muted>{t("External 5 V (not connected)")}</Muted>,
                    "",
                  )
                : null}
          </>,
        )}
        {group(
          "env",
          t("Environment"),
          "",
          item(
            { kind: "env", id: "room" },
            t("Indoors"),
            <Mono>{`${env.temp.toFixed(1)} °C`}</Mono>,
            ses.heat ? <TnSt kind="bad">{t("Hot")}</TnSt> : null,
          ),
        )}
        {bleFeed.get().state !== 0 &&
          group(
            "ble",
            t("Wireless"),
            "",
            item(
              { kind: "ble", id: "phone" },
              // The virtual PC drives the same central, so name whichever holds it
              bleFeed.get().view?.phone?.pc?.on ? t("Virtual PC") : t("Virtual phone"),
              phoneStateText(bleFeed.get()),
              bleFeed.get().state === 2 ? <TnSt kind="warn">!</TnSt> : null,
            ),
          )}
        {group(
          "firmware",
          t("Firmware"),
          "",
          ses.fwName
            ? item(
                { kind: "firmware", id: "main" },
                ses.fwName,
                ses.fwSize ? `${(ses.fwSize / 1024).toFixed(0)} KB` : "",
              )
            : item(
                { kind: "firmware", id: "main" },
                t("No firmware yet"),
                t("Drop a .bin here"),
              ),
        )}
        {group("run", t("Run history"), String(runs.length), runItems)}
        {c.work.checkpoints.length
          ? group(
              "checkpoint",
              t("Checkpoints"),
              `${passedCount(c, s)}/${c.work.checkpoints.length}`,
              cps,
            )
          : null}
      </div>,
    );
    b.renderLeft();
    // Empty-bench guide: only the dev board, no parts yet (fresh blank bench).
    overlay(
      "empty",
      // Hidden while placing: the guide card would cover the board pins.
      // An all-in-one board already carries its screen and sensors, so no "only a dev board" hint
      parts.length || b.placing || ses.scene.board ? null : (
        <EmptyBench
          hasFw={!!ses.fwName}
          onFirmware={openFwMenu}
        />
      ),
    );
    // Custom-board project: after auto-placing, explain what was placed and ask for firmware (hidden once firmware is in, closed, or placing).
    if (c.custom)
      overlay(
        "customPlaced",
        parts.length && !b.placing && !customClosed && !ses.fwBuf ? (
          <CustomPlacedCard
            n={parts.length}
            sub={c.custom.plan.sub}
            demo={c.custom.plan.demo}
            busy={b.demoBusy}
            onFirmware={openFwMenu}
            onBrief={() => void actions.brief?.()}
            onDemo={() => void b.runDemo()}
            onClose={() => {
              customClosed = true;
              renderTree();
            }}
          />
        ) : null,
      );
  }

  b.renderTree = renderTree;
}

