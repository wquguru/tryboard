// 换固件前的镜像校验（DESIGN_V2 §4 关键状态 3）：只看镜像头，不跑。
// 规则与 simrun.imageChip 一致：先找分区表（0x8000）里的 app，没有就当 0 处是 app；ESP 镜像头魔数 0xE9，偏移 12 的两字节是芯片 id。
import { Icon } from './icons';

const CHIP_NAMES: Record<number, string> = { 0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3', 12: 'ESP32-C2', 13: 'ESP32-C6', 16: 'ESP32-H2', 18: 'ESP32-P4' };
type Chip = 'esp32' | 'esp32c3' | 'esp32s3';

export interface FwCheck {
  ok: boolean;
  chip: Chip | null;
  /** 一句话结论 */
  title: string;
  rows: { ok: boolean; text: string }[];
}

export function fwCheck(buf: ArrayBuffer, cur: Chip): FwCheck {
  const b = new Uint8Array(buf);
  const u32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const rows: FwCheck['rows'] = [];
  if (b.length < 0x20) return { ok: false, chip: null, title: '文件太小，不是固件镜像', rows: [{ ok: false, text: `只有 ${b.length} 字节` }] };
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
  rows.push({ ok: true, text: table ? `整片 flash 镜像：分区表在 0x8000，app 在 0x${app.toString(16)}` : '单个 app 镜像（没有分区表）' });
  if (b[0] !== 0xe9 && b[app] !== 0xe9) {
    rows.push({ ok: false, text: `开头不是 ESP 镜像魔数 0xE9（读到 0x${(b[app] ?? 0).toString(16).toUpperCase().padStart(2, '0')}）` });
    return { ok: false, chip: null, title: '这不是 ESP-IDF / Arduino 编出来的 .bin', rows };
  }
  if (b[app] !== 0xe9) app = 0;
  rows.push({ ok: true, text: '镜像魔数 0xE9' });
  const id = b[app + 12] | (b[app + 13] << 8);
  const name = CHIP_NAMES[id] ?? `芯片 id ${id}`;
  const chip: Chip | null = id === 0 ? 'esp32' : id === 5 ? 'esp32c3' : id === 9 ? 'esp32s3' : null;
  if (!chip) {
    rows.push({ ok: false, text: `镜像头写的是 ${name}，试板只模拟 ESP32、ESP32-C3 和 ESP32-S3` });
    return { ok: false, chip: null, title: `这是 ${name} 的固件`, rows };
  }
  rows.push({ ok: true, text: `芯片 ${name}${chip !== cur ? '（台面会换成这块板）' : ''}` });
  return { ok: true, chip, title: '可以上电', rows };
}

export function FwCheckCard({ name, res, onClose }: { name: string; res: FwCheck; onClose: () => void }) {
  return (
    <div role="alertdialog" aria-label="固件校验" id="fwCheck" className="absolute top-14 left-1/2 z-5 w-[360px] max-w-[calc(100%-24px)] -translate-x-1/2 rounded-(--r) border border-(--bad-line) bg-surface p-3.5 text-fg shadow-panel">
      <div className="flex items-start gap-2">
        <Icon n="warn" size={18} className="mt-0.5 flex-none text-bad-ink" />
        <div className="min-w-0 flex-1">
          <b className="block text-sm">{res.title}</b>
          <span className="block truncate font-mono text-[11px] text-muted">{name}</span>
        </div>
        <button type="button" aria-label="关闭" onClick={onClose} className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field">
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
      <p className="mt-2 mb-0 text-xs text-muted">台面上原来的固件照常在跑。用 ESP-IDF 的 build/flash.bin（或 merge_bin 合成的整片镜像）再试。</p>
    </div>
  );
}
