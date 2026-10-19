import { cn } from "../../../ui/cn";
import type { BenchWire } from "../../wiring";
import { t } from "../../../i18n";

// ------------------------------------------------------------ wiring table
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
    return <p className="m-2 text-xs text-muted">{t("No external wires on the bench")}</p>;
  return (
    <table id="wireTable" className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-left text-[11px] text-muted">
          <th className="px-1 py-1 font-normal">{t("Dev board")}</th>
          <th className="px-1 py-1 font-normal">{t("Part")}</th>
          <th className="px-1 py-1 font-normal">{t("Wire")}</th>
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
                    {t("was {pin}", { pin: w.from })}
                  </span>
                )}
              </td>
              <td className="px-1 py-1.5">
                <span className="font-mono">{w.b}</span>
                {b && (
                  <span className="block text-[11px] text-bad-ink">✗ {b}</span>
                )}
                {w.missing && (
                  <span className="block text-[11px] text-muted">{t("Unplugged")}</span>
                )}
              </td>
              <td className="px-1 py-1.5 text-muted">
                {t(w.color)} · {w.lenCm} cm
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
