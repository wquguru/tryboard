// 拍照 / 录 10 秒（P2-10）。拍照 = 当前视角的高分辨率静帧：渲染器按 2× 输出尺寸再超采样一倍画一帧（含 bloom），
// 背景换成 DESIGN §2 的台面渐变，缩到输出尺寸、角落写上作品名和"外观示意"，PNG 用 Blob 下载。
// （three-gpu-pathtracer 不在依赖里，按 DECISIONS 不新装；超采样 + 渐变背景是它的替代。）
// 录 10 秒 = MediaRecorder 录 3D 画布（canvas.captureStream），声音开着时把 Web Audio 的蜂鸣器混进去，webm 用 Blob 下载。
import * as THREE from 'three';
import { currentTheme } from '../theme';

/** 3D 场景交出来给拍照用的东西：渲染器、场景、按当前尺寸渲染一帧（含后期）、改像素比（含 composer） */
export interface Capturable {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  render(): void;
  setPixelRatio(pr: number): void;
}

/** 带 EffectComposer 的场景：改像素比时 composer 跟着改（bloom / 描边的分辨率随之变） */
export function capturableOf(renderer: THREE.WebGLRenderer, scene: THREE.Scene, composer: { render(): void; setPixelRatio(pr: number): void; setSize(w: number, h: number): void }): Capturable {
  return {
    renderer,
    scene,
    render: () => composer.render(),
    setPixelRatio(pr) {
      renderer.setPixelRatio(pr);
      composer.setPixelRatio(pr);
      const s = renderer.getSize(new THREE.Vector2());
      composer.setSize(s.x, s.y);
    },
  };
}

/** 输出是画布 CSS 尺寸的几倍 */
export const STILL_SCALE = 2;
/** 渲染时长边最多多少像素（超采样受显存和 maxTextureSize 限制） */
const RENDER_MAX = 4096;
/** 输出长边上限 */
const OUT_MAX = 4096;

const GRAD = { light: ['#FFFFFF', '#ECEFF3'], dark: ['#2B2E33', '#16171A'] } as const;

function gradientTexture(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = Math.max(2, Math.round((512 * h) / w));
  const g = c.getContext('2d')!;
  const [a, b] = GRAD[currentTheme()];
  // radial-gradient(120% 90% at 50% 40%, a, b)
  const gr = g.createRadialGradient(c.width / 2, c.height * 0.4, 0, c.width / 2, c.height * 0.4, Math.max(c.width * 0.6, c.height * 0.9));
  gr.addColorStop(0, a);
  gr.addColorStop(1, b);
  g.fillStyle = gr;
  g.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Still {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** 实际渲染的分辨率（超采样前） */
  renderW: number;
  renderH: number;
}

/** 高分辨率静帧：同步画完（WebGL 画布不保留绘图缓冲，渲染后同一个任务里立刻拷走） */
export function renderStill(c: Capturable, caption: string): Still {
  const r = c.renderer;
  const css = r.getSize(new THREE.Vector2());
  const pr0 = r.getPixelRatio();
  const long = Math.max(css.x, css.y, 1);
  const outScale = Math.min(STILL_SCALE, OUT_MAX / long);
  const maxTex = Math.min(RENDER_MAX, r.capabilities.maxTextureSize || RENDER_MAX);
  const renderScale = Math.max(outScale, Math.min(outScale * 2, maxTex / long));
  const width = Math.round(css.x * outScale), height = Math.round(css.y * outScale);
  const bg0 = c.scene.background;
  const fog0 = c.scene.fog;
  const tex = gradientTexture(css.x, css.y);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const g = out.getContext('2d')!;
  try {
    c.setPixelRatio(renderScale);
    c.scene.background = tex;
    c.scene.fog = null;
    c.render();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(r.domElement, 0, 0, width, height);
  } finally {
    c.scene.background = bg0;
    c.scene.fog = fog0;
    c.setPixelRatio(pr0);
    c.render();
    tex.dispose();
  }
  // 角落署名：作品名 + 外观示意（DESIGN §4：3D 是示意，不是乐鑫官方模型）
  const fs = Math.round(13 * outScale);
  g.font = `500 ${fs}px "Noto Sans SC", "PingFang SC", sans-serif`;
  g.fillStyle = currentTheme() === 'dark' ? 'rgba(232,234,237,0.75)' : 'rgba(30,30,30,0.6)';
  g.textBaseline = 'bottom';
  g.fillText(`TryBoard 试板 · ${caption} · 外观示意，非乐鑫官方模型`, Math.round(16 * outScale), height - Math.round(14 * outScale));
  return { canvas: out, width, height, renderW: Math.round(css.x * renderScale), renderH: Math.round(css.y * renderScale) };
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Blob 下载（a[download] + object URL） */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 最近一次拍照 / 录像（给自动化测试核对文件：名字、大小、尺寸） */
interface LastCapture {
  photo?: { name: string; bytes: number; width: number; height: number; renderW: number; renderH: number };
  video?: { name: string; bytes: number; width: number; height: number; seconds: number; mime: string; audio: boolean };
}
const last: LastCapture = {};
(globalThis as { __tbCapture?: LastCapture }).__tbCapture = last;

export async function takePhoto(c: Capturable, slug: string, caption: string) {
  const s = renderStill(c, caption);
  const blob = await new Promise<Blob | null>((res) => s.canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('浏览器没能生成 PNG');
  const name = `tryboard-${slug}-${stamp()}.png`;
  last.photo = { name, bytes: blob.size, width: s.width, height: s.height, renderW: s.renderW, renderH: s.renderH };
  download(blob, name);
  return last.photo;
}

export const RECORD_SECONDS = 10;

export interface Recording {
  /** 已录秒数 */
  elapsed(): number;
  stop(): void;
  done: Promise<NonNullable<LastCapture['video']>>;
}

/** 录画布 seconds 秒（webm）；audio 是声音开着时 Web Audio 的输出流 */
export function recordCanvas(canvas: HTMLCanvasElement, slug: string, audio: MediaStream | null, seconds = RECORD_SECONDS): Recording {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error('这个浏览器不支持录屏（MediaRecorder）');
  const stream = canvas.captureStream(30);
  const tracks = audio?.getAudioTracks() ?? [];
  for (const t of tracks) stream.addTrack(t);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const t0 = performance.now();
  const width = canvas.width, height = canvas.height;
  const done = new Promise<NonNullable<LastCapture['video']>>((resolve, reject) => {
    rec.onerror = (e) => reject(new Error(String((e as unknown as { error?: unknown }).error ?? '录制出错')));
    rec.onstop = () => {
      // 视频轨停掉；音频轨属于 Web Audio，不能停（扬声器还要用）
      for (const t of stream.getVideoTracks()) t.stop();
      const blob = new Blob(chunks, { type: 'video/webm' });
      const name = `tryboard-${slug}-${stamp()}.webm`;
      last.video = { name, bytes: blob.size, width, height, seconds: (performance.now() - t0) / 1000, mime: rec.mimeType || 'video/webm', audio: tracks.length > 0 };
      download(blob, name);
      resolve(last.video);
    };
  });
  rec.start(500);
  const timer = setTimeout(() => rec.state !== 'inactive' && rec.stop(), seconds * 1000);
  return {
    elapsed: () => (performance.now() - t0) / 1000,
    stop() {
      clearTimeout(timer);
      if (rec.state !== 'inactive') rec.stop();
    },
    done,
  };
}
