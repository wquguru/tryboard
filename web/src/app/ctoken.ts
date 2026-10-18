// 底部坞「代码」页签（P2-15）的 C 高亮：只分注释 / 字符串 / 预处理 / 关键字 / 类型 / 数字 / 宏常量，够读就行。
// 自己写而不引高亮库：首包预算紧，示例源码都是 ESP-IDF 风格的 C，规则很少。按行切，块注释跨行时带状态。
// 纯函数，web/test/ctoken.test.ts 直接测。

export type TokKind = 'com' | 'str' | 'pre' | 'kw' | 'type' | 'num' | 'mac' | '';
export interface Tok {
  k: TokKind;
  t: string;
}

const KW = new Set('if else for while do switch case default break continue return goto sizeof typedef struct union enum static const volatile extern inline register restrict true false NULL setup loop'.split(' '));
const TYPES = new Set('void char short int long float double signed unsigned bool size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t esp_err_t TaskHandle_t QueueHandle_t TickType_t BaseType_t'.split(' '));
const IDENT = /[A-Za-z_]\w*/y;
const NUM = /(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)[uUlLfF]*/y;

/** 把源码切成行，每行一串记号；块注释跨行时下一行接着当注释 */
export function tokenize(src: string): Tok[][] {
  const out: Tok[][] = [];
  let inCom = false;
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    const toks: Tok[] = [];
    const push = (k: TokKind, t: string) => {
      if (!t) return;
      const last = toks[toks.length - 1];
      if (last && last.k === k) last.t += t;
      else toks.push({ k, t });
    };
    let i = 0;
    if (inCom) {
      const e = line.indexOf('*/');
      if (e < 0) {
        push('com', line);
        out.push(toks);
        continue;
      }
      push('com', line.slice(0, e + 2));
      i = e + 2;
      inCom = false;
    }
    // 预处理行整行一个颜色（里面的注释仍按注释）
    if (/^\s*#/.test(line.slice(i))) {
      const c = line.indexOf('//', i);
      const b = line.indexOf('/*', i);
      const cut = [c, b].filter((x) => x >= 0).sort((x, y) => x - y)[0] ?? line.length;
      push('pre', line.slice(i, cut));
      i = cut;
    }
    while (i < line.length) {
      const ch = line[i];
      const two = line.slice(i, i + 2);
      if (two === '//') {
        push('com', line.slice(i));
        break;
      }
      if (two === '/*') {
        const e = line.indexOf('*/', i + 2);
        if (e < 0) {
          push('com', line.slice(i));
          inCom = true;
          break;
        }
        push('com', line.slice(i, e + 2));
        i = e + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
        push('str', line.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      IDENT.lastIndex = i;
      const id = IDENT.exec(line);
      if (id) {
        const w = id[0];
        push(KW.has(w) ? 'kw' : TYPES.has(w) || /_t$/.test(w) ? 'type' : /^[A-Z][A-Z0-9_]{2,}$/.test(w) ? 'mac' : '', w);
        i += w.length;
        continue;
      }
      NUM.lastIndex = i;
      const n = /\d/.test(ch) ? NUM.exec(line) : null;
      if (n) {
        push('num', n[0]);
        i += n[0].length;
        continue;
      }
      push('', ch);
      i++;
    }
    out.push(toks);
  }
  return out;
}
