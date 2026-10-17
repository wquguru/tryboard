// 元件编辑器：用户按自己的实物接线，往面包板上加 / 删元件（数据与冲突检查在 ../editor.ts）。
import { useState, type FormEvent } from 'react';
import type { ChipId, PartSpec, SceneSpec } from '../board3d';
import { adcPins, conflicts, describe, KINDS, pinLabel, pinsOf, type Kind } from '../editor';
import { cn } from '../ui/cn';

const field = 'w-full cursor-pointer rounded-md border border-line bg-surface px-2 py-[5px] text-xs text-fg';

function PinSelect({ chip, name, label, pins, def }: { chip: ChipId; name: string; label: string; pins: number[]; def: number }) {
  return (
    <label className="grid min-w-[90px] flex-1 gap-0.5 text-[11px] text-muted">
      {label}
      <select name={name} defaultValue={pins.includes(def) ? def : pins[0]} className={field}>
        {pins.map((p) => (
          <option key={p} value={p}>
            {pinLabel(chip, p)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Editor({ scene, chip, onChange }: { scene: SceneSpec; chip: ChipId; onChange: (s: SceneSpec) => void }) {
  const [adding, setAdding] = useState<Kind>('led');
  const bad = conflicts(scene, chip);
  const pins = pinsOf(chip);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => Number(f.get(k));
    const part: PartSpec = adding === 'oled' || adding === 'bme280' ? { type: adding, sda: num('sda'), scl: num('scl'), addr: num('addr') } : ({ type: adding, pin: num('pin') } as PartSpec);
    onChange({ ...scene, parts: [...scene.parts, part] });
  };
  return (
    <div id="editor" className="px-3.5 pt-2.5 pb-3.5 text-[13px]">
      <ul className="parts m-0 mb-2 list-none p-0">
        {scene.parts.length ? (
          scene.parts.map((p, i) => (
            <li key={i} className="flex items-center justify-between border-b border-line py-1">
              <span>{describe(p, chip)}</span>
              <button type="button" className="ghost cursor-pointer px-1 text-muted hover:text-fg" data-del={i} onClick={() => onChange({ ...scene, parts: scene.parts.filter((_, j) => j !== i) })}>
                移除
              </button>
            </li>
          ))
        ) : (
          <li className="muted border-b border-line py-1 text-xs text-muted">面包板上还没有元件</li>
        )}
      </ul>
      {bad.length > 0 && (
        <div className="warn my-1.5 text-xs text-bad-ink">
          {bad.map((b, i) => (
            <div key={i}>{b}</div>
          ))}
        </div>
      )}
      <form className="add grid gap-1.5" onSubmit={submit}>
        <select name="kind" aria-label="元件种类" value={adding} onChange={(e) => setAdding(e.target.value as Kind)} className={field}>
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.name} — {k.desc}
            </option>
          ))}
        </select>
        {/* 换种类 / 换芯片时字段按新默认值重建 */}
        <div className="fields flex flex-wrap gap-1.5" key={adding + chip}>
          {adding === 'led' || adding === 'servo' ? (
            <PinSelect chip={chip} name="pin" label="引脚" pins={pins} def={adding === 'led' ? 5 : 6} />
          ) : adding === 'pot' ? (
            <PinSelect chip={chip} name="pin" label="滑片" pins={adcPins(chip)} def={2} />
          ) : (
            <>
              <PinSelect chip={chip} name="sda" label="SDA" pins={pins} def={6} />
              <PinSelect chip={chip} name="scl" label="SCL" pins={pins} def={7} />
              <label className="grid min-w-[90px] flex-1 gap-0.5 text-[11px] text-muted">
                地址
                <select name="addr" className={field}>
                  {(adding === 'oled' ? [0x3c, 0x3d] : [0x76, 0x77]).map((a) => (
                    <option key={a} value={a}>
                      0x{a.toString(16)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        <button type="submit" className={cn(field, 'hover:border-hover-line')}>
          ＋ 加到面包板
        </button>
      </form>
    </div>
  );
}
