// Drag-and-drop assembly: fit parts bottom-up per template (templates.ts), then power on the product. Checks are geometric
// estimates, but choices carry over: a sensor by the chip really reads warmer in the simulator; horn / lens choices change the picture.
import { t } from '../i18n';
import { fitText, mount, wrapText, type LiveFrame } from './common';
import type { ProductHandlers } from './product';
import { CHIP_HEAT_OFFSET, TEMPLATES, type Effects, type Part, type Template } from './templates';
import { createAsmCore } from './asmcore';

export { CHIP_HEAT_OFFSET };

/** Layer spacing: 30 normally, wider when exploded so each layer's contents are visible */
const GAP = 30;
const EXPLODED = 46;
const layerYg = (L: number, gap: number) => 292 - L * gap;
const isoG = (L: number, x: number, y: number, gap: number) => [505 + 0.866 * x - 0.866 * y, layerYg(L, gap) + 0.5 * x + 0.5 * y];
const layerY = (L: number) => layerYg(L, GAP);
const iso = (L: number, x: number, y: number) => isoG(L, x, y, GAP);
const ghostRect = (r: number[], k: string) =>
  `<rect data-k="g_${k}" x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" rx="4" fill="#FF7A1A" fill-opacity="0.14" stroke="#FF7A1A" stroke-width="2" stroke-dasharray="6 5" opacity="0"/>`;
/** Position choices (where the sensor goes) are made by dropping on a spot; others (horn centring) pop up a chooser */
const positional = (p: Part) => !!p.spots?.every((s) => s.at);

export interface AssemblyHandlers extends ProductHandlers {
  /** The assembly's effect on the simulator changed (currently the sensor offset) */
  offset(delta: number): void;
  step?(text: string): void;
  mode?(m: 'build' | 'product'): void;
}

export function createAssembly(el: HTMLElement, h: AssemblyHandlers, opts: { servoPin: number; template?: string }) {
  const T: Template = TEMPLATES[opts.template ?? 'weather'];
  const P = T.parts;
  const byId = Object.fromEntries(P.map((p) => [p.id, p])) as Record<string, Part>;
  const N = P.length;
  const core = createAsmCore(T);
  const st = core.st;
  let mode: 'build' | 'product' = 'build';

  const svg: string[] = [];
  svg.push(`<text data-fit="320" x="28" y="44"><tspan fill="#F7F6F3" font-size="15" font-weight="700">${t('Parts tray')}</tspan><tspan dx="10" fill="#9FBFB0" class="tb-mono" font-size="11">${t('Drag into the case · or just click')}</tspan></text>`);
  T.tray.forEach((k, i) => {
    const p = byId[k];
    const cx = 28 + (i % 2) * 156, cy = 62 + Math.floor(i / 2) * 120;
    svg.push(`<g data-k="card_${k}" data-part="${k}" class="as-card" transform="translate(${cx} ${cy})" tabindex="0" role="button" aria-label="${p.name}"><rect data-k="cs_${k}" width="144" height="108" rx="10" fill="#24392F" stroke="#3B5C4F" stroke-width="1.5"/><g transform="translate(22 12)">${p.mini}</g><text data-fit="136" x="72" y="96" fill="#F7F6F3" font-size="12" font-weight="700" text-anchor="middle">${p.name}</text><text data-k="ok_${k}" x="132" y="20" fill="#22C55E" class="tb-mono" font-size="14" font-weight="700" text-anchor="end" opacity="0">✓</text></g>`);
  });
  svg.push(`<text data-fit="300" x="28" y="446" fill="#9FBFB0" class="tb-mono" font-size="11">${t('Wrong order won’t fit: upper layers cover lower ones')}</text>`);
  svg.push(`<text data-fit="340" x="356" y="44" fill="#C9D6CF" class="tb-mono" font-size="12" font-weight="700">${T.caption}</text>`);
  svg.push('<ellipse cx="545" cy="470" rx="170" ry="22" fill="#1E332A"/>');
  const labels: string[] = [];
  /** In-layer tags ("← By the vent") move with the layer gap, so keep them for re-layout when exploding */
  const labelAt: { k: string; L: number; x: number; y: number; i: number }[] = [];
  P.forEach((p, L) => {
    svg.push(`<g data-k="layer${L}" transform="matrix(0.866 0.5 -0.866 0.5 505 ${layerY(L)})">`);
    if (positional(p)) {
      for (const s of p.spots!) svg.push(ghostRect([s.at![0], s.at![1], p.spotSize![0], p.spotSize![1]], p.id + s.key));
      svg.push(`<g data-k="po_${p.id}" opacity="0">${p.iso}</g>`);
      p.spots!.forEach((s, i) => {
        const c = iso(L, s.at![0] + p.spotSize![0] / 2, s.at![1] + p.spotSize![1] / 2);
        labelAt.push({ k: `gl_${p.id}${s.key}`, L, x: s.at![0] + p.spotSize![0] / 2, y: s.at![1] + p.spotSize![1] / 2, i });
        labels.push(`<text data-k="gl_${p.id}${s.key}" x="${c[0] + (i ? -40 : 40)}" y="${c[1] + 4}" fill="#FF7A1A" font-size="12" font-weight="700" text-anchor="${i ? 'end' : 'start'}" opacity="0">${i ? (s.where ?? s.label) + ' →' : '← ' + (s.where ?? s.label)}</text>`);
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
  svg.push(`<text x="724" y="58" fill="#F7F6F3" font-size="16" font-weight="700">${t('Assembly')}</text><text data-k="n" x="956" y="58" fill="#F7F6F3" class="tb-mono" font-size="16" font-weight="700" text-anchor="end">0/${N}</text>`);
  const segW = (234 - (N - 1) * 6) / N;
  for (let i = 0; i < N; i++) svg.push(`<rect data-k="seg${i}" x="${(724 + i * (segW + 6)).toFixed(1)}" y="70" width="${segW.toFixed(1)}" height="6" rx="3" fill="#2E2E2B"/>`);
  T.checks({ placed: [], choice: {} }).forEach((r, i) => {
    const y = 116 + i * 52;
    svg.push(`<text data-fit="232" x="724" y="${y}" fill="#8A867E" font-size="12">${r.label}</text><text data-k="rv${i}" data-fit="232" x="724" y="${y + 22}" fill="#55534F" font-size="13" font-weight="700">—</text>`);
  });
  svg.push('<rect x="716" y="330" width="248" height="78" rx="8" fill="#0E0E0D"/>');
  svg.push('<text data-k="ma" data-fit="224" x="732" y="362" fill="#F7F6F3" font-size="14" font-weight="700"></text><text data-k="mb" x="732" y="384" fill="#C9C6BF" font-size="12"></text>');
  svg.push(`<text data-fit="232" x="724" y="522" fill="#6E6A63" class="tb-mono" font-size="10">${t('Sizes, cable lengths, heating and angles are estimates')}</text>`);
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
<svg data-k="svg" viewBox="0 0 1000 560" role="group" aria-label="${t('Drag-and-drop assembly: fit the parts from the bottom up')}">
<defs><pattern id="as-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0 L0 0 L0 40" fill="none" stroke="#3B5C4F"/></pattern></defs>
<rect width="1000" height="560" fill="#2E4A3F"/><rect width="1000" height="560" fill="url(#as-grid)"/>
${svg.join('\n')}
</svg>
${choosers}
<div class="as-actions"><button type="button" data-k="power" class="as-b as-hot" hidden>${t('Power on the product →')}</button><button type="button" data-k="reset" class="as-b as-ghost">${t('Start over')}</button></div>
</div>
<div data-k="product" class="as-layer" hidden><div data-k="productView"></div><button type="button" data-k="reopen" class="as-b as-light as-reopen">${t('Take apart and rebuild')}</button></div>
</div>`,
  );
  const product = T.product(q<HTMLElement>('productView'), h, opts);
  const svgEl = q<SVGSVGElement>('svg');
  const fx = (): Effects => T.effects(st);
  let gap = GAP;
  function setExplode(on: boolean) {
    gap = on ? EXPLODED : GAP;
    P.forEach((_, L) => q(`layer${L}`).setAttribute('transform', `matrix(0.866 0.5 -0.866 0.5 505 ${layerYg(L, gap)})`));
    for (const a of labelAt) {
      const c = isoG(a.L, a.x, a.y, gap);
      q(a.k).setAttribute('x', String(c[0] + (a.i ? -40 : 40)));
      q(a.k).setAttribute('y', String(c[1] + 4));
    }
    render();
  }

  function place(id: string, spot?: string) {
    const r = core.place(id, spot);
    if (r.kind === 'rejected') h.step?.(t('Fit {part} ✗', { part: byId[id].short }));
    else if (r.kind === 'placed') {
      const s = byId[id].spots?.find((x) => x.key === spot);
      h.step?.(s ? t('Fit {part} ({choice})', { part: byId[id].short, choice: s.label }) : t('Fit {part}', { part: byId[id].short }));
      if (r.offsetChanged) h.offset(fx().sensorOffset ?? 0);
    }
    render();
  }
  function reset() {
    const had = core.reset();
    setMode('build');
    if (had) h.offset(0);
    h.step?.(t('Rebuild'));
    render();
  }
  function setMode(m: 'build' | 'product') {
    if (mode === m) return;
    mode = m;
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
      const c = isoG(L, 90, 50, gap);
      gl.setAttribute('x', String(c[0]));
      gl.setAttribute('y', String(c[1] - 70 + L * 2));
      gl.textContent = t('Drop here');
    } else gl.textContent = '';
    q('n').textContent = `${n}/${N}`;
    P.forEach((p, i) => {
      const s = p.spots?.find((x) => x.key === st.choice[p.id]);
      q(`seg${i}`).setAttribute('fill', i < n ? (s && !s.ok ? '#FF7A1A' : '#22C55E') : '#2E2E2B');
    });
    T.checks(st).forEach((c, i) => {
      const v = q(`rv${i}`);
      v.textContent = c.text;
      v.setAttribute('fill', c.ok === null ? '#55534F' : c.ok ? '#22C55E' : '#FF7A1A');
    });
    q('ma').textContent = st.msg[0];
    wrapText(q('mb'), st.msg[1], 224, 15);
    q('ma').setAttribute('fill', st.bad ? '#FF7A1A' : '#F7F6F3');
    q<HTMLElement>('power').hidden = n !== N;
    // Translations can run longer than the Chinese layout allowed; squeeze rather than overflow the panels
    svgEl.querySelectorAll('[data-fit]').forEach((e) => fitText(e, Number(e.getAttribute('data-fit'))));
  }

  // Drag: pointerdown on the card, move / up on window; barely moving counts as a click
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
        if (x < 340 || x > 700 || y < 40 || y > 530) return render(); // back to the tray
        if (positional(p) && P[st.placed.length]?.id === k) {
          const L = P.indexOf(p);
          let best = p.spots![0].key, dist = Infinity;
          for (const s of p.spots!) {
            const c = isoG(L, s.at![0] + p.spotSize![0] / 2, s.at![1] + p.spotSize![1] / 2, gap);
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
    h.step?.(t('Power on'));
  });
  q('reopen').addEventListener('click', () => setMode('build'));
  render();

  return {
    template: T.id,
    update(f: LiveFrame, roomTemp: number) {
      if (mode === 'product') product.update(f, roomTemp, fx());
    },
    state: () => ({ placed: [...st.placed], choice: { ...st.choice }, mode, total: N }),
    effects: fx,
    /** Fully assembled with no warnings */
    clean: core.clean,
    place,
    reset,
    /** Latest message (title, text) and whether it is a warning */
    message: () => ({ title: st.msg[0], text: st.msg[1], bad: st.bad }),
    /** Part waiting for the user to choose a placement */
    choosing: () => st.choosing,
    setExplode,
    exploded: () => gap !== GAP,
    /** Layer-local → SVG coords (follows explode), for overlays such as rulers */
    isoPoint: (L: number, x: number, y: number) => isoG(L, x, y, gap),
    svg: svgEl,
  };
}
