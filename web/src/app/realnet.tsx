// 「真实网络」开关（C-03，设计稿 docs/design-v2/compete/Net.dc.html，按「只放行 HTTP」改了文案）。
// 默认关：板子只连浏览器里的虚拟网络，每次跑结果一样。打开要先确认——结果会随外网变，检查点不再记运行编号。
// 弹层自己挂到 body（顶栏和手机 ⋯ 菜单都能打开，菜单关掉也不影响它）。
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { cn } from '../ui/cn';
import { Icon } from './icons';
import { realnetSwitch } from './netfeed';

/** https 页面里浏览器不许发 http 请求（混合内容）：本机 http 预览才真的能连外网 */
const mixedPage = () => location.protocol === 'https:';

function Confirm({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[data-act="keep"]')?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);
  const li = 'flex gap-2 leading-5';
  return (
    <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose}>
      <div
        ref={box}
        id="realnetDlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="realnetTitle"
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-x-3 top-14 flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4 text-[13px] text-fg shadow-panel md:right-40 md:left-auto md:w-[380px]"
      >
        <b id="realnetTitle" className="text-[15px]">
          让板子连真实互联网？
        </b>
        <p className="m-0 leading-5 text-fg/80">固件发往 tryboard.local 以外的 HTTP 请求会经你的浏览器真的发出去，拿回真实的接口数据。</p>
        <div className="flex flex-col gap-2 rounded-lg bg-field p-2.5">
          <div className={li}>
            <Icon n="warn" size={16} className="mt-0.5 flex-none text-warn-ink" />
            每次跑结果可能不同，检查点会标「依赖外网」，不记运行编号
          </div>
          <div className={li}>
            <Icon n="doc" size={16} className="mt-0.5 flex-none text-muted" />
            收到的回复都存进输入日志，以后可以离线重放（命令行 --inputs 逐字节相同）
          </div>
          <div className={li}>
            <Icon n="lock" size={16} className="mt-0.5 flex-none text-muted" />
            只放行 HTTP；HTTPS、MQTT 不放行。对方网站不允许跨域时会显示原因
          </div>
          {mixedPage() && (
            <div className={cn(li, 'text-warn-ink')}>
              <Icon n="warn" size={16} className="mt-0.5 flex-none" />
              本页是 https：浏览器会按「混合内容」拦下所有 http 请求，只有本机 http 预览能真的连上
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" data-act="keep" className="h-9 cursor-pointer rounded-lg border border-line bg-surface px-3.5 text-fg max-md:h-11" onClick={onClose}>
            保持虚拟网络
          </button>
          <button
            type="button"
            data-act="on"
            className="h-9 cursor-pointer rounded-lg border-0 bg-accent-strong px-3.5 font-medium text-white max-md:h-11"
            onClick={() => {
              realnetSwitch.set(true);
              onClose();
            }}
          >
            打开真实网络
          </button>
        </div>
      </div>
    </div>
  );
}

let host: { root: Root; el: HTMLElement } | null = null;
/** 开关：关着 → 先弹确认；开着 → 直接关回虚拟网络 */
export function toggleRealnet() {
  if (realnetSwitch.get()) {
    realnetSwitch.set(false);
    return;
  }
  if (host) return;
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  host = { root, el };
  const close = () => {
    const h = host;
    host = null;
    // 卸载放到下一拍：不在自己的点击处理里卸载自己
    setTimeout(() => {
      h?.root.unmount();
      h?.el.remove();
    });
  };
  root.render(<Confirm onClose={close} />);
}

export const useRealnet = () => useSyncExternalStore(realnetSwitch.subscribe, realnetSwitch.get);

/** 顶栏上的开关（设计稿：圆角胶囊 + 小拨杆，开着是琥珀色） */
export function RealnetSwitch() {
  const on = useRealnet();
  return (
    <button
      type="button"
      role="switch"
      id="realnetBtn"
      aria-checked={on}
      title={on ? '真实网络：开（芯片发往外网的 HTTP 经浏览器真的发出去）。点一下回到虚拟网络' : '真实网络：关（只连浏览器里的虚拟网络，结果可复现）'}
      onClick={toggleRealnet}
      className={cn(
        'flex h-8 flex-none cursor-pointer items-center gap-2 rounded-full border pr-2.5 pl-1.5 text-xs font-medium whitespace-nowrap max-[1100px]:hidden',
        on ? 'border-warn bg-warn-bg text-warn-ink' : 'border-line bg-surface text-muted hover:bg-field',
      )}
    >
      <span className={cn('relative h-5 w-8 rounded-full transition-colors', on ? 'bg-warn' : 'bg-line')}>
        <span className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-[left]', on ? 'left-3.5' : 'left-0.5')} />
      </span>
      真实网络
    </button>
  );
}
