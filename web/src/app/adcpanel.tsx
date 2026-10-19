// ADC part panel (D-02, design: docs/design-v2/depth/Adc.dc.html): ideal / real toggle, latest reading with
// its spread, the last 48 conversions as bars, the estimate tag and which pins are ADC1 vs ADC2.
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { cn } from '../ui/cn';
import { Conf } from '../ui/conf';
import { Sec, Seg, SegB } from '../ui/panel';
import type { AdcSamples } from '../simmsg';
import type { Chip } from './examples';
import type { Session } from './types';

/** ADC unit and channel of a GPIO, or null when the pin has no ADC */
export function adcChannel(chip: Chip, gpio: number): { unit: 1 | 2; ch: number } | null {
  if (chip === 'esp32s3') {
    if (gpio >= 1 && gpio <= 10) return { unit: 1, ch: gpio - 1 };
    if (gpio >= 11 && gpio <= 20) return { unit: 2, ch: gpio - 11 };
    return null;
  }
  if (chip === 'esp32c3') {
    if (gpio >= 0 && gpio <= 4) return { unit: 1, ch: gpio };
    if (gpio === 5) return { unit: 2, ch: 0 };
  }
  return null;
}

const PIN_GRID: Partial<Record<Chip, number[]>> = {
  esp32s3: Array.from({ length: 20 }, (_, i) => i + 1),
  esp32c3: [0, 1, 2, 3, 4, 5],
};

export function AdcPanel({ session, chip, pin }: { session: Session; chip: Chip; pin: number }) {
  const [ideal, setIdeal] = useState(session.adcIdeal);
  const [s, setS] = useState<AdcSamples>({ raw: [], mv: [] });
  useEffect(
    () =>
      session.onTick((m) => {
        const a = m.adc?.[pin];
        if (a) setS(a);
      }),
    [session, pin],
  );
  const ch = adcChannel(chip, pin);
  const n = s.raw.length;
  const raw = n ? s.raw[n - 1] : null;
  const mv = n ? s.mv[n - 1] : null;
  const lo = n ? Math.min(...s.raw) : 0;
  const hi = n ? Math.max(...s.raw) : 0;
  const half = Math.ceil((hi - lo) / 2);
  const flat = n > 1 && hi === lo;
  // Bars show deviation inside a window of at least 16 codes, so noise is visible but never exaggerated
  const span = Math.max(16, hi - lo);
  const base = (lo + hi) / 2 - span / 2;
  const pick = (v: boolean) => {
    setIdeal(v);
    session.setAdcIdeal(v);
  };
  const grid = PIN_GRID[chip] ?? [];
  return (
    <div className="adc-panel" data-adc-panel={pin}>
      <div className="mt-1 font-mono text-[11px] text-muted">
        GPIO{pin}
        {ch && ` · ADC${ch.unit}_CH${ch.ch}`}
      </div>
      <Sec>{t('ADC model')}</Sec>
      <Seg aria-label={t('ADC model')}>
        <SegB on={ideal} role="radio" aria-checked={ideal} data-adc-mode="ideal" className="max-md:min-h-11" onClick={() => pick(true)}>
          {t('Ideal')}
        </SegB>
        <SegB on={!ideal} role="radio" aria-checked={!ideal} data-adc-mode="real" className="max-md:min-h-11" onClick={() => pick(false)}>
          {t('Real (default)')}
        </SegB>
      </Seg>
      <Sec>{t('Firmware last read')}</Sec>
      <div className="flex items-baseline gap-2" data-adc-reading>
        <span className="font-mono text-[22px] font-medium">{raw ?? '—'}</span>
        {mv !== null && (
          <span className="font-mono text-xs text-muted">
            {flat ? t('± 0 = {mv} mV', { mv }) : t('± {d} ≈ {mv} mV', { d: half, mv })}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex h-9 items-end gap-px rounded-md bg-field p-1" aria-hidden="true" data-adc-bars={n}>
        {Array.from({ length: 48 }, (_, i) => {
          const v = s.raw[i - (48 - n)];
          const h = v === undefined ? 0 : 15 + (70 * (v - base)) / span;
          return <span key={i} className={cn('min-w-0 flex-1 rounded-[1px]', v === undefined ? 'bg-transparent' : 'bg-accent')} style={{ height: `${h}%` }} />;
        })}
      </div>
      <div className="mt-1 flex justify-between gap-3 text-[11px] text-muted">
        <span className="shrink-0">{t('Last 48')}</span>
        <span className="text-right font-mono" data-adc-spread>
          {n === 0 ? '' : flat ? t('Same every time (a real chip never is)') : t('min {lo} · max {hi}', { lo, hi })}
        </span>
      </div>
      <div className="mt-2 flex items-start gap-1.5 text-xs text-muted">
        <span className="shrink-0">
          <Conf c="估算" /* lint: allow-cjk */ />
        </span>
        <span>{t("Typical part on Espressif's calibration curve; the one in your hand will differ")}</span>
      </div>
      <div className="mt-2.5 rounded-md border border-line px-2.5 py-2 text-xs">
        <div className="mb-1 font-medium">{t('With Real on, firmware runs into')}</div>
        <ul className="m-0 list-none space-y-1 p-0 text-muted">
          <li>
            <b className="text-fg">{t('Jitter')}</b> {t('readings differ by a few codes each time; average or filter')}
          </li>
          <li>
            <b className="text-fg">{t('Inaccurate ends')}</b> {t('readings bend below 0.1 V and above 2.9 V')}
          </li>
          <li>
            <b className="text-fg">{t('Needs calibration')}</b> {t('without adc_cali it is a few percent off; with it, close to 1%')}
          </li>
          <li>
            <b className="text-fg">ADC2</b> {chip === 'esp32c3' ? t('not supported by ESP-IDF on C3 (chip erratum)') : t('cannot be read while Wi-Fi is on')}
          </li>
        </ul>
      </div>
      {grid.length > 0 && (
        <>
          <Sec>{t('Choosing a pin when wiring')}</Sec>
          <div className="grid grid-cols-10 gap-1" data-adc-pins>
            {grid.map((g) => {
              const c = adcChannel(chip, g);
              return (
                <span
                  key={g}
                  data-adc-unit={c?.unit}
                  className={cn(
                    'rounded-[4px] py-0.5 text-center font-mono text-[10px]',
                    c?.unit === 1 ? 'border border-accent-line bg-accent-bg text-accent-ink' : 'border border-dashed border-warn bg-warn-bg text-warn-ink',
                    g === pin && 'ring-2 ring-accent',
                  )}
                >
                  {g}
                </span>
              );
            })}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
            <span className="flex items-center gap-1">
              <i className="inline-block size-2.5 rounded-[2px] border border-accent-line bg-accent-bg" />
              {t('ADC1, use freely')}
            </span>
            <span className="flex items-center gap-1">
              <i className="inline-block size-2.5 rounded-[2px] border border-dashed border-warn bg-warn-bg" />
              {chip === 'esp32c3' ? t('ADC2, not supported by ESP-IDF on C3') : t('ADC2, unusable with Wi-Fi on')}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
