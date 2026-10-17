// 实验台 v2 的内联图标（DESIGN.md：描边 2、圆角端点，跟随文字颜色）。只收实际用到的。
const P: Record<string, string> = {
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  check: 'M20 6 9 17l-5-5',
  down: 'm6 9 6 6 6-6',
  up: 'm18 15-6-6-6 6',
  play: 'M7 4v16l13-8z',
  pause: 'M8 5v14M16 5v14',
  restart: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  x: 'M18 6 6 18M6 6l12 12',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  warn: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  doc: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  target: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 12h.01',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  help: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 18h.01',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
};

export function Icon({ n, size = 16, className }: { n: keyof typeof P | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={P[n]} />
    </svg>
  );
}
