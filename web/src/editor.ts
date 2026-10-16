// 元件编辑器：用户按自己的实物接线，往面包板上加 / 删元件。
// 上传自己的固件时最有用：示例自带接线，自定义固件的接线只有用户知道。
import { BOARDS, type ChipId, type PartSpec, type SceneSpec } from './board3d';

/** 各芯片的 ADC1 引脚与引脚提示（strapping、板载占用、USB、串口、PSRAM） */
const CHIP_PINS: Record<ChipId, { adc: number[]; hint: Record<number, string>; avoid: number[] }> = {
  esp32c3: {
    adc: [0, 1, 2, 3, 4],
    hint: { 2: 'strapping', 8: 'strapping · 板载 RGB', 9: 'strapping · BOOT 键', 18: 'USB D-', 19: 'USB D+', 20: 'UART0 RX', 21: 'UART0 TX' },
    avoid: [],
  },
  esp32s3: {
    adc: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    hint: { 0: 'strapping · BOOT 键', 3: 'strapping', 45: 'strapping', 46: 'strapping', 19: 'USB D-', 20: 'USB D+', 48: '板载 RGB' },
    // N16R8：GPIO35–37 接八线 PSRAM，排针上有但不能用
    avoid: [35, 36, 37],
  },
};
let chip: ChipId = 'esp32c3';
/** 当前开发板排针上引出的 GPIO（按丝印顺序，去掉不能用的） */
const PINS_OF = (c: ChipId) => {
  const b = BOARDS[c];
  return [...b.left, ...b.right]
    .filter((n) => /^IO\d+$/.test(n))
    .map((n) => Number(n.slice(2)))
    .filter((p) => !CHIP_PINS[c].avoid.includes(p))
    .sort((a, b) => a - b);
};
let PINS = PINS_OF(chip);
let ADC_PINS = CHIP_PINS[chip].adc;
let PIN_HINT = CHIP_PINS[chip].hint;

type Kind = PartSpec['type'];
const KINDS: { kind: Kind; name: string; desc: string }[] = [
  { kind: 'led', name: 'LED + 220Ω', desc: '数字输出 / PWM 调光' },
  { kind: 'servo', name: 'SG90 舵机', desc: '50Hz PWM，0.5–2.5ms' },
  { kind: 'pot', name: '电位器', desc: '模拟输入（ADC1）' },
  { kind: 'oled', name: 'SSD1306 OLED', desc: 'I2C 128×64' },
  { kind: 'bme280', name: 'BME280 温湿度气压', desc: 'I2C 环境传感器' },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pinOpt = (p: number, sel: number): string => `<option value="${p}" ${p === sel ? 'selected' : ''}>IO${p}${PIN_HINT[p] ? `（${PIN_HINT[p]}）` : ''}</option>`;

export function describe(p: PartSpec): string {
  switch (p.type) {
    case 'led':
      return `LED · IO${p.pin}`;
    case 'servo':
      return `舵机 · 信号 IO${p.pin}`;
    case 'pot':
      return `电位器 · 滑片 IO${p.pin}`;
    case 'buzzer':
      return `无源蜂鸣器 · IO${p.pin}`;
    case 'oled':
      return `OLED · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'bme280':
      return `BME280 · 0x${p.addr.toString(16)} · SDA IO${p.sda} / SCL IO${p.scl}`;
    case 'gc9a01':
      return 'GC9A01 圆屏 · SPI2 · SCLK IO12 / MOSI IO11 / CS IO10 / DC IO14 / RST IO13 / BL IO15';
  }
}

/** I2C 器件变了要重新上电（器件在上电时挂到总线上） */
export const needsReboot = (a: SceneSpec, b: SceneSpec) => {
  const i2c = (s: SceneSpec) =>
    JSON.stringify(s.parts.filter((p) => p.type === 'oled' || p.type === 'bme280' || p.type === 'gc9a01'));
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
    } else if (p.type === 'gc9a01') {
      for (const pin of [12, 11, 10, 14, 13, 15]) claim(pin, 'GC9A01 圆屏');
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
  return {
    render,
    /** 切换芯片后引脚列表跟着当前开发板变 */
    setChip(c: ChipId) {
      if (c === chip) return;
      chip = c;
      PINS = PINS_OF(c);
      ADC_PINS = CHIP_PINS[c].adc;
      PIN_HINT = CHIP_PINS[c].hint;
      render();
    },
  };
}
