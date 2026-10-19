// 「真买」卡（DESIGN_V2 §8.3，稿 LoopB）：网页里做成了之后，做成真的——真买、烧、上真机逐项勾。
// 自定义作品在实验台检查点全过后出现（bench.tsx），现成作品在成品步之后出现（product.tsx）；两处共用这一个组件。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BuyLine } from '../catalog/templates.ts';
import { getPart } from '../catalog/parts.ts';
import { ConfIcon } from '../ui/conf.tsx';
import { Icon } from './icons.tsx';

export interface BuyCardProps {
  /** 还要买的（已勾「我已有」的不列） */
  remaining: BuyLine[];
  /** 检查点全过时的运行指纹（界面上叫「运行编号」） */
  fingerprint: string | null;
  /** 网页证明不了、要上真机逐项勾的条目（来自本作品「必须上真机」） */
  manual: string[];
  /** 已勾的条目（存本机，由调用方读写） */
  checked: string[];
  onToggleManual: (item: string) => void;
  /** 下载 flash.bin（没有用户固件时传 null，按钮不出现） */
  onDownloadBin: (() => void) | null;
  /** 作品名（标题「<作品>在网页里做成了」）；缺省写「这个项目」 */
  title?: string;
  /** 目录里没有、只进清单的零件（选板的继电器、人体红外……）：照样要买，算进件数和参考价 */
  extra?: { name: string; price: [number, number]; keywords?: string }[];
  /** 检查点个数（标题上方「N 个检查点全部通过」）；缺省不写数字 */
  checks?: number;
  /** 有就显示右上角关闭 */
  onClose?: () => void;
}

const yuan = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** 清单行：目录零件按搜索词、参考价展开；没模型的件用名字当搜索词 */
function rowsOf(p: BuyCardProps) {
  const cat = p.remaining.map((l) => {
    const part = getPart(l.partId);
    return { name: part.name, model: part.model, qty: l.qty, lo: part.price.lo * l.qty, hi: part.price.hi * l.qty, kw: part.keywords, url: part.searchUrl.taobao };
  });
  const ext = (p.extra ?? []).map((e) => ({ name: e.name, model: '', qty: 1, lo: e.price[0], hi: e.price[1], kw: e.keywords ?? e.name, url: '' }));
  return [...cat, ...ext];
}

export function BuyCard(p: BuyCardProps) {
  const rows = rowsOf(p);
  const lo = rows.reduce((a, r) => a + r.lo, 0);
  const hi = rows.reduce((a, r) => a + r.hi, 0);
  const [copied, setCopied] = useState('');
  const copy = async () => {
    const text = rows.map((r) => `${r.name}${r.qty > 1 ? ` ×${r.qty}` : ''}：${r.kw}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('已复制搜索词');
    } catch {
      setCopied('浏览器不让写剪贴板：CSV 里有同样的搜索词');
    }
    // CSV 一起下（稿上是一个按钮：复制搜索词 · 导出 CSV）；BOM 开头让 Excel 认 UTF-8
    const csv = ['零件,型号,数量,参考价低,参考价高,搜索词,淘宝搜索', ...rows.map((r) => [r.name, r.model, String(r.qty), yuan(r.lo), yuan(r.hi), r.kw, r.url].map(csvCell).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'tryboard-buy.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // 三栏等高、按钮钉底、实线描边（DESIGN_V2 §9.5）：虚线读作「拖到这里」
  const card = 'flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-4';
  // 每一步只有一个动词和一个数字（DESIGN_V2 §9）；数字用正文黑——蓝色只给能点的东西
  const head = (n: number, verb: string, big: string | number, unit: string) => (
    <div>
      <span className="block text-xs font-medium text-muted">
        {n} · {verb}
      </span>
      <span className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[28px] leading-9 font-bold text-fg tabular-nums">{big}</span>
        <span className="text-[13px] text-muted">{unit}</span>
      </span>
    </div>
  );
  const shown = rows.slice(0, 3);
  const rest = rows.slice(3);
  const line = (r: (typeof rows)[number], i: number) => (
    <li key={i} className="flex justify-between gap-2 border-b border-line-soft py-1.5 text-[13px] leading-5">
      <span className="min-w-0">
        {r.name}
        {r.qty > 1 ? ` ×${r.qty}` : ''}
      </span>
      <span className="flex-none font-mono text-xs leading-5 text-muted tabular-nums">
        ¥{yuan(r.lo)}–{yuan(r.hi)}
      </span>
    </li>
  );
  const btn = 'inline-flex min-h-10 cursor-pointer items-center justify-center gap-1 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-fg hover:bg-field max-md:min-h-11';
  const btnPri = 'inline-flex min-h-10 cursor-pointer items-center justify-center gap-1 rounded-lg border border-accent-strong bg-accent-strong px-3 text-[13px] font-semibold text-on-accent max-md:min-h-11';
  return (
    <section id="buyCard" aria-label="做成真的" className="@container text-fg">
      <div className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-7 flex-none items-center justify-center rounded-full bg-ok-bg text-ok-ink">
          <Icon n="check" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-ok-ink">{p.checks ? `${p.checks} 个检查点全部通过` : '检查点全部通过'}</span>
          <h2 className="m-0 text-xl leading-7 font-semibold">{p.title ? `${p.title}，` : ''}网页里跑通了。</h2>
          <p className="m-0 text-[15px] leading-6 text-muted">接下来，把它做成真的。</p>
        </div>
        {p.onClose && (
          <button type="button" className="inline-flex size-11 flex-none cursor-pointer items-center justify-center rounded-md text-muted hover:bg-field" aria-label="关闭" onClick={p.onClose}>
            <Icon n="x" size={16} />
          </button>
        )}
      </div>
      {/* 按卡片自身宽度排列：作品页右栏只有约 300px，用视口断点会挤成三列 */}
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
        <div className={card} data-buy="buy">
          {head(1, '买零件', rows.length, `件 · 约 ¥${yuan(lo)}–${yuan(hi)}`)}
          {/* 只露 3 件，其余点开：卡里不再套一层滚动，名字也不截断 */}
          <ul className="m-0 list-none p-0">{shown.map(line)}</ul>
          {rest.length > 0 && (
            <details className="group">
              <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1 text-[13px] text-muted select-none max-md:min-h-11 [&::-webkit-details-marker]:hidden">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="-rotate-90 transition-transform group-open:rotate-0">
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                还有 {rest.length} 件
              </summary>
              <ul className="m-0 list-none p-0">{rest.map((r, i) => line(r, i + 3))}</ul>
            </details>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
            <button type="button" className={btnPri} data-buy-copy="" onClick={() => void copy()}>
              复制搜索词 · 导出 CSV
            </button>
            {copied && <span className="text-[11px] text-muted">{copied}</span>}
          </div>
        </div>
        <div className={card} data-buy="flash">
          {head(2, '烧进板子', 1, '条命令')}
          <p className="m-0 text-xs text-muted">用你在网页里跑通的同一份固件</p>
          <pre className="m-0 rounded-md bg-field px-2.5 py-2 font-mono text-xs whitespace-pre-wrap">idf.py -p [串口] flash monitor</pre>
          <p className="m-0 text-xs text-muted">也可以下载 flash.bin，用乐鑫官方烧录工具</p>
          {p.onDownloadBin && (
            <div className="mt-auto pt-1">
              <button type="button" className={btn} data-buy-bin="" onClick={p.onDownloadBin}>
                下载 flash.bin
              </button>
            </div>
          )}
        </div>
        <div className={card} data-buy="manual">
          {head(3, '上真机确认', p.manual.length, p.manual.length ? '件事' : '件要确认')}
          {p.manual.length > 0 && <p className="m-0 text-xs text-muted">网页证明不了的，到手后逐项勾掉</p>}
          {p.manual.length ? (
            p.manual.map((m) => (
              <label key={m} className="flex min-h-8 cursor-pointer items-start gap-2 text-xs max-md:min-h-11">
                <input type="checkbox" className="mt-0.5 accent-(--accent)" checked={p.checked.includes(m)} onChange={() => p.onToggleManual(m)} />
                <ConfIcon c="必须上真机" size={13} className="mt-0.5" />
                <span>{m}</span>
              </label>
            ))
          ) : (
            <p className="m-0 text-xs text-muted">这个作品没有「必须上真机」的条目。</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-line-soft pt-2 text-[11px] text-muted">
        <span>价格是参考价，已有的零件不再列。</span>
        {p.fingerprint && (
          <span title="同一固件、同样输入，网页和命令行的运行编号相同，说明结果可复现">
            运行编号{' '}
            <span className="font-mono" data-buy-fp="">
              {p.fingerprint}
            </span>
          </span>
        )}
      </div>
    </section>
  );
}

/** 实验台上弹出的真买卡：遮罩 + 对话框（点遮罩 / Esc / ✕ 关）。成品页里内嵌的那份不套这个 */
export function BuyDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [onClose]);
  // 挂到 body：遮罩要盖住整个实验台（左右栏也算），只盖舞台时两边仍像能点
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/48" onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="做成真的"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-3 overflow-auto rounded-2xl border border-line bg-surface p-4 shadow-[0_24px_48px_rgba(0,0,0,0.24)] outline-none md:inset-x-[max(12px,calc(50%-440px))] md:top-6 md:bottom-auto md:max-h-[calc(100%-48px)] md:p-7"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
