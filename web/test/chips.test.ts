// R-03: the web chip tables must match the Rust Chip enum (`tryboard chips`), the single source of truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BOOT_GPIO, CHIP_ID, NPINS, RGB_GPIO, ROM_FILE, chipFromId, type SimChip } from '../src/chipid.ts';
import { CHIP_LABEL, BOARD_NAME } from '../src/chips.ts';

const bin = new URL('../../core/target/release/tryboard', import.meta.url).pathname;

test('chip tables match tryboard chips', { skip: !existsSync(bin) && 'build core/target/release/tryboard first' }, () => {
  const rows = JSON.parse(execFileSync(bin, ['chips'], { encoding: 'utf8' })) as { name: SimChip; id: number; npins: number; bootPin: number; rgbPin: number | null; rom: string }[];
  assert.deepEqual(rows.map((r) => r.name).sort(), (Object.keys(CHIP_ID) as SimChip[]).sort());
  for (const r of rows) {
    assert.equal(CHIP_ID[r.name], r.id, `${r.name} id`);
    assert.equal(NPINS[r.name], r.npins, `${r.name} npins`);
    assert.equal(BOOT_GPIO[r.name], r.bootPin, `${r.name} boot`);
    assert.equal(RGB_GPIO[r.name], r.rgbPin, `${r.name} rgb`);
    assert.equal(ROM_FILE[r.name], r.rom, `${r.name} rom`);
    assert.equal(chipFromId(r.id), r.name);
    assert.ok(CHIP_LABEL[r.name] && BOARD_NAME[r.name]);
  }
});

test('unknown chip ids are rejected, not mapped to C3', () => {
  for (const id of [-1, 2, 12, 13, 16, 18]) assert.equal(chipFromId(id), null);
});
