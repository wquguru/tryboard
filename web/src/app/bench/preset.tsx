// Board preset picker (M5-09b): the scene's board id becomes the core preset (= CLI --board), which attaches the board's devices.
// Changing it reboots like any device change; the firmware still comes from "Upload your own .bin".
import { t } from "../../i18n";
import { BOARD_DEVS, PRESET_BOARDS, boardDevs, type BoardId } from "../../bench3d/boarddevs";
import { AIO_CHIP } from "../../chipid";
import { CHIP_SHORT } from "../../chips";
import { Note, Sec } from "../../ui/panel";
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
      {cur?.preset && !cur.noGrove && <GrovePick ses={ses} onChange={onChange} />}
    </>
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
