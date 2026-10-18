// USB 小键盘的平面成品视图（首页卡片"运行固件"、成品页没有 WebGL 时）：四个键帽 + 虚拟电脑屏幕。
// 键帽按住 = 对应 GPIO 接地（K1..K4 = GPIO4..7）；屏幕上的字来自 USB 虚拟主机（固件真的发出的 HID 报告还原成的文字）。
import { mount } from './common';
import type { UsbView } from '../usb3d';

export const KEYPAD_PINS = [4, 5, 6, 7];
export const KEYPAD_CAPS = ['a', 'b', 'c', 'M'];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function createKeypadView(el: HTMLElement, h: { press(pin: number, down: boolean): void }) {
  const keys = KEYPAD_CAPS.map(
    (k, i) =>
      `<g data-k="key${i}" data-pin="${KEYPAD_PINS[i]}" style="cursor:pointer"><rect data-k="cap${i}" x="${150 + i * 48}" y="318" width="40" height="40" rx="8" fill="${k === 'M' ? '#0D99FF' : '#F2EFE8'}" stroke="#141414" stroke-width="2"/><text x="${170 + i * 48}" y="345" fill="${k === 'M' ? '#FFF' : '#141414'}" class="tb-mono" font-size="18" font-weight="700" text-anchor="middle" pointer-events="none">${k}</text></g>`,
  ).join('');
  const q = mount(
    el,
    `<div class="tb-view sc-root">
<svg viewBox="50 44 380 350" role="img" aria-label="USB 小键盘接在虚拟电脑上：点键帽打字">
<rect width="480" height="480" fill="#DCD8D0"/><rect y="330" width="480" height="150" fill="#CFCAC0"/>
<rect x="96" y="70" width="288" height="180" rx="10" fill="#B9BDC4"/><rect x="108" y="82" width="264" height="156" rx="4" fill="#0F1726"/>
<text x="120" y="104" fill="#E8EDF5" class="tb-mono" font-size="11" font-weight="700">虚拟电脑 · USB</text>
<text data-k="state" x="360" y="104" fill="#F2A33A" class="tb-mono" font-size="11" text-anchor="end">等待设备</text>
<text data-k="dev" x="120" y="122" fill="#9FB0C8" class="tb-mono" font-size="10"></text>
<text data-k="l0" x="120" y="150" fill="#E8EDF5" class="tb-mono" font-size="15"></text>
<text data-k="l1" x="120" y="172" fill="#E8EDF5" class="tb-mono" font-size="15"></text>
<text data-k="l2" x="120" y="194" fill="#E8EDF5" class="tb-mono" font-size="15"></text>
<path d="M84 252 L396 252 L410 268 L70 268 Z" fill="#9A9FA6"/>
<path d="M240 300 C240 286 300 290 300 270" fill="none" stroke="#1C1E22" stroke-width="5"/>
<rect x="138" y="300" width="204" height="72" rx="12" fill="#3A3936" stroke="#141414" stroke-width="2"/>${keys}
<text x="60" y="62" fill="#6E6A63" class="tb-mono" font-size="11" font-weight="700">usbkey · K1–K4 = GPIO4–7</text>
</svg></div>`,
  );
  for (let i = 0; i < 4; i++) {
    const g = q(`key${i}`);
    const cap = q(`cap${i}`);
    const pin = KEYPAD_PINS[i];
    const up = () => {
      if (cap.getAttribute('transform')) {
        cap.removeAttribute('transform');
        h.press(pin, false);
      }
    };
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      cap.setAttribute('transform', 'translate(0 3)');
      h.press(pin, true);
    });
    g.addEventListener('pointerup', up);
    g.addEventListener('pointerleave', up);
  }
  return {
    setUsb(v: UsbView | null) {
      q('state').textContent = v ? v.state : '等待设备';
      q('state').setAttribute('fill', v?.configured ? '#4CC38A' : '#F2A33A');
      q('dev').textContent = v?.product ? `已连接：${v.product}（${v.manufacturer}）` : '';
      const lines = (v?.typed ?? '').replace(/\r/g, '').split('\n').slice(-3);
      for (let i = 0; i < 3; i++) q(`l${i}`).innerHTML = esc((lines[i] ?? '').slice(-28)) + (i === lines.length - 1 ? '▌' : '');
    },
  };
}
