// Image check before swapping firmware (DESIGN_V2 §4 key state 3): header only, nothing runs. Same rule as simrun.imageChip:
// app from the partition table at 0x8000, else at 0; ESP image magic 0xE9, chip id in the two bytes at offset 12.
import { chipFromId } from '../chipid';
import { t } from '../i18n';
import { Icon } from './icons';

const CHIP_NAMES: Record<number, string> = { 0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3', 12: 'ESP32-C2', 13: 'ESP32-C6', 16: 'ESP32-H2', 18: 'ESP32-P4' };
type Chip = 'esp32' | 'esp32c3' | 'esp32s3';

export interface FwCheck {
  ok: boolean;
  chip: Chip | null;
  /** One-line verdict. */
  title: string;
  rows: { ok: boolean; text: string }[];
}

export function fwCheck(buf: ArrayBuffer, cur: Chip): FwCheck {
  const b = new Uint8Array(buf);
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const rows: FwCheck['rows'] = [];
  if (b.length < 0x20) return { ok: false, chip: null, title: t('File too small to be a firmware image'), rows: [{ ok: false, text: t('Only {n} bytes', { n: b.length }) }] };
  let app = 0;
  let table = false;
  if (b[0x8000] === 0xaa && b[0x8001] === 0x50) {
    table = true;
    for (let i = 0; i < 95; i++) {
      const o = 0x8000 + i * 32;
      if (b[o] !== 0xaa || b[o + 1] !== 0x50) break;
      if (b[o + 2] === 0 && (b[o + 3] === 0 || b[o + 3] === 0x10)) {
        app = u32(o + 4);
        break;
      }
    }
  }
  rows.push({ ok: true, text: table ? t('Full flash image: partition table at 0x8000, app at 0x{addr}', { addr: app.toString(16) }) : t('Single app image (no partition table)') });
  if (b[0] !== 0xe9 && b[app] !== 0xe9) {
    rows.push({ ok: false, text: t("Doesn't start with the ESP image magic 0xE9 (read 0x{v})", { v: (b[app] ?? 0).toString(16).toUpperCase().padStart(2, '0') }) });
    return { ok: false, chip: null, title: t('This is not a .bin built by ESP-IDF / Arduino'), rows };
  }
  if (b[app] !== 0xe9) app = 0;
  rows.push({ ok: true, text: t('Image magic 0xE9') });
  const id = b[app + 12] | (b[app + 13] << 8);
  const name = CHIP_NAMES[id] ?? t('chip id {id}', { id });
  const chip: Chip | null = chipFromId(id);
  if (!chip) {
    rows.push({ ok: false, text: t('The image header says {name}; TryBoard only simulates ESP32, ESP32-C3 and ESP32-S3', { name }) });
    return { ok: false, chip: null, title: t('This is firmware for {name}', { name }), rows };
  }
  rows.push({ ok: true, text: chip !== cur ? t('Chip {name} (the bench will switch to this board)', { name }) : t('Chip {name}', { name }) });
  return { ok: true, chip, title: t('Ready to power on'), rows };
}

export function FwCheckCard({ name, res, onClose }: { name: string; res: FwCheck; onClose: () => void }) {
  return (
    <div role="alertdialog" aria-label={t('Firmware check')} id="fwCheck" className="absolute top-14 left-1/2 z-5 w-[360px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) bg-surface p-3.5 text-fg shadow-panel">
      <div className="flex items-start gap-2">
        <Icon n="warn" size={18} className="mt-0.5 flex-none text-bad-ink" />
        <div className="min-w-0 flex-1">
          <b className="block text-sm">{res.title}</b>
          <span className="block truncate font-mono text-[11px] text-muted">{name}</span>
        </div>
        <button type="button" aria-label={t('Close')} onClick={onClose} className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field">
          <Icon n="x" size={14} />
        </button>
      </div>
      <ul className="mt-2 mb-0 list-none space-y-1 p-0 text-xs">
        {res.rows.map((r, i) => (
          <li key={i} className="flex gap-1.5">
            <Icon n={r.ok ? 'check' : 'x'} size={13} className={r.ok ? 'mt-px flex-none text-ok-ink' : 'mt-px flex-none text-bad-ink'} />
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 mb-0 text-xs text-muted">{t('The firmware already on the bench keeps running. Try again with ESP-IDF build/flash.bin (or a full image from merge_bin).')}</p>
    </div>
  );
}
