// 底部坞「网络」页签（C-02 / C-03，设计稿 docs/design-v2/compete/SoftAP.dc.html、Net.dc.html）：
// 「虚拟手机」——连上固件自己开的热点、弹出登录页、填表提交（三步在同一部手机里，电脑上并排、手机上一次一步）；
// 「请求」——芯片发出的 DNS / HTTP / 被拦下的连接，按模拟时刻排。
// 手机上的每一步都走 actions.phone（脚本动作 phone=…，进输入日志），不在网页这边模拟任何网络行为。
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { ConfIcon } from '../ui/conf';
import { actions, bc, setDock } from './chrome';
import { netFeed, type NetRow, type PhonePage, type PhoneView } from './netfeed';
import { useStore } from './react';

// 虚拟路由器（内核 world.rs 的 ROUTER_SSID / ROUTER_PASS）：手机只听得到芯片的信标，路由器那一行按常量画
const ROUTER_SSID = 'MyHome';
const ROUTER_PASS = '12345678';

const LINK_TEXT: Record<string, string> = { off: '未连接', scan: '在找这个热点', auth: '认证中', assoc: '关联中', eapol: 'WPA2 握手中', up: '已连接' };

/** 模拟时刻 ms → 00:02.140 */
export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
};

/** 手机自己做的联网探测（generate_204 之类，302 / 204）不算"打开的页面"：第 3 步只显示用户点开的页 */
const shown = (p: PhoneView | null) => (p ? p.pages.filter((x) => (x.status < 300 && x.status !== 204) || x.status >= 400 || x.method === "POST") : []);

/** 三步里现在该做哪一步 */
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

/** 一部手机的外框 */
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
        <div className="text-[15px] font-bold">无线局域网</div>
        <p className="m-0 text-xs leading-[18px] text-muted">拿起虚拟手机，看看附近有哪些热点。板子开的热点要等固件跑起来才有信标。</p>
        <button type="button" id="phoneOn" onClick={() => send('on')} className="min-h-11 cursor-pointer rounded-lg border-0 bg-accent px-4 font-medium text-on-accent">
          打开无线局域网
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
      <div className="px-4 pt-5 pb-2 text-[15px] font-bold">无线局域网</div>
      <div className="px-4 text-xs text-muted">附近网络</div>
      {p.seen.length === 0 && <div className="px-4 py-3 text-xs text-muted">没找到板子的热点：固件还没开，或者已经关了</div>}
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
                <span className="block text-[11px] text-accent-ink">{`来自你的板子 · ${b.wpa2 ? 'WPA2' : '开放'}${mine ? ` · ${LINK_TEXT[p.link] ?? p.link}` : ''}`}</span>
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
                  placeholder="热点密码"
                  aria-label="热点密码"
                  className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-fg"
                />
                <button type="submit" className="h-11 cursor-pointer rounded-lg border-0 bg-fg px-3 text-surface">
                  加入
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
          <span className="block text-[11px]">家里的路由器 · 虚拟 · WPA2</span>
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
  if (!p?.ssid) return <div className="p-4 text-xs leading-[18px] text-muted">先在第 1 步点板子的热点。</div>;
  const up = p.link === 'up';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-5 pb-2 text-[15px] font-bold">无线局域网</div>
      <div className="mx-3 mt-2 flex items-center gap-2 rounded-[10px] border border-line p-2.5">
        {up ? <Check /> : <Wifi className="flex-none text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{p.ssid}</div>
          <div id="phoneIp" className="font-mono text-[11px] text-muted">
            {up && p.ip ? `分到 ${p.ip}` : up ? '已连接，等 DHCP 分地址' : (LINK_TEXT[p.link] ?? p.link)}
          </div>
        </div>
        <button type="button" onClick={() => send('leave')} className="min-h-11 cursor-pointer border-0 bg-transparent px-1 text-xs text-muted">
          断开
        </button>
      </div>
      <div className="flex-1" />
      {up && p.ip && (
        <div id="phoneCaptive" className="m-3 flex flex-col gap-2 rounded-[14px] bg-field p-3.5">
          {typeof p.captive === 'string' ? (
            <>
              <div className="font-bold">需要登录此网络</div>
              <div className="text-xs leading-[18px] text-muted">板子把所有网址都指向了自己（DNS 劫持），手机识别成"需要登录"。</div>
              <button type="button" id="phoneOpen" onClick={() => send('open')} className="h-11 cursor-pointer rounded-lg border-0 bg-accent font-medium text-on-accent">
                打开
              </button>
            </>
          ) : p.captive === false ? (
            <>
              <div className="font-bold">这个网络不需要登录</div>
              <button type="button" id="phoneOpen" onClick={() => send(`get,http://${p.gw}/`)} className="h-11 cursor-pointer rounded-lg border-0 bg-fg font-medium text-surface">
                {`打开 ${p.gw}`}
              </button>
            </>
          ) : (
            <div className="text-xs text-muted">正在检测要不要登录…</div>
          )}
        </div>
      )}
    </div>
  );
}

const LABEL: Record<string, string> = { ssid: 'Wi-Fi 名称', pass: '密码', password: '密码', pwd: '密码' };
const isPass = (f: string) => /^(pass|password|pwd|psk)$/i.test(f);

function Step3({ p, wrong }: { p: PhoneView | null; wrong: boolean }) {
  const pages = shown(p);
  const page: PhonePage | undefined = pages[pages.length - 1];
  const [vals, setVals] = useState<Record<string, string>>({});
  if (!page) return <div className="p-4 text-xs leading-[18px] text-muted">在第 2 步点「打开」，登录页就显示在这里。</div>;
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
          <div className="text-xs text-warn-ink">{`打不开：${page.error}`}</div>
        ) : (
          <>
            <div className="text-[15px] font-bold">{page.title || `${page.method} ${page.status}`}</div>
            <div className="text-xs text-muted">{page.method === 'POST' ? `提交后固件回了 ${page.status}` : '这一页是你的固件发出来的'}</div>
            {!page.fields.length && page.text && <div className="line-clamp-4 text-xs leading-[18px]">{page.text}</div>}
          </>
        )}
        {page.fields.length > 0 && (
          <form id="phoneForm" onSubmit={submit} className="flex flex-col gap-2">
            {page.fields.map((f) => (
              <label key={f} className="flex flex-col gap-1 text-xs text-muted">
                {LABEL[f.toLowerCase()] ?? f}
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
              保存并连接
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
    [posted, '板子收到名称和密码，存进 NVS'],
    [left, `关掉热点，去连虚拟路由器 ${ROUTER_SSID}`],
    [!!lease, lease ? `拿到 IP ${lease}` : '拿到 IP'],
  ];
  return (
    <aside id="phoneAfter" className="flex w-[264px] flex-none flex-col gap-2.5 self-stretch rounded-xl border border-line bg-surface p-4 max-md:w-full">
      <div className="text-[15px] font-bold">提交之后</div>
      {items.map(([ok, t]) => (
        <div key={t} data-ok={ok ? '' : undefined} className={cn('flex items-start gap-2 leading-5', !ok && 'text-muted')}>
          {ok ? <Check /> : <Dot />}
          <span>{t}</span>
        </div>
      ))}
      <div className="h-px bg-line" />
      <div className="text-xs text-muted">也可以试错</div>
      <button type="button" id="phoneWrong" aria-pressed={wrong} onClick={onWrong} className="min-h-11 cursor-pointer rounded-lg border border-line bg-surface px-2.5 text-left text-fg aria-pressed:border-accent aria-pressed:bg-accent-bg">
        {wrong ? '表单里已换成错的密码 wrongpass' : '故意填错密码，看固件怎么处理'}
      </button>
      <p className="m-0 text-xs leading-[18px] text-muted">配好网的固件会自己重启一次：串口里看它从 NVS 读出 {ROUTER_SSID} 直接连上。台面的「重新上电」会把 flash 恢复成原样，不算记住。</p>
      <div className="mt-auto flex gap-1.5 text-xs leading-[18px] text-muted">
        <ConfIcon c="必须上真机" size={16} className="flex-none" />
        iPhone / 安卓弹不弹登录页各不相同：必须上真机
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
  // 手机上一次一步：跟着进度走，点数字可以回看
  useEffect(() => setPick(null), [cur]);
  const show = pick ?? cur;
  const steps: [1 | 2 | 3, string, ReactNode][] = [
    [1, '找到板子的热点', <Step1 p={p} />],
    [2, '连上，自动弹出登录页', <Step2 p={p} />],
    [3, '填家里 Wi-Fi，提交', <Step3 p={p} wrong={wrong} />],
  ];
  if (mobile)
    return (
      <div className="flex flex-col gap-3 px-4 pt-3 pb-8">
        <div role="tablist" aria-label="配网步骤" className="flex gap-2">
          {steps.map(([n, t]) => (
            <button key={n} type="button" role="tab" aria-selected={show === n} data-phone-step={n} onClick={() => setPick(n)} title={t} className="min-h-11 min-w-11 cursor-pointer rounded-full border border-line bg-surface px-3 text-[13px] aria-selected:border-accent aria-selected:bg-accent-bg aria-selected:text-accent-ink">
              {n}
            </button>
          ))}
        </div>
        {steps
          .filter(([n]) => n === show)
          .map(([n, t, body]) => (
            <div key={n} className="flex flex-col items-center gap-3">
              <StepHead n={n} cur={n === cur}>
                {t}
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
      {steps.map(([n, t, body], i) => (
        <div key={n} className="contents">
          {i > 0 && <Arrow />}
          <div className="flex flex-col items-center gap-2.5">
            <StepHead n={n} cur={n === cur}>
              {t}
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
  虚拟: 'bg-field text-fg',
  真实: 'bg-accent-bg text-accent-ink',
  未放行: 'bg-warn-bg text-warn-ink',
};

export function NetRows({ rows, mobile }: { rows: NetRow[]; mobile?: boolean }) {
  if (!rows.length) return <p className="m-0 px-3.5 py-3 text-xs text-muted">芯片还没发出 DNS / HTTP 请求。</p>;
  return (
    <table id="netRows" className="w-full table-fixed border-collapse text-xs">
      {/* 地址列吃掉剩下的宽度；手机上不显示时间 / 耗时 */}
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
          {['时间', '方法', '去向', '地址', '状态', '耗时'].map((h) => (
            <th key={h} className={cn('border-b border-line-soft px-2 py-1.5 font-normal', mobile && (h === '时间' || h === '耗时') && 'hidden')}>
              {h}
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
              <span className={cn('rounded-full px-1.5 py-px text-[11px] whitespace-nowrap', DEST_CLS[r[2]] ?? 'bg-field')}>{r[2]}</span>
            </td>
            <td className="truncate px-2 py-1 font-mono" title={r[3]}>
              {r[3]}
            </td>
            <td className="truncate px-2 py-1 font-mono" title={r[4]}>{r[4]}</td>
            <td className={cn('px-2 py-1 font-mono whitespace-nowrap text-muted', mobile && 'hidden')}>{r[5] === null ? '—' : `${Math.round(r[5])} ms`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 「网络」页签：虚拟手机 / 请求两块切换 */
export function NetPane({ mobile, extra }: { mobile?: boolean; extra?: ReactNode }) {
  const v = useSyncExternalStore(netFeed.subscribe, netFeed.get);
  const [view, setView] = useState<'auto' | 'phone' | 'reqs'>('auto');
  // 默认：芯片在当客户端发请求、又没拿起手机 → 看请求；否则看虚拟手机
  const cur = view === 'auto' ? (v.rows.length && !v.phone ? 'reqs' : 'phone') : view;
  const { dock } = useStore(bc);
  // 电脑上手机三步要 ~430px 高：坞太矮就拉高（个人偏好里的高度，不进作品）
  useEffect(() => {
    if (mobile || cur !== 'phone' || dock.collapsed) return;
    const want = Math.min(Math.round(window.innerHeight * 0.62), 520);
    // 外壳 setter 同步提交（flushSync），不能在 effect 里直接调：挪到下一拍
    if (dock.h >= want) return;
    const t = window.setTimeout(() => setDock({ h: want }), 0);
    return () => clearTimeout(t);
  }, [mobile, cur, dock.collapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div id="netPane" data-view={cur} className="flex min-h-0 flex-1 flex-col text-[13px] text-fg">
      <div className="flex flex-none items-center gap-1.5 border-b border-line-soft px-3 py-1">
        {(
          [
            ['phone', '虚拟手机'],
            ['reqs', `请求 ${v.total}`],
          ] as const
        ).map(([k, t]) => (
          <button key={k} type="button" data-net={k} aria-pressed={cur === k} onClick={() => setView(k)} className="min-h-8 cursor-pointer rounded-md border-0 bg-transparent px-2.5 text-[13px] text-muted aria-pressed:bg-field aria-pressed:font-medium aria-pressed:text-fg max-md:min-h-11">
            {t}
          </button>
        ))}
        <span className="flex-1" />
        {extra}
        <span className="inline-flex items-center gap-1 text-xs" title="手机的行为按常见手机系统写的，不是某一款手机的实测">
          <ConfIcon c="行为模拟" size={14} />
          行为模拟
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{cur === 'phone' ? <PhoneView_ mobile={mobile} /> : <NetRows rows={v.rows} mobile={mobile} />}</div>
    </div>
  );
}
