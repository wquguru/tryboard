// 可信度图标（DESIGN_V2 §8.1）：一个墨色、四档填充。颜色留给结果状态（通过 / 未过 / 没跑完 / 开机复测），两条轴不混。
// 用 currentColor：浅色主题是墨色 #1E1E1E，暗色主题跟着文字变亮，不用另配色。
import type { ReactNode } from 'react';

export type ConfLevel = '仿真验证' | '行为模拟' | '估算' | '必须上真机';
export const CONF_LEVELS: ConfLevel[] = ['仿真验证', '行为模拟', '估算', '必须上真机'];

/** 装配 / 接线规则的依据（catalog/rules.ts）折算到四档：数据手册、经验规则都是算出来的，不是跑出来的 */
export function confOfRule(c: '数据手册' | '估算' | '必须上真机' | '经验规则'): ConfLevel {
  return c === '必须上真机' ? '必须上真机' : '估算';
}

export function ConfIcon({ c, size = 16, className }: { c: ConfLevel; size?: number; className?: string }) {
  const ring = (dash?: string) => <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={dash} />;
  let body: ReactNode;
  if (c === '仿真验证') body = <circle cx="8" cy="8" r="6.2" fill="currentColor" />;
  else if (c === '行为模拟') body = <>{ring()}<path d="M8 8V1.8A6.2 6.2 0 1 1 1.8 8Z" fill="currentColor" /></>;
  else if (c === '估算') body = <>{ring()}<path d="M8 1.8A6.2 6.2 0 0 1 8 14.2Z" fill="currentColor" /></>;
  else body = ring('2.4 2');
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" data-conf={c} className={`conf-icon shrink-0 ${className ?? ''}`}>
      {body}
    </svg>
  );
}

/** 图标 + 档名（不能只靠图形） */
export function Conf({ c, size = 13, className }: { c: ConfLevel; size?: number; className?: string }) {
  return (
    <span className={`conf inline-flex items-center gap-1.5 ${className ?? ''}`}>
      <ConfIcon c={c} size={size} />
      {c}
    </span>
  );
}

const BAR_BG: Record<ConfLevel, string> = {
  仿真验证: 'currentColor',
  行为模拟: 'color-mix(in srgb, currentColor 60%, transparent)',
  估算: 'color-mix(in srgb, currentColor 32%, transparent)',
  必须上真机: 'repeating-linear-gradient(90deg, color-mix(in srgb, currentColor 18%, transparent) 0 4px, transparent 4px 6px)',
};

/** 整份结论的分布条：四段同一墨色、深浅递减，段宽按条数 */
export function ConfBar({ counts, className }: { counts: Partial<Record<ConfLevel, number>>; className?: string }) {
  const segs = CONF_LEVELS.filter((k) => (counts[k] ?? 0) > 0);
  return (
    <div className={`conf-bar ${className ?? ''}`}>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px]" role="img" aria-label={segs.map((k) => `${k} ${counts[k]}`).join('，')}>
        {segs.map((k) => (
          <span key={k} style={{ flex: counts[k], background: BAR_BG[k] }} />
        ))}
      </div>
    </div>
  );
}
