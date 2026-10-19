// 选板 v3：地址状态 → 推荐 / 任务书 / 「刚才」文字 / 放宽条件。纯函数，页面和实验台共用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefMarkdown, checkpointsOf } from '../src/advisor/brief.ts';
import { resolve, changeText, relaxOptions, partRows, sanitize, lasts } from '../src/advisor/derive.ts';
import { EMPTY, decode, encode } from '../src/advisor/state.ts';

const W = { ...EMPTY, t: 'weather' };

test('旧链接 ?t=weather 能解出温湿度计，并有推荐板', () => {
  const r = resolve(decode('?t=weather'));
  assert.equal(r.tpl.id, 'weather');
  assert.ok(r.plan);
  assert.ok(r.trio.length >= 2);
});

test('乱填的地址参数被丢掉，不报错', () => {
  const s = sanitize(decode('?t=nope&add=foo,buzzer&rm=bar&req=xx&board=zz'));
  assert.equal(s.t, 'weather');
  assert.deepEqual(s.add, ['buzzer']);
  assert.deepEqual(s.rm, []);
  assert.deepEqual(s.req, []);
  assert.equal(s.board, '');
});

test('任务书：四节、检查点名照接口约定 3、没有命令行', () => {
  const md = briefMarkdown(W);
  for (const h of ['## 硬件', '## 引脚', '## 要求', '## 验收']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('1. 开机不崩溃，串口有输出'));
  assert.ok(md.includes('I2C 0x76 有回应（BME280）'));
  assert.ok(md.includes('I2C 0x3c 有回应（SSD1306）'));
  assert.ok(md.includes('OLED 收到画面'));
  assert.ok(md.includes('深睡后能再唤醒'));
  assert.ok(!/npx|idf\.py|tryboard run/.test(md));
  assert.equal(md.trim().split('\n').at(-1), '想离线跑的，从仓库本地装 packages/tryboard');
});

test('检查点：灯带、舵机；不用电池就没有深睡', () => {
  const r = resolve({ ...EMPTY, t: 'lights', add: ['servo'] });
  const names = checkpointsOf(r).map((c) => c.name);
  assert.ok(names.includes('灯带收到数据'));
  assert.ok(names.includes('舵机信号'));
  assert.ok(!names.includes('深睡后能再唤醒'));
});

test('「刚才」：加蜂鸣器推荐没变、多占引脚、价钱涨', () => {
  const t = changeText('加了蜂鸣器', resolve(W), resolve({ ...W, add: ['buzzer'] }));
  assert.match(t, /^加了蜂鸣器 → 推荐没变，多占 1 个引脚 .+，参考价 \+¥/);
  // 续航变了就要说出来（数字来自引擎，不写死）
  const a = resolve(W).plan!.power!.days;
  const b = resolve({ ...W, add: ['buzzer'] }).plan!.power!.days;
  if (lasts(a) !== lasts(b)) assert.match(t, /续航 约 \d+ 天 → 约 \d+ 天$/);
  // 换模板时差价取整，不出小数
  const u = changeText('换成「温湿度计」', resolve({ ...EMPTY, t: 'lights' }), resolve(W));
  assert.doesNotMatch(u, /参考价 [+−]¥\d+\.\d/);
});

test('0 块板时给出能放宽的条件，且每条真的能出板', () => {
  const s = { ...W, req: ['bt_classic'], budget: 60 as const };
  const r = resolve(s);
  assert.equal(r.plans.length, 0);
  const opts = relaxOptions(r);
  assert.ok(opts.length > 0);
  for (const o of opts) assert.equal(resolve(o.next).plans.length, o.n);
});

test('零件清单：必选 / 建议分组，建议默认虚线', () => {
  const rows = partRows(resolve(W));
  assert.ok(rows.some((x) => x.key === 'bme280' && x.group === 'need' && x.on));
  assert.ok(rows.some((x) => x.key === 'battery' && x.group === 'suggest' && x.on));
  assert.ok(rows.some((x) => x.key === 'buzzer' && x.group === 'suggest' && !x.on));
});

test('分享参数往返一致', () => {
  const s = { ...W, add: ['buzzer'], bat: false, budget: 120 as const, board: 'c3-supermini' };
  assert.deepEqual(decode('?' + encode(s)), { ...s, have: [] });
});
