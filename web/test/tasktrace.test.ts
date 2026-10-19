// 任务时间线数据层（C-04）：切片、占用、Chrome Trace JSON 格式、app.elf 函数符号
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NO_TASK, ST, TaskStore, chromeJson, decodeTaskEvents, elfFuncs, funcAt, slices, usage, type TaskEvent } from '../src/app/tasktrace.ts';

const bytes = (ev: TaskEvent[]) => {
  const b = new Uint8Array(ev.length * 16);
  const dv = new DataView(b.buffer);
  ev.forEach((e, i) => {
    const o = i * 16;
    dv.setUint32(o, e.t % 2 ** 32, true);
    dv.setUint32(o + 4, Math.floor(e.t / 2 ** 32), true);
    dv.setUint8(o + 8, e.core);
    dv.setUint8(o + 9, e.prev);
    dv.setUint16(o + 10, e.task, true);
    dv.setUint32(o + 12, e.pc, true);
  });
  return b;
};

const EV: TaskEvent[] = [
  { t: 100, core: 0, prev: ST.NONE, task: 0, pc: 0x42000010 },
  { t: 110, core: 1, prev: ST.NONE, task: 1, pc: 0 },
  { t: 300, core: 0, prev: ST.WAIT, task: 2, pc: 0x42000020 },
  { t: 500, core: 0, prev: ST.READY, task: 0, pc: 0x42000010 },
  { t: 600, core: 1, prev: ST.GONE, task: NO_TASK, pc: 0 },
];

test('16 字节记录来回一致（含超过 2^32 的周期）', () => {
  const ev = [...EV, { t: 2 ** 33 + 5, core: 1, prev: ST.BLOCKED, task: 3, pc: 0xdeadbeef }];
  assert.deepEqual(decodeTaskEvents(bytes(ev)), ev);
});

test('切片：每核按切换切开，结束状态取下一次切换的 prev；NO_TASK 关掉本核的段', () => {
  const sl = slices(EV, 1000);
  assert.deepEqual(
    sl.map((s) => [s.core, s.task, s.t0, s.t1, s.end]),
    [
      [0, 0, 100, 300, ST.WAIT],
      [1, 1, 110, 600, ST.GONE],
      [0, 2, 300, 500, ST.READY],
      [0, 0, 500, 1000, ST.NONE],
    ],
  );
  const u = usage(sl);
  assert.equal(u.get('0:0'), 200 + 500);
  assert.equal(u.get('1:1'), 490);
  // 窗口裁剪
  assert.equal(usage(sl, 400, 900).get('0:2'), 100);
});

test('Chrome Trace JSON：合法、每核一条轨道、等待段补在任务轨道上，格式与 Rust 一致', () => {
  const tasks = [
    { name: 'main', prio: 1, core: -1, tcb: 1 },
    { name: 'w1', prio: 5, core: 1, tcb: 2 },
    { name: 'IDLE0', prio: 0, core: 0, tcb: 3 },
  ];
  const j = chromeJson(tasks, slices(EV, 1000), 'esp32s3', 2, 160_000_000, (a) => (a === 0x42000010 ? 'app_main' : undefined));
  const d = JSON.parse(j);
  assert.equal(d.displayTimeUnit, 'ms');
  const x = d.traceEvents.filter((e: { ph: string; pid: number }) => e.ph === 'X' && e.pid === 1);
  assert.deepEqual(
    x.map((e: { tid: number; name: string }) => `${e.tid}:${e.name}`),
    ['0:main', '1:w1', '0:IDLE0', '0:main'],
  );
  const wait = d.traceEvents.filter((e: { cat?: string }) => e.cat === 'wait');
  assert.equal(wait.length, 1);
  assert.equal(wait[0].tid, 10);
  // 逐字：与 Rust report::chrome_json 同一行（ts 微秒 3 位小数、args 字段顺序）
  assert.ok(j.includes('{"ph":"X","pid":1,"tid":0,"name":"main","cat":"task","ts":0.625,"dur":1.250,"args":{"prio":1,"pc":"0x42000010","resume":"app_main","out":"wait"}}'), j);
  assert.ok(j.startsWith('{"displayTimeUnit":"ms","traceEvents":[\n{"ph":"M","pid":1,"name":"process_name","args":{"name":"esp32s3 CPU"}}'));
});

test('仓库：reset 清空、任务表跟着消息走、此刻推进收尾段', () => {
  const s = new TaskStore();
  s.onMsg({ reset: true, data: bytes(EV.slice(0, 2)), table: '{"cores":2,"dropped":0,"tasks":[{"name":"main","prio":1,"core":-1,"tcb":1},{"name":"w1","prio":5,"core":1,"tcb":2}]}', chip: 'esp32s3' });
  assert.equal(s.cores, 2);
  assert.equal(s.tasks[1].name, 'w1');
  s.setNow(5000);
  assert.equal(s.slices().find((x) => x.task === 1)!.t1, 5000);
  assert.match(s.text(), /^0 main 100 5000 -$/m);
  s.onMsg({ reset: true, data: new Uint8Array(0), table: '{"cores":1,"dropped":0,"tasks":[]}' });
  assert.equal(s.events.length, 0);
  assert.equal(s.slices().length, 0);
});

const ELF = new URL('../../firmware/build/hello/app.elf', import.meta.url);
test('app.elf：从 .symtab 取函数符号，按地址找函数', { skip: !fs.existsSync(ELF) && '没构建 hello' }, () => {
  const b = fs.readFileSync(ELF);
  const syms = elfFuncs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))!;
  assert.ok(syms.length > 500, `${syms.length}`);
  const am = syms.find((s) => s.name === 'app_main')!;
  assert.ok(am);
  assert.equal(funcAt(syms, am.a + 2), 'app_main');
  assert.equal(elfFuncs(new ArrayBuffer(64)), null);
});
