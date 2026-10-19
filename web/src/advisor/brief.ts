// 选板 v3「任务书」：把选板结果写成一份能直接贴给 AI 写代码助手的 Markdown（DESIGN_V2 §8.2 / 设计稿 UtilB）。
// 实验台也 import 它（签名固定）。验收一节的检查点名照 DECISIONS 2026-10-18 接口约定 3，和实验台生成的检查点逐字一致。
// 不写任何命令行：任务书给的是"要做成什么样"，怎么跑交给试板网页；离线跑只指一句本地包。
import { PARTS } from './data.ts';
import { capName, type Confidence } from './engine.ts';
import type { Cap } from './data.ts';
import { PART_MAP } from './catalogmap.ts';
import { answers, labelIs, pinFull, pinKind, resolve, yuan, lasts, type Result } from './derive.ts';
import type { SelectState } from './state.ts';

/** I2C 器件地址（目录零件 id → 7 位地址），与实验台 `--i2c ssd1306@0x3c,bme280@0x76` 一致 */
const I2C_ADDR: Record<string, number> = { bme280: 0x76, ssd1306: 0x3c };
const CHIP_NAME: Record<string, string> = { bme280: 'BME280', ssd1306: 'OLED' };
const hex = (a: number) => '0x' + a.toString(16).padStart(2, '0');

export interface Checkpoint {
  name: string;
  conf: Confidence;
  /** 不判定，只提醒（深睡唤醒） */
  manual?: boolean;
}

/** 按零件生成的检查点（名字与实验台 genlevels 逐字一致） */
export function checkpointsOf(r: Result): Checkpoint[] {
  const ids = r.need.parts.map((id) => PART_MAP[id]?.partId).filter((x): x is string => !!x);
  const out: Checkpoint[] = [{ name: '开机不崩溃，串口有输出', conf: '仿真验证' }];
  for (const id of ids) if (id in I2C_ADDR) out.push({ name: `I2C ${hex(I2C_ADDR[id])} 有回应（${CHIP_NAME[id]}）`, conf: '行为模拟' });
  if (ids.includes('ssd1306')) out.push({ name: 'OLED 收到画面', conf: '仿真验证' });
  if (ids.includes('ws2812-strip')) out.push({ name: '灯带收到数据', conf: '仿真验证' });
  if (ids.includes('sg90')) out.push({ name: '舵机信号', conf: '行为模拟' });
  if (r.need.battery) out.push({ name: '深睡后能再唤醒', conf: '必须上真机', manual: true });
  return out;
}

/** 接口里每根线的角色（引擎只给引脚号，按顺序对上） */
const ROLES: Record<string, string[]> = { i2c: ['SDA', 'SCL'], spi: ['SCK', 'MOSI', 'CS'], i2s: ['BCLK', 'WS', '数据'], uart: ['TX', 'RX'] };

function wiring(r: Result, partId: string): string {
  const p = r.plan!;
  const part = PARTS[partId];
  const segs: string[] = [];
  for (const n of part.needs) {
    const a = p.pins.find((x) => labelIs(x.label, n.label));
    if (!a) continue;
    const kind = pinKind(a.label, r.need.parts);
    const roles = ROLES[kind];
    if (n.label.includes('DC / RST / 背光')) segs.push(['DC', 'RST', '背光'].map((k, i) => (a.pins[i] !== undefined ? `${k} = ${pinFull(p.board, a.pins[i])}` : '')).filter(Boolean).join('，'));
    else if (roles) segs.push(`${kind.toUpperCase()}，` + a.pins.map((x, i) => `${roles[i] ?? '线' + (i + 1)} = ${pinFull(p.board, x)}`).join('，'));
    else segs.push(`${kind === 'pwm' ? 'PWM' : kind === 'adc' ? 'ADC' : kind === 'rmt' ? 'RMT' : kind === 'usb' ? '原生 USB' : 'GPIO'}，${a.pins.map((x) => pinFull(p.board, x)).join(' / ')}`);
  }
  const cat = PART_MAP[partId]?.partId;
  if (cat && cat in I2C_ADDR) segs.push(`地址 ${hex(I2C_ADDR[cat])}`);
  if (PART_MAP[partId] === null) segs.push('试板里没有这个零件的模型，要上真机试');
  return segs.join('，') || '不占引脚';
}

export function briefMarkdown(s: SelectState): string {
  const r = resolve(s);
  const a = answers(r.s);
  const L: string[] = [];
  const title = r.tpl.title;
  L.push(`# ${title}`, '');
  if (!r.plan) {
    L.push('还没有板子同时满足这些条件。回选板页去掉一个条件或放宽预算，再生成任务书。');
    return L.join('\n');
  }
  const p = r.plan;
  L.push(`用 ${p.board.name}（${p.chip.name}）做「${title}」。整套参考价 ${yuan(p.total)}（估算）。`, '');

  L.push('## 硬件', '');
  L.push(`- 开发板：${p.board.name}（${p.chip.name}，${p.board.flashMB}MB Flash${p.board.psramMB ? `，${p.board.psramMB}MB PSRAM` : ''}）`);
  for (const id of r.need.parts) L.push(`- ${PARTS[id].name}：${wiring(r, id)}`);
  if (a.bat) L.push(`- ${PARTS.battery.name}${p.board.battery ? '：接板上电池座，板子自带充电' : '：要另配充电板'}`);
  L.push('');

  L.push('## 引脚', '');
  L.push('| 用途 | 引脚 | 说明 |', '|---|---|---|');
  for (const x of p.pins) L.push(`| ${x.label} | ${x.pins.map((n) => pinFull(p.board, n)).join(' / ')} | ${x.note ?? ''} |`);
  for (const x of p.pinProblems) L.push(`| 有冲突 | — | ${x} |`);
  L.push('');

  L.push('## 要求', '');
  if (a.bat && r.need.duty) {
    const d = r.need.duty;
    const every = d.wakePerHour ? Math.round(60 / d.wakePerHour) : 0;
    L.push(`- 电池供电：每 ${every} 分钟醒来一次，干活约 ${d.activeSec} 秒${d.wifi ? '（含连 Wi-Fi 上报）' : ''}，其余时间深睡`);
    if (p.power) L.push(`- 续航目标：${lasts(p.power.days)}（估算，按 1000mAh 电池）`);
  }
  if (a.net) L.push(`- 连网：${r.need.caps.includes('wifi') ? 'Wi-Fi' : '蓝牙'}${r.need.caps.includes('ble') && r.need.caps.includes('wifi') ? ' + 蓝牙' : ''}`);
  const names = r.need.parts.map((id) => PARTS[id].short);
  if (names.length) L.push(`- 串口每次都打印一行状态（读数 / 按键 / 输出），方便对照：用到 ${names.join('、')}`);
  if (r.need.parts.includes('oled') || r.need.parts.includes('tft')) L.push('- 屏幕上显示当前读数或状态');
  for (const c of r.s.req) L.push(`- 必须支持：${capName(c as Cap)}`);
  for (const w of r.tpl.risks) L.push(`- 注意：${w}`);
  L.push('- 框架：ESP-IDF v5.x 或 Arduino-ESP32 都行；引脚按上表，不要改');
  L.push('');

  L.push('## 验收（试板按零件自动生成的检查点）', '');
  checkpointsOf(r).forEach((c, i) => L.push(`${i + 1}. ${c.name}${c.manual ? '（必须上真机，试板不判定）' : ''}`));
  const noModel = r.need.parts.filter((id) => PART_MAP[id] === null);
  if (noModel.length) L.push('', `${noModel.map((id) => PARTS[id].short).join('、')}试板里没有模型，这部分必须上真机。`);
  L.push('', '没过时结果写成「实际 x；要 y」，照这句改代码。', '');
  L.push('想离线跑的，从仓库本地装 packages/tryboard');
  return L.join('\n');
}
