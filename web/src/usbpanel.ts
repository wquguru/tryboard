// 侧栏"虚拟电脑 / 手机"面板：固件用原生 USB 枚举出设备后出现。
// 显示设备描述符、接口、枚举过程；键盘打出的字、鼠标轨迹、USB 串口终端（可以往里输入）。
import type { UsbView } from './usb3d';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();

export function createUsbPanel(before: HTMLElement, sendCdc: (text: string) => void) {
  const el = document.createElement('div');
  el.className = 'panel usb';
  el.hidden = true;
  el.innerHTML = `
    <div class="panel-head">虚拟电脑 · USB <span class="muted" id="usbState"></span></div>
    <div class="usb-body">
      <div id="usbDev" class="usb-dev"></div>
      <div id="usbKbd" class="usb-sec" hidden>
        <div class="usb-cap">键盘输入（电脑上的文本编辑器）</div>
        <pre id="usbTyped" class="usb-typed"></pre>
        <div class="usb-cap">鼠标 <span class="muted" id="usbMouseInfo"></span></div>
        <canvas id="usbMouse" width="360" height="120"></canvas>
      </div>
      <div id="usbCdc" class="usb-sec" hidden>
        <div class="usb-cap">USB 串口终端（电脑上多出一个串口）</div>
        <pre id="usbCdcOut" class="usb-typed"></pre>
        <form id="usbCdcForm"><input id="usbCdcIn" placeholder="发到 USB 串口（回车）" autocomplete="off" /></form>
      </div>
      <details class="usb-log"><summary>枚举过程</summary><ol id="usbLog"></ol></details>
    </div>`;
  before.parentElement!.insertBefore(el, before);
  const q = <T extends HTMLElement>(id: string) => el.querySelector('#' + id) as T;
  q<HTMLFormElement>('usbCdcForm').onsubmit = (e) => {
    e.preventDefault();
    const inp = q<HTMLInputElement>('usbCdcIn');
    sendCdc(inp.value + '\n');
    inp.value = '';
  };
  const canvas = q<HTMLCanvasElement>('usbMouse');
  const g = canvas.getContext('2d')!;
  const trail: [number, number][] = [];
  let lastReports = -1;

  function drawMouse(v: UsbView) {
    const { width: w, height: h } = canvas;
    const x = w * 0.35 + v.mouse.x * 0.6;
    const y = h * 0.2 + v.mouse.y * 0.6;
    if (v.mouse.reports !== lastReports) {
      lastReports = v.mouse.reports;
      trail.push([x, y]);
      if (trail.length > 300) trail.shift();
    }
    g.fillStyle = '#0b0f15';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f2a33a';
    g.lineWidth = 2;
    g.beginPath();
    trail.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b)));
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + 14);
    g.lineTo(x + 4, y + 10);
    g.lineTo(x + 10, y + 10);
    g.closePath();
    g.fill();
  }

  return {
    reset() {
      el.hidden = true;
      trail.length = 0;
      lastReports = -1;
    },
    update(v: UsbView | null) {
      if (!v) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      q('usbState').textContent = v.state;
      q('usbDev').innerHTML = v.vid
        ? `<b>${esc(v.product || '未命名设备')}</b> <span class="muted">${esc(v.manufacturer)}</span>
           <div class="muted mono">VID ${hex4(v.vid)} · PID ${hex4(v.pid)} · 序列号 ${esc(v.serial || '—')}</div>
           <ul>${v.interfaces.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        : '<span class="muted">设备接入，正在枚举…</span>';
      q('usbLog').innerHTML = v.log.map((l) => `<li>${esc(l)}</li>`).join('');
      const hid = v.interfaces.some((i) => i.includes('HID'));
      const cdc = v.interfaces.some((i) => i.includes('CDC-ACM'));
      q('usbKbd').hidden = !hid;
      q('usbCdc').hidden = !cdc;
      if (hid) {
        q('usbTyped').textContent = v.typed || '（还没有输入）';
        q('usbMouseInfo').textContent = `${v.mouse.reports} 次报告 · (${v.mouse.x}, ${v.mouse.y})`;
        drawMouse(v);
      }
      if (cdc) {
        const out = q('usbCdcOut');
        out.textContent = v.cdc.replace(/\r/g, '') || '（还没有数据）';
        out.scrollTop = out.scrollHeight;
      }
    },
  };
}
