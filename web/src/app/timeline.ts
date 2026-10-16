// 最底的时间线条：每一步是一个格子（放零件、连线、运行 #n）。本组件只负责画和点；
// 回到某一步的确定性重算由 P0-03 接在 onSeek 上。

export interface TimelineStep {
  id: string;
  /** 单个字符或短符号，不用 emoji */
  icon: string;
  label: string;
  status?: 'ok' | 'bad' | 'run';
}

export interface Timeline {
  setSteps(steps: TimelineStep[]): void;
  setCurrent(i: number): void;
  onSeek(cb: (i: number, step: TimelineStep) => void): void;
}

export function createTimeline(el: HTMLElement): Timeline {
  let steps: TimelineStep[] = [];
  let cur = -1;
  const cbs: ((i: number, s: TimelineStep) => void)[] = [];
  el.classList.add('tl');
  el.setAttribute('role', 'list');
  const mark = { ok: '✓', bad: '✗', run: '…' } as const;
  function render() {
    el.innerHTML = '';
    steps.forEach((s, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'tl-sep';
        el.appendChild(sep);
      }
      const b = document.createElement('button');
      b.type = 'button';
      // 点回中间某步后，后面的步骤画淡（还在，接着改会被丢掉）
      b.className = 'tl-step' + (i === cur ? ' on' : '') + (cur >= 0 && i > cur ? ' after' : '') + (s.status ? ' ' + s.status : '');
      b.setAttribute('role', 'listitem');
      b.dataset.id = s.id;
      b.innerHTML = `<span class="tl-ic"></span><span class="tl-t"></span>${s.status ? `<span class="tl-st">${mark[s.status]}</span>` : ''}`;
      b.querySelector('.tl-ic')!.textContent = s.icon;
      b.querySelector('.tl-t')!.textContent = s.label;
      b.onclick = () => cbs.forEach((f) => f(i, s));
      el.appendChild(b);
    });
    // 只横向滚时间线自己：scrollIntoView 会连带滚整页（手机上面板堆叠、整页可滚，一跑起来就被拽到页底）
    const on = el.querySelector<HTMLElement>('.tl-step.on');
    if (on) {
      const l = on.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft, r = l + on.offsetWidth;
      if (l < el.scrollLeft) el.scrollLeft = l;
      else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth;
    }
  }
  return {
    setSteps(s) {
      steps = s.slice();
      if (cur >= steps.length) cur = steps.length - 1;
      render();
    },
    setCurrent(i) {
      cur = i;
      render();
    },
    onSeek(cb) {
      cbs.push(cb);
    },
  };
}
