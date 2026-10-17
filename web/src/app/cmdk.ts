// ⌘K 命令框（P1-06）：顶部正中的输入框 + 下拉列表。搜零件（选中并在台面上高亮）、引脚（GPIO4）、检查点，
// 执行命令：量 3V3、把室温设为 N ℃、换外接 5 V / USB 并重跑、回到第 n 次运行、打开逻辑分析仪、切到四个步骤。
// ⌘K / Ctrl+K 打开；焦点在别的输入框里时不抢这个键（用户可能在输入框里用它）。上下键选、回车执行、Esc 关；记最近用过的。
import type { StepCtx, StepId, SelKind } from './types';
import { fuzzy, highlight, parseRun, parseTemp, pushRecent } from './cmdmatch';
import { partId, partInfo } from './wiring';
import { getAnalyzer } from './analyzer';

interface Item {
  id: string;
  group: string;
  label: string;
  meta?: string;
  keys?: string;
  /** 执行后不关框（比如还缺参数，把提示填进输入框） */
  keep?: boolean;
  run(): void | Promise<unknown>;
}

const RECENT_KEY = 'tryboard-cmdk-recent';
const STEP_NAMES: [StepId, string, string][] = [
  ['shop', '采购', 'shop caigou 清单 买'],
  ['bench', '实验台', 'bench shiyantai 台面'],
  ['assemble', '组装', 'assemble zuzhuang 外壳 装'],
  ['product', '成品', 'product chengpin 3d'],
];

export interface Cmdk {
  open(q?: string): void;
  close(): void;
  /** 测试用：按当前输入列出的条目 */
  items(): { id: string; label: string; group: string }[];
  /** 测试用：直接执行（等同于输入 q 后回车第一条） */
  exec(q: string): Promise<string | null>;
}

export function createCmdk(ctx: StepCtx): Cmdk {
  const { session, store, shell, work } = ctx;
  const input = document.getElementById('cmdk') as HTMLInputElement;
  const box = input.closest('.cmdk') as HTMLElement;
  const list = document.createElement('div');
  list.className = 'pnl cmdk-list';
  list.id = 'cmdkList';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  document.body.appendChild(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', 'cmdkList');
  input.setAttribute('aria-expanded', 'false');
  input.placeholder = '搜零件、引脚、命令（如：室温 35）';

  let shown: Item[] = [];
  let sel = 0;
  let recent: string[] = [];
  try {
    recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(recent)) recent = [];
  } catch {
    recent = [];
  }

  const goBench = () => {
    if (store.get().step !== 'bench') location.hash = 'bench';
  };
  const select = (kind: SelKind, id: string) => {
    goBench();
    store.set({ selection: { kind, id } });
  };

  function setTemp(t: number) {
    const v = Math.max(-10, Math.min(45, t));
    const env = { ...store.get().env, temp: v };
    ctx.hist?.op({ k: 'env', env });
    session.setEnv({ temp: v });
    shell.toast(`室温设为 ${v.toFixed(1)} ℃${v !== t ? `（超出 -10–45 ℃，按 ${v} ℃ 算）` : ''}，传感器读数、串口和 OLED 都会跟着变`);
  }
  function powerRerun(ext: boolean) {
    goBench();
    if (!!session.power?.ext5v !== ext) {
      ctx.hist?.op({ k: 'power', ext5v: ext });
      session.setPower(ext);
    }
    session.reboot();
    shell.toast(ext ? '舵机改由外接 5 V 2 A 供电，重新上电' : '舵机改回 USB 5 V 供电，重新上电');
  }
  async function backToRun(n: number) {
    const h = ctx.hist;
    if (!h) return;
    const i = h.steps().findIndex((s) => s.op.k === 'run' && s.op.n === n);
    if (i < 0) {
      shell.toast(`没有第 ${n} 次运行（现在有 ${h.runs().length} 次）`);
      return;
    }
    goBench();
    const r = await h.seek(i);
    if (r) shell.toast(`回到运行 #${r.run} 的 ${(r.untilMs / 1000).toFixed(2)} s${r.same === null ? '' : r.same ? ' · ✓ 指纹一致' : ' · ✗ 指纹不同'}`);
  }

  /** 按输入算出全部候选（参数命令随输入生成） */
  function candidates(q: string): Item[] {
    const out: Item[] = [];
    const temp = parseTemp(q);
    out.push(
      temp !== null
        ? { id: `temp:${temp}`, group: '命令', label: `把室温设为 ${temp} ℃`, meta: '环境', keys: '室温 温度 temp 设为', run: () => setTemp(temp) }
        : { id: 'temp', group: '命令', label: '把室温设为 … ℃', meta: '输入数字', keys: '室温 温度 temp 设为 环境 shiwen', keep: true, run: () => open('室温 ') },
    );
    const ana = getAnalyzer(ctx);
    out.push(
      { id: 'meter3v3', group: '命令', label: '量 3V3', meta: '万用表', keys: '万用表 电压 3.3 3v3 multimeter liang', run: () => { select('pin', '3V3'); shell.toast('先选中 3V3 引脚；要读电压，按工具条「万用表」再点 3V3'); } },
      { id: 'power:ext', group: '命令', label: '换外接 5 V 并重跑', meta: '供电', keys: '外接 5v 电源 power ext 重跑 舵机', run: () => powerRerun(true) },
      { id: 'power:usb', group: '命令', label: '换回 USB 供电并重跑', meta: '供电', keys: 'usb 电脑 power 重跑', run: () => powerRerun(false) },
      { id: 'rerun', group: '命令', label: '再跑一次（重新上电）', meta: '运行', keys: 'rerun reboot 重新上电 复位 reset', run: () => { goBench(); session.reboot(); } },
      { id: 'analyzer', group: '命令', label: ana.isOpen ? '关闭逻辑分析仪' : '打开逻辑分析仪', meta: '示波器', keys: '逻辑分析仪 示波器 波形 scope analyzer i2c pwm luoji', run: () => { goBench(); ana.toggle(); } },
    );
    for (const [id, name, keys] of STEP_NAMES) out.push({ id: `step:${id}`, group: '命令', label: `切到${name}`, meta: '步骤', keys: `${keys} 切到 去`, run: () => { location.hash = id; } });
    const runs = ctx.hist?.runs() ?? [];
    const rn = parseRun(q);
    for (const r of runs) {
      if (rn !== null && r.n !== rn) continue;
      out.push({ id: `run:${r.n}`, group: '运行', label: `回到第 ${r.n} 次运行`, meta: r.snap ? `${r.snap.simSeconds.toFixed(1)} s` : '运行中', keys: `回到 运行 run #${r.n} 回退 时间线`, run: () => backToRun(r.n) });
    }
    if (rn !== null && !runs.some((r) => r.n === rn)) out.push({ id: `run:${rn}`, group: '运行', label: `回到第 ${rn} 次运行`, meta: '不存在', keys: '回到 运行 run', run: () => backToRun(rn) });
    const board = session.chip === 'esp32s3' ? 'ESP32-S3-DevKitC-1' : 'ESP32-C3-DevKitM-1';
    out.push({ id: 'part:board', group: '零件', label: board, meta: '开发板', keys: 'board 开发板 esp32', run: () => select('part', 'board') });
    for (const p of session.scene.parts) {
      const info = partInfo(p);
      out.push({ id: `part:${partId(p)}`, group: '零件', label: info.name, meta: info.iface.split(' · ')[0], keys: `${p.type} ${info.model} ${info.iface}`, run: () => select('part', partId(p)) });
    }
    for (const p of session.pick.listPins?.() ?? []) out.push({ id: `pin:${p.id}`, group: '引脚', label: p.id, meta: p.role ?? '', keys: `${p.label} 引脚 针脚 pin`, run: () => select('pin', p.id) });
    for (const id of work.checkpoints) {
      const l = session.levels.find((x) => x.id === id);
      out.push({ id: `cp:${id}`, group: '检查点', label: `${id} ${l?.title ?? ''}`, meta: store.get().checks[id]?.ok ? '✓' : '', keys: '检查点 关卡 checkpoint 验收', run: () => select('checkpoint', id) });
    }
    return out;
  }

  function compute(q: string): Item[] {
    const all = candidates(q);
    if (!q.trim()) {
      const rec = recent.flatMap((id) => {
        const it = all.find((x) => x.id === id) ?? (id.startsWith('temp:') ? candidates(`室温 ${id.slice(5)}`)[0] : undefined);
        return it ? [{ ...it, group: '最近' }] : [];
      });
      const cmds = all.filter((x) => x.group === '命令' && !rec.some((r) => r.id === x.id));
      return [...rec, ...cmds, ...all.filter((x) => x.group === '运行').slice(-3)];
    }
    // 认出了参数（室温 35、第 2 次运行）：参数命令排最前
    const scored = all
      .map((it) => ({ it, m: fuzzy(q, it.label, it.keys) }))
      .filter((x) => x.m || (parseTemp(q) !== null && x.it.id.startsWith('temp:')) || (parseRun(q) !== null && x.it.id.startsWith('run:')))
      .map((x) => ({ it: x.it, score: (x.m?.score ?? 0) + (/^(temp:|run:)/.test(x.it.id) && (parseTemp(q) !== null || parseRun(q) !== null) ? 100 : 0), hits: x.m?.hits ?? [] }));
    scored.sort((a, b) => b.score - a.score);
    hitMap = new Map(scored.map((s) => [s.it.id, s.hits]));
    return scored.slice(0, 40).map((s) => s.it);
  }
  let hitMap = new Map<string, number[]>();

  function render() {
    const q = input.value;
    hitMap = new Map();
    shown = compute(q);
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    let html = '';
    let g = '';
    shown.forEach((it, i) => {
      if (it.group !== g) {
        g = it.group;
        html += `<div class="ck-g">${g}</div>`;
      }
      const hits = q.trim() ? (hitMap.get(it.id) ?? []) : [];
      html += `<button type="button" class="ck-i" role="option" id="ck-${i}" data-i="${i}" aria-selected="${i === sel}"><span class="ck-l">${highlight(it.label, hits)}</span>${it.meta ? `<span class="ck-m">${escHtml(it.meta)}</span>` : ''}</button>`;
    });
    if (!shown.length) html = `<div class="ck-empty">没有匹配「${escHtml(q)}」的零件、引脚或命令</div>`;
    html += '<div class="ck-foot"><span>↑↓ 选择</span><span>回车 执行</span><span>Esc 关闭</span></div>';
    list.innerHTML = html;
    input.setAttribute('aria-activedescendant', shown.length ? `ck-${sel}` : '');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    list.querySelectorAll<HTMLButtonElement>('.ck-i').forEach((b) =>
      b.addEventListener('mousedown', (e) => {
        // mousedown 里执行：click 之前输入框会先失焦关框
        e.preventDefault();
        void run(Number(b.dataset.i));
      }),
    );
  }

  async function run(i: number) {
    const it = shown[i];
    if (!it) return null;
    if (!it.keep) {
      recent = pushRecent(recent, it.id);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      } catch {
        /* 隐私模式：最近命令只在本页 */
      }
      close();
      input.value = '';
      input.blur();
    }
    await it.run();
    return it.label;
  }

  function open(q?: string) {
    if (q !== undefined) input.value = q;
    if (document.activeElement !== input) input.focus();
    sel = 0;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render();
  }
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('keydown', (e) => {
    if (!((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k')) return;
    const t = e.target as HTMLElement | null;
    // 焦点在别的输入框里：不抢（那里的 ⌘K 归那个输入框 / 浏览器）
    if (t && t !== input && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    if (list.hidden) {
      input.select();
      open();
    } else close();
  });
  input.addEventListener('focus', () => open());
  input.addEventListener('input', () => {
    sel = 0;
    open();
  });
  input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && close(), 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return open();
      const n = shown.length;
      if (n) sel = (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (list.hidden) open();
      else void run(sel);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      input.blur();
    }
  });
  box.querySelector('kbd')!.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

  return {
    open,
    close,
    items: () => {
      const q = input.value;
      return compute(q).map((x) => ({ id: x.id, label: x.label, group: x.group }));
    },
    async exec(q) {
      input.value = q;
      shown = compute(q);
      sel = 0;
      return run(0);
    },
  };
}

function escHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
