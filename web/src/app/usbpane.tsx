// Dock "USB" tab: the virtual PC (DESIGN_V2 §6.1, moved from the old lab sidebar; ids kept, test scripts read them).
// Shown once firmware enumerates over native USB; data throttled to ≤ 10 Hz, the mouse trail is canvas-only.
import { useEffect, useRef, useSyncExternalStore, type FormEvent } from 'react';
import { t } from '../i18n';
import { usbFeed, type UsbFeed } from './usbfeed';

const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
const cap = 'usb-cap mt-1.5 mb-1 text-xs text-muted';
const box = 'm-0 max-h-[120px] min-h-[34px] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-field px-2.5 py-2 font-mono text-xs leading-normal text-fg';

// The canvas stands for the PC screen: dark with an orange trail like the 3D PC, independent of theme.
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
  return <canvas id="usbMouse" ref={ref} width={360} height={120} aria-label={t('Mouse trail')} style={{ background: SCREEN }} className="h-[90px] w-full rounded-md border border-line" />;
}

export function UsbPane({ sendCdc }: { sendCdc: (text: string) => void }) {
  const feed = usbFeed;
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
    <div className="usb min-h-0 flex-1 overflow-auto px-3.5 pt-2 pb-3 text-[13px] text-fg">
      <div className="flex items-baseline gap-2 font-semibold">
        {t('Virtual PC')}{' '}
        <span className="text-xs font-normal text-muted" id="usbState">
          {v?.state}
        </span>
      </div>
      <div className="grid gap-x-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div id="usbDev">
          {v?.vid ? (
            <>
              <b>{v.product || t('Unnamed device')}</b> <span className="muted text-xs text-muted">{v.manufacturer}</span>
              <div className="muted font-mono text-[11px] text-muted">
                VID {hex4(v.vid)} · PID {hex4(v.pid)} · {t('Serial number')} {v.serial || '—'}
              </div>
              <ul className="mt-1.5 mb-0 list-disc pl-[18px]">
                {v.interfaces.map((i, k) => (
                  <li key={k}>{i}</li>
                ))}
              </ul>
            </>
          ) : (
            <span className="muted text-xs text-muted">{t('Device attached, enumerating…')}</span>
          )}
        </div>
        <div id="usbKbd" className="mt-2.5" hidden={!hid}>
          <div className={cap}>{t('Keyboard input (text editor on the PC)')}</div>
          <pre id="usbTyped" className={box}>
            {v?.typed || t('(no input yet)')}
          </pre>
          <div className={cap}>
            {t('Mouse')}{' '}
            <span className="muted" id="usbMouseInfo">
              {hid && v ? t('Reports: {n} · ({x}, {y})', { n: v.mouse.reports, x: v.mouse.x, y: v.mouse.y }) : ''}
            </span>
          </div>
          {hid && <MouseCanvas feed={feed} />}
        </div>
        <div id="usbCdc" className="mt-2.5" hidden={!cdc}>
          <div className={cap}>{t('USB serial terminal (a new serial port on the PC)')}</div>
          <pre id="usbCdcOut" ref={cdcOut} className={box}>
            {v?.cdc.replace(/\r/g, '') || t('(no data yet)')}
          </pre>
          <form id="usbCdcForm" onSubmit={submit}>
            <input id="usbCdcIn" name="usbCdcIn" placeholder={t('Send to USB serial (Enter)')} aria-label={t('Send to USB serial')} autoComplete="off" className="mt-1.5 w-full rounded-md border border-line bg-field px-2.5 py-1.5 font-mono text-xs text-fg outline-none" />
          </form>
        </div>
        <details className="usb-log mt-2.5 text-muted md:col-span-2">
          <summary className="cursor-pointer">{t('Enumeration log')}</summary>
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
