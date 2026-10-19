// Photo / 10 s video (P2-10). Photo: one supersampled 2× frame (with bloom) on the DESIGN §2 gradient, captioned; supersampling
// stands in for three-gpu-pathtracer (not a dependency). Video: MediaRecorder on canvas.captureStream plus Web Audio when on.
import * as THREE from 'three';
import { t } from '../i18n/index.ts';
import { currentTheme } from '../theme';

/** What the 3D scene exposes for capture: renderer, scene, render one frame (with post), set pixel ratio (incl. composer). */
export interface Capturable {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  render(): void;
  setPixelRatio(pr: number): void;
}

/** With an EffectComposer, the composer follows pixel-ratio changes (bloom / outline resolution). */
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

/** Output size as a multiple of the canvas CSS size. */
export const STILL_SCALE = 2;
/** Max render long edge in px (supersampling is bounded by VRAM and maxTextureSize). */
const RENDER_MAX = 4096;
/** Max output long edge. */
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface Still {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Actual render resolution (before downsampling). */
  renderW: number;
  renderH: number;
}

/** High-res still, synchronous: the WebGL canvas doesn't preserve its buffer, so copy it in the same task. */
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
  // Corner caption: project name + "illustrative" (DESIGN §4: the 3D is not an official Espressif model).
  const fs = Math.round(13 * outScale);
  g.font = `500 ${fs}px "Noto Sans SC", "PingFang SC", sans-serif`;
  g.fillStyle = currentTheme() === 'dark' ? 'rgba(232,234,237,0.75)' : 'rgba(30,30,30,0.6)';
  g.textBaseline = 'bottom';
  g.fillText(t('TryBoard · {caption} · Illustrative look, not an official Espressif model', { caption }), Math.round(16 * outScale), height - Math.round(14 * outScale));
  return { canvas: out, width, height, renderW: Math.round(css.x * renderScale), renderH: Math.round(css.y * renderScale) };
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Blob download (a[download] + object URL). */
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

/** Last photo / video, for automated tests to check name, size and dimensions. */
interface LastCapture {
  photo?: { name: string; bytes: number; width: number; height: number; renderW: number; renderH: number };
  video?: { name: string; bytes: number; width: number; height: number; seconds: number; mime: string; audio: boolean };
}
const last: LastCapture = {};
(globalThis as { __tbCapture?: LastCapture }).__tbCapture = last;

export async function takePhoto(c: Capturable, slug: string, caption: string) {
  const s = renderStill(c, caption);
  const blob = await new Promise<Blob | null>((res) => s.canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error(t("The browser couldn't create the PNG"));
  const name = `tryboard-${slug}-${stamp()}.png`;
  last.photo = { name, bytes: blob.size, width: s.width, height: s.height, renderW: s.renderW, renderH: s.renderH };
  download(blob, name);
  return last.photo;
}

export const RECORD_SECONDS = 10;

export interface Recording {
  /** Seconds recorded so far. */
  elapsed(): number;
  stop(): void;
  done: Promise<NonNullable<LastCapture['video']>>;
}

/** Record the canvas for `seconds` (webm); audio is the Web Audio output stream when sound is on. */
export function recordCanvas(canvas: HTMLCanvasElement, slug: string, audio: MediaStream | null, seconds = RECORD_SECONDS): Recording {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error(t("This browser can't record video (MediaRecorder)"));
  const stream = canvas.captureStream(30);
  const tracks = audio?.getAudioTracks() ?? [];
  for (const tr of tracks) stream.addTrack(tr);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const t0 = performance.now();
  const width = canvas.width, height = canvas.height;
  const done = new Promise<NonNullable<LastCapture['video']>>((resolve, reject) => {
    rec.onerror = (e) => reject(new Error(String((e as unknown as { error?: unknown }).error ?? t('Recording failed'))));
    rec.onstop = () => {
      // Stop video tracks only; the audio track belongs to Web Audio and the speaker still needs it.
      for (const tr of stream.getVideoTracks()) tr.stop();
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
