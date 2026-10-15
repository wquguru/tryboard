// 元件编辑器：用户按自己的实物接线，往面包板上加 / 删元件。
// 上传自己的固件时最有用：示例自带接线，自定义固件的接线只有用户知道。
import type { PartSpec, SceneSpec } from './board3d';

/** C3 开发板上可接外设的引脚（避开 flash 12–17）；ADC 只有 0–4 */
const PINS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21];
const ADC_PINS = [0, 1, 2, 3, 4];
const PIN_HINT: Record<number, string> = {
  2: 'strapping',
  8: 'strapping · 板载 RGB',
  9: 'strapping · BOOT 键',
  18: 'USB D-',
  19: 'USB D+',
  20: 'UART0 RX',
  21: 'UART0 TX',
};

type Kind = PartSpec['type'];
const KINDS: { kind: Kind; name: string; desc: string }[] = [
  { kind: 'led', name: 'LED + 220Ω', desc: '数字输出 / PWM 调光' },
  { kind: 'servo', name: 'SG90 舵机', desc: '50Hz PWM，0.5–2.5ms' },
  { kind: 'pot', name: '电位器', desc: '模拟输入（ADC1）' },
  { kind: 'oled', name: 'SSD1306 OLED', desc: 'I2C 128×64' },
  { kind: 'bme280', name: 'BME280 温湿度气压', desc: 'I2C 环境传感器' },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pinOpt = (p: number, sel: number) => `<option value="${p}" ${p === sel ? 'selected' : ''}>IO${p}${PIN_HINT[p] ? `（${PIN_HINT[p]}）` : ''}</option>`;

export function describe(p: PartSpec): string {
  switch (p.type) {
    case 'led':
      return `LED · IO${p.pin}`;
    case 'servo':
      return `舵机 · 信号 IO${p.pin}`;
    case 'pot':
      return `电位器 · 滑片 IO${p.pin}`;
    case 'oled':
      return `OLED · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'bme280':
      return `BME280 · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
  }
}

/** I2C 器件变了要重新上电（器件在上电时挂到总线上） */
export const needsReboot = (a: SceneSpec, b: SceneSpec) => {
  const i2c = (s: SceneSpec) =>
    JSON.stringify(s.parts.filter((p) => p.type === 'oled' || p.type === 'bme280'));
  return i2c(a) !== i2c(b);
};

/** 检查引脚冲突：同一引脚被两个非 I2C 元件占用，或 I2C 线与普通元件撞脚 */
export function conflicts(s: SceneSpec): string[] {
  const used = new Map<number, string>();
  const out: string[] = [];
  const claim = (pin: number, who: string, shareable = false) => {
    const prev = used.get(pin);
    if (prev && !(shareable && prev.startsWith('I2C'))) out.push(`IO${pin} 同时接了「${prev}」和「${who}」`);
    else used.set(pin, who);
  };
  for (const p of s.parts) {
    if (p.type === 'oled' || p.type === 'bme280') {
      claim(p.sda, 'I2C SDA', true);
      claim(p.scl, 'I2C SCL', true);
    } else claim(p.pin, describe(p));
  }
  const addrs = s.parts.flatMap((p) => ('addr' in p ? [p.addr] : []));
  if (new Set(addrs).size !== addrs.length) out.push('两个 I2C 器件地址相同，总线上会冲突');
  return out;
}

export function mountEditor(root: HTMLElement, get: () => SceneSpec, set: (s: SceneSpec) => void) {
  let adding: Kind = 'led';
  const render = () => {
    const s = get();
    const bad = conflicts(s);
    const fields = (() => {
      switch (adding) {
        case 'led':
        case 'servo':
          return `<label>引脚<select name="pin">${PINS.map((p) => pinOpt(p, adding === 'led' ? 5 : 6)).join('')}</select></label>`;
        case 'pot':
          return `<label>滑片<select name="pin">${ADC_PINS.map((p) => pinOpt(p, 2)).join('')}</select></label>`;
        default:
          return `<label>SDA<select name="sda">${PINS.map((p) => pinOpt(p, 6)).join('')}</select></label>
            <label>SCL<select name="scl">${PINS.map((p) => pinOpt(p, 7)).join('')}</select></label>
            <label>地址<select name="addr">${(adding === 'oled' ? [0x3c, 0x3d] : [0x76, 0x77]).map((a) => `<option value="${a}">0x${a.toString(16)}</option>`).join('')}</select></label>`;
      }
    })();
    root.innerHTML = `
      <ul class="parts">${s.parts.map((p, i) => `<li><span>${esc(describe(p))}</span><button class="ghost" data-del="${i}">移除</button></li>`).join('') || '<li class="muted">面包板上还没有元件</li>'}</ul>
      ${bad.length ? `<div class="warn">${bad.map(esc).join('<br/>')}</div>` : ''}
      <form class="add">
        <select name="kind">${KINDS.map((k) => `<option value="${k.kind}" ${k.kind === adding ? 'selected' : ''}>${k.name} — ${k.desc}</option>`).join('')}</select>
        <div class="fields">${fields}</div>
        <button type="submit">＋ 加到面包板</button>
      </form>`;
    (root.querySelector('select[name=kind]') as HTMLSelectElement).onchange = (e) => {
      adding = (e.target as HTMLSelectElement).value as Kind;
      render();
    };
    root.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
      b.onclick = () => {
        const n = get();
        set({ ...n, parts: n.parts.filter((_, i) => i !== Number(b.dataset.del)) });
        render();
      };
    });
    (root.querySelector('form') as HTMLFormElement).onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target as HTMLFormElement);
      const num = (k: string) => Number(f.get(k));
      let part: PartSpec;
      if (adding === 'oled' || adding === 'bme280') part = { type: adding, sda: num('sda'), scl: num('scl'), addr: num('addr') };
      else part = { type: adding, pin: num('pin') } as PartSpec;
      const n = get();
      set({ ...n, parts: [...n.parts, part] });
      render();
    };
  };
  render();
  return { render };
}
