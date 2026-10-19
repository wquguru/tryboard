// BLE（C-01）：底部坞「蓝牙」页签（空中日志）+ 属性面板「虚拟手机」（docs/design-v2/compete/Main.dc.html）。
// 内核按模拟时间跑虚拟控制器和虚拟手机；这里只显示、只发 ble=<命令>（进输入日志，命令行 --inputs 逐字节重放）。
// 数据节流到 ≤ 10 Hz 再通知 React：通知、广播日志可能一个时间片来好几条。
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { lineDir, lineText, uuidLabel, type BleChar, type BleLine, type BleUpdate, type BleView } from '../ble';
import { ConfIcon } from '../ui/conf';
import { cn } from '../ui/cn';

const LOG_CAP = 1000;

export interface BleSnap {
  /** 0 = 固件没用 BLE，1 = 在跑，2 = 没认出 VHCI 边界 */
  state: number;
  view: BleView | null;
  error: string;
  log: BleLine[];
  /** 最近一条被拒的手机命令的原因（下一条命令被接受时清掉） */
  cmdError: string;
}

function createBleFeed() {
  let snap: BleSnap = { state: 0, view: null, error: '', log: [], cmdError: '' };
  let log: BleLine[] = [];
  let timer = 0;
  let last = 0;
  const subs = new Set<() => void>();
  let pending: Partial<BleSnap> = {};
  const notify = () => {
    timer = 0;
    last = performance.now();
    snap = { ...snap, ...pending, log };
    pending = {};
    for (const f of subs) f();
  };
  const schedule = (now = false) => {
    if (now) {
      clearTimeout(timer);
      notify();
      return;
    }
    if (timer) return;
    const wait = 100 - (performance.now() - last);
    if (wait <= 0) notify();
    else timer = window.setTimeout(notify, wait);
  };
  return {
    get: () => snap,
    update(u: BleUpdate) {
      if (u.cmdError !== undefined) {
        pending.cmdError = u.cmdError;
        schedule(true);
        return;
      }
      if (u.reset) {
        log = [];
        pending = { view: null, error: '', cmdError: '' };
      }
      if (u.log.length) {
        log = log.concat(u.log);
        if (log.length > LOG_CAP) log = log.slice(log.length - LOG_CAP);
      }
      const stateChanged = u.state !== (pending.state ?? snap.state);
      pending.state = u.state;
      if (u.view) pending.view = u.view;
      if (u.error !== undefined) pending.error = u.error;
      // 状态变化（出现 / 认不出）马上通知：坞的页签、构建树要立刻长出来
      schedule(stateChanged || !!u.reset);
    },
    /** 用户发了命令：先清掉上一条的错误 */
    clearError() {
      if (snap.cmdError) {
        pending.cmdError = '';
        schedule(true);
      }
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
/** 整页一份：session 推，坞页签、属性面板、构建树读 */
export const bleFeed = createBleFeed();
export const useBle = () => useSyncExternalStore(bleFeed.subscribe, bleFeed.get);

/** 构建树里「虚拟手机」后面的状态字 */
export function phoneStateText(s: BleSnap): string {
  if (s.state === 2) return '认不出';
  const p = s.view?.phone;
  if (!p) return '';
  return { idle: s.view?.advertising ? '板子在广播' : '空闲', scanning: '扫描中', connecting: '连接中', connected: '已连接' }[p.state];
}

const two = (n: number) => String(n).padStart(2, '0');
/** 模拟微秒 → 00:01.204 */
export function simClock(us: number) {
  const ms = Math.floor(us / 1000);
  return `${two(Math.floor(ms / 60000))}:${two(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, '0')}`;
}

// ------------------------------------------------------------ 坞：空中日志

/** 底部坞「蓝牙」页签：广播、连接、ATT 读写通知，一行一条，按模拟时间 */
export function BlePane() {
  const s = useBle();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const b = box.current;
    if (b && stick.current) b.scrollTop = b.scrollHeight;
  }, [s.log]);
  if (s.state === 2) return <ElfCard reason={s.error} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 px-3 pt-1.5 pb-1 text-xs text-muted">
        <span id="bleAir">{s.view?.connected ? '已连接' : s.view?.advertising ? `广播中 · ${s.view.adv_name || s.view.addr}` : '没在广播'}</span>
        <span className="flex-1" />
        <span>按模拟时间，可导出重放</span>
      </div>
      <div
        ref={box}
        id="bleLog"
        role="log"
        aria-label="蓝牙空中日志"
        onScroll={(e) => {
          const b = e.currentTarget;
          stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-mono text-xs leading-[22px]"
      >
        {s.log.length === 0 && <div className="text-muted">还没有空中活动</div>}
        {s.log.map((l, i) => (
          <div
            key={l.n}
            data-k={l.k}
            className={cn(
              'grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 md:grid-cols-[90px_140px_minmax(0,1fr)]',
              i === s.log.length - 1 && 'bg-accent-bg',
            )}
          >
            <span className="text-muted">{simClock(l.t)}</span>
            <span className="max-md:text-muted">{lineDir(l)}</span>
            <span className="min-w-0 break-words max-md:col-span-2">{lineText(l)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 路线 a′ 没认出 VHCI 边界：说明原因，指向路线 c（拖 app.elf） */
function ElfCard({ reason }: { reason: string }) {
  return (
    <div id="bleElf" className="m-3 flex flex-col gap-1.5 rounded-lg border border-line bg-warn-bg px-3 py-2.5 text-[13px] text-fg">
      <b className="font-medium">BLE 需要再拖一个 app.elf</b>
      <span className="text-xs text-muted">
        固件里用了蓝牙，但没在 .bin 里认出乐鑫蓝牙库的接口（{reason || '签名没对上'}）。把同一次构建出来的 build/&lt;工程名&gt;.elf 拖进来，按符号接上虚拟控制器。
      </span>
      <span className="text-xs text-muted">这一步还在做：目前先显示这张卡，蓝牙不会动。</span>
    </div>
  );
}

// ------------------------------------------------------------ 属性面板：虚拟手机

const pill = (on: boolean) =>
  cn(
    'inline-flex h-8 items-center rounded-2xl px-3 text-[13px] max-md:h-11',
    on ? 'bg-fg text-surface' : 'border border-line bg-surface text-fg',
  );
const smallBtn = (primary = false) =>
  cn(
    'inline-flex h-8 flex-none cursor-pointer items-center rounded-lg px-2.5 text-xs max-md:h-11 disabled:cursor-not-allowed disabled:opacity-50',
    primary ? 'border-0 bg-accent-strong font-medium text-on-accent' : 'border border-line bg-surface text-fg',
  );

const BtIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m7 7 10 10-5 5V2l5 5L7 17" />
  </svg>
);

const hhex = (h: number) => `0x${h.toString(16).padStart(4, '0')}`;

/** 通知值曲线（最近 30 个点），纵轴按数据自己的范围 */
function Spark({ hist, label }: { hist: [number, number][]; label: string }) {
  const pts = hist.slice(-30);
  if (pts.length < 2) return null;
  const vs = pts.map((p) => p[1]);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const t0 = pts[0][0];
  const tw = pts[pts.length - 1][0] - t0 || 1;
  const poly = pts.map(([t, v]) => `${(((t - t0) / tw) * 300).toFixed(1)},${(34 - ((v - lo) / span) * 28).toFixed(1)}`).join(' ');
  return (
    <svg data-spark width="100%" height="40" viewBox="0 0 300 40" preserveAspectRatio="none" role="img" aria-label={`${label}最近 ${pts.length} 次通知，在 ${lo} 到 ${hi} 之间`}>
      <polyline points={poly} fill="none" stroke="var(--color-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 一张特征卡：名字 + UUID、当前值（认得的给人话）、读取 / 订阅 / 写入 */
function CharCard({ c, send }: { c: BleChar; send: (cmd: string) => void }) {
  const [hex, setHex] = useState('01');
  const canRead = c.props.includes('read');
  const canSub = (c.props.includes('notify') || c.props.includes('indicate')) && c.cccd !== null;
  const canWrite = c.props.includes('write') || c.props.includes('write-nr');
  const shown = c.text || c.value;
  const big = c.hist.length > 0 || /^\d/.test(c.text);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(`write ${hhex(c.handle)} ${hex}`);
  };
  return (
    <div data-char={c.uuid} className="flex flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium">{c.name || '特征'}</span>
        <span className="flex-none font-mono text-[11px] text-muted">{uuidLabel(c.uuid)}</span>
        <span className="flex-1" />
        {c.notify && <span className="flex-none text-xs text-ok-ink">已订阅</span>}
        {canRead && !canSub && (
          <button type="button" data-act="read" className={smallBtn()} onClick={() => send(`read ${hhex(c.handle)}`)}>
            读取
          </button>
        )}
      </div>
      {shown && (
        <div className="flex min-w-0 items-baseline gap-1.5" data-val>
          <span className={cn('font-mono break-all', big ? 'text-[28px] leading-9 font-bold' : 'text-[13px]')}>{c.text ? c.text.replace(/\s*bpm$/, '').replace(/%$/, ' %') : c.value}</span>
          {/\bbpm$/.test(c.text) && <span className="text-muted">次/分</span>}
          {c.text && c.value && !/bpm$|%$/.test(c.text) && <span className="font-mono text-[11px] text-muted">{c.value}</span>}
        </div>
      )}
      <Spark hist={c.hist} label={c.name || c.uuid} />
      {canSub && (
        <div className="flex flex-wrap gap-1.5">
          {canSub && (
            <button type="button" data-act={c.notify ? 'unsub' : 'sub'} className={smallBtn(!c.notify)} onClick={() => send(`${c.notify ? 'unsub' : 'sub'} ${hhex(c.handle)}`)}>
              {c.notify ? '取消订阅' : '订阅'}
            </button>
          )}
          {canRead && (
            <button type="button" data-act="read" className={smallBtn()} onClick={() => send(`read ${hhex(c.handle)}`)}>
              读取
            </button>
          )}
          {c.notes > 0 && <span className="self-center text-xs text-muted">{`收到 ${c.notes} 条`}</span>}
        </div>
      )}
      {canWrite && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <label htmlFor={`bleW${c.handle}`} className="flex-none font-medium">
            写入
          </label>
          <input
            id={`bleW${c.handle}`}
            data-write={c.uuid}
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={`写入 ${c.name || c.uuid} 的十六进制字节`}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 font-mono text-xs text-fg max-md:h-11 max-md:text-base"
          />
          <button type="submit" data-act="write" className={smallBtn(true)}>
            发送
          </button>
        </form>
      )}
    </div>
  );
}

/** 属性面板「虚拟手机」：附近设备 / 已连接两页，手机外框里是服务与特征卡 */
export function PhonePanel({ send }: { send: (cmd: string) => void }) {
  const s = useBle();
  const p = s.view?.phone;
  const connected = p?.state === 'connected';
  const [tab, setTab] = useState<'near' | 'conn' | null>(null);
  const cur = tab ?? (connected ? 'conn' : 'near');
  const go = (cmd: string) => {
    bleFeed.clearError();
    send(cmd);
  };
  // 连上 / 断开时跟着切页（用户手点过就按手点的，直到下一次连接状态变化）
  const lastConn = useRef(connected);
  useEffect(() => {
    if (lastConn.current !== connected) setTab(null);
    lastConn.current = connected;
  }, [connected]);
  const dev = p?.devices.find((d) => d.addr === p.target) ?? p?.devices[0];
  const head = (
    <div className="mt-2 flex items-center gap-2">
      <strong className="text-[15px]">虚拟手机</strong>
      <span className="inline-flex items-center gap-1 text-xs text-fg" title="协议按规范逐包模拟；射频、距离、手机系统没模拟">
        <ConfIcon c="行为模拟" />
        行为模拟
      </span>
    </div>
  );
  const foot = (
    <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
      <ConfIcon c="必须上真机" />
      信号距离、穿墙、手机系统差异：必须上真机
    </div>
  );
  if (s.state !== 1 || !p)
    return (
      <div id="blePhone" data-state={s.state}>
        {head}
        {s.state === 2 ? <ElfCard reason={s.error} /> : <p className="my-2 text-xs text-muted">台面上的固件没用蓝牙。换一个用 NimBLE 的固件（例如 c3-ble-hr）再来。</p>}
        {foot}
      </div>
    );
  return (
    <div id="blePhone" data-state={s.state} data-phone={p.state} className="flex flex-col">
      {head}
      <div className="mt-3 flex flex-col overflow-hidden rounded-[36px] border-8 border-[#1e1e1e] bg-surface text-[13px] text-fg">
        <div className="flex gap-1.5 px-4 pt-5 pb-2" role="tablist" aria-label="虚拟手机">
          <button type="button" role="tab" id="blePillNear" aria-selected={cur === 'near'} className={pill(cur === 'near')} onClick={() => setTab('near')}>
            附近设备
          </button>
          <button type="button" role="tab" id="blePillConn" aria-selected={cur === 'conn'} className={pill(cur === 'conn')} onClick={() => setTab('conn')}>
            已连接
          </button>
        </div>
        {cur === 'near' ? (
          <div className="flex flex-col gap-2 px-4 pt-1 pb-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {p.state === 'scanning' ? (
                <button type="button" id="bleScanOff" className={smallBtn()} onClick={() => go('scan off')}>
                  停止扫描
                </button>
              ) : (
                <button type="button" id="bleScan" className={smallBtn(true)} disabled={connected} onClick={() => go('scan')}>
                  扫描
                </button>
              )}
              <button type="button" id="bleAuto" className={smallBtn()} disabled={connected} title="扫描 → 连第一台 → 读全部可读特征 → 订阅全部通知" onClick={() => go('auto')}>
                一键连上
              </button>
              <span className="text-xs text-muted">{p.state === 'scanning' ? '扫描中…' : p.state === 'connecting' ? '连接中…' : ''}</span>
            </div>
            {p.devices.length === 0 && <p className="my-1 text-xs text-muted">{p.state === 'scanning' ? '还没听到广播' : '点扫描，听板子的广播'}</p>}
            {p.devices.map((d) => (
              <div key={d.addr} data-dev={d.addr} className="flex items-center gap-2.5 border-b border-line-soft py-2 last:border-0">
                <div className="grid size-9 flex-none place-items-center rounded-[10px] bg-accent-bg text-accent-ink">
                  <BtIcon />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{d.name || '（没名字）'}</div>
                  <div className="truncate font-mono text-[11px] text-muted">{`${d.addr} · ${d.rssi} dBm${d.uuids.length ? ' · ' + d.uuids.map((u) => '0x' + u).join(' ') : ''}`}</div>
                </div>
                {connected && p.target === d.addr ? (
                  <span className="text-xs text-ok-ink">已连接</span>
                ) : (
                  <button type="button" data-act="connect" className={smallBtn()} disabled={!d.connectable || connected || p.state === 'connecting'} onClick={() => go(`connect ${d.addr}`)}>
                    连接
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : !connected ? (
          <div className="px-4 pt-2 pb-5 text-xs text-muted">
            {p.state === 'connecting' ? '连接中…' : '还没连上设备。到「附近设备」扫描、连接。'}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 border-b border-line-soft px-4 pt-2 pb-3">
              <div className="grid size-9 flex-none place-items-center rounded-[10px] bg-accent-bg text-accent-ink">
                <BtIcon />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold" id="bleConnName">
                  {dev?.name || s.view?.adv_name || '设备'}
                </div>
                <div className="truncate font-mono text-[11px] text-muted">{`${p.target ?? s.view?.addr} · ${p.rssi} dBm · MTU ${p.mtu}`}</div>
              </div>
              <button type="button" id="bleDisc" className={smallBtn()} onClick={() => go('disconnect')}>
                断开
              </button>
            </div>
            <div className="flex flex-col gap-3 px-4 pt-3 pb-4">
              {!p.ready && <p className="my-0 text-xs text-muted">正在发现服务…</p>}
              {p.services
                .filter((sv) => sv.chars.length && sv.uuid !== '1800' && sv.uuid !== '1801')
                .map((sv) => (
                  <div key={sv.start} data-svc={sv.uuid} className="flex flex-col gap-2">
                    <div className="text-xs text-muted">{`${sv.name ? sv.name + '服务' : '自定义服务'} · ${uuidLabel(sv.uuid)}`}</div>
                    {sv.chars.map((c) => (
                      <CharCard key={c.handle} c={c} send={go} />
                    ))}
                  </div>
                ))}
              {p.ready && p.services.some((sv) => sv.uuid === '1800' || sv.uuid === '1801') && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer">通用服务（设备名、外观、服务变更）</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    {p.services
                      .filter((sv) => sv.uuid === '1800' || sv.uuid === '1801')
                      .flatMap((sv) => sv.chars)
                      .map((c) => (
                        <CharCard key={c.handle} c={c} send={go} />
                      ))}
                  </div>
                </details>
              )}
            </div>
          </>
        )}
      </div>
      {s.cmdError && (
        <p id="bleCmdErr" className="my-2 text-xs text-bad-ink">
          {`手机没照做：${s.cmdError}`}
        </p>
      )}
      {foot}
    </div>
  );
}
