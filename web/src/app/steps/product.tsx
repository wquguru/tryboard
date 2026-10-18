// ④ 成品：气象站是 three.js 3D 成品（product3d.ts），小黄 / 透镜小人是 lcd3d.ts（P1-10）；WebGL 不可用时退回 lcdproducts.ts 的 SVG 成品。
// 用的是整页共享的那个实时模拟，不重启：进来时把装法的温漂加到传感器上，离开时撤掉。
// 热源改的是"气象站周围的温度"（env），一阶滞后逼近目标，模拟壳子有热惯性；读数、表盘、灯、报警全来自固件。
import { createProduct3D, type ProductScene } from '../product3d';
import { createLcd3D, webglOk, type Lcd3D } from '../lcd3d';
import { createTilt3D, type Tilt3D } from '../tilt3d';
import { createWork3D, type WorkKind, type WorkProduct3D } from '../works3d';
import { gravity } from '../../imupose';
import { createLensProduct, createSpinProduct } from '../../views/lcdproducts';
import { TEMPLATES, type Template } from '../../views/templates';
import { passedCount } from './bench';
import { emptyFrame, ledCss, servoAngle, type LiveFrame } from '../../views/common';
import type { AssemblyState, StepCtx, StepImpl } from '../types';
import type { TimelineStep } from '../timeline';
import { createKeypad3D, type Keypad3D } from '../keypad3d';
import { createKeypadView, KEYPAD_CAPS, KEYPAD_PINS } from '../../views/keypad';
import { isPhone, onPhoneChange, setMui } from '../mobile';
import type { Tool, ToolGroup } from '../toolbar';
import { HOME_WORKS } from '../works';
import { RECORD_SECONDS, recordCanvas, takePhoto, type Capturable, type Recording } from '../capture';
import { i2cLoad, i2cText, wifiText } from '../harness';
import { I2C_DEVICES } from './assemble';
import { setBc } from '../chrome';

import { Host, Txt } from '../../ui/native';
import { Brief, Btn, Btns, Kv, LinkBtn, LockCard, Note, Ph, PhT, Res, Sec, TnL, TnM, TnSt, TreeEmpty, TreeGroup, TreeNode, TreeRow, btnClass, tnClass, type ResKind } from '../../ui/panel';

/** 一行实时字段：初值"—"，之后由 updateLive 按 data-live 改 */
const row = (k: string, live: string) => <Kv key={live} k={k} live={live} v="—" />;
/** 成品顶部的说明条（参考成品 / 倾角仪） */
const Banner = ({ t, s }: { t: string; s: string }) => (
  <div className="prod-preview" role="status">
    <b>{t}</b>
    <span>{s}</span>
  </div>
);
/** 彩灯色块（实时字段里由命令式代码拼） */
function swatch(bg: string) {
  const i = document.createElement('i');
  i.className = 'sw mr-1.5 inline-block size-2.5 rounded-[3px] border border-[#0002] align-[-1px]';
  i.style.background = bg;
  return i;
}

/** 热源最多把通风口附近加热多少（℃）和壳子的热时间常数（s）：示意数值，未经真机标定 */
const HEAT_MAX = 14;
const TAU = 3;

/** P0-18：真机到手先做这三件事（按作品） */
const FIRST3: Record<string, [string, string][]> = {
  weather: [
    ['认板子和彩灯引脚', 'ESP32-S3-DevKitC-1 的板载 RGB 在 v1.0 是 GPIO48、v1.1 改到 GPIO38；先烧 blink 看灯亮不亮，不亮就改固件里的引脚。'],
    ['I2C 扫描 + 芯片 ID', '串口「I2C scan」一行应有 0x3C 和 0x76。BME280 的 SDO 接高是 0x77；芯片 ID 应为 0x60，0x58 是 BMP280（没有湿度）。'],
    ['装壳前后各标定一次温度', '旁边放一支温度计，各等 10 分钟对比；差值写进固件当偏移。舵机先单独转到 1.5 ms 中位，再装指针。'],
  ],
  spin: [
    ['认板子和圆屏接线', '对照 SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15，有的圆屏模组没有 BL 脚（背光常亮）。'],
    ['舵机先单独供电试转', '只靠 USB 时舵机一转板子可能复位：舵机接外接 5 V，地和开发板共地。先回 90° 中位再装舵盘。'],
    ['看圆屏颜色对不对', '颜色反了是没开反色（INVON），红蓝对调是 RGB / BGR 顺序配错；这两样模拟器里也能看到，真屏以实物为准。'],
  ],
  usbkey: [
    ['插对口、用数据线', 'ESP32-S3-DevKitC-1 有两个 Type-C：标 USB（或 OTG）的才是原生 USB，标 UART 的只是串口。有的线只能充电，没有数据线芯，电脑上什么都不出现。'],
    ['先只烧枚举那一步', '电脑上应出现一个叫 TryBoard Macro Pad 的键盘（Windows 设备管理器 / macOS 系统信息 USB）。出不来先看 sdkconfig 里 TinyUSB 有没有开、HID 数量 ≥ 1。'],
    ['按键先看串口再看电脑', '每按一次串口应有 KEY 1 a；串口有、电脑上没字，多半是报告描述符不对，或按下 / 松开报告之间等得太短。'],
  ],
  lens: [
    ['认板子和圆屏接线', '对照 SCLK 12 · MOSI 11 · CS 10 · DC 14 · RST 13 · BL 15，有的圆屏模组没有 BL 脚。'],
    ['看圆屏颜色对不对', '颜色反了是没开反色（INVON），红蓝对调是 RGB / BGR 顺序配错。'],
    ['实测透镜高度', '透镜离屏 8 mm 左右放大约 1.35×（估算）；真透镜焦距不同，拿尺子量一下再定卡槽。'],
  ],
  lamp: [
    ['先只接灯带、不接旋钮', '先烧检查点「灯带点亮」的固件，8 颗都亮成暖白再往下走；颜色对调（红绿互换）是 GRB 顺序写错了。'],
    ['灯带单独供电、共地', '灯带 5 V 接外接电源，地一定要和开发板连在一起；不共地时数据线没有参考，灯会乱闪。'],
    ['旋钮方向和手感', '顺时针变亮才顺手；反了就把 CLK / DT 两根线对调。真 EC11 有机械抖动，PCNT 的 glitch 滤波别关。'],
  ],
  ruler: [
    ['先量分压', 'Echo 经 1 kΩ / 2 kΩ 后用万用表量，最高约 3.3 V；没分压直接进 GPIO 会伤芯片。'],
    ['拿卷尺对一遍', '对着墙在 10 / 50 / 100 cm 各量一次；声速随温度变（20 ℃ 约 343 m/s），差 1–2 % 是正常的。'],
    ['探头要露出外壳', '探头缩在孔里时读数会变成几厘米、蜂鸣器一直响；装壳后再对着远处的墙试一次。'],
  ],
  tilt: [
    ['先读姿态再画', '先烧检查点「读姿态」的固件，平放时俯仰、横滚都接近 0；WHO_AM_I 不是 0x05 先查地址（SA0 接地是 0x6A）。'],
    ['认方向', '把右边放低，横滚应该变正；不对就是模块转了方向，要么转回来，要么在固件里给符号取反。'],
    ['看圆屏颜色对不对', '颜色反了是没开反色（INVON），红蓝对调是 RGB / BGR 顺序配错。'],
  ],
};

/** 不能模拟的项：网页给不出、只能上真机看 */
const CANNOT: Record<string, [string, string][]> = {
  weather: [
    ['OLED 亮度、可视角度', '这里只算哪些像素亮，不算亮度和视角'],
    ['蜂鸣器音色和音量', '这里是方波示意，真蜂鸣器有谐振峰，音量取决于驱动方式'],
    ['舵机力矩、抖动和噪声', '指针的惯性是示意，真 SG90 会抖、有回差'],
    ['壳内真实温升', `「贴着芯片偏高 2.5 ℃」是估算，要拿温度计实测`],
    ['RGB 实际亮度和导光效果', '画面亮度做了放大，真灯会暗得多'],
  ],
  spin: [
    ['舵机力矩带不带得动', '身体重心、舵盘螺丝松紧都影响，网页里不算力'],
    ['圆屏亮度、可视角度', '这里只算像素颜色，不算亮度和视角'],
    ['转台噪声和抖动', 'SG90 停住时会微抖，真机才听得到'],
  ],
  usbkey: [
    ['不同电脑 / 系统的兼容性', '虚拟主机按 USB 规范走一遍枚举；真电脑的驱动、BIOS 里能不能用、键盘布局（非美式）只能实测'],
    ['按键手感和抖动', '这里按下就是干净的低电平，真开关有几毫秒抖动，消抖要真机试'],
    ['USB 线和接口质量', '线长、接触不良、只能充电的线，网页里都看不到'],
  ],
  lens: [
    ['透镜实际放大与畸变', '放大倍数是按卡槽高度估算的'],
    ['圆屏亮度、可视角度', '这里只算像素颜色，不算亮度和视角'],
  ],
  lamp: [
    ['灯的真实亮度和色温', '这里按固件写的 0–255 画发光强度，不是光度学计算；灯罩的散光效果是示意'],
    ['EC11 的手感与抖动', '模拟器里旋钮是干净的正交波形，真机触点会抖'],
    ['电源压降', '满白 480 mA 是估算，长灯带的线损和压降没算'],
  ],
  ruler: [
    ['斜面、软物体、窄物体的回波', '这里障碍物是正对探头的平面，真机遇到斜面或布料可能测不到'],
    ['温度对声速的影响', '固件按 343 m/s 算，模拟器也按 343 m/s 出回波'],
    ['蜂鸣器音色和音量', '这里是方波示意'],
  ],
  tilt: [
    ['六轴的零偏、噪声和温漂', '模拟器的读数就是设定的姿态，没有噪声'],
    ['手持时的晃动', '这里的姿态是你拖出来的，真机手一抖小豆也会跟着动'],
    ['圆屏亮度、可视角度', '这里只算像素颜色，不算亮度和视角'],
  ],
};

const PARTS: Record<string, { id: string; name: string; about: string }[]> = {
  weather: [
    { id: 'shell', name: '外壳 70×50×32 mm', about: '3D 打印外壳（估算尺寸）。前面板最后合上；右侧是通风口，BME280 应该装在它旁边。' },
    { id: 'dial', name: '表盘指针 · SG90', about: 'GPIO4，50 Hz，脉宽 0.5–2.5 ms 对应 0–40 ℃。指针角度直接来自固件输出的 PWM，惯性是示意。' },
    { id: 'oled', name: 'OLED 0.96″', about: 'SSD1306（I2C 0x3C）。画面就是固件画出来的：大字温度，下面是湿度和气压。' },
    { id: 'rgb', name: '板载 RGB · 导光柱', about: 'WS2812（GPIO48）：低于 18 ℃ 蓝，低于 28 ℃ 绿，否则红。' },
    { id: 'buzzer', name: '无源蜂鸣器', about: 'GPIO5，≥ 30 ℃ 报警 2.7 kHz，响 200 ms 停 200 ms；降到 29 ℃ 以下停。默认静音。' },
    { id: 'boot', name: 'BOOT 键', about: 'GPIO0，按下接地：切换 OLED 上的 ℃/℉（串口和表盘始终是摄氏度）。' },
    { id: 'bme', name: 'BME280', about: '温度 / 湿度 / 气压，I2C 0x76。装在哪决定它读到的是不是室温。' },
  ],
  spin: [
    { id: 'body', name: '小黄身体', about: '黄色胶囊身体、头顶一缕卷发、正面一块深色屏幕眼罩（圆屏就在里面）、工具腰带。站在 SG90 转台上。' },
    { id: 'servo', name: 'SG90 转台', about: 'GPIO4 PWM，±60° 来回转身。' },
    { id: 'lcd', name: '圆屏 GC9A01', about: 'SPI2，画面就是固件画出来的。' },
    { id: 'boot', name: 'BOOT 键', about: '按一下转回正面，再按一下接着转。' },
  ],
  usbkey: [
    { id: 'pad', name: 'USB 小键盘', about: '外壳 80×44×22 mm（估算），一排四个键：K1–K3 发 a / b / c，K4 宏键打出 Hello TryBoard 再换行。' },
    { id: 'keys', name: '按键 K1–K4', about: 'GPIO4 / 5 / 6 / 7，另一端接地，内部上拉。点 3D 里的键帽就是按下，引脚拉低。' },
    { id: 'pc', name: '虚拟电脑', about: 'USB 虚拟主机：真的按 USB 规范枚举（取描述符、设地址、读报告描述符），屏幕上是它收到的 HID 报告还原出的字。' },
  ],
  lens: [
    { id: 'lcd', name: '圆屏 GC9A01', about: 'SPI2，画面就是固件画出来的。' },
    { id: 'dome', name: '凸透镜罩', about: 'Ø40 mm 平凸透镜，离屏高度决定放大倍数（估算）。3D 里的折射是示意，不是光学仿真。' },
    { id: 'boot', name: 'BOOT 键', about: '换表情。' },
  ],
  lamp: [
    { id: 'strip', name: 'WS2812 × 8 · 导光柱', about: 'DIN 接 GPIO5（RMT）。每颗灯的颜色就是模拟器从引脚波形里解码出来的那一帧。' },
    { id: 'knob', name: 'EC11 旋钮', about: 'CLK GPIO6 · DT GPIO7 · SW GPIO15，PCNT 4 倍频。拖动或滚轮转，点一下就是按下，在调亮度和调颜色之间切换。' },
    { id: 'shade', name: '乳白灯罩', about: '3D 打印乳白 PLA。灯带贴着灯罩壁时罩上会有一排亮点（装法影响，估算）。' },
  ],
  ruler: [
    { id: 'sonar', name: 'HC-SR04 探头', about: 'Trig GPIO17 · Echo 经分压接 GPIO18。模拟器按挡板距离出回波宽度（343 m/s）。' },
    { id: 'oled', name: 'OLED 0.96″', about: 'SSD1306（0x3C）：大字显示距离，下面一条距离条。' },
    { id: 'buzzer', name: '无源蜂鸣器', about: 'GPIO5，2.7 kHz：1 m 以内每次响 40 ms，间隔是距离（cm）× 5 ms；10 cm 以内一直响。默认静音。' },
    { id: 'board', name: '木挡板', about: '拖着它在桌上前后挪：距离从探头正面量起，桌上的卷尺 0 刻度对准探头。' },
  ],
  tilt: [
    { id: 'disc', name: '圆盘外壳', about: '拖动它倾斜：往右拖右边放低（横滚 +），往下拖前边放低（俯仰 +）。' },
    { id: 'imu', name: 'QMI8658 六轴', about: 'I2C 0x6B。模拟器按圆盘姿态算重力分量；装反时俯仰、横滚方向全反（装法影响）。' },
    { id: 'lcd', name: '圆屏 GC9A01', about: 'SPI2，小豆就画在这块屏上，画面就是固件画出来的。' },
  ],
};

/** 这几个作品的成品是 works3d.ts（P2-09） */
const WORK3D = new Set(['lamp', 'ruler', 'tilt']);
const COLOR_LABEL: Record<string, string> = { warm: '暖白', red: '红', green: '绿', blue: '蓝', purple: '紫', white: '白' };

/** lens 固件串口里的表情名 */
const MOOD_LABEL: Record<string, string> = { normal: '平常', happy: '开心', love: '喜欢', sleepy: '困了' };

/** 成品步骤里能切的作品：跟着作品定义走（works.ts），加作品自动出现 */
const WORK_LIST = HOME_WORKS.map((w) => ({ id: w.id, title: w.title }));

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
  let lcd3d: Lcd3D | null = null;
  let keypad: Keypad3D | null = null;
  let keypadSvg: ReturnType<typeof createKeypadView> | null = null;
  /** 正在录的 10 秒 */
  let rec: Recording | null = null;
  // 倾角仪（P2-03）：没有组装模板，成品就是端在手里转的盒子
  let tilt: Tilt3D | null = null;
  let tiltNode: HTMLElement | null = null;
  let tiltTimer = 0;
  let svgProduct: { update(f: LiveFrame, room: number, fx: object): void } | null = null;
  let work3d: WorkProduct3D | null = null;
  // P2-09：台灯的亮度 / 模式 / 颜色、尺子的读数与蜂鸣节奏、小豆的位置（从串口整行解析）
  let lamp = { level: 0, mode: '', color: '' };
  let ruler = { dist: '', beep: '' };
  let bean = { pos: '', edges: 0 };
  /** 用户摆出来的距离 / 姿态（装法影响之前）；离开成品时还原 */
  let rawCm = 25;
  let rawPose = { pitch: 0, roll: 0, yaw: 0 };
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
  /** lens 的表情、spin 是不是停在正面（从串口整行解析） */
  let mood = '';
  let look = '';
  let alarm = false;
  let tail = '';
  /** 还没装配完：用参考装配展示（"先看参考成品"），顶部标明 */
  let preview = false;

  const sim = () => ctx?.session.sim ?? null;
  const frame = (): LiveFrame => sim()?.frame ?? emptyFrame();
  /** 屏幕（OLED / 圆屏）收到过不全黑的一帧：回归脚本用它判断"成品屏幕有画面" */
  const lit = () => {
    const f = frame();
    const px = f.oled ?? f.lcd;
    return !!px && px.some((v: number) => v !== 0);
  };

  let event = (icon: string, label: string, status?: TimelineStep['status']) => {
    const t = storeRef?.get().simSeconds ?? 0;
    events.push({ id: `ev:${events.length}`, icon, label: `${label} · ${t.toFixed(1)} s`, status });
    if (events.length > 60) events.splice(0, events.length - 60);
    if (ctx?.store.get().step === 'product') {
      ctx.shell.timeline.setSteps(events);
      ctx.shell.timeline.setCurrent(events.length - 1);
    }
  };

  /** 进成品之前的串口（本次上电以来）：只更新状态，不往事件时间线里记 */
  let quiet = false;
  function onSerial(text: string) {
    // 按整行处理：串口文本可能在一行中间被切成两次 tick
    const lines = (tail + text).split('\n');
    tail = lines.pop() ?? '';
    const ev = event;
    if (quiet) event = () => {};
    try {
      parseLines(lines);
    } finally {
      event = ev;
    }
  }
  function parseLines(lines: string[]) {
    for (const raw of lines) {
      const l = raw.trim();
      if (l === 'ALARM ON') {
        alarm = true;
        event('!', '报警：≥ 30 ℃，蜂鸣器响', 'bad');
      } else if (l === 'ALARM OFF') {
        alarm = false;
        event('✓', '报警解除', 'ok');
      } else if (/^MOOD \d+ \w+$/.test(l)) {
        mood = l.split(' ')[2];
        event('☺', `换表情：${MOOD_LABEL[mood] ?? mood}`);
      } else if (l === 'LOOK FRONT' || l === 'LOOK AROUND') {
        look = l === 'LOOK FRONT' ? 'front' : 'around';
        event('↻', look === 'front' ? '转回正面，停住' : '继续左右转身');
      } else if (/^LEVEL \d+$/.test(l)) {
        lamp.level = Number(l.slice(6));
      } else if (l === 'MODE color' || l === 'MODE level') {
        lamp.mode = l.slice(5);
        event('◎', lamp.mode === 'color' ? '旋钮切到调颜色' : '旋钮切到调亮度');
      } else if (/^COLOR \d+ \w+$/.test(l)) {
        lamp.color = l.split(' ')[2];
      } else if (/^DIST /.test(l)) {
        ruler.dist = l.slice(5);
      } else if (/^BEEP /.test(l)) {
        const b = l.slice(5);
        if (b !== ruler.beep) event(b === 'off' ? '○' : '♪', b === 'off' ? '蜂鸣器停' : b === 'on' ? '太近了：蜂鸣器一直响' : `蜂鸣节奏：停 ${b.replace('gap=', '')}`, b === 'on' ? 'bad' : undefined);
        ruler.beep = b;
      } else if (/^EDGE /.test(l)) {
        bean.edges++;
        event('◉', `小豆滑到边上（${l.slice(5)}）`);
      } else if (/^POS /.test(l)) {
        bean.pos = l.slice(4).replace(/ pitch=.*$/, '');
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
    const pickPart = (id: string) => {
      sel = sel === id ? '' : id;
      renderTree();
      renderProps();
    };
    const how =
      T && a ? (
        <TreeGroup title={preview ? '参考装法' : '装法'} count={preview ? '默认正确装法' : '来自组装'} open>
          {T.parts
            .filter((p) => p.spots)
            .map((p) => {
              const s = p.spots!.find((x) => x.key === a.choice[p.id]);
              return <TreeRow key={p.id} label={`${p.short}：${s?.label.replace(/^放/, '') ?? '—'}`} st={<TnSt kind={s?.ok ? 'ok' : 'warn'}>{s?.ok ? '✓' : '!'}</TnSt>} />;
            })}
          {!preview && <TreeRow label="开机复测" st={<TnSt kind={a.retest === null ? 'muted' : a.retest ? 'ok' : 'bad'}>{a.retest === null ? '没测' : a.retest ? '✓' : '✗'}</TnSt>} />}
        </TreeGroup>
      ) : null;
    c.shell.tree.render(
      <div role="group" aria-label="成品">
        <TreeGroup title="作品" count="换作品会重新加载" open>
          {WORK_LIST.map((w) => (
            <a key={w.id} className={tnClass(w.id === c.work.id)} href={`./app.html?work=${w.id}#product`} role="treeitem" aria-selected={w.id === c.work.id}>
              <TnL>{w.title}</TnL>
              {w.id === c.work.id && <TnM>当前</TnM>}
            </a>
          ))}
        </TreeGroup>
        <TreeGroup title="成品" count="" open>
          {(PARTS[c.work.id] ?? []).map((p) => (
            <TreeNode key={p.id} on={sel === p.id} data-id={p.id} label={p.name} onClick={() => pickPart(p.id)} />
          ))}
        </TreeGroup>
        {how}
      </div>,
    );
  }

  function renderProps() {
    const c = ctx!;
    const w = c.work.id;
    const weather = w === 'weather';
    const p = (PARTS[w] ?? []).find((x) => x.id === sel);
    const off = assembly()?.effects.sensorOffset ?? 0;
    const rows = weather
      ? [row('气象站周围', 'air'), row('BME280 读到', 'rt'), row('OLED 单位', 'unit'), row('表盘指针', 'needle'), row('板载 RGB', 'rgb'), row('蜂鸣器', 'buzz'), row('热源', 'heat')]
      : w === 'spin'
        ? [row('舵机', 'servo'), row('转台', 'turn'), row('状态', 'look')]
        : w === 'usbkey'
          ? [row('电脑看到', 'usbstate'), row('打出的字', 'typed')]
          : w === 'lens'
            ? [row('表情', 'mood'), row('透镜', 'lens')]
            : w === 'lamp'
              ? [row('灯带', 'strip'), row('亮度 / 颜色', 'lampst'), row('旋钮模式', 'lampmode'), row('旋钮', 'knob')]
              : w === 'ruler'
                ? [row('挡板距离', 'cm'), row('探头量到', 'cmfx'), row('固件读到', 'rdist'), row('蜂鸣器', 'buzz')]
                : [row('圆盘姿态', 'tpose'), row('六轴读到', 'tfx'), row('小豆', 'bean')];
    const b = (id: string, label: string, f: () => void) => (
      <Btn key={id} id={id} onClick={f}>
        {label}
      </Btn>
    );
    const acts =
      w === 'lamp'
        ? [b('pKnobL', '旋钮 −1', () => turnKnob(-1)), b('pKnobR', '旋钮 +1', () => turnKnob(1)), b('pKnobP', '按旋钮', () => onTool('p-knob'))]
        : w === 'ruler'
          ? [b('pNear', '挡板近 10 cm', () => moveBoard(-10)), b('pFar', '挡板远 10 cm', () => moveBoard(10))]
          : w === 'tilt'
            ? [b('pTiltR', '右边放低', () => tiltTo({ pitch: 0, roll: 25, yaw: 0 })), b('pTiltL', '左前放低', () => tiltTo({ pitch: 20, roll: -25, yaw: 0 })), b('pLevel', '放平', () => tiltTo({ pitch: 0, roll: 0, yaw: 0 }))]
            : w === 'usbkey'
              ? []
              : [
                  <Btn key="pBoot" id="pBoot" onPointerDown={() => pressBoot(true)} onPointerUp={() => pressBoot(false)} onPointerLeave={() => pressBoot(false)}>
                    按 BOOT
                  </Btn>,
                ];
    c.shell.props.render(
      <>
        {p && (
          <>
            <Sec>选中</Sec>
            <Ph>{p.name}</Ph>
            <Note>{p.about}</Note>
          </>
        )}
        <Sec>成品 · 和实验台同一份固件</Sec>
        {row('运行', 'run')}
        {rows}
        {off ? <Note bad>装法：BME280 贴着芯片，读数比周围高 {off.toFixed(1)} ℃（估算）。回「组装」改放通风口旁。</Note> : null}
        {fxNote()}
        {assembly()?.effects.usbBlocked && <Note bad>装法：开发板转了 180°，USB 口顶着前墙，线插不进去，电脑看不到设备。回「组装」把 USB 口朝背面开孔。</Note>}
        {harnessPanel()}
        <Btns>
          {c.session.audio.hasSound && <Txt as="button" type="button" className={btnClass()} id="pSound" aria-pressed="false" onClick={() => toggleSound()} text="声音：关" />}
          {weather && <Txt as="button" type="button" className={btnClass()} id="pHeat" onClick={() => toggleHeat()} text="热源：关" />}
          {acts}
        </Btns>
        {cur3d() && (
          <>
            <Sec>拍照 · 录像</Sec>
            <Btns>
              <Btn id="pPhoto" onClick={() => void photo()}>
                拍照
              </Btn>
              <Txt as="button" type="button" className={btnClass()} id="pRec" onClick={() => record()} text={rec ? `录制中 ${rec.elapsed().toFixed(0)} / ${RECORD_SECONDS} s` : `录 ${RECORD_SECONDS} 秒`} />
            </Btns>
            <Note>照片是 2 倍分辨率 PNG；录像是 webm，开着声音会录进蜂鸣器。文件直接下载。</Note>
          </>
        )}
        <Sec>串口 · 最近几行</Sec>
        {/* 串口行多了会出滚动条：可聚焦才能用键盘滚（axe scrollable-region-focusable） */}
        <Brief className="serial-tail" data-live="serial" tabIndex={0} aria-label="串口最近几行" />
        <Sec>真机到手先做这三件事</Sec>
        <ol className="first3">
          {(FIRST3[w] ?? []).map(([t, d]) => (
            <li key={t}>
              <b>{t}</b>
              <span>{d}</span>
            </li>
          ))}
        </ol>
        <Sec>不能模拟的项 · 必须上真机</Sec>
        {(CANNOT[w] ?? []).map(([t, d]) => (
          <Res key={t} kind="na" mk="×">
            <b>{t}</b> · {d}
          </Res>
        ))}
      </>,
    );
    updateLive();
  }

  /** 装法带来的提示（台灯亮点 / 探头被挡 / 六轴装反） */
  function fxNote() {
    const fx = assembly()?.effects ?? {};
    if (fx.glare) return <Note bad>装法：灯带贴着灯罩，罩上一排刺眼亮点（估算）。回「组装」把灯带贴到导光柱上。</Note>;
    if (fx.sonarBlock) return <Note bad>装法：探头缩在外壳孔里，模拟器里的 HC-SR04 只能量到孔壁（约 {fx.sonarBlock} cm），蜂鸣器一直响。回「组装」让探头伸出前面板。</Note>;
    if (fx.hornOffset) return <Note bad>装法：舵盘装偏 {fx.hornOffset.toFixed(1)}°，固件说「正面」，它其实歪着（与旧实验台同一估算）。回「组装」先把舵机转到中位再按舵盘。</Note>;
    if (fx.imuFlip) return <Note bad>装法：六轴装反了，读到的俯仰、横滚方向全反，小豆往高处爬。回「组装」把箭头朝前装。</Note>;
    return null;
  }
  function turnKnob(steps: number) {
    if (!ctx) return;
    ctx.session.turnEncoder(steps);
    knobPos += steps;
  }
  let knobPos = 0;
  /** 尺子：把用户摆的距离（装法之前）送进模拟器；探头被挡时只能量到孔壁 */
  function applyDistance(cm: number) {
    rawCm = cm;
    const b = assembly()?.effects.sonarBlock ?? 0;
    ctx?.session.setDistance(b ? Math.min(cm, b) : cm);
  }
  function moveBoard(d: number) {
    const cm = Math.max(2, Math.min(80, rawCm + d));
    work3d?.setDistance(cm);
    applyDistance(cm);
    event('↔', `挡板挪到 ${cm.toFixed(0)} cm`);
  }
  /** 体感小人：用户摆的姿态 → 六轴看到的姿态（装反时俯仰、横滚反号） */
  function applyPose(p: { pitch: number; roll: number; yaw: number }) {
    rawPose = { ...p };
    const flip = assembly()?.effects.imuFlip;
    ctx?.session.setPose(flip ? { pitch: -p.pitch, roll: -p.roll, yaw: p.yaw } : p);
  }
  function tiltTo(p: { pitch: number; roll: number; yaw: number }) {
    work3d?.setPose(p);
    applyPose(p);
    event('⟋', p.pitch || p.roll ? `倾斜：俯仰 ${p.pitch}°、横滚 ${p.roll}°` : '放平');
  }

  // ------------------------------------------------------------ 线束（P2-11，估算）
  function harnessPanel() {
    const c = ctx!;
    const fx = assembly()?.effects ?? {};
    const n = I2C_DEVICES[c.work.id] ?? 0;
    const mk = (v: string) => (v === 'ok' ? '✓' : v === 'marginal' ? '!' : '✗');
    const l = n && fx.i2cWireCm !== undefined ? i2cLoad(fx.i2cWireCm, n) : null;
    const wf = wifiText(fx.antennaDb ?? 0);
    const wk: ResKind = wf.level === 'ok' ? 'ok' : wf.level === 'marginal' ? 'warn' : 'bad';
    const sim = c.session.harnessText.trim();
    return (
      <>
        <Sec>线束与天线 · 估算，必须上真机</Sec>
        {l && (
          <Res kind={l.verdict === 'ok' ? 'ok' : 'bad'} mk={mk(l.verdict)}>
            I2C 排线 {fx.i2cWireCm} cm：{i2cText(l)}
          </Res>
        )}
        <Res kind={wk} mk={mk(wf.level)}>
          Wi-Fi：天线遮挡 {fx.antennaDb ?? 0} dB，{wf.text}（本固件没用 Wi-Fi，暂不受影响）
        </Res>
        {sim && <Txt as="p" className="note my-2 font-mono text-xs text-muted" data-live="hz" text={sim.replace(/\[tryboard\] /g, '模拟器：')} />}
      </>
    );
  }

  /** 成品用装好的线束（预览按参考装法：理想总线、天线无遮挡） */
  function applyHarness() {
    const c = ctx!;
    const fx = assembly()?.effects ?? {};
    const want = { i2cWire: fx.i2cWireCm ?? -1, antenna: fx.antennaDb ?? 0 };
    const cur = c.session.harness;
    const h: { i2cWire?: number; antenna?: number } = {};
    if ((cur.i2cWire ?? -1) !== want.i2cWire) h.i2cWire = want.i2cWire;
    if ((cur.antenna ?? 0) !== want.antenna) h.antenna = want.antenna;
    if (Object.keys(h).length) c.session.setHarness(h);
  }

  // ------------------------------------------------------------ 拍照 / 录 10 秒（P2-10）
  function cur3d(): { capture(): Capturable } | null {
    return scene3d ?? lcd3d ?? keypad ?? work3d;
  }
  async function photo() {
    const c = ctx;
    const s = cur3d();
    if (!c || !s) return;
    try {
      const r = await takePhoto(s.capture(), c.work.id, c.work.title);
      event('◉', `拍照 ${r.width}×${r.height}`);
      c.shell.toast(`已下载 ${r.name}（${r.width}×${r.height}，${(r.bytes / 1024).toFixed(0)} KB）`);
    } catch (e) {
      c.shell.toast(`拍照失败：${e}`);
    }
  }
  function record() {
    const c = ctx;
    const s = cur3d();
    if (!c || !s) return;
    if (rec) {
      rec.stop();
      return;
    }
    try {
      const audio = c.session.audio.recordStream();
      const r = recordCanvas(s.capture().renderer.domElement, c.work.id, audio);
      rec = r;
      event('●', `开始录像${audio ? '（含声音）' : ''}`);
      syncToolbar();
      renderProps();
      void r.done
        .then((v) => {
          event('■', `录像 ${v.seconds.toFixed(1)} s · ${v.width}×${v.height}`);
          ctx?.shell.toast(`已下载 ${v.name}（${(v.bytes / 1024).toFixed(0)} KB${v.audio ? '，含声音' : ''}）`);
        })
        .catch((e) => ctx?.shell.toast(`录像失败：${e}`))
        .finally(() => {
          if (rec === r) rec = null;
          if (ctx?.store.get().step === 'product') {
            syncToolbar();
            renderProps();
          }
        });
    } catch (e) {
      rec = null;
      c.shell.toast(`录像失败：${e}`);
    }
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
      // 运行组里的声音键读同一份状态
      setBc({ sound: { has: a.hasSound, on: !a.state.muted } });
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
    const el = c.shell.props.el;
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
    if (rgb) {
      if (css && f.rgb) rgb.replaceChildren(swatch(css), `#${f.rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`);
      else rgb.textContent = '灭';
    }
    const au = c.session.audio.state;
    set('buzz', `${au.sounding ? `响 ${au.lastFreq} Hz` : alarm ? '报警中（间歇）' : '不响'} · ${au.muted ? '静音' : '出声'}`, alarm);
    set('heat', heat.on ? `开 · 离通风口 ${(heat.prox * 100).toFixed(0)}%` : '关');
    set('servo', a === null ? '没有 PWM' : `${a.toFixed(1)}°`);
    if (lcd3d) set('turn', `${lcd3d.turn() >= 0 ? '+' : ''}${lcd3d.turn().toFixed(0)}°（0° 是正面）`);
    set('look', look === 'front' ? '停在正面（按 BOOT 继续）' : look === 'around' ? '左右转身' : '左右转身');
    set('mood', mood ? `${MOOD_LABEL[mood] ?? mood}（按 BOOT 换下一个）` : '等固件打印…');
    const uv = c.session.usb;
    const blocked = !!assembly()?.effects.usbBlocked;
    set('usbstate', blocked ? '没有设备（线插不进去）' : uv ? `${uv.state}${uv.product ? ` · ${uv.product}` : ''}` : '等待设备', blocked || !uv?.configured);
    set('typed', blocked ? '—' : uv?.typed ? uv.typed.replace(/\r/g, '').replace(/\n/g, '↵') : '（还没有输入）');
    const rb = el.querySelector<HTMLButtonElement>('#pRec');
    if (rb && rec) rb.textContent = `录制中 ${Math.min(RECORD_SECONDS, rec.elapsed()).toFixed(0)} / ${RECORD_SECONDS} s · 点击停止`;
    const k = assembly()?.effects.lensScale ?? 1.35;
    set('lens', `${k > 1.2 ? '高档 8 mm' : '低档 1 mm'} · 放大约 ${k.toFixed(2)}×（估算）`, k < 1.2);
    const snd = el.querySelector<HTMLButtonElement>('#pSound');
    if (snd) {
      snd.textContent = au.muted ? '声音：关' : '声音：开';
      snd.setAttribute('aria-pressed', String(!au.muted));
    }
    const ht = el.querySelector<HTMLButtonElement>('#pHeat');
    if (ht) ht.textContent = heat.on ? '热源：开' : '热源：关';
    if (c.work.id === 'lamp') {
      const strip = f.strips?.[5] ?? [];
      const st = el.querySelector<HTMLElement>('[data-live="strip"]');
      if (st) {
        if (strip.length) st.replaceChildren(...strip.map((x) => swatch(ledCss(x) ?? '#222')), ` #${(strip[0] ?? [0, 0, 0]).map((x) => x.toString(16).padStart(2, '0')).join('')}`);
        else st.textContent = '灭';
      }
      // 固件上电是亮度 4、暖白，只在变了的时候才打印 LEVEL / COLOR
      set('lampst', lamp.level || lamp.color || strip.some((x) => Math.max(...x) > 0) ? `亮度 ${lamp.level || 4}/8 · ${COLOR_LABEL[lamp.color] ?? (lamp.color || '暖白')}${lamp.level || lamp.color ? '' : '（上电默认）'}` : '等固件打印…');
      set('lampmode', lamp.mode === 'color' ? '调颜色（再按一下回到调亮度）' : '调亮度（按一下切到调颜色）');
      set('knob', `${knobPos >= 0 ? '+' : ''}${knobPos} 格（从进成品算起）`);
    } else if (c.work.id === 'ruler') {
      const b = assembly()?.effects.sonarBlock ?? 0;
      set('cm', `${rawCm.toFixed(1)} cm`);
      set('cmfx', b && rawCm > b ? `约 ${b} cm（被孔壁挡住）` : `${Math.min(rawCm, b || rawCm).toFixed(1)} cm`, !!b && rawCm > b);
      set('rdist', ruler.dist || '等固件打印…');
      set('buzz', `${ruler.beep === 'on' ? '一直响' : ruler.beep.startsWith('gap=') ? `响 40 ms · 停 ${ruler.beep.slice(4)}` : '不响'} · ${au.muted ? '静音' : '出声'}`, ruler.beep === 'on');
    } else if (c.work.id === 'tilt') {
      const flip = assembly()?.effects.imuFlip;
      set('tpose', `俯仰 ${rawPose.pitch.toFixed(0)}° · 横滚 ${rawPose.roll.toFixed(0)}°`);
      set('tfx', flip ? `俯仰 ${(-rawPose.pitch).toFixed(0)}° · 横滚 ${(-rawPose.roll).toFixed(0)}°（装反了）` : '和圆盘一致', !!flip);
      set('bean', bean.pos ? `${bean.pos} · 碰边 ${bean.edges} 次` : '等固件打印…');
    }
    const pre = el.querySelector<HTMLElement>('[data-live="serial"]');
    if (pre) {
      const lines = c.session.consoleText().split('\n').filter((l) => l.trim());
      pre.textContent = lines.slice(-6).join('\n');
    }
  }

  /** 手机成品（P2-17）：3D 占满，按键网格就是工具条。拖动本来就转视角，不要「旋转」；属性卡里的按键（旋钮 ±1、
   *  倾斜、K1–K4）都搬进网格——都是桌面上已有的同一个动作，只是换个地方点；「详情」打开属性抽屉看读数和真机提醒 */
  function phoneGroups(): ToolGroup[] {
    const c = ctx!;
    const w = c.work.id;
    const act: Tool[] =
      w === 'lamp'
        ? [{ id: 'p-knob-l', label: '旋钮 −1' }, { id: 'p-knob-r', label: '旋钮 +1' }, { id: 'p-knob', label: '按旋钮' }]
        : w === 'ruler'
          ? [{ id: 'p-near', label: '挡板近 10 cm' }, { id: 'p-far', label: '挡板远 10 cm' }]
          : w === 'tilt'
            ? [{ id: 'p-tilt-r', label: '右边放低' }, { id: 'p-tilt-l', label: '左前放低' }, { id: 'p-level', label: '放平' }]
            : w === 'usbkey'
              ? KEYPAD_PINS.map((pin, i) => ({ id: `p-key-${pin}`, label: `K${i + 1} · ${KEYPAD_CAPS[i]}` }))
              : [{ id: 'p-boot', label: '按 BOOT' }, ...(w === 'weather' ? [{ id: 'p-heat', label: heat.on ? '热源：开' : '热源：关' }] : [])];
    return [
      { id: 'act', tools: act },
      ...(c.session.audio.hasSound ? [{ id: 'snd', tools: [{ id: 'p-sound', label: c.session.audio.state.muted ? '声音：关' : '声音：开' }] }] : []),
      ...(cur3d() ? [{ id: 'media', tools: [{ id: 'p-photo', label: '拍照' }, { id: 'p-rec', label: rec ? '停止录像' : `录 ${RECORD_SECONDS} 秒` }, { id: 'p-home', label: '复位视角' }] }] : []),
      { id: 'run', tools: [{ id: 'p-info', label: '详情' }, { id: 'p-rerun', label: '重启', primary: true }] },
    ];
  }

  function syncToolbar() {
    const c = ctx!;
    const weather = c.work.id === 'weather';
    const w = c.work.id;
    if (isPhone()) {
      c.shell.toolbar.setGroups(phoneGroups());
      c.shell.toolbar.setActive(rec ? 'p-rec' : heat.on ? 'p-heat' : null);
      return;
    }
    const act = w === 'lamp' ? [{ id: 'p-knob', label: '按旋钮' }] : w === 'ruler' ? [{ id: 'p-near', label: '挡板近' }, { id: 'p-far', label: '挡板远' }] : w === 'tilt' ? [{ id: 'p-level', label: '放平' }] : [{ id: 'p-boot', label: '按 BOOT' }, ...(weather ? [{ id: 'p-heat', label: heat.on ? '热源：开' : '热源' }] : [])];
    c.shell.toolbar.setGroups([
      ...(scene3d || lcd3d || keypad || work3d ? [{ id: 'nav', tools: [{ id: 'p-orbit', label: '旋转', key: '拖动' }, { id: 'p-home', label: '复位视角' }] }] : []),
      ...(c.work.id === 'usbkey' ? [] : [{ id: 'act', tools: act }]),
      ...(c.session.audio.hasSound ? [{ id: 'snd', tools: [{ id: 'p-sound', label: c.session.audio.state.muted ? '声音：关' : '声音：开' }] }] : []),
      ...(cur3d() ? [{ id: 'media', tools: [{ id: 'p-photo', label: '拍照' }, { id: 'p-rec', label: rec ? '停止录像' : `录 ${RECORD_SECONDS} 秒` }] }] : []),
      { id: 'run', tools: [{ id: 'p-rerun', label: '重启', primary: true }] },
    ]);
    c.shell.toolbar.setActive(rec ? 'p-rec' : heat.on ? 'p-heat' : 'p-orbit');
  }

  function previewWhy() {
    const c = ctx!;
    const n = c.work.checkpoints.length;
    const d = passedCount(c);
    if (d < n) return `检查点 ${d}/${n}`;
    const a = c.store.get().assembly;
    return `组装 ${a?.placed.length ?? 0}/${a?.total ?? TEMPLATES[c.work.id]?.parts.length ?? 0}`;
  }

  /** 预览时下一步引导去完成检查点 / 组装；装完了就是最后一步 */
  function syncNext() {
    const c = ctx!;
    if (!preview) {
      c.shell.setNext('已是最后一步', null, '这是最后一步', undefined, 'end');
      return;
    }
    const n = c.work.checkpoints.length;
    if (passedCount(c) < n) {
      c.shell.setNext(`回实验台 · 还差 ${n - passedCount(c)} 个检查点`, 'bench', '', () => {
        const s = c.store.get();
        const first = c.work.checkpoints.find((id) => !(s.checks[id]?.ok && s.checks[id].own)) ?? c.work.checkpoints[0];
        if (first) c.store.set({ selection: { kind: 'checkpoint', id: first } });
        location.hash = 'bench';
      });
    } else c.shell.setNext('下一步：组装 →', 'assemble');
  }

  function syncVerdict() {
    const c = ctx!;
    if (preview) {
      c.shell.setVerdict(alarm ? '报警中' : previewWhy(), alarm ? 'bad' : 'idle');
      c.shell.onVerdict(() => (location.hash = passedCount(c) < c.work.checkpoints.length ? 'bench' : 'assemble'));
      return;
    }
    const a = c.store.get().assembly;
    const off = a?.effects.sensorOffset ?? 0;
    const fx = a?.effects ?? {};
    const fxBad = fx.glare ? '灯罩有亮点（装法）' : fx.sonarBlock ? '读数被挡（装法）' : fx.imuFlip ? '方向反了（装法）' : '';
    c.shell.setVerdict(alarm ? '报警中 ≥ 30 ℃' : off ? '读数偏高（装法）' : fxBad || (a?.retest ? '复测 ✓ · 成品' : '成品'), alarm || off || fxBad ? 'bad' : a?.retest ? 'ok' : 'idle');
    c.shell.onVerdict(() => (location.hash = 'assemble'));
  }

  function onTool(id: string) {
    const c = ctx;
    if (!c || c.store.get().step !== 'product') return;
    if (id === 'p-sound') toggleSound();
    else if (id === 'p-heat') toggleHeat();
    else if (id === 'p-home') (scene3d ?? lcd3d ?? keypad ?? work3d)?.resetView();
    else if (id === 'p-photo') void photo();
    else if (id === 'p-rec') record();
    else if (id === 'p-rerun') c.session.reboot();
    else if (id === 'p-level') {
      if (WORK3D.has(c.work.id)) tiltTo({ pitch: 0, roll: 0, yaw: 0 });
      else c.session.setPose({ pitch: 0, roll: 0, yaw: 0 });
    } else if (id === 'p-knob') {
      c.session.pressEncoder(true);
      setTimeout(() => ctx?.session.pressEncoder(false), 150);
      event('●', '按旋钮');
    } else if (id === 'p-knob-l') turnKnob(-1);
    else if (id === 'p-knob-r') turnKnob(1);
    else if (id === 'p-tilt-r') tiltTo({ pitch: 0, roll: 25, yaw: 0 });
    else if (id === 'p-tilt-l') tiltTo({ pitch: 20, roll: -25, yaw: 0 });
    else if (id === 'p-info') setMui({ props: true, sheet: 'peek' });
    else if (id.startsWith('p-key-')) {
      // USB 小键盘：和 3D 里按键帽同一个动作（按下 150 ms 再松开）
      const pin = Number(id.slice(6));
      c.session.pressPin(pin, true);
      event('⌨', `按 K${KEYPAD_PINS.indexOf(pin) + 1}`);
      setTimeout(() => ctx?.session.pressPin(pin, false), 150);
    } else if (id === 'p-near') moveBoard(-10);
    else if (id === 'p-far') moveBoard(10);
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
        screen: () => lit(),
      };
    } else if (WORK3D.has(c.work.id) && webglOk()) {
      work3d = createWork3D(node, {
        kind: c.work.id as WorkKind,
        frame: () => frame(),
        effects: () => assembly()?.effects ?? {},
        sounding: () => c.session.audio.state.sounding,
        onKnob: (n) => turnKnob(n),
        onKnobPress: (d) => {
          c.session.pressEncoder(d);
          if (d) event('●', '按旋钮');
        },
        onDistance: (cm) => applyDistance(cm),
        distance: c.session.distance,
        onPose: (p) => applyPose(p),
        pose: c.store.get().pose,
      });
      (window as unknown as { __tbProduct: unknown }).__tbProduct = {
        handlePos: () => work3d!.handleScreenPos(),
        azimuth: () => work3d!.azimuth(),
        state: () => work3d!.state(),
        lamp: () => ({ ...lamp }),
        ruler: () => ({ ...ruler, raw: rawCm }),
        bean: () => ({ ...bean }),
        strip: () => frame().strips?.[5] ?? [],
      };
    } else if (c.work.id === 'usbkey') {
      const press = (pin: number, d: boolean) => {
        c.session.pressPin(pin, d);
        if (d) event('⌨', `按 K${pin - 3}`);
      };
      if (webglOk()) keypad = createKeypad3D(node, { press });
      else {
        const box = document.createElement('div');
        box.className = 'prod-svg';
        node.appendChild(box);
        keypadSvg = createKeypadView(box, { press });
      }
      c.session.onUsb((v) => {
        const blocked = !!assembly()?.effects.usbBlocked;
        keypad?.setUsb(blocked ? null : v);
        keypadSvg?.setUsb(blocked ? null : v);
      });
      (window as unknown as { __tbProduct: unknown }).__tbProduct = {
        keyPos: (i: number) => keypad?.keyScreenPos(i) ?? null,
        azimuth: () => keypad?.azimuth() ?? 0,
        typed: () => c.session.usb?.typed ?? '',
        usbState: () => c.session.usb?.state ?? '',
      };
    } else if (webglOk()) {
      const w = c.work.id as 'spin' | 'lens';
      lcd3d = createLcd3D(node, {
        kind: w,
        frame,
        servoPin: 4,
        effects: () => assembly()?.effects ?? {},
        sounding: () => c.session.audio.state.sounding,
        onBoot: (d) => pressBoot(d),
      });
      (window as unknown as { __tbProduct: unknown }).__tbProduct = {
        buttonPos: () => lcd3d!.buttonScreenPos(),
        azimuth: () => lcd3d!.azimuth(),
        turn: () => lcd3d!.turn(),
        ext: () => lcd3d!.ext(),
        mood: () => mood,
        look: () => look,
        screen: () => lit(),
      };
    } else {
      const box = document.createElement('div');
      box.className = 'prod-svg';
      node.appendChild(box);
      const h = { boot: (d: boolean) => pressBoot(d), temp: () => {} };
      svgProduct = c.work.id === 'spin' ? createSpinProduct(box, h, { servoPin: 4 }) : c.work.id === 'lens' ? createLensProduct(box, h) : TEMPLATES[c.work.id].product(box, h, { servoPin: 4 });
      const note = document.createElement('div');
      note.className = 'p3-disclaimer';
      note.textContent = '外观示意（2D：这台设备不支持 WebGL）';
      node.appendChild(note);
    }
  }

  function mountTilt(c: StepCtx) {
    if (!tiltNode) {
      tiltNode = document.createElement('div');
      tiltNode.className = 'prod-stage';
      tilt = createTilt3D(tiltNode, { pose: () => c.store.get().pose, onPose: (p) => c.session.setPose(p) });
      const note = document.createElement('div');
      note.className = 'p3-disclaimer';
      note.textContent = '外观示意 · 拖动可转动盒子';
      tiltNode.appendChild(note);
    }
    c.shell.layer.render(
      <>
        <Banner t="倾角仪 · 端在手里转" s="这个作品不装壳。转动盒子就是在转实验台上的 IMU，读数实时跟着变" />
        <Host node={tiltNode} />
      </>,
    );
    tilt!.start();
    c.shell.tree.render(<TreeRow on label={`倾角仪 · ${c.session.scene.parts.some((p) => p.type === 'qmi8658') ? 'QMI8658' : 'MPU6050'}`} />);
    c.shell.props.render(
      <>
        <Sec>盒子姿态 · 你转出来的</Sec>
        {row('俯仰 / 横滚 / 航向', 'tp')}
        {row('应读到（重力分量）', 'tg')}
        <Sec>固件读到 · 串口最近一行</Sec>
        {row('俯仰', 'tip')}
        {row('横滚', 'tir')}
        {row('陀螺', 'tgy')}
        <Note>拖动时陀螺读到角速度，松手 150 ms 后回零。真机的零偏、温漂和振动噪声没有算进去（未经真机标定）。</Note>
      </>,
    );
    const tiltBar = () => {
      c.shell.toolbar.setGroups(
        isPhone()
          ? [{ id: 'run', tools: [{ id: 'p-level', label: '放平' }, { id: 'p-info', label: '详情' }, { id: 'p-rerun', label: '重启', primary: true }] }]
          : [
              { id: 'nav', tools: [{ id: 'p-orbit', label: '转动', key: '拖动' }, { id: 'p-level', label: '放平' }] },
              { id: 'run', tools: [{ id: 'p-rerun', label: '重启', primary: true }] },
            ],
      );
      c.shell.toolbar.setActive(isPhone() ? null : 'p-orbit');
    };
    tiltBar();
    unsubs.push(onPhoneChange(tiltBar));
    c.shell.timeline.setSteps([]);
    c.shell.setNext('已是最后一步', null, '这是最后一步', undefined, 'end');
    c.shell.setVerdict('倾角仪 · 成品', 'idle');
    c.shell.onVerdict(() => (location.hash = 'bench'));
    const set = (k: string, v: string, bad = false) => {
      const n = c.shell.props.el.querySelector<HTMLElement>(`[data-live="${k}"]`);
      if (n) {
        n.textContent = v;
        n.classList.toggle('bad', bad);
      }
    };
    const upd = () => {
      const s = c.store.get();
      const p = s.pose;
      set('tp', `${p.pitch.toFixed(1)}° / ${p.roll.toFixed(1)}° / ${p.yaw.toFixed(1)}°`);
      set('tg', gravity(p).map((v) => v.toFixed(3)).join(' / ') + ' g');
      set('tip', s.imu ? `${s.imu.pitch.toFixed(1)}°` : '等固件打印…');
      set('tir', s.imu ? `${s.imu.roll.toFixed(1)}°` : '—');
      set('tgy', s.imu?.gyro ? `${s.imu.gyro.map((v) => v.toFixed(1)).join(' / ')} °/s` : '—');
    };
    upd();
    tiltTimer = window.setInterval(upd, 100);
    (window as unknown as { __tbProduct: unknown }).__tbProduct = { center: () => tilt!.centerPos(), pose: () => c.store.get().pose, imu: () => c.store.get().imu };
  }

  function loopSvg() {
    raf = requestAnimationFrame(loopSvg);
    const c = ctx;
    if (!c || !svgProduct) return;
    svgProduct.update(frame(), c.store.get().env.temp, assembly()?.effects ?? {});
  }

  return {
    mount(c) {
      ctx = c;
      if (!hooked) {
        hooked = true;
        storeRef = c.store;
        c.shell.toolbar.onTool(onTool);
        // 先把挂上之前的串口过一遍（台灯上电时打印的 LAMP ON / LEVEL 等），只更新状态
        quiet = true;
        onSerial(c.session.consoleText() + '\n');
        quiet = false;
        c.session.onConsole((t) => onSerial(t));
        c.store.subscribe((s, prev) => {
          if (s.run > prev.run) {
            unitF = false;
            alarm = false;
            mood = '';
            look = '';
            lamp = { level: 0, mode: '', color: '' };
            ruler = { dist: '', beep: '' };
            bean = { pos: '', edges: 0 };
            event('▶', `上电 · 运行 #${s.run}`);
          }
        }, ['run']);
      }
      if (c.work.id === 'imu') {
        mountTilt(c);
        return;
      }
      if (!TEMPLATES[c.work.id]) {
        c.shell.layer.render(
          <LockCard role="status">
            <Sec>④ 成品</Sec>
            <PhT>{c.work.id === 'blank' ? '空白作品' : c.work.title}没有成品</PhT>
            <Btns>
              <LinkBtn primary href="./app.html?work=weather#product">
                看气象站成品
              </LinkBtn>
            </Btns>
          </LockCard>,
        );
        c.shell.tree.render(<TreeEmpty>没有成品</TreeEmpty>);
        c.shell.props.render(null);
        c.shell.toolbar.setGroups([]);
        c.shell.timeline.setSteps([]);
        return;
      }
      const own = c.store.get().assembly;
      // 没装完不锁整页：先看参考成品（参考装配 + 实验台现在的固件），顶部标明，下一步引导去完成检查点 / 组装
      preview = !own || own.placed.length < own.total;
      const a = assembly()!;
      if (!node) build(c);
      c.shell.layer.render(
        <>
          {preview && <Banner t="参考成品" s="按默认正确装法展示，你装完后换成你的装法" />}
          <Host node={node} />
        </>,
      );
      // 装法的温漂只在成品里生效
      c.session.setSensorOffset(a?.effects.sensorOffset ?? 0);
      room = c.store.get().env.temp;
      air = room;
      if (!events.length && c.store.get().run) event('▶', `${preview ? '参考成品 · ' : ''}开机 · 运行 #${c.store.get().run}${a.effects.sensorOffset ? `，传感器受热偏高 ${a.effects.sensorOffset} ℃` : ''}`);
      scene3d?.start();
      lcd3d?.start();
      work3d?.start();
      // 装法影响进模拟器：尺子的探头被挡、六轴装反（离开成品时还原成用户摆的样子）
      if (c.work.id === 'ruler') {
        rawCm = c.session.distance < 0 ? 25 : c.session.distance;
        work3d?.setDistance(rawCm);
        applyDistance(rawCm);
      } else if (c.work.id === 'tilt') {
        rawPose = { ...c.store.get().pose };
        work3d?.setPose(rawPose);
        applyPose(rawPose);
      }
      keypad?.start();
      keypad?.setBlocked(!!a.effects.usbBlocked);
      if (keypad || keypadSvg) {
        const v = a.effects.usbBlocked ? null : c.session.usb;
        keypad?.setUsb(v);
        keypadSvg?.setUsb(v);
      }
      applyHarness();
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
      unsubs = [
        onPhoneChange(() => syncToolbar()),
        c.store.subscribe(() => renderTree(), ['assembly']),
        c.store.subscribe(() => preview && (syncNext(), renderProps()), ['checks']),
        c.session.onHarness((t) => {
          const n = c.shell.props.el.querySelector('[data-live="hz"]');
          if (n) n.textContent = t.trim().replace(/\[tryboard\] /g, '模拟器：');
          else if (t.trim()) renderProps();
        }),
      ];
    },
    unmount() {
      unsubs.forEach((u) => u());
      unsubs = [];
      clearInterval(timer);
      clearInterval(tiltTimer);
      tilt?.stop();
      cancelAnimationFrame(raf);
      raf = 0;
      scene3d?.stop();
      lcd3d?.stop();
      work3d?.stop();
      keypad?.stop();
      rec?.stop();
      if (ctx) {
        if (ctx.work.id === 'ruler') ctx.session.setDistance(rawCm);
        if (ctx.work.id === 'tilt') ctx.session.setPose(rawPose);
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
