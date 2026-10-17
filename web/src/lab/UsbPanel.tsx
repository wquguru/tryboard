// 侧栏"虚拟电脑 · USB"面板：固件用原生 USB 枚举出设备后出现（id 与旧 usbpanel.ts 相同，验收脚本按 id 读）。
// 数据经 usbFeed 节流到 ≤ 10 Hz；鼠标轨迹画在 canvas 上，不进 React 状态。
import { useEffect, useRef, useSyncExternalStore, type FormEvent } from 'react';
import type { UsbFeed } from './store';

const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
const cap = 'usb-cap mt-1.5 mb-1 text-xs text-muted';
const box = 'm-0 max-h-[120px] min-h-[34px] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-field px-2.5 py-2 font-mono text-xs leading-normal text-fg';

// 画布是"电脑屏幕"的示意：深色底、橙色轨迹，与 3D 里的虚拟电脑同色，不跟主题
const SCREEN = '#0b0f15';
const TRAIL = '#f2a33a';
const CURSOR = '#ffffff';

function MouseCanvas({ feed }: { feed: UsbFeed }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = useSyncExternalStore(feed.subscribe, feed.get);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !v) return;
    const g = canvas.getContext('2d')!;
    const { width: w, height: h } = canvas;
    const at = (mx: number, my: number): [number, number] => [w * 0.35 + mx * 0.6, h * 0.2 + my * 0.6];
    g.fillStyle = SCREEN;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = TRAIL;
    g.lineWidth = 2;
    g.beginPath();
    feed.trail.forEach(([a, b], i) => {
      const [x, y] = at(a, b);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    const [x, y] = at(v.mouse.x, v.mouse.y);
    g.fillStyle = CURSOR;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y + 14);
    g.lineTo(x + 4, y + 10);
    g.lineTo(x + 10, y + 10);
    g.closePath();
    g.fill();
  }, [v, feed]);
  return <canvas id="usbMouse" ref={ref} width={360} height={120} aria-label="鼠标轨迹" style={{ background: SCREEN }} className="h-[90px] w-full rounded-md border border-line" />;
}

export function UsbPanel({ feed, sendCdc }: { feed: UsbFeed; sendCdc: (text: string) => void }) {
  const v = useSyncExternalStore(feed.subscribe, feed.get);
  const cdcOut = useRef<HTMLPreElement>(null);
  const hid = !!v?.interfaces.some((i) => i.includes('HID'));
  const cdc = !!v?.interfaces.some((i) => i.includes('CDC-ACM'));
  useEffect(() => {
    if (cdcOut.current) cdcOut.current.scrollTop = cdcOut.current.scrollHeight;
  }, [v?.cdc]);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const inp = e.currentTarget.elements.namedItem('usbCdcIn') as HTMLInputElement;
    sendCdc(inp.value + '\n');
    inp.value = '';
  };
  return (
    <div className="panel usb flex max-h-[46vh] min-h-0 flex-col overflow-auto border-t border-line" hidden={!v}>
      <div className="panel-head flex items-baseline gap-2 border-b border-line px-3.5 py-2.5 font-semibold">
        虚拟电脑 · USB{' '}
        <span className="muted text-xs font-normal text-muted" id="usbState">
          {v?.state}
        </span>
      </div>
      <div className="px-3.5 pt-2.5 pb-3 text-[13px] text-fg">
        <div id="usbDev">
          {v?.vid ? (
            <>
              <b>{v.product || '未命名设备'}</b> <span className="muted text-xs text-muted">{v.manufacturer}</span>
              <div className="muted font-mono text-[11px] text-muted">
                VID {hex4(v.vid)} · PID {hex4(v.pid)} · 序列号 {v.serial || '—'}
              </div>
              <ul className="mt-1.5 mb-0 list-disc pl-[18px]">
                {v.interfaces.map((i, k) => (
                  <li key={k}>{i}</li>
                ))}
              </ul>
            </>
          ) : (
            <span className="muted text-xs text-muted">设备接入，正在枚举…</span>
          )}
        </div>
        <div id="usbKbd" className="mt-2.5" hidden={!hid}>
          <div className={cap}>键盘输入（电脑上的文本编辑器）</div>
          <pre id="usbTyped" className={box}>
            {v?.typed || '（还没有输入）'}
          </pre>
          <div className={cap}>
            鼠标{' '}
            <span className="muted" id="usbMouseInfo">
              {hid && v ? `${v.mouse.reports} 次报告 · (${v.mouse.x}, ${v.mouse.y})` : ''}
            </span>
          </div>
          {hid && <MouseCanvas feed={feed} />}
        </div>
        <div id="usbCdc" className="mt-2.5" hidden={!cdc}>
          <div className={cap}>USB 串口终端（电脑上多出一个串口）</div>
          <pre id="usbCdcOut" ref={cdcOut} className={box}>
            {v?.cdc.replace(/\r/g, '') || '（还没有数据）'}
          </pre>
          <form id="usbCdcForm" onSubmit={submit}>
            <input id="usbCdcIn" name="usbCdcIn" placeholder="发到 USB 串口（回车）" aria-label="发到 USB 串口" autoComplete="off" className="mt-1.5 w-full rounded-md border border-line bg-field px-2.5 py-1.5 font-mono text-xs text-fg outline-none" />
          </form>
        </div>
        <details className="usb-log mt-2.5 text-muted">
          <summary className="cursor-pointer">枚举过程</summary>
          <ol id="usbLog" className="mt-1.5 mb-0 list-decimal pl-5 text-xs">
            {v?.log.map((l, k) => (
              <li key={k}>{l}</li>
            ))}
          </ol>
        </details>
      </div>
    </div>
  );
}
