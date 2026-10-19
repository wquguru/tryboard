import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRows, headline } from '../src/ui/say.ts';

// 尺子装壳后复测的真实逐条（checks.ts 产出的 say / tag / dev）
const ruler = [
  { ok: false, text: '串口出现 “DIST 15.0 cm”', say: '串口没打印「DIST 15.0 cm」', tag: '串口', dev: '串口' },
  { ok: true, text: 'GPIO5 PWM …', say: '蜂鸣器音调对', tag: 'GPIO5', dev: '蜂鸣器' },
  { ok: false, text: 'GPIO5 0.3–1.5 s 响 0 声（要 2–5）', say: '0.3–1.5 秒蜂鸣器没响，应响 2–5 声', tag: 'GPIO5', dev: '蜂鸣器' },
  { ok: false, text: 'GPIO5 1.8–2.5 s 响 0 声（要 4–9）', say: '1.8–2.5 秒蜂鸣器没响，应响 4–9 声', tag: 'GPIO5', dev: '蜂鸣器' },
  { ok: true, text: 'GPIO5 2.8–3.2 s 响 0 声（要 0）', say: '2.8–3.2 秒蜂鸣器安静', tag: 'GPIO5', dev: '蜂鸣器' },
  { ok: true, text: 'OLED 点亮 300 像素', say: '屏幕亮了', tag: 'OLED', dev: '屏幕' },
];

test('按器件分组：引脚只写一次，没过的组在前', () => {
  const g = groupRows(ruler);
  assert.deepEqual(g.map((x) => x.dev), ['串口', '蜂鸣器', '屏幕']);
  assert.equal(g[0].pin, undefined);
  assert.equal(g[1].pin, 'GPIO5');
  assert.equal(g[1].rows.length, 4);
  assert.equal(g[1].sum, '蜂鸣器一直没响');
});

test('标题按器件数，不按时间窗数', () => {
  assert.equal(headline(ruler), '有 2 个器件不对');
  assert.equal(headline(ruler.slice(1)), '蜂鸣器一直没响');
  assert.equal(headline(ruler.slice(0, 2)), '串口没打印「DIST 15.0 cm」');
  assert.equal(headline(ruler.filter((r) => r.ok)), '3 项都通过了');
});

test('没有 dev 的旧结果按 tag 分组', () => {
  const g = groupRows([{ ok: false, text: 'a', tag: 'GPIO2' }, { ok: false, text: 'b', tag: 'GPIO2' }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].sum, 'GPIO2 有 2 处不对');
});
