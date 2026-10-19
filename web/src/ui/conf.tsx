// Confidence icon (DESIGN_V2 §8.1): one ink, four fill levels; colour is reserved for result state so the two axes never mix.
// currentColor follows the text colour, so dark theme needs no extra palette.
import type { ReactNode } from 'react';
import { t } from '../i18n';

// The level values are stable ids shared with catalog / advisor / checks / data-conf selectors; only the label is translated.
export type ConfLevel = '仿真验证' | '行为模拟' | '估算' | '必须上真机'; // lint: allow-cjk
export const CONF_LEVELS: ConfLevel[] = ['仿真验证', '行为模拟', '估算', '必须上真机']; // lint: allow-cjk

/** Display name of a level in the UI language; every confidence badge and tooltip uses this one map. */
export function confLabel(c: ConfLevel): string {
  const en: Record<ConfLevel, string> = {
    仿真验证: 'Simulated', // lint: allow-cjk
    行为模拟: 'Behaviour model', // lint: allow-cjk
    估算: 'Estimate', // lint: allow-cjk
    必须上真机: 'Needs real hardware', // lint: allow-cjk
  };
  return t(en[c] ?? c);
}

export type RuleBasis = '数据手册' | '估算' | '必须上真机' | '经验规则'; // lint: allow-cjk

/** Map a wiring-rule basis (catalog/rules.ts) to the four levels: datasheet and rules of thumb are computed, not simulated. */
export function confOfRule(c: RuleBasis): ConfLevel {
  return c === '必须上真机' ? '必须上真机' : '估算'; // lint: allow-cjk
}

/** Display name of a wiring-rule basis. */
export function ruleBasisLabel(c: RuleBasis): string {
  const en: Record<RuleBasis, string> = {
    数据手册: 'Datasheet', // lint: allow-cjk
    估算: 'Estimate', // lint: allow-cjk
    必须上真机: 'Needs real hardware', // lint: allow-cjk
    经验规则: 'Rule of thumb', // lint: allow-cjk
  };
  return t(en[c] ?? c);
}

export function ConfIcon({ c, size = 16, className }: { c: ConfLevel; size?: number; className?: string }) {
  const ring = (dash?: string) => <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray={dash} />;
  let body: ReactNode;
  if (c === '仿真验证') body = <circle cx="8" cy="8" r="6.2" fill="currentColor" />; // lint: allow-cjk
  else if (c === '行为模拟') body = <>{ring()}<path d="M8 8V1.8A6.2 6.2 0 1 1 1.8 8Z" fill="currentColor" /></>; // lint: allow-cjk
  else if (c === '估算') body = <>{ring()}<path d="M8 1.8A6.2 6.2 0 0 1 8 14.2Z" fill="currentColor" /></>; // lint: allow-cjk
  else body = ring('2.4 2');
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" data-conf={c} className={`conf-icon shrink-0 ${className ?? ''}`}>
      {body}
    </svg>
  );
}

/** Icon plus level name (the shape alone is not enough). */
export function Conf({ c, size = 13, className }: { c: ConfLevel; size?: number; className?: string }) {
  return (
    <span className={`conf inline-flex items-center gap-1.5 ${className ?? ''}`}>
      <ConfIcon c={c} size={size} />
      {confLabel(c)}
    </span>
  );
}

const BAR_BG: Record<ConfLevel, string> = {
  仿真验证: 'currentColor', // lint: allow-cjk
  行为模拟: 'color-mix(in srgb, currentColor 60%, transparent)', // lint: allow-cjk
  估算: 'color-mix(in srgb, currentColor 32%, transparent)', // lint: allow-cjk
  必须上真机: 'repeating-linear-gradient(90deg, color-mix(in srgb, currentColor 18%, transparent) 0 4px, transparent 4px 6px)', // lint: allow-cjk
};

/** Distribution bar of a whole report: four segments in one ink, fading, width by count. */
export function ConfBar({ counts, className }: { counts: Partial<Record<ConfLevel, number>>; className?: string }) {
  const segs = CONF_LEVELS.filter((k) => (counts[k] ?? 0) > 0);
  return (
    <div className={`conf-bar ${className ?? ''}`}>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px]" role="img" aria-label={segs.map((k) => `${confLabel(k)} ${counts[k]}`).join(', ')}>
        {segs.map((k) => (
          <span key={k} style={{ flex: counts[k], background: BAR_BG[k] }} />
        ))}
      </div>
    </div>
  );
}
