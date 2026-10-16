// 拖拽装配：按模板把零件从下到上装进外壳，装完开机看成品（模板见 templates.ts）。
// 装配检查是几何估算，但装法的影响会进成品：传感器贴着芯片 → 模拟器里传感器真的读到更高温度；
// 舵盘装偏 / 透镜高度 → 成品画面变化（标明估算）。
import { mount, type LiveFrame } from './common';
import type { ProductHandlers } from './product';
import { CHIP_HEAT_OFFSET, TEMPLATES, type Effects, type Part, type Picked, type Template } from './templates';

export { CHIP_HEAT_OFFSET };

const layerY = (L: number) => 292 - L * 30;
const iso = (L: number, x: number, y: number) => [505 + 0.866 * x - 0.866 * y, layerY(L) + 0.5 * x + 0.5 * y];
const ghostRect = (r: number[], k: string) =>
  `<rect data-k="g_${k}" x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" rx="4" fill="#FF7A1A" fill-opacity="0.14" stroke="#FF7A1A" stroke-width="2" stroke-dasharray="6 5" opacity="0"/>`;
/** 有位置差别的选择（如传感器放哪）可以拖到对应位置；没有位置差别的（如舵盘对不对中）放下后弹出选择 */
const positional = (p: Part) => !!p.spots?.every((s) => s.at);

export interface AssemblyHandlers extends ProductHandlers {
  /** 装法对模拟器的影响变了（目前是传感器偏移） */
  offset(delta: number): void;
  step?(text: string): void;
  mode?(m: 'build' | 'product'): void;
}

export function createAssembly(el: HTMLElement, h: AssemblyHandlers, opts: { servoPin: number; template?: string }) {
  const T: Template = TEMPLATES[opts.template ?? 'weather'];
  const P = T.parts;
  const byId = Object.fromEntries(P.map((p) => [p.id, p])) as Record<string, Part>;
  const N = P.length;
  const st: Picked & { msg: [string, string]; bad: boolean; choosing: string | null; mode: 'build' | 'product' } = { placed: [], choice: {}, msg: T.intro, bad: false, choosing: null, mode: 'build' };

  const svg: string[] = [];
  svg.push('<text x="28" y="44" fill="#F7F6F3" font-size="15" font-weight="700">零件盘</text><text x="84" y="44" fill="#9FBFB0" class="tb-mono" font-size="11">拖进壳里 · 也可以点一下</text>');
  T.tray.forEach((k, i) => {
    const p = byId[k];
    const cx = 28 + (i % 2) * 156, cy = 62 + Math.floor(i / 2) * 120;
    svg.push(`<g data-k="card_${k}" data-part="${k}" class="as-card" transform="translate(${cx} ${cy})" tabindex="0" role="button" aria-label="${p.name}"><rect data-k="cs_${k}" width="144" height="108" rx="10" fill="#24392F" stroke="#3B5C4F" stroke-width="1.5"/><g transform="translate(22 12)">${p.mini}</g><text x="72" y="96" fill="#F7F6F3" font-size="12" font-weight="700" text-anchor="middle">${p.name}</text><text data-k="ok_${k}" x="132" y="20" fill="#22C55E" class="tb-mono" font-size="14" font-weight="700" text-anchor="end" opacity="0">✓</text></g>`);
  });
  svg.push('<text x="28" y="446" fill="#9FBFB0" class="tb-mono" font-size="11">装错顺序会被拦下：上一层压着下一层</text>');
  svg.push(`<text x="356" y="44" fill="#C9D6CF" class="tb-mono" font-size="12" font-weight="700">${T.caption}</text>`);
  svg.push('<ellipse cx="545" cy="470" rx="170" ry="22" fill="#1E332A"/>');
  const labels: string[] = [];
  P.forEach((p, L) => {
    svg.push(`<g transform="matrix(0.866 0.5 -0.866 0.5 505 ${layerY(L)})">`);
    if (positional(p)) {
      for (const s of p.spots!) svg.push(ghostRect([s.at![0], s.at![1], p.spotSize![0], p.spotSize![1]], p.id + s.key));
      svg.push(`<g data-k="po_${p.id}" opacity="0">${p.iso}</g>`);
      p.spots!.forEach((s, i) => {
        const c = iso(L, s.at![0] + p.spotSize![0] / 2, s.at![1] + p.spotSize![1] / 2);
        labels.push(`<text data-k="gl_${p.id}${s.key}" x="${c[0] + (i ? -40 : 40)}" y="${c[1] + 4}" fill="#FF7A1A" font-size="12" font-weight="700" text-anchor="${i ? 'end' : 'start'}" opacity="0">${i ? s.label.replace(/^放/, '') + ' →' : '← ' + s.label.replace(/^放/, '')}</text>`);
      });
    } else {
      svg.push(ghostRect(p.ghost!, p.id));
      svg.push(`<g data-k="po_${p.id}" opacity="0">${p.iso}</g>`);
    }
    svg.push('</g>');
  });
  svg.push(...labels);
  svg.push('<text data-k="gl" fill="#FF7A1A" font-size="13" font-weight="700" text-anchor="middle"></text>');
  svg.push('<rect x="704" y="24" width="272" height="512" rx="12" fill="#1A1A19"/>');
  svg.push(`<text x="724" y="58" fill="#F7F6F3" font-size="16" font-weight="700">装配</text><text data-k="n" x="956" y="58" fill="#F7F6F3" class="tb-mono" font-size="16" font-weight="700" text-anchor="end">0/${N}</text>`);
  const segW = (234 - (N - 1) * 6) / N;
  for (let i = 0; i < N; i++) svg.push(`<rect data-k="seg${i}" x="${(724 + i * (segW + 6)).toFixed(1)}" y="70" width="${segW.toFixed(1)}" height="6" rx="3" fill="#2E2E2B"/>`);
  T.checks({ placed: [], choice: {} }).forEach((r, i) => {
    const y = 116 + i * 52;
    svg.push(`<text x="724" y="${y}" fill="#8A867E" font-size="12">${r.label}</text><text data-k="rv${i}" x="724" y="${y + 22}" fill="#55534F" font-size="13" font-weight="700">—</text>`);
  });
  svg.push('<rect x="716" y="330" width="248" height="78" rx="8" fill="#0E0E0D"/>');
  svg.push('<text data-k="ma" x="732" y="362" fill="#F7F6F3" font-size="14" font-weight="700"></text><text data-k="mb" x="732" y="390" fill="#C9C6BF" font-size="12"></text>');
  svg.push('<text x="724" y="522" fill="#6E6A63" class="tb-mono" font-size="10">尺寸、线长、温漂、角度均为估算</text>');
  svg.push('<g data-k="float" style="pointer-events:none" opacity="0"><rect x="-8" y="-8" width="116" height="76" rx="10" fill="#FF7A1A" fill-opacity="0.18"/>');
  for (const p of P) svg.push(`<g data-k="f_${p.id}" opacity="0">${p.mini}</g>`);
  svg.push('</g>');
  const choosers = P.filter((p) => p.spots)
    .map((p) => `<div data-k="choose_${p.id}" class="as-choose" hidden>${p.spots!.map((s, i) => `<button type="button" data-k="pick${s.key}" class="as-b ${i ? 'as-light' : 'as-hot'}">${s.label}</button>`).join('')}</div>`)
    .join('');

  const q = mount(
    el,
    `<div class="tb-view as-root" data-template="${T.id}">
<div data-k="build" class="as-layer">
<svg data-k="svg" viewBox="0 0 1000 560" role="group" aria-label="拖拽装配：把零件按从下到上的顺序装好">
<defs><pattern id="as-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0 L0 0 L0 40" fill="none" stroke="#3B5C4F"/></pattern></defs>
<rect width="1000" height="560" fill="#2E4A3F"/><rect width="1000" height="560" fill="url(#as-grid)"/>
${svg.join('\n')}
</svg>
${choosers}
<div class="as-actions"><button type="button" data-k="power" class="as-b as-hot" hidden>开机看成品 →</button><button type="button" data-k="reset" class="as-b as-ghost">重来</button></div>
</div>
<div data-k="product" class="as-layer" hidden><div data-k="productView"></div><button type="button" data-k="reopen" class="as-b as-light as-reopen">拆开重装</button></div>
</div>`,
  );
  const product = T.product(q<HTMLElement>('productView'), h, opts);
  const svgEl = q<SVGSVGElement>('svg');
  const fx = (): Effects => T.effects(st);

  function place(id: string, spot?: string) {
    const next = P[st.placed.length]?.id;
    if (id !== next) {
      st.bad = true;
      st.choosing = null;
      st.msg = [`还不能装「${byId[id].short}」`, next ? `先装「${byId[next].short}」，它在更下面` : '已经装完了'];
      h.step?.(`装${byId[id].short} ✗`);
      return render();
    }
    const p = byId[id];
    if (p.spots && !spot) {
      st.choosing = id;
      st.bad = false;
      st.msg = [`${p.short}怎么装？`, p.spots.map((s) => s.label).join('，还是')];
      return render();
    }
    const before = fx().sensorOffset ?? 0;
    st.placed.push(id);
    const s = p.spots?.find((x) => x.key === spot);
    if (s) st.choice[id] = s.key;
    st.choosing = null;
    st.bad = !!s && !s.ok;
    st.msg = s ? s.msg : p.okMsg ?? ['装好了', ''];
    h.step?.(`装${p.short}${s ? `（${s.label}）` : ''}`);
    if ((fx().sensorOffset ?? 0) !== before) h.offset(fx().sensorOffset ?? 0);
    render();
  }
  function reset() {
    const before = fx().sensorOffset ?? 0;
    Object.assign(st, { placed: [], choice: {}, msg: T.intro, bad: false, choosing: null });
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
    const next = P[n]?.id;
    const done = (k: string) => st.placed.includes(k);
    for (const p of P) {
      const k = p.id;
      const card = q(`card_${k}`);
      card.setAttribute('opacity', done(k) ? '0.4' : '1');
      card.classList.toggle('as-done', done(k));
      card.setAttribute('aria-disabled', String(done(k)));
      q(`cs_${k}`).setAttribute('stroke', k === next && st.bad ? '#FF7A1A' : '#3B5C4F');
      q(`ok_${k}`).setAttribute('opacity', done(k) ? '1' : '0');
      q(`po_${k}`).setAttribute('opacity', done(k) ? '1' : '0');
      if (positional(p)) {
        for (const s of p.spots!) {
          q(`g_${k}${s.key}`).setAttribute('opacity', k === next ? '0.9' : '0');
          q(`gl_${k}${s.key}`).setAttribute('opacity', k === next ? '1' : '0');
        }
        const at = p.spots!.find((s) => s.key === st.choice[k])?.at ?? p.spots![0].at!;
        q(`po_${k}`).setAttribute('transform', `translate(${at[0]} ${at[1]})`);
      } else q(`g_${k}`).setAttribute('opacity', k === next ? '0.9' : '0');
      if (p.spots) q<HTMLElement>(`choose_${k}`).hidden = st.choosing !== k;
    }
    const gl = q('gl');
    const np = next ? byId[next] : null;
    if (np && !positional(np)) {
      const L = P.indexOf(np);
      const c = iso(L, 90, 50);
      gl.setAttribute('x', String(c[0]));
      gl.setAttribute('y', String(c[1] - 70 + L * 2));
      gl.textContent = '放这里';
    } else gl.textContent = '';
    q('n').textContent = `${n}/${N}`;
    P.forEach((p, i) => {
      const s = p.spots?.find((x) => x.key === st.choice[p.id]);
      q(`seg${i}`).setAttribute('fill', i < n ? (s && !s.ok ? '#FF7A1A' : '#22C55E') : '#2E2E2B');
    });
    T.checks(st).forEach((c, i) => {
      const t = q(`rv${i}`);
      t.textContent = c.text;
      t.setAttribute('fill', c.ok === null ? '#55534F' : c.ok ? '#22C55E' : '#FF7A1A');
    });
    q('ma').textContent = st.msg[0];
    q('mb').textContent = st.msg[1];
    q('ma').setAttribute('fill', st.bad ? '#FF7A1A' : '#F7F6F3');
    q<HTMLElement>('power').hidden = n !== N;
  }

  // 拖动：pointerdown 在卡片上，move / up 挂在窗口上；几乎没动就当作"点一下"
  const toSvg = (cx: number, cy: number) => {
    const m = svgEl.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    return [p.x, p.y];
  };
  const float = q('float');
  for (const p of P) {
    const k = p.id;
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
      const move = (m: PointerEvent) => {
        last = toSvg(m.clientX, m.clientY);
        if (Math.hypot(last[0] - start[0], last[1] - start[1]) > 6) moved = true;
        if (!moved) return;
        card.setAttribute('opacity', '0.35');
        float.setAttribute('transform', `translate(${last[0] - 50} ${last[1] - 30})`);
        float.setAttribute('opacity', '1');
        for (const j of P) q(`f_${j.id}`).setAttribute('opacity', j.id === k ? '1' : '0');
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        float.setAttribute('opacity', '0');
        if (!moved) return place(k);
        const [x, y] = last;
        if (x < 340 || x > 700 || y < 40 || y > 530) return render(); // 放回零件盘
        if (positional(p) && P[st.placed.length]?.id === k) {
          const L = P.indexOf(p);
          let best = p.spots![0].key, dist = Infinity;
          for (const s of p.spots!) {
            const c = iso(L, s.at![0] + p.spotSize![0] / 2, s.at![1] + p.spotSize![1] / 2);
            const d = Math.hypot(x - c[0], y - c[1]);
            if (d < dist) [best, dist] = [s.key, d];
          }
          place(k, best);
        } else place(k);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    for (const s of p.spots ?? []) q(`choose_${k}`).querySelector(`[data-k="pick${s.key}"]`)!.addEventListener('click', () => place(k, s.key));
  }
  q('reset').addEventListener('click', reset);
  q('power').addEventListener('click', () => {
    setMode('product');
    h.step?.('开机');
  });
  q('reopen').addEventListener('click', () => setMode('build'));
  render();

  return {
    template: T.id,
    update(f: LiveFrame, roomTemp: number) {
      if (st.mode === 'product') product.update(f, roomTemp, fx());
    },
    state: () => ({ placed: [...st.placed], choice: { ...st.choice }, mode: st.mode, total: N }),
    effects: fx,
    /** 装完且没有警告 */
    clean: () => st.placed.length === N && P.every((p) => !p.spots || p.spots.find((s) => s.key === st.choice[p.id])?.ok),
    place,
    reset,
  };
}
