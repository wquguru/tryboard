import { createBench } from './board3d';
import type { FromWorker, ToWorker } from './worker';

interface Example {
  id: string;
  title: string;
  about: string;
  tags: string[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const consoleEl = $<HTMLPreElement>('console');
const runBtn = $<HTMLButtonElement>('run');
const resetBtn = $<HTMLButtonElement>('reset');
const exampleSel = $<HTMLSelectElement>('example');

const bench = createBench($('stage'));
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

let wasm: ArrayBuffer | null = null;
let rom: ArrayBuffer | null = null;
let flash: ArrayBuffer | null = null;
let running = false;
let examples: Example[] = [];

function log(text: string, cls?: string) {
  const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 8;
  if (cls) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    consoleEl.appendChild(s);
  } else {
    consoleEl.appendChild(document.createTextNode(text));
  }
  // 控制台只留最近约 200KB
  if (consoleEl.textContent!.length > 200_000) consoleEl.textContent = consoleEl.textContent!.slice(-150_000);
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function setRunning(r: boolean) {
  running = r;
  runBtn.textContent = r ? '❚❚ 暂停' : '▶ 运行';
}

async function fetchBuf(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

function boot(autorun: boolean) {
  if (!wasm || !rom || !flash) return;
  consoleEl.textContent = '';
  log('[试板] 上电，加载固件…\n', 'sys');
  bench.setPowered(true);
  pendingAutorun = autorun;
  send({ type: 'boot', wasm: wasm.slice(0), rom: rom.slice(0), flash: flash.slice(0) });
}
let pendingAutorun = false;

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'booted':
      runBtn.disabled = resetBtn.disabled = false;
      if (pendingAutorun) {
        send({ type: 'run' });
        setRunning(true);
      }
      break;
    case 'error':
      log(`[试板] 启动失败：${m.message}\n`, 'err');
      bench.setPowered(false);
      break;
    case 'tick':
      if (m.console) log(m.console);
      bench.setGpio(m.gpio, m.enable);
      $('simtime').textContent = `${m.simSeconds.toFixed(3)} s`;
      if (m.running) {
        const r = $('ratio');
        r.textContent = `${m.ratio.toFixed(2)}× 实时`;
        r.classList.toggle('slow', m.ratio < 0.9);
      }
      break;
    case 'stopped':
      setRunning(false);
      log(`\n[试板] 停止：${m.reason}\n`, 'err');
      break;
  }
};

runBtn.onclick = () => {
  if (running) {
    send({ type: 'pause' });
    setRunning(false);
  } else {
    send({ type: 'run' });
    setRunning(true);
  }
};
resetBtn.onclick = () => boot(true);
$<HTMLSelectElement>('speed').onchange = (e) => send({ type: 'speed', factor: Number((e.target as HTMLSelectElement).value) });
$('clear').onclick = () => (consoleEl.textContent = '');
$<HTMLFormElement>('uartForm').onsubmit = (e) => {
  e.preventDefault();
  const inp = $<HTMLInputElement>('uartIn');
  send({ type: 'uart', text: inp.value + '\n' });
  inp.value = '';
};
$<HTMLInputElement>('upload').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  flash = await f.arrayBuffer();
  $('about').innerHTML = `<p>自定义固件：${f.name}（${(f.size / 1024).toFixed(0)} KB）</p><p class="muted">支持 ESP-IDF / Arduino 构建出的完整 flash 镜像（含分区表），或单独的 app .bin。</p>`;
  boot(true);
};
bench.onButton((name, down) => {
  if (name === 'BOOT') send({ type: 'gpio', pin: 9, level: down ? 0 : -1 });
  if (name === 'RST' && !down) boot(true);
});

async function loadExample(id: string, autorun: boolean) {
  const ex = examples.find((e) => e.id === id)!;
  $('about').innerHTML = `<p><b>${ex.title}</b></p><p>${ex.about}</p><p>${ex.tags.map((t) => `<span class="tag ${t.startsWith('✓') ? 'ok' : ''}">${t}</span>`).join('')}</p>`;
  flash = await fetchBuf(`./fw/${id}/flash.bin`);
  boot(autorun);
}

exampleSel.onchange = () => loadExample(exampleSel.value, true);

(async () => {
  try {
    [wasm, rom] = await Promise.all([fetchBuf('./wasm/tryboard.wasm'), fetchBuf('./rom/esp32c3_rev3_rom.elf')]);
    examples = await (await fetch('./fw/examples.json')).json();
    for (const e of examples) exampleSel.add(new Option(e.title, e.id));
    const want = new URLSearchParams(location.search).get('example');
    const first = examples.find((e) => e.id === want) ?? examples[0];
    exampleSel.value = first.id;
    await loadExample(first.id, new URLSearchParams(location.search).get('autorun') !== '0');
  } catch (err) {
    log(`[试板] 资源加载失败：${err}\n`, 'err');
  }
})();
