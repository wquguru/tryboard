// R-19: content-hash manifest (tools/asset_hashes.py) and versioned URLs (assetver.ts): one changed byte moves one URL only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetUrl } from '../src/assetver.ts';

const script = fileURLToPath(new URL('../../tools/asset_hashes.py', import.meta.url));

function hashes(pub: string): Record<string, string> {
  const out = path.join(pub, '..', 'm.json');
  execFileSync('python3', [script, pub, out], { stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('asset_hashes: flipping one wasm byte changes only the wasm hash; sidecars are not listed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-r19-'));
  const pub = path.join(dir, 'public');
  const put = (rel: string, data: string | Uint8Array) => {
    fs.mkdirSync(path.dirname(path.join(pub, rel)), { recursive: true });
    fs.writeFileSync(path.join(pub, rel), data);
  };
  put('wasm/tryboard.wasm', new Uint8Array(4096).fill(7));
  put('wasm/tryboard.wasm.gz', 'gz');
  put('rom/esp32c3_rev3_rom.elf', 'rom');
  put('rom/NOTICE.txt', 'notice');
  put('fw/examples.json', '[]');
  for (const id of ['weather', 'blink']) {
    put(`fw/${id}/flash.bin`, `fw ${id}`);
    put(`fw/${id}/src.json`, `{"id":"${id}"}`);
    put(`fw/${id}/src.zip`, `zip ${id}`);
  }
  put('fonts/fonts.css', '@font-face{}');
  put('audio/sine1k.wav', 'RIFF');
  try {
    const a = hashes(pub);
    assert.deepEqual(Object.keys(a).sort(), [
      'audio/sine1k.wav', 'fonts/fonts.css', 'fw/blink/flash.bin', 'fw/blink/src.json', 'fw/blink/src.zip', 'fw/examples.json',
      'fw/weather/flash.bin', 'fw/weather/src.json', 'fw/weather/src.zip', 'rom/esp32c3_rev3_rom.elf', 'wasm/tryboard.wasm',
    ]);
    assert.ok(Object.values(a).every((h) => /^[0-9a-f]{10}$/.test(h)));
    assert.deepEqual(hashes(pub), a, 'same bytes, same hashes');
    const w = fs.readFileSync(path.join(pub, 'wasm/tryboard.wasm'));
    w[100] ^= 1;
    fs.writeFileSync(path.join(pub, 'wasm/tryboard.wasm'), w);
    const b = hashes(pub);
    assert.deepEqual(Object.keys(b).filter((k) => a[k] !== b[k]), ['wasm/tryboard.wasm']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assetUrl: ?v=<hash> for listed files, .gz sidecar shares the base hash, unknown / already-queried URLs unchanged', () => {
  globalThis.__TB_ASSETS__ = { 'wasm/tryboard.wasm': '0123456789', 'fw/weather/flash.bin': 'abcdef0123' };
  try {
    assert.equal(assetUrl('./wasm/tryboard.wasm'), './wasm/tryboard.wasm?v=0123456789');
    assert.equal(assetUrl('/wasm/tryboard.wasm'), '/wasm/tryboard.wasm?v=0123456789');
    assert.equal(assetUrl('./fw/weather/flash.bin.gz', './fw/weather/flash.bin'), './fw/weather/flash.bin.gz?v=abcdef0123');
    assert.equal(assetUrl('./fw/blink/flash.bin'), './fw/blink/flash.bin');
    assert.equal(assetUrl('./wasm/tryboard.wasm?x=1'), './wasm/tryboard.wasm?x=1');
  } finally {
    globalThis.__TB_ASSETS__ = undefined;
  }
  assert.equal(assetUrl('./wasm/tryboard.wasm'), './wasm/tryboard.wasm', 'no manifest (dev, npm CLI): plain URL');
});
