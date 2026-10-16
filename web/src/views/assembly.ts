// 拖拽装配：把六个零件按从下到上的顺序装进外壳，装完开机看成品。
// 装配检查是几何估算（尺寸、线长、温漂），不是仿真；但"传感器贴着芯片"会真实地改变模拟器里传感器读到的温度，
// 成品屏幕上的读数随之偏高——同一份固件，装法不同，结果不同。
import { mount, type LiveFrame } from './common';
import { createProductView, type ProductHandlers } from './product';

export type PartId = 'shell' | 'board' | 'bme' | 'servo' | 'oled' | 'front';
export const ORDER: PartId[] = ['shell', 'board', 'bme', 'servo', 'oled', 'front'];
const NAME: Record<PartId, string> = { shell: '后壳', board: 'ESP32-S3 开发板', bme: 'BME280', servo: 'SG90 舵机', oled: 'OLED 0.96″', front: '前面板' };
const SHORT: Record<PartId, string> = { shell: '后壳', board: '开发板', bme: 'BME280', servo: '舵机', oled: 'OLED', front: '前面板' };
/** 传感器贴着芯片时比室温高多少（估算：ESP32-S3 满载壳内温升的量级，未经真机标定） */
export const CHIP_HEAT_OFFSET = 2.5;
const OK_MSG: Record<string, [string, string]> = {
  shell: ['后壳就位', 'USB-C 开孔朝后'],
  board: ['开发板卡进卡扣', 'GPIO4→舵机 · SDA/SCL→屏和传感器'],
  bmeA: ['传感器靠着通风口', '读到的就是室温'],
  bmeB: ['传感器贴着芯片', `芯片发热，读数会偏高约 ${CHIP_HEAT_OFFSET} ℃`],
  servo: ['舵机轴对准表盘中心', '指针从 0 ℃ 扫到 40 ℃'],
  oled: ['屏幕排线 8 cm', '从开发板够得到前面板'],
  front: ['合上了', '点「开机看成品」'],
};
const INTRO: [string, string] = ['把零件拖进壳里', '从最底下那层开始'];

// 零件盘里的平面小图（100×60）
const MINI: Record<PartId, string> = {
  shell: '<rect width="100" height="60" rx="8" fill="#E9E5DC" stroke="#8A867E" stroke-width="1.5"/><rect x="6" y="6" width="88" height="48" rx="5" fill="#D6D1C6"/><path d="M86 18 L92 18 M86 26 L92 26 M86 34 L92 34 M86 42 L92 42" stroke="#8A867E" stroke-width="2"/><rect y="24" width="6" height="12" fill="#3A3936"/>',
  board: '<rect x="2" y="10" width="96" height="40" rx="3" fill="#141414"/><rect x="50" y="15" width="42" height="30" rx="2" fill="#BDB9B0"/><rect y="22" width="8" height="14" fill="#8A867E"/><circle cx="22" cy="18" r="3.5" fill="#22C55E"/>',
  bme: '<rect x="32" y="12" width="36" height="34" rx="3" fill="#6A3FA0"/><rect x="44" y="22" width="12" height="12" fill="#C9C6BF"/><path d="M38 46 L38 54 M46 46 L46 54 M54 46 L54 54 M62 46 L62 54" stroke="#E8C547" stroke-width="2"/>',
  servo: '<rect x="20" y="16" width="60" height="30" rx="3" fill="#2B5FD9"/><rect x="12" y="24" width="76" height="6" rx="2" fill="#2B5FD9"/><circle cx="36" cy="16" r="8" fill="#F7F6F3"/><path d="M36 16 L60 6" stroke="#F7F6F3" stroke-width="4" stroke-linecap="round"/>',
  oled: '<rect x="12" y="4" width="76" height="52" rx="3" fill="#1C4F86"/><rect x="18" y="12" width="64" height="34" fill="#050608"/><path d="M26 24 L46 24 M26 32 L60 32" stroke="#D7F3FF" stroke-width="3"/>',
  front: '<rect width="100" height="60" rx="8" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5"/><path d="M28 28 A22 22 0 0 1 72 28" fill="none" stroke="#141414" stroke-width="2"/><rect x="32" y="34" width="36" height="16" rx="2" fill="none" stroke="#141414" stroke-width="2"/>',
};
// 装好后的等轴测样子（局部坐标在 180×100 的壳内）
const ISO: Record<Exclude<PartId, 'bme'>, string> = {
  shell: '<rect width="180" height="100" rx="10" fill="#E9E5DC" stroke="#8A867E" stroke-width="1.5"/><rect x="8" y="8" width="164" height="84" rx="6" fill="#D6D1C6"/><rect y="40" width="10" height="20" fill="#3A3936"/><path d="M160 30 L172 30 M160 40 L172 40 M160 50 L172 50 M160 60 L172 60 M160 70 L172 70" stroke="#8A867E" stroke-width="2.5"/>',
  board: '<rect x="20" y="20" width="120" height="60" rx="3" fill="#141414"/><rect x="74" y="28" width="56" height="44" rx="2" fill="#BDB9B0"/><rect x="14" y="40" width="10" height="18" fill="#8A867E"/><circle cx="50" cy="32" r="4" fill="#22C55E"/>',
  servo: '<rect x="56" y="14" width="56" height="30" rx="3" fill="#2B5FD9"/><rect x="74" y="4" width="10" height="10" fill="#F7F6F3"/>',
  oled: '<rect x="50" y="52" width="80" height="40" rx="3" fill="#1C4F86"/><rect x="56" y="58" width="68" height="28" fill="#050608"/>',
  front: '<rect width="180" height="100" rx="10" fill="#F2EFE8" stroke="#8A867E" stroke-width="1.5" opacity="0.7"/><path d="M50 46 A40 40 0 0 1 130 46" fill="none" stroke="#141414" stroke-width="2"/><rect x="56" y="58" width="68" height="28" rx="3" fill="none" stroke="#141414" stroke-width="2"/>',
};
const BME_ISO = '<rect width="36" height="30" rx="2" fill="#6A3FA0"/><rect x="12" y="9" width="12" height="12" fill="#C9C6BF"/>';
const GHOST: Record<Exclude<PartId, 'bme'>, number[]> = { shell: [0, 0, 180, 100], board: [20, 20, 120, 60], servo: [56, 14, 56, 30], oled: [50, 52, 80, 40], front: [0, 0, 180, 100] };
/** BME280 的两个可选位置：A 通风口旁，B 开发板芯片旁 */
const BME_AT = { A: [128, 40], B: [74, 28] } as const;
export type BmeSpot = keyof typeof BME_AT;
const TRAY: PartId[] = ['servo', 'shell', 'oled', 'bme', 'front', 'board']; // 故意打乱

const layerY = (L: number) => 292 - L * 30;
const iso = (L: number, x: number, y: number) => [505 + 0.866 * x - 0.866 * y, layerY(L) + 0.5 * x + 0.5 * y];
const ghostRect = (r: number[], k: string) =>
  `<rect data-k="g_${k}" x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" rx="4" fill="#FF7A1A" fill-opacity="0.14" stroke="#FF7A1A" stroke-width="2" stroke-dasharray="6 5" opacity="0"/>`;

export interface AssemblyState {
  placed: PartId[];
  bme: BmeSpot | null;
}

/** 装配检查（估算）：返回 [颜色, 文字]，没装到的项目显示 — */
export function assemblyChecks(s: AssemblyState): { label: string; ok: boolean | null; text: string }[] {
  const has = (k: PartId) => s.placed.includes(k);
  return [
    { label: '传感器位置', ok: has('bme') ? s.bme === 'A' : null, text: has('bme') ? (s.bme === 'B' ? `! 贴着芯片，偏高约 ${CHIP_HEAT_OFFSET} ℃` : '✓ 通风口旁，读数准') : '—' },
    { label: '屏幕排线', ok: has('oled') ? true : null, text: has('oled') ? '✓ 8 cm，需要 ≥ 6 cm' : '—' },
    { label: '舵机轴心', ok: has('servo') ? true : null, text: has('servo') ? '✓ 对准表盘中心' : '—' },
    { label: '内腔高度', ok: has('front') ? true : null, text: has('front') ? '✓ 用了 27 / 32 mm' : '—' },
  ];
}

export interface AssemblyHandlers extends ProductHandlers {
  /** 传感器偏移变了（宿主据此改模拟器里传感器看到的温度） */
  offset(delta: number): void;
  /** 每一步操作（记进"你的操作"/串口） */
  step?(text: string): void;
  /** 进入 / 离开成品视图 */
  mode?(m: 'build' | 'product'): void;
}

export function createAssembly(el: HTMLElement, h: AssemblyHandlers, opts: { servoPin: number }) {
  const st: AssemblyState & { msg: [string, string]; bad: boolean; choosing: boolean; mode: 'build' | 'product' } = { placed: [], bme: null, msg: INTRO, bad: false, choosing: false, mode: 'build' };
  const svg: string[] = [];
  svg.push('<text x="28" y="44" fill="#F7F6F3" font-size="15" font-weight="700">零件盘</text><text x="84" y="44" fill="#9FBFB0" class="tb-mono" font-size="11">拖进壳里 · 也可以点一下</text>');
  TRAY.forEach((k, i) => {
    const cx = 28 + (i % 2) * 156, cy = 62 + Math.floor(i / 2) * 120;
    svg.push(`<g data-k="card_${k}" data-part="${k}" class="as-card" transform="translate(${cx} ${cy})" tabindex="0" role="button" aria-label="${NAME[k]}"><rect data-k="cs_${k}" width="144" height="108" rx="10" fill="#24392F" stroke="#3B5C4F" stroke-width="1.5"/><g transform="translate(22 12)">${MINI[k]}</g><text x="72" y="96" fill="#F7F6F3" font-size="12" font-weight="700" text-anchor="middle">${NAME[k]}</text><text data-k="ok_${k}" x="132" y="20" fill="#22C55E" class="tb-mono" font-size="14" font-weight="700" text-anchor="end" opacity="0">✓</text></g>`);
  });
  svg.push('<text x="28" y="446" fill="#9FBFB0" class="tb-mono" font-size="11">装错顺序会被拦下：上一层压着下一层</text>');
  svg.push('<text x="356" y="44" fill="#C9D6CF" class="tb-mono" font-size="12" font-weight="700">weather · 外壳 70×50×32 mm（估算）</text>');
  svg.push('<ellipse cx="545" cy="470" rx="170" ry="22" fill="#1E332A"/>');
  ORDER.forEach((k, L) => {
    svg.push(`<g transform="matrix(0.866 0.5 -0.866 0.5 505 ${layerY(L)})">`);
    if (k === 'bme') {
      svg.push(ghostRect([BME_AT.A[0], BME_AT.A[1], 36, 30], 'bmeA') + ghostRect([BME_AT.B[0], BME_AT.B[1], 36, 30], 'bmeB'));
      svg.push(`<g data-k="po_bme" opacity="0">${BME_ISO}</g>`);
    } else {
      svg.push(ghostRect(GHOST[k], k));
      svg.push(`<g data-k="po_${k}" opacity="0">${ISO[k]}</g>`);
    }
    svg.push('</g>');
  });
  const ga = iso(2, 164, 55), gb = iso(2, 74, 43);
  svg.push('<text data-k="gl" fill="#FF7A1A" font-size="13" font-weight="700" text-anchor="middle"></text>');
  svg.push(`<text data-k="glA" x="${ga[0] + 8}" y="${ga[1]}" fill="#FF7A1A" font-size="12" font-weight="700" opacity="0">← 通风口旁</text>`);
  svg.push(`<text data-k="glB" x="${gb[0] - 10}" y="${gb[1]}" fill="#FF7A1A" font-size="12" font-weight="700" text-anchor="end" opacity="0">开发板旁 →</text>`);
  svg.push('<rect x="704" y="24" width="272" height="512" rx="12" fill="#1A1A19"/>');
  svg.push('<text x="724" y="58" fill="#F7F6F3" font-size="16" font-weight="700">装配</text><text data-k="n" x="956" y="58" fill="#F7F6F3" class="tb-mono" font-size="16" font-weight="700" text-anchor="end">0/6</text>');
  for (let i = 0; i < 6; i++) svg.push(`<rect data-k="seg${i}" x="${724 + i * 39}" y="70" width="33" height="6" rx="3" fill="#2E2E2B"/>`);
  ['传感器位置', '屏幕排线', '舵机轴心', '内腔高度'].forEach((r, i) => {
    const y = 116 + i * 52;
    svg.push(`<text x="724" y="${y}" fill="#8A867E" font-size="12">${r}</text><text data-k="rv${i}" x="724" y="${y + 22}" fill="#55534F" font-size="13" font-weight="700">—</text>`);
  });
  svg.push('<rect x="716" y="330" width="248" height="78" rx="8" fill="#0E0E0D"/>');
  svg.push('<text data-k="ma" x="732" y="362" fill="#F7F6F3" font-size="14" font-weight="700"></text><text data-k="mb" x="732" y="390" fill="#C9C6BF" font-size="12"></text>');
  svg.push('<text x="724" y="522" fill="#6E6A63" class="tb-mono" font-size="10">尺寸、线长、温漂均为估算</text>');
  svg.push('<g data-k="float" style="pointer-events:none" opacity="0"><rect x="-8" y="-8" width="116" height="76" rx="10" fill="#FF7A1A" fill-opacity="0.18"/>');
  for (const k of ORDER) svg.push(`<g data-k="f_${k}" opacity="0">${MINI[k]}</g>`);
  svg.push('</g>');

  const q = mount(
    el,
    `<div class="tb-view as-root">
<div data-k="build" class="as-layer">
<svg data-k="svg" viewBox="0 0 1000 560" role="group" aria-label="拖拽装配：把六个零件按从下到上的顺序装进外壳">
<defs><pattern id="as-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0 L0 0 L0 40" fill="none" stroke="#3B5C4F"/></pattern></defs>
<rect width="1000" height="560" fill="#2E4A3F"/><rect width="1000" height="560" fill="url(#as-grid)"/>
${svg.join('\n')}
</svg>
<div data-k="choose" class="as-choose" hidden><button type="button" data-k="pickA" class="as-b as-hot">放通风口旁</button><button type="button" data-k="pickB" class="as-b as-light">放开发板旁</button></div>
<div class="as-actions"><button type="button" data-k="power" class="as-b as-hot" hidden>开机看成品 →</button><button type="button" data-k="reset" class="as-b as-ghost">重来</button></div>
</div>
<div data-k="product" class="as-layer" hidden><div data-k="productView"></div><button type="button" data-k="reopen" class="as-b as-light as-reopen">拆开重装</button></div>
</div>`,
  );
  const product = createProductView(q<HTMLElement>('productView'), h, opts);
  const svgEl = q<SVGSVGElement>('svg');

  const offset = () => (st.bme === 'B' ? CHIP_HEAT_OFFSET : 0);
  function place(id: PartId, spot?: BmeSpot) {
    const next = ORDER[st.placed.length];
    if (id !== next) {
      st.bad = true;
      st.choosing = false;
      st.msg = [`还不能装「${SHORT[id]}」`, next ? `先装「${SHORT[next]}」，它在更下面` : '已经装完了'];
      h.step?.(`装${SHORT[id]} ✗`);
      return render();
    }
    if (id === 'bme' && !spot) {
      st.choosing = true;
      st.bad = false;
      st.msg = ['BME280 放哪？', '通风口旁，还是开发板旁'];
      return render();
    }
    const before = offset();
    st.placed.push(id);
    if (id === 'bme') st.bme = spot!;
    st.choosing = false;
    st.bad = spot === 'B';
    st.msg = OK_MSG[id === 'bme' ? 'bme' + spot : id];
    h.step?.(`装${SHORT[id]}${spot === 'B' ? '（贴着芯片）' : spot === 'A' ? '（通风口旁）' : ''}`);
    if (offset() !== before) h.offset(offset());
    render();
  }
  function reset() {
    const before = offset();
    Object.assign(st, { placed: [], bme: null, msg: INTRO, bad: false, choosing: false });
    setMode('build');
    if (before) h.offset(0);
    h.step?.('重新装');
    render();
  }
  function setMode(m: 'build' | 'product') {
    if (st.mode === m) return;
    st.mode = m;
    q<HTMLElement>('build').hidden = m !== 'build';
    q<HTMLElement>('product').hidden = m !== 'product';
    h.mode?.(m);
  }

  function render() {
    const n = st.placed.length;
    const next = ORDER[n];
    const has = (k: PartId) => st.placed.includes(k);
    for (const k of ORDER) {
      const card = q(`card_${k}`);
      card.setAttribute('opacity', has(k) ? '0.4' : '1');
      card.classList.toggle('as-done', has(k));
      card.setAttribute('aria-disabled', String(has(k)));
      q(`cs_${k}`).setAttribute('stroke', k === next && st.bad ? '#FF7A1A' : '#3B5C4F');
      q(`ok_${k}`).setAttribute('opacity', has(k) ? '1' : '0');
      q(`po_${k}`).setAttribute('opacity', has(k) ? '1' : '0');
      if (k !== 'bme') q(`g_${k}`).setAttribute('opacity', k === next ? '0.9' : '0');
    }
    for (const s of ['A', 'B']) {
      q(`g_bme${s}`).setAttribute('opacity', next === 'bme' ? '0.9' : '0');
      q(`glB`).setAttribute('opacity', next === 'bme' ? '1' : '0');
      q(`glA`).setAttribute('opacity', next === 'bme' ? '1' : '0');
    }
    const bp = BME_AT[st.bme ?? 'A'];
    q('po_bme').setAttribute('transform', `translate(${bp[0]} ${bp[1]})`);
    const gl = q('gl');
    if (next && next !== 'bme') {
      const L = ORDER.indexOf(next);
      const c = iso(L, 90, 50);
      gl.setAttribute('x', String(c[0]));
      gl.setAttribute('y', String(c[1] - 70 + L * 2));
      gl.textContent = '放这里';
    } else gl.textContent = '';
    q('n').textContent = `${n}/6`;
    for (let i = 0; i < 6; i++) q(`seg${i}`).setAttribute('fill', i < n ? (i === 2 && st.bme === 'B' ? '#FF7A1A' : '#22C55E') : '#2E2E2B');
    assemblyChecks(st).forEach((c, i) => {
      const t = q(`rv${i}`);
      t.textContent = c.text;
      t.setAttribute('fill', c.ok === null ? '#55534F' : c.ok ? '#22C55E' : '#FF7A1A');
    });
    q('ma').textContent = st.msg[0];
    q('mb').textContent = st.msg[1];
    q('ma').setAttribute('fill', st.bad ? '#FF7A1A' : '#F7F6F3');
    q<HTMLElement>('choose').hidden = !st.choosing;
    q<HTMLElement>('power').hidden = n !== 6;
  }

  // 拖动：pointerdown 在卡片上，move / up 挂在窗口上；几乎没动就当作"点一下"
  const toSvg = (cx: number, cy: number) => {
    const m = svgEl.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    return [p.x, p.y];
  };
  const float = q('float');
  for (const k of ORDER) {
    const card = q(`card_${k}`);
    card.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if ((key === 'Enter' || key === ' ') && !st.placed.includes(k)) {
        e.preventDefault();
        place(k);
      }
    });
    card.addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent;
      if (st.placed.includes(k) || ev.button > 0) return;
      ev.preventDefault();
      const start = toSvg(ev.clientX, ev.clientY);
      let last = start;
      let moved = false;
      const show = () => {
        float.setAttribute('transform', `translate(${last[0] - 50} ${last[1] - 30})`);
        float.setAttribute('opacity', '1');
        for (const j of ORDER) q(`f_${j}`).setAttribute('opacity', j === k ? '1' : '0');
      };
      const move = (m: PointerEvent) => {
        last = toSvg(m.clientX, m.clientY);
        if (Math.hypot(last[0] - start[0], last[1] - start[1]) > 6) moved = true;
        if (moved) {
          card.setAttribute('opacity', '0.35');
          show();
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        float.setAttribute('opacity', '0');
        if (!moved) return place(k);
        const [x, y] = last;
        if (x < 340 || x > 700 || y < 40 || y > 530) return render(); // 放回零件盘
        if (k === 'bme' && ORDER[st.placed.length] === 'bme') {
          const a = iso(2, BME_AT.A[0] + 18, BME_AT.A[1] + 15);
          const b = iso(2, BME_AT.B[0] + 18, BME_AT.B[1] + 15);
          place(k, Math.hypot(x - a[0], y - a[1]) <= Math.hypot(x - b[0], y - b[1]) ? 'A' : 'B');
        } else place(k);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }
  q('pickA').addEventListener('click', () => place('bme', 'A'));
  q('pickB').addEventListener('click', () => place('bme', 'B'));
  q('reset').addEventListener('click', reset);
  q('power').addEventListener('click', () => {
    setMode('product');
    h.step?.('开机');
  });
  q('reopen').addEventListener('click', () => setMode('build'));
  render();

  return {
    update(f: LiveFrame, roomTemp: number) {
      if (st.mode === 'product') product.update(f, roomTemp, offset());
    },
    state: (): AssemblyState & { mode: string } => ({ placed: [...st.placed], bme: st.bme, mode: st.mode }),
    /** 装完且没有警告 */
    clean: () => st.placed.length === 6 && st.bme === 'A',
    place,
    reset,
  };
}
