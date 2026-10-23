// Board preset picker (M5-09b): the scene's board id becomes the core preset (= CLI --board), which attaches the board's devices.
// Changing it reboots like any device change; the firmware still comes from "Upload your own .bin".
import { t } from "../../i18n";
import { BOARD_DEVS, PRESET_BOARDS, boardDevs, type BoardDevs, type BoardId } from "../../bench3d/boarddevs";
import { AIO_CHIP } from "../../chipid";
import { CHIP_SHORT } from "../../chips";
import { Note, Sec } from "../../ui/panel";
import { ConfBadge, REAL } from "./ui";
import type { Session } from "../types";
import type { GroveId } from "../../bench3d/spec";

export function PresetPick({ ses, onChange }: { ses: Session; onChange: () => void }) {
  const cur = boardDevs(ses.scene.board);
  const chip = ses.scene.board ? AIO_CHIP[ses.scene.board] : undefined;
  return (
    <>
      <Sec>{t("Board preset")}</Sec>
      <select
        id="boardPreset"
        aria-label={t("Board preset")}
        defaultValue={ses.scene.board ?? ""}
        className="h-9 w-full cursor-pointer rounded-md border border-line bg-surface px-2 text-[13px] text-fg max-md:h-11"
        onChange={(e) => {
          const v = e.currentTarget.value as BoardId | "";
          const { board: _old, ...rest } = ses.scene;
          const name = v ? BOARD_DEVS[v].name : "";
          ses.applyScene(v ? { ...rest, board: v } : rest, ses.power ?? { ext5v: false }, v ? t("Board preset {name}", { name }) : t("Generic dev board"));
          onChange();
        }}
      >
        <option value="">{t("Generic dev board (no preset)")}</option>
        {PRESET_BOARDS.map((id) => (
          <option key={id} value={id}>
            {`${BOARD_DEVS[id].name} · ${CHIP_SHORT[AIO_CHIP[id]]}`}
          </option>
        ))}
      </select>
      {cur?.preset && (
        <Note>
          {t("Same as CLI --board {id}: the core attaches this board's screen, I2C devices and buttons. Upload firmware built for it ({chip}).", { id: cur.preset, chip: chip ? CHIP_SHORT[chip] : "" })}
          {cur.keyboard ? ` ${t("Keys you type while the bench has focus press the matching Cardputer keys.")}` : ""}
        </Note>
      )}
      {cur?.preset && <PresetChecks devs={cur} />}
      {cur?.preset && !cur.noGrove && <GrovePick ses={ses} onChange={onChange} />}
    </>
  );
}

/** G-08: preset items that are inferred (or a preset never run) stay "needs real hardware" in every conclusion that uses them */
function PresetChecks({ devs }: { devs: BoardDevs }) {
  const rows = [...(devs.unverified ? ["Whole preset: pins and addresses come from docs; no firmware has run it yet"] : []), ...(devs.check ?? [])];
  if (!rows.length) return null;
  return (
    <div data-preset-checks className="mt-2 flex flex-col gap-1.5">
      <div className="text-[12px] text-muted">{t("Confirm on a real board")}</div>
      {rows.map((r) => (
        <div key={r} className="flex items-start gap-2 text-[12px] leading-5 text-fg">
          <ConfBadge c={REAL} />
          <span className="min-w-0">{t(r)}</span>
        </div>
      ))}
    </div>
  );
}

/** Grove units on Port A (M5-09d); "ENV III" / "ENV IV" are product names */
const GROVE_UNITS: { id: GroveId; name: string; chips: string }[] = [
  { id: "env3", name: "ENV III", chips: "SHT30 + QMP6988" },
  { id: "env4", name: "ENV IV", chips: "SHT40 + BMP280" },
];

/** Port A unit (= CLI --grove); every M5 preset in boards.rs has Port A (the CYD is hidden by noGrove). Changing it reboots. */
function GrovePick({ ses, onChange }: { ses: Session; onChange: () => void }) {
  const cur = GROVE_UNITS.find((u) => u.id === ses.scene.grove);
  return (
    <>
      <Sec>{t("Grove Port A")}</Sec>
      <select
        id="grovePort"
        aria-label={t("Grove Port A")}
        defaultValue={ses.scene.grove ?? ""}
        className="h-9 w-full cursor-pointer rounded-md border border-line bg-surface px-2 text-[13px] text-fg max-md:h-11"
        onChange={(e) => {
          const v = e.currentTarget.value as GroveId | "";
          const { grove: _old, ...rest } = ses.scene;
          const u = GROVE_UNITS.find((x) => x.id === v);
          ses.applyScene(v ? { ...rest, grove: v } : rest, ses.power ?? { ext5v: false }, u ? t("Grove unit {name}", { name: u.name }) : t("Grove unit removed"));
          onChange();
        }}
      >
        <option value="">{t("None")}</option>
        {GROVE_UNITS.map((u) => (
          <option key={u.id} value={u.id}>{`${u.name} (${u.chips})`}</option>
        ))}
      </select>
      {cur && <Note>{t("Same as CLI --grove {id}: temperature, humidity and pressure follow the environment controls.", { id: cur.id })}</Note>}
    </>
  );
}
