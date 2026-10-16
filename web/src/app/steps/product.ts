// ④ 成品：气象站是 three.js 3D 成品（product3d.ts），小黄 / 透镜小人先挂现有的 SVG 成品（3D 化留给 P1-10）。
// 用的是整页共享的那个实时模拟，不重启：进来时把装法的温漂加到传感器上，离开时撤掉。
// 热源改的是"气象站周围的温度"（env），一阶滞后逼近目标，模拟壳子有热惯性；读数、表盘、灯、报警全来自固件。
import { createProduct3D, type ProductScene } from '../product3d';
import { createLensProduct, createSpinProduct } from '../../views/lcdproducts';
import { TEMPLATES, type Template } from '../../views/templates';
import { passedCount } from './bench';
import { emptyFrame, ledCss, servoAngle, type LiveFrame } from '../../views/common';
import type { AssemblyState, StepCtx, StepImpl, WorkId } from '../types';
import type { TimelineStep } from '../timeline';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const sec = (t: string) => `<div class="sec">${t}</div>`;
const row = (k: string, live: string) => `<div class="kv"><span class="k">${k}</span><span class="v mono" data-live="${live}">—</span></div>`;

/** 热源最多把通风口附近加热多少（℃）和壳子的热时间常数（s）：示意数值，未经真机标定 */
const HEAT_MAX = 14;
const TAU = 3;

/** P0-18：真机到手先做这三件事（按作品） */
const FIRST3: Record<string, [string, string][]> = {
  weather: [
    ['认板子和彩灯引脚', 'ESP32-S3-DevKitC-1 的板载 RGB 在 v1.0 是 GPIO48、v1.1 改到 GPIO38；先烧 blink 看灯亮不亮，不亮就改固件里的引脚。'],
    ['I2C 扫描 + 芯片 ID', '串口 "I2C scan" 一行应有 0x3C 和 0x76。BME280 的 SDO 接高是 0x77；芯片 ID 应为 0x60，0x58 是 BMP280（没有湿度）。'],
    ['装壳前后各标定一次温度', '旁边放一支温度计，各等 10 分钟对比；差值写进固件当偏移。舵机先单独转到 1.5 ms 中位，再装指针。'],
  ],
  spin: [
    ['认板子和圆屏接线', '对照 SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15，有的圆屏模组没有 BL 脚（背光常亮）。'],
    ['舵机先单独供电试转', '只靠 USB 时舵机一转板子可能复位：舵机接外接 5 V，地和开发板共地。先回 90° 中位再装舵盘。'],
    ['看圆屏颜色对不对', '颜色反了是没开反色（INVON），红蓝对调是 RGB / BGR 顺序配错；这两样模拟器里也能看到，真屏以实物为准。'],
  ],
  lens: [
    ['认板子和圆屏接线', '对照 SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15，有的圆屏模组没有 BL 脚。'],
    ['看圆屏颜色对不对', '颜色反了是没开反色（INVON），红蓝对调是 RGB / BGR 顺序配错。'],
    ['实测透镜高度', '透镜离屏 8 mm 左右放大约 1.35×（估算）；真透镜焦距不同，拿尺子量一下再定卡槽。'],
  ],
};

/** 不能模拟的项：网页给不出、只能上真机看 */
const CANNOT: Record<string, [string, string][]> = {
  weather: [
    ['OLED 亮度、可视角度', '这里只知道哪些像素亮，不知道多亮'],
    ['蜂鸣器音色和音量', '这里是方波示意，真蜂鸣器有谐振峰，音量取决于驱动方式'],
    ['舵机力矩、抖动和噪声', '指针的惯性是示意（二阶缓动），真 SG90 会抖、有回差'],
    ['壳内真实温升', `"贴着芯片 +2.5 ℃" 是估算，要拿温度计实测`],
    ['RGB 实际亮度和导光效果', '固件写的是 0x20 这类低亮度，画面上按最大通道放大到可见'],
  ],
  spin: [
    ['舵机力矩带不带得动', '身体重心、舵盘螺丝松紧都影响，网页里不算力'],
    ['圆屏亮度、可视角度', '这里只有帧缓冲颜色'],
    ['转台噪声和抖动', 'SG90 停住时会微抖，真机才听得到'],
  ],
  lens: [
    ['透镜实际放大与畸变', '放大倍数是按卡槽高度估算的'],
    ['圆屏亮度、可视角度', '这里只有帧缓冲颜色'],
  ],
};

const PARTS: Record<string, { id: string; name: string; about: string }[]> = {
  weather: [
    { id: 'shell', name: '外壳 70×50×32 mm', about: '3D 打印外壳（估算尺寸）。前面板最后合上；右侧是通风口，BME280 应该装在它旁边。' },
    { id: 'dial', name: '表盘指针 · SG90', about: 'GPIO4，50 Hz，脉宽 0.5–2.5 ms → 0–40 ℃。指针角度直接来自固件输出的 PWM，惯性是示意。' },
    { id: 'oled', name: 'OLED 0.96″', about: 'SSD1306（I2C 0x3C）。画面就是模拟器里的帧缓冲：大字温度 + 湿度气压。' },
    { id: 'rgb', name: '板载 RGB · 导光柱', about: 'WS2812（GPIO48）：低于 18 ℃ 蓝，低于 28 ℃ 绿，否则红。' },
    { id: 'buzzer', name: '无源蜂鸣器', about: 'GPIO5，≥ 30 ℃ 报警 2.7 kHz，响 200 ms 停 200 ms；降到 29 ℃ 以下停。默认静音。' },
    { id: 'boot', name: 'BOOT 键', about: 'GPIO0，按下接地：切换 OLED 上的 ℃/℉（串口和表盘始终是摄氏度）。' },
    { id: 'bme', name: 'BME280', about: '温度 / 湿度 / 气压，I2C 0x76。装在哪决定它读到的是不是室温。' },
  ],
  spin: [
    { id: 'body', name: '小黄身体', about: '站在 SG90 转台上，脸是一块 1.28″ 圆屏。' },
    { id: 'servo', name: 'SG90 转台', about: 'GPIO4 PWM，±60° 来回转身。' },
    { id: 'lcd', name: '圆屏 GC9A01', about: 'SPI2，画面来自模拟器里的帧缓冲。' },
    { id: 'boot', name: 'BOOT 键', about: '按住转回正面。' },
  ],
  lens: [
    { id: 'lcd', name: '圆屏 GC9A01', about: 'SPI2，画面来自模拟器里的帧缓冲。' },
    { id: 'dome', name: '凸透镜罩', about: '离屏高度决定放大倍数（估算）。' },
    { id: 'boot', name: 'BOOT 键', about: '换表情。' },
  ],
};

const WORK_LIST: { id: WorkId; title: string }[] = [
  { id: 'weather', title: '桌面气象站' },
  { id: 'spin', title: '会转身的小黄' },
  { id: 'lens', title: '透镜里的小人' },
];

/** 参考装配：每个零件都装上，有装法选择的取正确的那种（成品预览用，不写进 store） */
export function referenceAssembly(T: Template): AssemblyState {
  const placed = T.parts.map((p) => p.id);
  const choice: Record<string, string> = {};
  for (const p of T.parts) {
    const ok = p.spots?.find((x) => x.ok);
    if (ok) choice[p.id] = ok.key;
  }
  return { placed, choice, total: placed.length, clean: true, effects: T.effects({ placed, choice }), retest: null };
}

export function productStep(): StepImpl {
  let ctx: StepCtx | null = null;
  let storeRef: StepCtx['store'] | null = null;
  let unsubs: (() => void)[] = [];
  let hooked = false;
  let node: HTMLElement | null = null;
  let scene3d: ProductScene | null = null;
  let svgProduct: { update(f: LiveFrame, room: number, fx: object): void } | null = null;
  let raf = 0;
  let timer = 0;
  let sel = '';
  // 热环境
  let room = 23.5;
  let air = 23.5;
  let heat = { on: false, prox: 0 };
  // 事件与固件状态
  const events: TimelineStep[] = [];
  let unitF = false;
  let alarm = false;
  let tail = '';
  /** 还没装配完：用参考装配展示（"先看参考成品"），顶部标明 */
  let preview = false;
  let banner: HTMLElement | null = null;

  const sim = () => ctx?.session.sim ?? null;
  const frame = (): LiveFrame => sim()?.frame ?? emptyFrame();

  function event(icon: string, label: string, status?: TimelineStep['status']) {
    const t = storeRef?.get().simSeconds ?? 0;
    events.push({ id: `ev:${events.length}`, icon, label: `${label} · ${t.toFixed(1)} s`, status });
    if (events.length > 60) events.splice(0, events.length - 60);
    if (ctx?.store.get().step === 'product') {
      ctx.shell.timeline.setSteps(events);
      ctx.shell.timeline.setCurrent(events.length - 1);
    }
  }

  function onSerial(text: string) {
    // 按整行处理：串口文本可能在一行中间被切成两次 tick
    const lines = (tail + text).split('\n');
    tail = lines.pop() ?? '';
    for (const raw of lines) {
      const l = raw.trim();
      if (l === 'ALARM ON') {
        alarm = true;
        event('!', '报警：≥ 30 ℃，蜂鸣器响', 'bad');
      } else if (l === 'ALARM OFF') {
        alarm = false;
        event('✓', '报警解除', 'ok');
      } else if (l === 'UNIT F' || l === 'UNIT C') {
        unitF = l === 'UNIT F';
        event('°', `OLED 换成 ${unitF ? '℉' : '℃'}`);
      }
    }
  }

  // ------------------------------------------------------------ 热：一阶滞后逼近目标温度
  function tickHeat() {
    const c = ctx;
    if (!c) return;
    const target = room + (heat.on ? HEAT_MAX * heat.prox : 0);
    const next = air + (target - air) * (1 - Math.exp(-0.1 / TAU));
    if (Math.abs(next - air) > 0.001) air = Math.abs(next - target) < 0.02 ? target : next;
    if (Math.abs(air - (c.session.sim?.env.temp ?? air)) >= 0.05) c.session.setEnv({ temp: Math.round(air * 100) / 100 });
  }

  // ------------------------------------------------------------ 面板
  /** 成品用的装配：真正装完的用自己的，没装完用参考装配 */
  function assembly(): AssemblyState | null {
    const c = ctx;
    if (!c) return null;
    const T = TEMPLATES[c.work.id];
    return preview && T ? referenceAssembly(T) : c.store.get().assembly;
  }

  function renderTree() {
    const c = ctx!;
    const a = assembly();
    const T = TEMPLATES[c.work.id];
    const works = WORK_LIST.map((w) => `<a class="tn ${w.id === c.work.id ? 'on' : ''}" href="./app.html?work=${w.id}#product" role="treeitem" aria-selected="${w.id === c.work.id}"><span class="tn-l">${esc(w.title)}</span>${w.id === c.work.id ? '<span class="tn-m">当前</span>' : ''}</a>`).join('');
    const parts = (PARTS[c.work.id] ?? []).map((p) => `<button type="button" class="tn ${sel === p.id ? 'on' : ''}" data-id="${p.id}" role="treeitem"><span class="tn-l">${esc(p.name)}</span></button>`).join('');
    const how = T && a
      ? T.parts.filter((p) => p.spots).map((p) => {
          const s = p.spots!.find((x) => x.key === a.choice[p.id]);
          return `<div class="tn static"><span class="tn-l">${esc(p.short)}：${esc(s?.label.replace(/^放/, '') ?? '—')}</span><span class="tn-st ${s?.ok ? 'ok' : 'warn'}">${s?.ok ? '✓' : '!'}</span></div>`;
        }).join('') + (preview ? '' : `<div class="tn static"><span class="tn-l">开机复测</span><span class="tn-st ${a.retest === null ? 'muted' : a.retest ? 'ok' : 'bad'}">${a.retest === null ? '没测' : a.retest ? '✓' : '✗'}</span></div>`)
      : '';
    c.shell.tree.innerHTML = `<div role="tree" aria-label="成品">
<details class="tg" open><summary><span>作品</span><span class="tn-m">换作品会重新加载</span></summary><div role="group">${works}</div></details>
<details class="tg" open><summary><span>成品</span><span class="tn-m"></span></summary><div role="group">${parts}</div></details>
${how ? `<details class="tg" open><summary><span>${preview ? '参考装法' : '装法'}</span><span class="tn-m">${preview ? '默认正确装法' : '来自组装'}</span></summary><div role="group">${how}</div></details>` : ''}
</div>`;
    c.shell.tree.querySelectorAll<HTMLButtonElement>('button.tn[data-id]').forEach((b) => (b.onclick = () => {
      sel = sel === b.dataset.id ? '' : b.dataset.id!;
      renderTree();
      renderProps();
    }));
  }

  function renderProps() {
    const c = ctx!;
    const w = c.work.id;
    const weather = w === 'weather';
    const p = (PARTS[w] ?? []).find((x) => x.id === sel);
    const off = assembly()?.effects.sensorOffset ?? 0;
    const first = (FIRST3[w] ?? []).map(([t, d]) => `<li><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join('');
    const cannot = (CANNOT[w] ?? []).map(([t, d]) => `<div class="res na"><span class="mk">×</span><span><b>${esc(t)}</b> · ${esc(d)}</span></div>`).join('');
    c.shell.props.innerHTML = `${preview ? `${sec('参考成品')}<p class="note">${esc(previewWhy())}。这里按默认正确装法、跑实验台上现在的固件；你自己装完以后，这里换成你的装法。</p>` : ''}${p ? `${sec('选中')}<div class="ph">${esc(p.name)}</div><p class="note">${esc(p.about)}</p>` : ''}
${sec('成品 · 同一份固件，模拟没有重启')}
${row('运行', 'run')}
${weather ? `${row('气象站周围', 'air')}${row('BME280 读到', 'rt')}${row('OLED 单位', 'unit')}${row('表盘指针', 'needle')}${row('板载 RGB', 'rgb')}${row('蜂鸣器', 'buzz')}${row('热源', 'heat')}` : row('舵机', 'servo')}
${off ? `<p class="note bad">装法：BME280 贴着芯片，读数比周围高 ${off.toFixed(1)} ℃（估算）。回「组装」改放通风口旁。</p>` : ''}
<div class="btns">${c.session.audio.hasBuzzer ? `<button type="button" class="btn" id="pSound" aria-pressed="false">声音：关</button>` : ''}${weather ? `<button type="button" class="btn" id="pHeat">热源：关</button>` : ''}<button type="button" class="btn" id="pBoot">按住 BOOT</button></div>
${sec('串口 · 最近几行')}<pre class="brief serial-tail" data-live="serial"></pre>
${sec('真机到手先做这三件事')}<ol class="first3">${first}</ol>
${sec('不能模拟的项 · 必须上真机')}${cannot}`;
    const snd = c.shell.props.querySelector<HTMLButtonElement>('#pSound');
    if (snd) snd.onclick = () => toggleSound();
    const ht = c.shell.props.querySelector<HTMLButtonElement>('#pHeat');
    if (ht) ht.onclick = () => toggleHeat();
    const boot = c.shell.props.querySelector<HTMLButtonElement>('#pBoot')!;
    boot.onpointerdown = () => pressBoot(true);
    boot.onpointerup = boot.onpointerleave = () => pressBoot(false);
    updateLive();
  }

  let bootDown = false;
  function pressBoot(down: boolean) {
    if (!ctx || down === bootDown) return;
    bootDown = down;
    ctx.session.pressBoot(down);
    if (down) event('●', '按 BOOT');
  }
  function toggleSound() {
    const a = ctx!.session.audio;
    // 点击就是用户手势：AudioContext 在这一刻创建 / 恢复
    void a.setMuted(!a.state.muted).then(() => {
      event('♪', a.state.muted ? '声音关' : '声音开');
      syncToolbar();
      updateLive();
    });
  }
  function toggleHeat() {
    if (!scene3d) return;
    scene3d.setHeat(!scene3d.heatOn);
  }

  function updateLive() {
    const c = ctx;
    if (!c) return;
    const el = c.shell.props;
    const set = (k: string, v: string, bad = false) => {
      const n = el.querySelector<HTMLElement>(`[data-live="${k}"]`);
      if (n) {
        n.textContent = v;
        n.classList.toggle('bad', bad);
      }
    };
    const s = c.store.get();
    const f = frame();
    set('run', s.run ? `#${s.run} · ${s.simSeconds.toFixed(1)} s` : '未上电');
    set('air', `${air.toFixed(1)} ℃${heat.on ? '（热源加热中）' : ''}`);
    set('rt', s.reading ? `${s.reading.t.toFixed(2)} ℃` : '等固件打印…', !!s.reading && s.reading.t >= 30);
    set('unit', unitF ? '℉' : '℃');
    const a = servoAngle(f.pwm, 4);
    set('needle', a === null ? '没有 PWM' : `${a.toFixed(1)}° ≈ ${((a / 180) * 40).toFixed(1)} ℃`);
    const css = ledCss(f.running ? f.rgb : null);
    const rgb = el.querySelector<HTMLElement>('[data-live="rgb"]');
    if (rgb) rgb.innerHTML = css && f.rgb ? `<i class="sw" style="background:${css}"></i>#${f.rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}` : '灭';
    const au = c.session.audio.state;
    set('buzz', `${au.sounding ? `响 ${au.lastFreq} Hz` : alarm ? '报警中（间歇）' : '不响'} · ${au.muted ? '静音' : '出声'}`, alarm);
    set('heat', heat.on ? `开 · 离通风口 ${(heat.prox * 100).toFixed(0)}%` : '关');
    set('servo', a === null ? '没有 PWM' : `${a.toFixed(1)}°`);
    const snd = el.querySelector<HTMLButtonElement>('#pSound');
    if (snd) {
      snd.textContent = au.muted ? '声音：关' : '声音：开';
      snd.setAttribute('aria-pressed', String(!au.muted));
    }
    const ht = el.querySelector<HTMLButtonElement>('#pHeat');
    if (ht) ht.textContent = heat.on ? '热源：开' : '热源：关';
    const pre = el.querySelector<HTMLElement>('[data-live="serial"]');
    if (pre) {
      const lines = c.session.consoleText().split('\n').filter((l) => l.trim());
      pre.textContent = lines.slice(-6).join('\n');
    }
  }

  function syncToolbar() {
    const c = ctx!;
    const weather = c.work.id === 'weather';
    c.shell.toolbar.setGroups([
      ...(weather ? [{ id: 'nav', tools: [{ id: 'p-orbit', label: '旋转', key: '拖动' }, { id: 'p-home', label: '复位视角' }] }] : []),
      { id: 'act', tools: [{ id: 'p-boot', label: '按键' }, ...(weather ? [{ id: 'p-heat', label: heat.on ? '热源：开' : '热源' }] : [])] },
      ...(c.session.audio.hasBuzzer ? [{ id: 'snd', tools: [{ id: 'p-sound', label: c.session.audio.state.muted ? '声音：关' : '声音：开' }] }] : []),
      { id: 'run', tools: [{ id: 'p-rerun', label: '再跑一次', primary: true }] },
    ]);
    c.shell.toolbar.setActive(heat.on ? 'p-heat' : 'p-orbit');
  }

  function previewWhy() {
    const c = ctx!;
    const n = c.work.checkpoints.length;
    const d = passedCount(c);
    if (d < n) return `你还没装配：实验台检查点 ${d}/${n}，全过才能组装`;
    const a = c.store.get().assembly;
    return `你还没装配：组装 ${a?.placed.length ?? 0}/${a?.total ?? TEMPLATES[c.work.id]?.parts.length ?? 0}`;
  }

  /** 预览时下一步引导去完成检查点 / 组装；装完了就是最后一步 */
  function syncNext() {
    const c = ctx!;
    if (!preview) {
      c.shell.setNext('下一步', null, '这是最后一步');
      return;
    }
    const n = c.work.checkpoints.length;
    if (passedCount(c) < n) {
      c.shell.setNext('去完成检查点 →', 'bench', '', () => {
        const s = c.store.get();
        const first = c.work.checkpoints.find((id) => !(s.checks[id]?.ok && s.checks[id].own)) ?? c.work.checkpoints[0];
        if (first) c.store.set({ selection: { kind: 'checkpoint', id: first } });
        location.hash = 'bench';
      });
    } else c.shell.setNext('去组装 →', 'assemble');
  }

  function syncVerdict() {
    const c = ctx!;
    if (preview) {
      c.shell.setVerdict(alarm ? '参考成品 · 报警中' : '参考成品 · 还没装配', alarm ? 'bad' : 'idle');
      c.shell.onVerdict(() => (location.hash = passedCount(c) < c.work.checkpoints.length ? 'bench' : 'assemble'));
      return;
    }
    const a = c.store.get().assembly;
    const off = a?.effects.sensorOffset ?? 0;
    c.shell.setVerdict(alarm ? '报警中 ≥ 30 ℃' : off ? '读数偏高（装法）' : a?.retest ? '复测 ✓ · 成品' : '成品', alarm || off ? 'bad' : a?.retest ? 'ok' : 'idle');
    c.shell.onVerdict(() => (location.hash = 'assemble'));
  }

  function onTool(id: string) {
    const c = ctx;
    if (!c || c.store.get().step !== 'product') return;
    if (id === 'p-sound') toggleSound();
    else if (id === 'p-heat') toggleHeat();
    else if (id === 'p-home') scene3d?.resetView();
    else if (id === 'p-rerun') c.session.reboot();
    else if (id === 'p-boot') {
      pressBoot(true);
      setTimeout(() => pressBoot(false), 150);
    }
  }

  function build(c: StepCtx) {
    node = document.createElement('div');
    node.className = 'prod-stage';
    if (c.work.id === 'weather') {
      scene3d = createProduct3D(node, {
        frame,
        servoPin: 4,
        sounding: () => c.session.audio.state.sounding,
        onBoot: (d) => pressBoot(d),
        onHeat: (on, prox) => {
          const was = heat.on;
          heat = { on, prox };
          if (was !== on) {
            event(on ? '≈' : '○', on ? '热源打开，放到通风口旁' : '热源关掉');
            syncToolbar();
          }
        },
      });
      (window as unknown as { __tbProduct: unknown }).__tbProduct = {
        buttonPos: () => scene3d!.buttonScreenPos(),
        azimuth: () => scene3d!.azimuth(),
        needle: () => scene3d!.needle(),
        heat: () => ({ ...heat, air }),
        unit: () => (unitF ? 'F' : 'C'),
        alarm: () => alarm,
      };
    } else {
      const box = document.createElement('div');
      box.className = 'prod-svg';
      node.appendChild(box);
      const h = { boot: (d: boolean) => pressBoot(d), temp: () => {} };
      svgProduct = c.work.id === 'spin' ? createSpinProduct(box, h, { servoPin: 4 }) : createLensProduct(box, h);
      const note = document.createElement('div');
      note.className = 'p3-disclaimer';
      note.textContent = '外观示意（2D，3D 成品待做）';
      node.appendChild(note);
    }
  }

  function loopSvg() {
    raf = requestAnimationFrame(loopSvg);
    const c = ctx;
    if (!c || !svgProduct) return;
    svgProduct.update(frame(), c.store.get().env.temp, assembly()?.effects ?? {});
  }

  return {
    mount(el, c) {
      ctx = c;
      if (!hooked) {
        hooked = true;
        storeRef = c.store;
        c.shell.toolbar.onTool(onTool);
        c.session.onConsole((t) => onSerial(t));
        c.store.subscribe((s, prev) => {
          if (s.run > prev.run) {
            unitF = false;
            alarm = false;
            event('▶', `上电 · 运行 #${s.run}`);
          }
        }, ['run']);
      }
      if (!TEMPLATES[c.work.id]) {
        el.innerHTML = `<div class="pnl lockcard" role="status"><div class="sec">④ 成品</div><p class="ph-t">空白实验台没有成品</p><div class="btns"><a class="btn primary" href="./app.html?work=weather#product">看气象站成品</a></div></div>`;
        c.shell.tree.innerHTML = '<div class="tree-empty">没有成品</div>';
        c.shell.props.innerHTML = '';
        c.shell.toolbar.setGroups([]);
        c.shell.timeline.setSteps([]);
        return;
      }
      const own = c.store.get().assembly;
      // 没装完不锁整页：先看参考成品（参考装配 + 实验台现在的固件），顶部标明，下一步引导去完成检查点 / 组装
      preview = !own || own.placed.length < own.total;
      const a = assembly()!;
      if (!node) build(c);
      el.appendChild(node!);
      banner = null;
      if (preview) {
        banner = document.createElement('div');
        banner.className = 'prod-preview';
        banner.setAttribute('role', 'status');
        banner.innerHTML = `<b>参考成品 · 你还没装配</b><span>${esc(previewWhy().replace(/^你还没装配：/, ''))} · 按默认正确装法展示</span>`;
        el.insertBefore(banner, node);
      }
      // 装法的温漂只在成品里生效
      c.session.setSensorOffset(a?.effects.sensorOffset ?? 0);
      room = c.store.get().env.temp;
      air = room;
      if (!events.length && c.store.get().run) event('▶', `${preview ? '参考成品 · ' : ''}开机 · 运行 #${c.store.get().run}${a.effects.sensorOffset ? `，传感器 +${a.effects.sensorOffset} ℃` : ''}`);
      scene3d?.start();
      if (svgProduct) loopSvg();
      timer = window.setInterval(() => {
        tickHeat();
        updateLive();
        syncVerdict();
      }, 100);
      syncNext();
      renderTree();
      renderProps();
      syncToolbar();
      syncVerdict();
      c.shell.timeline.setSteps(events);
      c.shell.timeline.setCurrent(events.length - 1);
      unsubs = [c.store.subscribe(() => renderTree(), ['assembly']), c.store.subscribe(() => preview && (syncNext(), renderProps()), ['checks'])];
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      clearInterval(timer);
      cancelAnimationFrame(raf);
      raf = 0;
      scene3d?.stop();
      if (ctx) {
        // 离开成品：撤掉温漂和热源，回到室温
        if (heat.on) scene3d?.setHeat(false);
        heat = { on: false, prox: 0 };
        ctx.session.setSensorOffset(0);
        if (Math.abs(air - room) > 0.01) ctx.session.setEnv({ temp: room });
        air = room;
      }
      ctx = null;
    },
  };
}
