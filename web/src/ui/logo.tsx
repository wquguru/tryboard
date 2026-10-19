// Brand mark: 8 white dots are breadboard holes, the amber one is the part being tried. Dark theme swaps colours (DESIGN_V2 §1).
const DOTS: [number, number][] = [
  [20, 20], [32, 20], [20, 32], [32, 32], [44, 32], [20, 44], [32, 44], [44, 44],
];

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect x="4" y="4" width="56" height="56" rx="14" className="fill-[#0B76C8] dark:fill-[#3AA8FF]" />
      <g className="fill-white dark:fill-[#17181B]">
        {DOTS.map(([x, y]) => (
          <circle key={`${x},${y}`} cx={x} cy={y} r="5" />
        ))}
      </g>
      {size >= 64 && <circle cx="44" cy="20" r="8.5" fill="#FFB020" opacity="0.35" />}
      <circle cx="44" cy="20" r="6" fill="#FFB020" />
    </svg>
  );
}
