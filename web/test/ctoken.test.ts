// 代码页签的 C 高亮（P2-15）：记号拼回去等于原文，各类记号分得出来，块注释跨行
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/app/ctoken.ts';

const join = (src: string) => tokenize(src).map((l) => l.map((t) => t.t).join('')).join('\n');
const kinds = (line: string) => tokenize(line)[0].filter((t) => t.k).map((t) => `${t.k}:${t.t}`);

test('拼回原文', () => {
  const src = '#include "a.h" // x\nvoid app_main(void) {\n  /* a\n b */ int x = 0x3C; char *s = "q\\"z";\n}';
  assert.equal(join(src), src);
});

test('分类', () => {
  assert.deepEqual(kinds('static const uint8_t ADDR = 0x3C; // 地址'), ['kw:static', 'kw:const', 'type:uint8_t', 'mac:ADDR', 'num:0x3C', 'com:// 地址']);
  assert.deepEqual(kinds('#define LED_GPIO 5'), ['pre:#define LED_GPIO 5']);
  assert.deepEqual(kinds('printf("T=%.2f C\\n", t);'), ['str:"T=%.2f C\\n"']);
  assert.deepEqual(kinds("if (c == '\\'') return 1.5f;"), ['kw:if', "str:'\\''", 'kw:return', 'num:1.5f']);
});

test('块注释跨行', () => {
  const t = tokenize('a /* b\nc\nd */ e');
  assert.equal(t[1][0].k, 'com');
  assert.equal(t[2][0].t, 'd */');
  assert.equal(t[2][0].k, 'com');
  assert.equal(t[2].at(-1)!.k, '');
});
