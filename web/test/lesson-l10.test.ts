// H-16 lesson 10 (USB keyboard, usbkey · usbkey-2): data points at the real usbkey bench, firmware lines and checkpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L10 } from '../src/app/lessondata/l10.ts';
import { COURSE, courseLesson } from '../src/app/course.ts';
import { lessonFor } from '../src/app/lessons.ts';
import { lessonWires, partId, sceneView } from '../src/app/wiring.ts';
import { matchTask, parseDone, taskTarget } from '../src/app/lessontasks.ts';
import type { PartSpec } from '../src/bench3d/spec.ts';

const root = new URL('../../', import.meta.url);
type Level = { id: string; ref?: string; script?: string; usb?: { state?: string; typed?: string } };
const levels = JSON.parse(readFileSync(new URL('firmware/levels.json', root), 'utf8')) as Level[];
const examples = JSON.parse(readFileSync(new URL('firmware/examples.json', root), 'utf8')) as { id: string; scene?: { parts: PartSpec[] } }[];
const bench = examples.find((e) => e.id === 'usbkey')!.scene!;
const src = readFileSync(new URL(L10.src, root), 'utf8').split('\n');
const lv = levels.find((x) => x.id === 'usbkey-2')!;

test('lesson 10 sits in the course as usbkey-2 with its reference build', () => {
  const e = COURSE.find((x) => x.no === 10)!;
  assert.equal(e.work, 'usbkey');
  assert.equal(e.cp, 'usbkey-2');
  assert.equal(courseLesson(e), L10);
  assert.equal(lessonFor('usbkey', 'usbkey-2'), L10);
  assert.equal(L10.fw, lv.ref);
  assert.equal(L10.src, `firmware/${lv.ref}/main/main.c`);
  // The checkpoint is exactly what the lesson ticks: enumerated + K1-K3 typed abc
  assert.deepEqual(lv.usb, { state: 'configured', typed: 'abc' });
  for (const p of [4, 5, 6]) assert.match(lv.script!, new RegExp(`gpio${p}=0`));
});

test('bench shows only K1-K3, wire notes cover exactly their wires', () => {
  assert.deepEqual(L10.parts, ['key:4', 'key:5', 'key:6']);
  assert.deepEqual(sceneView(bench, L10.parts!).parts.map(partId), L10.parts);
  const rows = lessonWires(bench.parts, L10.parts!).map((w) => w.id);
  assert.deepEqual(rows.sort(), Object.keys(L10.wireNotes!).sort());
});

test('steps, callouts and tasks point at real bench items', () => {
  const rows = new Set(lessonWires(bench.parts, L10.parts!).map((w) => w.id));
  const parts = new Set(['board', ...L10.parts!]);
  const pins = new Set(['GPIO4', 'GPIO5', 'GPIO6']);
  assert.deepEqual(L10.steps.map((s) => s.id), ['keys', 'wire', 'enum', 'run', 'tweak']);
  for (const s of L10.steps) {
    assert.ok(s.callouts.length >= 2 && s.tasks.length >= 2, `${s.id}: callouts and tasks`);
    for (const c of s.callouts) {
      if (c.target.kind === 'wire') assert.ok(rows.has(c.target.id), `${s.id}: ${c.target.id}`);
      else if (c.target.kind === 'pin') assert.ok(pins.has(c.target.id), `${s.id}: ${c.target.id}`);
      else assert.ok(parts.has(c.target.id), `${s.id}: ${c.target.id}`);
    }
    for (const x of s.tasks) {
      assert.ok(parseDone(x.done), `${s.id}: ${x.done}`);
      const tg = taskTarget(x.done);
      if (tg) assert.ok(parts.has(tg.id) || pins.has(tg.id), `${s.id}: ${tg.id}`);
    }
  }
  const done = L10.steps.flatMap((s) => s.tasks.map((x) => x.done));
  for (const d of ['run', 'usb:configured', `usb:typed=${lv.usb!.typed}`]) assert.ok(done.includes(d), d);
});

test('usb signals tick enumeration and typed text', () => {
  assert.deepEqual(parseDone('usb:configured'), { kind: 'usb', what: 'configured' });
  assert.deepEqual(parseDone('usb:typed=abc'), { kind: 'usb', what: 'typed', text: 'abc' });
  assert.ok(matchTask('usb:configured', 'usb:configured', { boots: 0 }));
  assert.equal(matchTask('usb:configured', 'usb:typed=a', { boots: 0 }), null);
  assert.equal(matchTask('usb:typed=abc', 'usb:typed=ab', { boots: 0 }), null);
  assert.deepEqual(matchTask('usb:typed=abc', 'usb:typed=xxabcb', { boots: 0 }), { v: 'abc' });
});

test('code lines match the firmware', () => {
  const at = (n: number) => src[n - 1];
  assert.match(at(13), /KEY_GPIO\[4\] = \{4, 5, 6, 7\}/);
  assert.match(at(14), /KEY_CHAR\[3\] = \{'a', 'b', 'c'\}/);
  assert.match(at(17), /TUD_HID_REPORT_DESC_KEYBOARD/);
  assert.match(at(22), /"TryBoard"/);
  assert.match(at(23), /"TryBoard Macro Pad"/);
  assert.match(at(30), /TUD_CONFIG_DESCRIPTOR\(1, 1, .*, 100\)/);
  assert.match(at(31), /HID_ITF_PROTOCOL_KEYBOARD, .*0x81, 16, 10\)/);
  assert.match(at(38), /HID_ASCII_TO_KEYCODE/);
  assert.match(at(51), /tud_hid_keyboard_report\(0, ascii_map/);
  assert.match(at(52), /pdMS_TO_TICKS\(12\)/);
  assert.match(at(54), /tud_hid_keyboard_report\(0, 0, NULL\)/);
  assert.match(at(60), /pull_up_en = 1/);
  assert.match(at(71), /tinyusb_driver_install/);
  assert.match(at(73), /tud_mounted\(\)/);
  assert.match(at(75), /TRYBOARD_OK/);
  assert.match(at(82), /lv == last\[k\] && lv != stable\[k\]/);
  assert.match(at(84), /lv == 0 && tud_mounted\(\)/);
  assert.match(at(86), /KEY %d %c/);
  assert.match(at(87), /type_char\(KEY_CHAR\[k\]\)/);
  assert.match(at(96), /pdMS_TO_TICKS\(10\)/);
  for (const n of L10.code!.map((c) => c.line)) assert.ok(at(n)?.trim(), `line ${n}`);
  assert.ok(L10.params!.some((p) => p.source === 'datasheet' && p.doc));
  assert.ok(L10.params!.filter((p) => p.source === 'datasheet').every((p) => p.doc));
});
