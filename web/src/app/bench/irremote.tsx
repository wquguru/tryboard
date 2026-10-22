// F-08f bench IR remote (21-key "Car MP3" NEC remote, address 0x00) and the IR LED eye feed.
import { t } from "../../i18n";
import { Btn, Note, Sec } from "../../ui/panel";
import { IR_KEYS, irCode, irHex as hex, useIr } from "../irfeed";

const big = "min-h-11 md:min-h-0";

export function IrRemote({ send }: { send: (code: string) => void }) {
  return (
    <>
      <Sec>{t("IR remote")}</Sec>
      <div className="mt-2 grid max-w-[15rem] grid-cols-3 gap-1.5">
        {IR_KEYS.map(([label, cmd]) => (
          <Btn key={cmd} className={big} data-ir={irCode(cmd)} title={`0x${hex(cmd, 2)}`} onClick={() => send(irCode(cmd))}>
            {label}
          </Btn>
        ))}
      </div>
      <Btn className={`${big} mt-1.5`} data-ir="repeat" onClick={() => send("repeat")}>
        {t("Repeat code (key held)")}
      </Btn>
      <Note>{t("Each key sends one NEC frame (address 0x00) to the receiver; the input log records it as ir=ADDR,CMD and replays it. Receiver timing uses typical values; not calibrated on real hardware.")}</Note>
    </>
  );
}

export function IrSeenList() {
  const { list, total } = useIr();
  return (
    <>
      <Sec>{t("Decoded from the IR LED")}</Sec>
      {list.length ? (
        <ul className="mt-1 space-y-0.5 font-mono text-xs" data-ir-seen={total}>
          {list.map((s) => (
            <li key={`${s.t}-${s.pin}-${s.text}`} className="break-words">
              {s.t.toFixed(3)} s · GPIO{s.pin} · {s.text}
            </li>
          ))}
        </ul>
      ) : (
        <Note>{t("Nothing sent yet: the eye decodes NEC frames the firmware sends through the LED.")}</Note>
      )}
    </>
  );
}
