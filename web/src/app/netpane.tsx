// Dock "Network" tab (C-02 / C-03, designs docs/design-v2/compete/SoftAP.dc.html, Net.dc.html): "Virtual phone" joins the
// firmware's own hotspot and submits the portal form; "Requests" lists DNS / HTTP / blocked connections by simulated time.
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { Conf, ConfIcon } from '../ui/conf';
import { t } from '../i18n';
import { actions, bc, setDock } from './chrome';
import { netFeed, type NetRow, type PhonePage, type PhoneView } from './netfeed';
import { useStore } from './react';

// Virtual router (core world.rs ROUTER_SSID / ROUTER_PASS): the phone only hears the chip's beacon, so the router row is drawn from constants
const ROUTER_SSID = 'MyHome';
const ROUTER_PASS = '12345678';

function linkText(k: string): string {
  switch (k) {
    case 'off':
      return t('Not connected');
    case 'scan':
      return t('Looking for this hotspot');
    case 'auth':
      return t('Authenticating');
    case 'assoc':
      return t('Associating');
    case 'eapol':
      return t('WPA2 handshake');
    case 'up':
      return t('Connected');
    default:
      return k;
  }
}

// Core table rows carry Chinese tokens (core output); map the known ones to the UI language.
function coreText(s: string): string {
  switch (s) {
    case '虚拟': // lint: allow-cjk
      return t('Virtual');
    case '真实': // lint: allow-cjk
      return t('Real');
    case '未放行': // lint: allow-cjk
      return t('Not allowed');
    case '等待': // lint: allow-cjk
      return t('Waiting');
    case '超时': // lint: allow-cjk
      return t('Timed out');
    case '解析': // lint: allow-cjk
      return t('Resolved');
    case '拦截': // lint: allow-cjk
      return t('Blocked');
    case '失败': // lint: allow-cjk
      return t('Failed');
    case '对方网站不允许跨域（CORS），浏览器拦下了': // lint: allow-cjk
      return t('The site does not allow cross-origin requests (CORS); the browser blocked it');
    case '连不上（域名不存在、断网或被拦）': // lint: allow-cjk
      return t('Cannot connect (no such domain, offline or blocked)');
    case '10 秒没有回应': // lint: allow-cjk
      return t('No reply in 10 s');
    case '页面是 https，浏览器不许发 http 请求（混合内容）': // lint: allow-cjk
      return t('The page is https; the browser does not allow http requests (mixed content)');
    case '浏览器拦下了（跨域或网络错误）': // lint: allow-cjk
      return t('Blocked by the browser (cross-origin or network error)');
    case '芯片没等到回复就断开了': // lint: allow-cjk
      return t('The chip closed the connection before a reply came');
    case '真实网络只放行 HTTP，HTTPS 未放行': // lint: allow-cjk
      return t('The real network only allows HTTP; HTTPS is not allowed');
    case '真实网络只放行 HTTP': // lint: allow-cjk
      return t('The real network only allows HTTP');
    case '真实网络：芯片没等到回复就关了连接': // lint: allow-cjk
      return t('Real network: the chip closed the connection before a reply came');
    default:
      return s;
  }
}

/** Simulated time ms -> 00:02.140 */
export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
};

/** The phone's own connectivity probes (generate_204 etc., 302 / 204) are not "opened pages": step 3 shows only pages the user opened */
const shown = (p: PhoneView | null) => (p ? p.pages.filter((x) => (x.status < 300 && x.status !== 204) || x.status >= 400 || x.method === "POST") : []);

/** Which of the three steps is current */
function stepOf(p: PhoneView | null): 1 | 2 | 3 {
  if (!p || !p.ssid) return 1;
  if (shown(p).length) return 3;
  return 2;
}

const send = (cmd: string) => actions.phone?.(cmd);

function Wifi({ strong, className }: { strong?: boolean; className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={className}>
      {strong && <path d="M2 9a15 15 0 0 1 20 0" />}
      <path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" />
      <circle cx="12" cy="19.5" r="1" />
    </svg>
  );
}
const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true" className="mt-0.5 flex-none text-ok-ink">
    <path d="m5 12 5 5 9-10" />
  </svg>
);
const Dot = () => <span aria-hidden="true" className="mt-[7px] size-1.5 flex-none rounded-full bg-line" />;

/** Outer frame of a phone */
function Frame({ active, children, id }: { active: boolean; children: ReactNode; id: string }) {
  return (
    <div
      id={id}
      className={cn(
        'flex h-[336px] w-[224px] flex-none flex-col overflow-hidden rounded-[30px] border-[7px] bg-surface text-[13px] max-md:h-auto max-md:min-h-[340px] max-md:w-full max-md:max-w-[340px]',
        active ? 'border-accent' : 'border-fg',
      )}
    >
      {children}
    </div>
  );
}

function StepHead({ n, cur, children }: { n: number; cur: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-medium">
      <span className={cn('grid size-[22px] place-items-center rounded-full text-xs text-on-accent', cur ? 'bg-accent' : 'bg-fg')}>{n}</span>
      {children}
    </div>
  );
}

function Step1({ p }: { p: PhoneView | null }) {
  const [askPass, setAskPass] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  if (!p)
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-4">
        <div className="text-[15px] font-bold">{t('Wi-Fi')}</div>
        <p className="m-0 text-xs leading-[18px] text-muted">{t("Pick up the virtual phone to see which hotspots are nearby. The board's hotspot only has a beacon once the firmware is running.")}</p>
        <button type="button" id="phoneOn" onClick={() => send('on')} className="min-h-11 cursor-pointer rounded-lg border-0 bg-accent px-4 font-medium text-on-accent">
          {t('Turn on Wi-Fi')}
        </button>
      </div>
    );
  const join = (ssid: string, wpa2: boolean) => {
    if (wpa2) {
      setAskPass(ssid);
      return;
    }
    send(`join,${ssid}`);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="px-4 pt-5 pb-2 text-[15px] font-bold">{t('Wi-Fi')}</div>
      <div className="px-4 text-xs text-muted">{t('Nearby networks')}</div>
      {p.seen.length === 0 && <div className="px-4 py-3 text-xs text-muted">{t("The board's hotspot was not found: the firmware has not opened it yet, or has closed it")}</div>}
      {p.seen.map((b) => {
        const mine = p.ssid === b.ssid;
        return (
          <div key={b.bssid} className="mx-3 mt-2">
            <button
              type="button"
              data-ssid={b.ssid}
              onClick={() => join(b.ssid, b.wpa2)}
              className={cn('flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-[10px] border-0 p-2.5 text-left text-fg', mine ? 'bg-accent-bg' : 'bg-field')}
            >
              <Wifi strong className="flex-none text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{b.ssid}</span>
                <span className="block text-[11px] text-accent-ink">{`${t('From your board')} · ${b.wpa2 ? 'WPA2' : t('Open')}${mine ? ` · ${linkText(p.link)}` : ''}`}</span>
              </span>
            </button>
            {askPass === b.ssid && (
              <form
                className="mt-1.5 flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  send(`join,${b.ssid},${pass}`);
                  setAskPass(null);
                }}
              >
                <input
                  id="phonePass"
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder={t('Hotspot password')}
                  aria-label={t('Hotspot password')}
                  className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-fg"
                />
                <button type="submit" className="h-11 cursor-pointer rounded-lg border-0 bg-fg px-3 text-surface">
                  {t('Join')}
                </button>
              </form>
            )}
          </div>
        );
      })}
      <div className="mx-3 mt-1 flex items-center gap-2 p-2.5 text-muted">
        <Wifi className="flex-none" />
        <span className="flex-1">
          {ROUTER_SSID}
          <span className="block text-[11px]">{t('Home router · virtual · WPA2')}</span>
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      </div>
    </div>
  );
}

function Step2({ p }: { p: PhoneView | null }) {
  if (!p?.ssid) return <div className="p-4 text-xs leading-[18px] text-muted">{t("First tap the board's hotspot in step 1.")}</div>;
  const up = p.link === 'up';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-5 pb-2 text-[15px] font-bold">{t('Wi-Fi')}</div>
      <div className="mx-3 mt-2 flex items-center gap-2 rounded-[10px] border border-line p-2.5">
        {up ? <Check /> : <Wifi className="flex-none text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{p.ssid}</div>
          <div id="phoneIp" className="font-mono text-[11px] text-muted">
            {up && p.ip ? t('Got {ip}', { ip: p.ip }) : up ? t('Connected, waiting for DHCP to assign an address') : linkText(p.link)}
          </div>
        </div>
        <button type="button" onClick={() => send('leave')} className="min-h-11 cursor-pointer border-0 bg-transparent px-1 text-xs text-muted">
          {t('Disconnect')}
        </button>
      </div>
      <div className="flex-1" />
      {up && p.ip && (
        <div id="phoneCaptive" className="m-3 flex flex-col gap-2 rounded-[14px] bg-field p-3.5">
          {typeof p.captive === 'string' ? (
            <>
              <div className="font-bold">{t('Sign in to this network')}</div>
              <div className="text-xs leading-[18px] text-muted">{t('The board points every address at itself (DNS hijack), so the phone recognises it as needing sign-in.')}</div>
              <button type="button" id="phoneOpen" onClick={() => send('open')} className="h-11 cursor-pointer rounded-lg border-0 bg-accent font-medium text-on-accent">
                {t('Open page')}
              </button>
            </>
          ) : p.captive === false ? (
            <>
              <div className="font-bold">{t('This network needs no sign-in')}</div>
              <button type="button" id="phoneOpen" onClick={() => send(`get,http://${p.gw}/`)} className="h-11 cursor-pointer rounded-lg border-0 bg-fg font-medium text-surface">
                {t('Open {gw}', { gw: p.gw })}
              </button>
            </>
          ) : (
            <div className="text-xs text-muted">{t('Checking whether sign-in is needed…')}</div>
          )}
        </div>
      )}
    </div>
  );
}

const labelOf = (f: string) => {
  const k = f.toLowerCase();
  if (k === 'ssid') return t('Wi-Fi name');
  return k === 'pass' || k === 'password' || k === 'pwd' ? t('Password') : f;
};
const isPass = (f: string) => /^(pass|password|pwd|psk)$/i.test(f);

function Step3({ p, wrong }: { p: PhoneView | null; wrong: boolean }) {
  const pages = shown(p);
  const page: PhonePage | undefined = pages[pages.length - 1];
  const [vals, setVals] = useState<Record<string, string>>({});
  if (!page) return <div className="p-4 text-xs leading-[18px] text-muted">{t('In step 2 tap "Open page"; the sign-in page shows up here.')}</div>;
  const host = page.url.replace(/^https?:\/\//, '');
  const def = (f: string) => vals[f] ?? (f.toLowerCase() === 'ssid' ? ROUTER_SSID : isPass(f) ? (wrong ? 'wrongpass' : ROUTER_PASS) : '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = page.fields.map((f) => `${encodeURIComponent(f)}=${encodeURIComponent(def(f))}`).join('&');
    send(`post,,${body}`);
    setVals({});
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-3 mt-4 flex h-7 flex-none items-center gap-1.5 rounded-lg bg-field px-2.5 font-mono text-[11px] text-muted">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
        <span className="truncate">{host}</span>
      </div>
      <div id="phonePage" className="flex flex-col gap-2 p-4">
        {page.error ? (
          <div className="text-xs text-warn-ink">{t('Cannot open: {err}', { err: page.error ?? '' })}</div>
        ) : (
          <>
            <div className="text-[15px] font-bold">{page.title || `${page.method} ${page.status}`}</div>
            <div className="text-xs text-muted">{page.method === 'POST' ? t('After the submit the firmware replied {status}', { status: page.status }) : t('This page was served by your firmware')}</div>
            {!page.fields.length && page.text && <div className="line-clamp-4 text-xs leading-[18px]">{page.text}</div>}
          </>
        )}
        {page.fields.length > 0 && (
          <form id="phoneForm" onSubmit={submit} className="flex flex-col gap-2">
            {page.fields.map((f) => (
              <label key={f} className="flex flex-col gap-1 text-xs text-muted">
                {labelOf(f)}
                <input
                  name={f}
                  type={isPass(f) ? 'password' : 'text'}
                  value={def(f)}
                  onChange={(e) => setVals({ ...vals, [f]: e.target.value })}
                  autoComplete="off"
                  className="h-11 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg"
                />
              </label>
            ))}
            <button type="submit" id="phoneSubmit" className="mt-1.5 h-11 cursor-pointer rounded-lg border-0 bg-fg font-medium text-surface">
              {t('Save and connect')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function After({ p, lease, onWrong, wrong }: { p: PhoneView | null; lease: string | null; onWrong: () => void; wrong: boolean }) {
  const posted = !!p?.pages.some((x) => x.method === 'POST' && x.status === 200);
  const left = posted && (p?.link !== 'up' || !!lease);
  const items: [boolean, string][] = [
    [posted, t('The board received the name and password and stored them in NVS')],
    [left, t('Closes its hotspot and joins the virtual router {ssid}', { ssid: ROUTER_SSID })],
    [!!lease, lease ? t('Got IP {ip}', { ip: lease }) : t('Got an IP')],
  ];
  return (
    <aside id="phoneAfter" className="flex w-[264px] flex-none flex-col gap-2.5 self-stretch rounded-xl border border-line bg-surface p-4 max-md:w-full">
      <div className="text-[15px] font-bold">{t('After the submit')}</div>
      {items.map(([ok, text]) => (
        <div key={text} data-ok={ok ? '' : undefined} className={cn('flex items-start gap-2 leading-5', !ok && 'text-muted')}>
          {ok ? <Check /> : <Dot />}
          <span>{text}</span>
        </div>
      ))}
      <div className="h-px bg-line" />
      <div className="text-xs text-muted">{t('You can also try a failure')}</div>
      <button type="button" id="phoneWrong" aria-pressed={wrong} onClick={onWrong} className="min-h-11 cursor-pointer rounded-lg border border-line bg-surface px-2.5 text-left text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg">
        {wrong ? t('The form now holds a wrong password: wrongpass') : t('Enter a wrong password on purpose and see how the firmware copes')}
      </button>
      <p className="m-0 text-xs leading-[18px] text-muted">{t('A provisioned firmware restarts once by itself: in the serial log you see it read {ssid} from NVS and connect directly. The bench "Power cycle" restores the flash to its original state, which does not count as remembering.', { ssid: ROUTER_SSID })}</p>
      <div className="mt-auto flex gap-1.5 text-xs leading-[18px] text-muted">
        <ConfIcon c="必须上真机" size={16} className="flex-none" />{/* lint: allow-cjk */}
        {t('Whether an iPhone / Android pops up the sign-in page differs: needs real hardware')}
      </div>
    </aside>
  );
}

const Arrow = () => (
  <svg width="28" height="16" viewBox="0 0 32 16" aria-hidden="true" className="flex-none self-center text-muted max-md:hidden">
    <path d="M2 8h26m-6-6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);

function PhoneView_({ mobile }: { mobile?: boolean }) {
  const v = useSyncExternalStore(netFeed.subscribe, netFeed.get);
  const p = v.phone;
  const cur = stepOf(p);
  const [pick, setPick] = useState<1 | 2 | 3 | null>(null);
  const [wrong, setWrong] = useState(false);
  // One step at a time on mobile: follows progress, tap a number to look back
  useEffect(() => setPick(null), [cur]);
  const show = pick ?? cur;
  const steps: [1 | 2 | 3, string, ReactNode][] = [
    [1, t("Find the board's hotspot"), <Step1 p={p} />],
    [2, t('Join; the sign-in page pops up by itself'), <Step2 p={p} />],
    [3, t('Enter the home Wi-Fi and submit'), <Step3 p={p} wrong={wrong} />],
  ];
  if (mobile)
    return (
      <div className="flex flex-col gap-3 px-4 pt-3 pb-8">
        <div role="tablist" aria-label={t('Provisioning steps')} className="flex gap-2">
          {steps.map(([n, title]) => (
            <button key={n} type="button" role="tab" aria-selected={show === n} data-phone-step={n} onClick={() => setPick(n)} title={title} className="min-h-11 min-w-11 cursor-pointer rounded-full border border-line bg-surface px-3 text-[13px] aria-selected:border-accent aria-selected:bg-accent-bg aria-selected:text-accent-ink">
              {n}
            </button>
          ))}
        </div>
        {steps
          .filter(([n]) => n === show)
          .map(([n, title, body]) => (
            <div key={n} className="flex flex-col items-center gap-3">
              <StepHead n={n} cur={n === cur}>
                {title}
              </StepHead>
              <Frame id={`phoneStep${n}`} active={n === cur}>
                {body}
              </Frame>
            </div>
          ))}
        <After p={p} lease={v.lease} wrong={wrong} onWrong={() => setWrong(!wrong)} />
      </div>
    );
  return (
    <div className="flex min-w-max items-start gap-5 px-5 py-3">
      {steps.map(([n, title, body], i) => (
        <div key={n} className="contents">
          {i > 0 && <Arrow />}
          <div className="flex flex-col items-center gap-2.5">
            <StepHead n={n} cur={n === cur}>
              {title}
            </StepHead>
            <Frame id={`phoneStep${n}`} active={n === cur}>
              {body}
            </Frame>
          </div>
        </div>
      ))}
      <After p={p} lease={v.lease} wrong={wrong} onWrong={() => setWrong(!wrong)} />
    </div>
  );
}

const DEST_CLS: Record<string, string> = {
    虚拟: 'bg-field text-fg', // lint: allow-cjk
    真实: 'bg-accent-bg text-accent-ink', // lint: allow-cjk
    未放行: 'bg-warn-bg text-warn-ink', // lint: allow-cjk
};

export function NetRows({ rows, mobile }: { rows: NetRow[]; mobile?: boolean }) {
  if (!rows.length) return <p className="m-0 px-3.5 py-3 text-xs text-muted">{t('The chip has not sent any DNS / HTTP request yet.')}</p>;
  return (
    <table id="netRows" className="w-full table-fixed border-collapse text-xs">
      {/* The address column takes the remaining width; mobile hides time / duration */}
      <colgroup>
        {!mobile && <col className="w-[96px]" />}
        <col className="w-[56px]" />
        <col className="w-[64px]" />
        <col />
        <col className={mobile ? 'w-[64px]' : 'w-[120px]'} />
        {!mobile && <col className="w-[72px]" />}
      </colgroup>
      <thead className="sticky top-0 bg-surface text-left text-muted">
        <tr>
          {([['time', t('Time')], ['method', t('Method')], ['dest', t('Destination')], ['addr', t('Address')], ['status', t('Status')], ['dur', t('Duration')]] as const).map(([h, label]) => (
            <th key={h} className={cn('border-b border-line-soft px-2 py-1.5 font-normal', mobile && (h === 'time' || h === 'dur') && 'hidden')}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line-soft">
            <td className={cn('px-2 py-1 font-mono whitespace-nowrap text-muted', mobile && 'hidden')}>{clock(r[0])}</td>
            <td className="px-2 py-1 font-mono">{r[1]}</td>
            <td className="px-2 py-1">
              <span className={cn('rounded-full px-1.5 py-px text-[11px] whitespace-nowrap', DEST_CLS[r[2]] ?? 'bg-field')}>{coreText(r[2])}</span>
            </td>
            <td className="px-2 py-1 font-mono" title={r[3]}>
              <span className="block truncate">{r[3]}</span>
              {/* Note (C-03): why the real network got no reply (cross-origin, timeout...), why HTTPS was not allowed */}
              {r[6] && <span className="net-note block font-sans text-[11px] leading-4 whitespace-normal text-warn-ink">{coreText(r[6])}</span>}
            </td>
            <td className={cn('truncate px-2 py-1 font-mono', r[4] === '失败' /* lint: allow-cjk */ && 'text-bad-ink', r[4] === '等待' /* lint: allow-cjk */ && 'text-muted')} title={coreText(r[4])}>
              {coreText(r[4])}
            </td>
            <td className={cn('px-2 py-1 font-mono whitespace-nowrap text-muted', mobile && 'hidden')}>{r[5] === null ? '—' : `${Math.round(r[5])} ms`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The "Network" tab: switch between the virtual phone and the requests */
export function NetPane({ mobile, extra }: { mobile?: boolean; extra?: ReactNode }) {
  const v = useSyncExternalStore(netFeed.subscribe, netFeed.get);
  const [view, setView] = useState<'auto' | 'phone' | 'reqs'>('auto');
  // Default: the chip is a client sending requests and the phone is not picked up -> show requests; otherwise the virtual phone
  const cur = view === 'auto' ? (v.rows.length && !v.phone ? 'reqs' : 'phone') : view;
  const { dock } = useStore(bc);
  // On desktop the phone's three steps need ~430px: raise a dock that is too short (a personal preference, not part of the project)
  useEffect(() => {
    if (mobile || cur !== 'phone' || dock.collapsed) return;
    const want = Math.min(Math.round(window.innerHeight * 0.62), 520);
    // The shell setter commits synchronously (flushSync), so it cannot be called straight in an effect: defer to the next tick
    if (dock.h >= want) return;
    const t = window.setTimeout(() => setDock({ h: want }), 0);
    return () => clearTimeout(t);
  }, [mobile, cur, dock.collapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div id="netPane" data-view={cur} className="flex min-h-0 flex-1 flex-col text-[13px] text-fg">
      <div className="flex flex-none items-center gap-1.5 border-b border-line-soft px-3 py-1">
        {(
          [
            ['phone', t('Virtual phone')],
            ['reqs', `${t('Requests')} ${v.total}`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" data-net={k} aria-pressed={cur === k} onClick={() => setView(k)} className="min-h-8 cursor-pointer rounded-md border-0 bg-transparent px-2.5 text-[13px] text-muted aria-pressed:bg-field aria-pressed:font-medium aria-pressed:text-fg max-md:min-h-11">
            {label}
          </button>
        ))}
        <span className="flex-1" />
        {(v.realnet || v.replies > 0) && (
          <span id="realnetBar" className="inline-flex items-center gap-1.5">
            <span className="text-xs text-muted max-md:hidden">
              {t('{n} replies recorded this run · {kb} KB', { n: v.replies, kb: (v.replyBytes / 1024).toFixed(1) })}
            </span>
            <button
              type="button"
              id="saveReplies"
              disabled={!actions.exportInputs}
              title={t("Download this run's input log (with every reply): replay it offline with the command line tryboard run --inputs, byte-for-byte identical")}
              onClick={() => actions.exportInputs?.('realnet')}
              className="min-h-8 cursor-pointer rounded-md border border-line bg-surface px-2.5 text-xs text-fg hover:bg-field disabled:cursor-not-allowed disabled:text-muted max-md:min-h-11"
            >
              {t('Save replies, replay offline')}
            </button>
          </span>
        )}
        {extra}
        <span className="inline-flex items-center gap-1 text-xs" title={t('The phone behaves like common phone systems, not measured on one specific phone')}>
          <Conf c="行为模拟" size={14} />{/* lint: allow-cjk */}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{cur === 'phone' ? <PhoneView_ mobile={mobile} /> : <NetRows rows={v.rows} mobile={mobile} />}</div>
    </div>
  );
}
