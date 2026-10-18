// 空白实验台的 2D 外壳：工具栏、示例选择、侧栏面板、编辑器。3D 台面 / worker / 串口流由 lab.ts 命令式地挂在这里给的 ref 上。
// 选择器 / id / 文案是验收脚本的契约（Reviews/ab/react/index-contract.md），改之前先看那里。
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { buttonVariants, ThemeToggle } from '../ui/components';
import { cn } from '../ui/cn';
import { createStore, initialLab, useStore, type About, type LabState } from './store';
import { CHIP_LABEL, createLab, type Lab } from './lab';
import { Controls } from './Controls';
import { Editor } from './Editor';
import { UsbPanel } from './UsbPanel';
import { Logo } from '../ui/logo';

const tool = cn(buttonVariants({ variant: 'outline' }), 'h-auto px-3 py-1.5 text-[13px]');
const selectCls = 'cursor-pointer rounded-md border border-line bg-surface px-2 py-[5px] text-[13px] text-fg';
const head = 'panel-head flex items-baseline gap-2 border-b border-line px-3.5 py-2.5 font-semibold';
const muted = 'muted text-xs font-normal text-muted';
const tag = 'tag mr-1 inline-block rounded-full border px-[7px] py-px text-[11px]';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="select flex items-center gap-1.5 text-xs text-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

function AboutView({ about }: { about: About | null }) {
  if (!about) return null;
  if (about.kind === 'custom')
    return (
      <>
        <p>
          自定义固件：{about.name}（{about.kb.toFixed(0)} KB）
        </p>
        <p className={muted}>支持 ESP-IDF / Arduino 构建出的完整 flash 镜像（含分区表），或单独的 app .bin。在下面「面包板元件」里按你的实物接线加元件。</p>
      </>
    );
  return (
    <>
      <p>
        <b>{about.title}</b>
      </p>
      <p>{about.about}</p>
      <p>
        <span className={cn(tag, 'chip border-warn/50 text-warn-ink')}>{about.chip === 'esp32s3' ? 'ESP32-S3' : 'ESP32-C3'}</span>
        {about.tags.map((t, i) => (
          <span key={i} className={cn(tag, t.startsWith('✓') ? 'ok border-ok/50 text-ok-ink' : 'border-line text-muted')}>
            {t}
          </span>
        ))}
      </p>
    </>
  );
}

const runCls = cn(buttonVariants({ variant: 'default' }), 'h-auto px-3 py-1.5 text-[13px] font-semibold');

/** 工具栏里依赖 lab 的部分；lab 建好前只画不可点的运行 / 复位（首帧布局一致） */
function Toolbar({ lab }: { lab: Lab | null }) {
  const s = useStore(lab?.store ?? idle);
  const sound = useRef<HTMLSpanElement>(null);
  // 声音键由 audio.ts 自己管文字 / aria 状态；这里只挂进工具栏、套样式
  useEffect(() => {
    if (!lab) return;
    const b = lab.audio.button();
    b.className = tool;
    sound.current!.replaceChildren(b);
    return () => b.remove();
  }, [lab]);
  return (
    <div className="controls flex flex-wrap items-center gap-2">
      <Field label="示例">
        <select id="example" className={selectCls} value={s.exampleId} onChange={(e) => lab?.selectExample(e.target.value)}>
          {s.examples.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
          {s.custom && <option value="__custom">自定义：{s.custom}</option>}
        </select>
      </Field>
      <button id="run" type="button" className={runCls} disabled={!s.ready} onClick={() => lab?.toggleRun()}>
        {s.running ? '❚❚ 暂停' : '▶ 运行'}
      </button>
      <button id="reset" type="button" className={tool} disabled={!s.ready} onClick={() => lab?.reset()}>
        ⟲ 复位
      </button>
      <Field label="速度">
        <select id="speed" className={selectCls} defaultValue="1" onChange={(e) => lab?.speed(Number(e.target.value))}>
          <option value="0.25">0.25×</option>
          <option value="1">1×</option>
          <option value="4">4×</option>
          <option value="100">尽快</option>
        </select>
      </Field>
      <span ref={sound} className="contents" />
      <button type="button" className={tool} title="下载本次上电以来的输入日志（模拟时间），用 tryboard run <固件> --inputs <文件> 重放" onClick={() => void lab?.exportInputs()}>
        导出输入
      </button>
      <label className={cn(tool, 'upload text-muted focus-within:outline-2 focus-within:outline-accent')}>
        上传固件
        <input
          id="upload"
          type="file"
          accept=".bin"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) lab?.upload(f);
          }}
        />
      </label>
    </div>
  );
}

/** lab 建好前给 useStore 的空 store（hook 不能条件调用） */
const idle = createStore<LabState>(initialLab());

function StageOverlay({ lab, asmBox }: { lab: Lab | null; asmBox: RefObject<HTMLDivElement | null> }) {
  const { asm, view } = useStore(lab?.store ?? idle);
  // asmBox 的子节点归 assembly.ts 管，React 只切 hidden
  useEffect(() => {
    asmBox.current!.hidden = view !== 'asm';
  }, [view, asmBox]);
  const tabs: ['3d' | 'asm', string][] = [
    ['3d', '面包板 3D'],
    ['asm', '装配 · 成品'],
  ];
  return (
    <>
      <div id="hint" className="pointer-events-none absolute bottom-3 left-3.5 text-xs text-muted" hidden={view === 'asm'}>
        拖动旋转 · 滚轮缩放 · 点击板上的 BOOT / RST 按键
      </div>
      <div id="viewTabs" role="tablist" aria-label="视图" hidden={!asm} className="absolute top-3 left-3.5 z-[3] flex gap-1 rounded-[10px] border border-line bg-surface p-1">
        {tabs.map(([v, t]) => (
          <button key={v} type="button" role="tab" data-v={v} aria-selected={view === v} onClick={() => lab?.setView(v)} className="cursor-pointer rounded-md border-0 bg-transparent px-3.5 py-1.5 font-semibold text-muted aria-selected:bg-accent-bg aria-selected:text-accent-ink">
            {t}
          </button>
        ))}
      </div>
    </>
  );
}

function ChipLabel({ lab }: { lab: Lab | null }) {
  const { chip } = useStore(lab?.store ?? idle);
  return <span id="chip">{CHIP_LABEL[chip]}</span>;
}

function AboutBox({ lab }: { lab: Lab }) {
  const { about } = useStore(lab.store);
  return <AboutView about={about} />;
}

function ControlsBox({ lab }: { lab: Lab }) {
  const { controls, controlsKey, micSource, micStatus } = useStore(lab.store);
  return <Controls key={controlsKey} lab={lab} controls={controls} micSource={micSource} micStatus={micStatus} />;
}

function EditorBox({ lab }: { lab: Lab }) {
  const { editorOpen, scene, chip } = useStore(lab.store);
  return (
    <details className="panel editor flex min-h-0 flex-col border-t border-line" id="editorBox" open={editorOpen} onToggle={(e) => lab.store.set({ editorOpen: e.currentTarget.open })}>
      <summary className={cn(head, 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
        面包板元件 <span className={muted}>按你的实物接线添加</span>
      </summary>
      <Editor scene={scene} chip={chip} onChange={lab.setScene} />
    </details>
  );
}

const navLink = 'rounded-md px-2.5 py-[5px] text-[13px] no-underline';

export function App() {
  const stage = useRef<HTMLElement>(null);
  const consoleEl = useRef<HTMLPreElement>(null);
  const simtime = useRef<HTMLSpanElement>(null);
  const ratio = useRef<HTMLSpanElement>(null);
  const asmBox = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const uartIn = useRef<HTMLInputElement>(null);
  const [lab, setLab] = useState<Lab | null>(null);

  // 命令式部分（3D、worker、串口流）只建一次，卸载时拆掉
  useEffect(() => {
    const l = createLab({ stage: stage.current!, console: consoleEl.current!, simtime: simtime.current!, ratio: ratio.current!, asmBox: asmBox.current!, controls: controls.current! });
    setLab(l);
    return () => l.dispose();
  }, []);

  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto] text-[13px] leading-normal max-[900px]:h-auto max-[900px]:min-h-full">
      <header className="bar flex flex-wrap items-center gap-5 border-b border-line bg-head-bg px-4 py-2.5">
        <h1 className="sr-only">空白实验台</h1>
        <a className="brand flex items-center gap-1.5 text-base font-bold tracking-[0.2px] text-inherit no-underline" href="./home.html">
          <Logo size={22} />
          <b className="text-lg font-black">试板</b> <span className="en font-mono text-[11px] font-bold tracking-[0.08em] text-accent-ink">TRYBOARD</span>
        </a>
        <nav className="nav flex gap-0.5" aria-label="站点">
          <a href="./home.html" className={cn(navLink, 'text-muted hover:bg-field hover:text-fg')}>
            首页
          </a>
          <a href="./index.html" aria-current="page" className={cn(navLink, 'on bg-field text-fg')}>
            空白实验台
          </a>
          <a href="./advisor.html" className={cn(navLink, 'text-muted hover:bg-field hover:text-fg')}>
            选型助手
          </a>
          <a href="./app.html?work=weather#bench" title="按作品走：采购 → 实验台 → 组装 → 成品" className={cn(navLink, 'new text-accent-ink hover:bg-field')}>
            新工作台 →
          </a>
        </nav>
        <Toolbar lab={lab} />
        <div className="status ml-auto flex gap-3.5 font-mono text-xs text-muted max-[900px]:ml-0">
          <ChipLabel lab={lab} />
          <span id="simtime" ref={simtime}>
            0.000 s
          </span>
          <span id="ratio" ref={ratio} className="[&.slow]:text-bad-ink">
            —
          </span>
        </div>
        <ThemeToggle />
      </header>
      <main className="grid min-h-0 grid-cols-[1fr_420px] max-[900px]:min-h-auto max-[900px]:grid-cols-1 max-[900px]:grid-rows-[55vh_auto]">
        <section id="stage" ref={stage} className="relative min-h-0 overflow-hidden [&>canvas]:block">
          <StageOverlay lab={lab} asmBox={asmBox} />
          <div id="asmBox" ref={asmBox} hidden className="absolute inset-0 z-[2] flex items-center justify-center bg-bg px-4 pt-16 pb-4 [&>.tb-view]:w-[min(100%,calc((100vh_-_200px)*1000/560))]" />
        </section>
        <aside className="grid min-h-0 grid-rows-[1fr_auto] border-l border-line bg-surface max-[900px]:border-t max-[900px]:border-l-0" aria-label="串口与示例">
          <div className="panel flex min-h-0 flex-col">
            <div className={head}>
              串口监视器 <span className={muted}>UART0 · 115200</span>
              <button id="clear" type="button" className="ghost ml-auto cursor-pointer border-0 bg-transparent px-1 text-muted hover:text-fg" onClick={() => lab?.clearConsole()}>
                清空
              </button>
            </div>
            <pre id="console" ref={consoleEl} tabIndex={0} role="log" aria-live="off" aria-label="串口输出" className="m-0 min-h-0 flex-1 overflow-auto px-3.5 py-2.5 font-mono text-xs leading-[1.55] break-all whitespace-pre-wrap text-fg max-[900px]:min-h-[220px] [&_.err]:text-bad-ink [&_.sys]:text-accent-ink" />
            <form
              id="uartForm"
              className="border-t border-line"
              onSubmit={(e) => {
                e.preventDefault();
                lab?.uart(uartIn.current!.value + '\n');
                uartIn.current!.value = '';
              }}
            >
              <input id="uartIn" ref={uartIn} placeholder="发送到串口（回车）" aria-label="发送到串口" autoComplete="off" className="w-full border-0 bg-transparent px-3.5 py-2.5 font-mono text-xs text-fg outline-none focus-visible:bg-field" />
            </form>
          </div>
          {lab && <UsbPanel feed={lab.usbFeed} sendCdc={lab.usbCdc} />}
          {/* 矮屏（< 约 650px 高）下说明卡不封顶会把串口挤到 0 高：桌面布局封顶 40vh、自己滚动 */}
          <div className="panel info flex min-h-0 flex-col border-t border-line min-[901px]:max-h-[40vh] min-[901px]:overflow-y-auto">
            <div className={head}>这个示例</div>
            <div id="about" className="px-3.5 pt-2.5 pb-3.5 text-[13px] text-fg [&_p]:m-0 [&_p]:mb-1.5">
              {lab && <AboutBox lab={lab} />}
            </div>
            {/* 容器先于 lab 存在（lab 拿它找滑块：3D 拖动、装配视图直接改滑块的值） */}
            <div id="controls" ref={controls} className="px-3.5 pb-2">
              {lab && <ControlsBox lab={lab} />}
            </div>
          </div>
          {lab && <EditorBox lab={lab} />}
        </aside>
      </main>
      <footer className="border-t border-line px-4 py-1.5 text-[11px] text-muted">
        ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif. ROM 来自 esp-rom-elfs（Apache-2.0）。
        <a href="./licenses.html" className="text-inherit underline">
          第三方授权
        </a>
      </footer>
    </div>
  );
}
