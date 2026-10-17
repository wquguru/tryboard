// "这个示例"面板里的滑块（环境 / 倾斜 / 旋钮）与 I2S 声源。
// 滑块是非受控的、直接挂原生 input 监听：验收脚本直接改 value 再派发 new Event('input')（不冒泡，React 的根委托收不到），
// 3D 拖动也直接改 DOM；读数 <output> 由监听里直接写。
import { useEffect, useRef } from 'react';
import type { Control } from './store';
import { ENV_ROWS, MIC_SOURCES, POSE_ROWS, type Lab } from './lab';

const row = 'grid grid-cols-[36px_1fr_84px] items-center gap-2 text-xs text-muted';
const range = 'w-full accent-accent';
const out = 'text-right font-mono text-fg';
const hint = 'muted mt-1.5 text-xs text-muted';
const output = (el: HTMLInputElement) => el.parentElement!.querySelector('output')!;
/** ref 回调：给滑块挂原生 input 监听，卸载时摘掉 */
const onInput = (f: (el: HTMLInputElement) => void) => (el: HTMLInputElement | null) => {
  if (!el) return;
  el.oninput = () => f(el);
  return () => void (el.oninput = null);
};

function EnvRows({ lab }: { lab: Lab }) {
  const env = lab.env();
  return (
    <div className="env mt-2 grid gap-1.5">
      {ENV_ROWS.map(([k, name, min, max, step, fmt]) => (
        <label key={k} className={row}>
          <span>{name}</span>
          <input
            type="range"
            className={range}
            min={min}
            max={max}
            step={step}
            defaultValue={env[k]}
            data-env={k}
            ref={onInput((el) => {
              const v = Number(el.value);
              output(el).textContent = fmt(v);
              lab.setEnv(k, v);
            })}
          />
          <output className={out}>{fmt(env[k])}</output>
        </label>
      ))}
    </div>
  );
}

function ImuRows({ lab }: { lab: Lab }) {
  const pose = lab.pose();
  return (
    <div className="env mt-2 grid gap-1.5">
      <div className={hint}>倾斜台面：拖滑块，或在 3D 里按住 IMU 模块拖动</div>
      {POSE_ROWS.map(([k, name, lim]) => (
        <label key={k} className={row}>
          <span>{name}</span>
          <input
            type="range"
            className={range}
            min={-lim}
            max={lim}
            step={1}
            defaultValue={Math.round(pose[k])}
            data-pose={k}
            ref={onInput((el) => {
              output(el).textContent = `${el.value}°`;
              lab.setPoseAxis(k, Number(el.value));
            })}
          />
          <output className={out}>{Math.round(pose[k])}°</output>
        </label>
      ))}
    </div>
  );
}

function AudioRows({ lab, spk, mic, source, status }: { lab: Lab; spk: boolean; mic: boolean; source: string; status: string }) {
  const readout = useRef<HTMLDivElement>(null);
  // 读数每个 tick 由 lab.ts 直接改写；这里只给初始文字
  useEffect(() => {
    readout.current!.textContent = spk ? '喇叭：等固件放音…（声音默认关，点工具栏「声音」）' : '麦克风：等固件开始录音…';
  }, [spk]);
  return (
    <div className="env audio mt-2 grid gap-1.5">
      {mic && (
        <>
          <label className={row}>
            <span>麦克风声源</span>
            <select id="micSource" value={source} onChange={(e) => lab.setMicSource(e.target.value)} className="cursor-pointer rounded-md border border-line bg-surface px-2 py-[5px] text-[13px] text-fg">
              {MIC_SOURCES.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <div className={hint} id="micStatus">
            {status}
          </div>
        </>
      )}
      <div className={hint + ' whitespace-pre-line'} id="audioReadout" ref={readout} />
    </div>
  );
}

export function Controls({ lab, controls, micSource, micStatus }: { lab: Lab; controls: Control[]; micSource: string; micStatus: string }) {
  return controls.map((c, i) => {
    switch (c.kind) {
      case 'env':
        return <EnvRows key={i} lab={lab} />;
      case 'imu':
        return <ImuRows key={i} lab={lab} />;
      case 'analog':
        return (
          <div key={i} className="env mt-2 grid gap-1.5">
            <div className={hint}>{c.c.label}：拖滑块或直接拖 3D 里的旋钮</div>
            <label className={row}>
              <span>旋钮</span>
              <input type="range" className={range} min={0} max={c.c.max_mv} step={10} defaultValue={c.c.value} data-pot={c.c.pin} ref={onInput((el) => lab.setAnalog(c.c.pin, Number(el.value)))} />
              <output className={out}>{c.c.value} mV</output>
            </label>
          </div>
        );
      case 'audio':
        return <AudioRows key={i} lab={lab} spk={c.spk} mic={c.mic} source={micSource} status={micStatus} />;
    }
  });
}
