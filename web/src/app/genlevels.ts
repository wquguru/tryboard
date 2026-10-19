// 按台面上的零件生成检查点（DECISIONS「选板 v3」接口约定 3）：现成作品的检查点写在 firmware/levels.json，
// 选板出来的自定义项目零件组合太多，不手写；这里按零件出 Level，判定字段和 check.py / npm 包同一套。
// 纯函数：同样的板子和零件永远生成同样的 Level（导出的 JSON 给 check.py --level-json 用，网页和命令行指纹对得上）。
import type { PartSpec } from '../board3d';
import { CHIP_LABEL } from '../chips.ts';
import type { Level } from '../checks.ts';
import type { ConfLevel } from '../ui/conf.tsx';

export interface GenInput {
  /** 实验台板子名（任务书里写） */
  boardName: string;
  chip: 'esp32' | 'esp32c3' | 'esp32s3';
  parts: PartSpec[];
  /** 电池供电又要深睡：加一条「深睡后能再唤醒」（必须上真机，不判） */
  deepSleep: boolean;
}

const hex2 = (n: number) => '0x' + n.toString(16).padStart(2, '0');
const I2C_KIND: Record<string, { kind: string; name: string }> = { bme280: { kind: 'bme280', name: 'BME280' }, oled: { kind: 'ssd1306', name: 'OLED' }, mpu6050: { kind: 'mpu6050', name: 'MPU6050' }, qmi8658: { kind: 'qmi8658', name: 'QMI8658' } };

/** 一条检查点的可信度：上真机的不判；I2C 应答、舵机脉宽是行为模型；其余有验收固件跑过 */
export function levelConf(l: Level): ConfLevel {
  if (l.manual) return '必须上真机';
  if (l.i2c_ack?.length || l.pwm) return '行为模拟';
  return '仿真验证';
}

export function genLevels(g: GenInput): Level[] {
  const i2c = g.parts.flatMap((p) => ('addr' in p && 'sda' in p && I2C_KIND[p.type] ? [{ ...I2C_KIND[p.type], addr: p.addr, sda: p.sda, scl: p.scl }] : [])).sort((a, b) => a.addr - b.addr);
  const servo = g.parts.find((p): p is Extract<PartSpec, { type: 'servo' }> => p.type === 'servo');
  const strip = g.parts.find((p): p is Extract<PartSpec, { type: 'ws2812' }> => p.type === 'ws2812');
  const oled = g.parts.some((p) => p.type === 'oled');
  // 每条检查点都带上板上器件（--i2c、环境），网页由 bootOptions 翻译；舵机按外接 5 V 摆，验收也按外接供电跑
  const args = [
    ...(i2c.length ? ['--i2c', i2c.map((d) => `${d.kind}@${hex2(d.addr)}`).join(','), '--i2c-log'] : []),
    '--env', '23.5,45,101325',
    ...(servo ? ['--servo', String(servo.pin), '--power', 'ext'] : []),
  ];
  const wiring = [
    ...i2c.map((d) => `${d.name}（I2C 地址 ${hex2(d.addr)}）：SDA=GPIO${d.sda}、SCL=GPIO${d.scl}`),
    ...(servo ? [`舵机信号：GPIO${servo.pin}（50 Hz，外接 5 V 供电）`] : []),
    ...(strip ? [`灯带数据 DIN：GPIO${strip.pin}`] : []),
  ];
  const chipName = CHIP_LABEL[g.chip];
  const brief = (goal: string, pass: string) =>
    [`用 ESP-IDF 5.x 给 ${g.boardName}（${chipName}）写固件。`, `目标：${goal}`, ...(wiring.length ? ['接线：', ...wiring.map((w) => `- ${w}`)] : []), `通过条件：${pass}`, '只交 flash.bin（合并镜像，从 0x0 开始）。'].join('\n');
  const out: Level[] = [];
  const add = (l: Omit<Level, 'id' | 'buy' | 'learn' | 'brief' | 'ref' | 'work' | 'seconds' | 'args'> & { manual?: boolean }) => {
    const id = `custom-${out.length + 1}`;
    out.push({ id, ...l, buy: '', learn: '', brief: brief(l.goal, l.pass), ref: null, work: 'custom', seconds: 3, args: [...args] });
  };
  add({ title: '开机不崩溃，串口有输出', goal: '上电后正常启动、往串口打印东西', pass: '3 s 内没有 panic / abort，串口至少输出 1 行', boots: true });
  for (const d of i2c) add({ title: `I2C ${hex2(d.addr)} 有回应（${d.name}）`, goal: `用 I2C 访问 ${d.name}`, pass: `${d.name}（${hex2(d.addr)}）对地址字节应答至少 1 次`, i2c_ack: [{ addr: d.addr, min: 1 }] });
  if (oled) add({ title: 'OLED 收到画面', goal: '在 OLED 上画点东西（文字、读数都行）', pass: 'OLED 最后一帧点亮至少 50 个像素', oled_min_pixels: 50 });
  if (strip) add({ title: '灯带收到数据', goal: '用 RMT 给 WS2812 灯带发颜色数据', pass: `GPIO${strip.pin} 上解码出至少 1 帧 WS2812 数据`, ws2812: { pin: strip.pin, min_frames: 1 } });
  if (servo) add({ title: '舵机信号', goal: '用 LEDC 输出 50 Hz 舵机信号', pass: `GPIO${servo.pin} 上 50 Hz PWM，脉宽在 0.5–2.5 ms`, pwm: { pin: servo.pin, freq: 50, min: 0.075, max: 0.075, tol: 0.05 } });
  if (g.deepSleep) add({ title: '深睡后能再唤醒', goal: '测完进深睡，定时唤醒再测', pass: '网页判不了：深睡电流和唤醒要上真机量', manual: true });
  return out;
}
