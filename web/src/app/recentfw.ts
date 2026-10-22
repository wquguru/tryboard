// "Recent" list of the firmware menu (U-08, F-07c/d): localStorage, newest first, three entries.
// Own-bin entries drop out once their kept copy is gone (forgotten or evicted) and only show under their chip.
const RECENT_KEY = 'tryboard-recent-fw';
export type Recent = { kind: 'example'; id: string; title: string; at: number } | { kind: 'file'; name: string; at: number; h?: string; chip?: string };

const ls = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
export function recentFw(s = ls()): Recent[] {
  try {
    const v = JSON.parse(s?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(0, 3) : [];
  } catch {
    return [];
  }
}
function save(list: Recent[], s: Storage | null) {
  try {
    s?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode: not recorded */
  }
}
/** Record opened examples/uploads; files keep their name, chip and, once kept in IndexedDB (F-07c), its sha256 to run it again. */
export function pushRecent(r: Recent, s = ls()) {
  const key = (x: Recent) => (x.kind === 'example' ? `e:${x.id}` : `f:${x.name}`);
  save([r, ...recentFw(s).filter((x) => key(x) !== key(r))].slice(0, 3), s);
}

/** Entries whose kept bin is not in `kept` are dropped (null = storage unreadable, keep all); never-kept files stay */
export const liveRecent = (list: Recent[], kept: ReadonlySet<string> | null) => list.filter((r) => r.kind !== 'file' || !r.h || !kept || kept.has(r.h));
/** What the menu lists for `chip`; file entries from before F-07d carry no chip and always show */
export const recentFor = (list: Recent[], chip: string) => list.filter((r) => r.kind !== 'file' || !r.chip || r.chip === chip);

/** Drop entries of bins no longer kept; returns the stored list */
export function pruneRecent(kept: ReadonlySet<string> | null, s = ls()): Recent[] {
  const list = recentFw(s);
  const live = liveRecent(list, kept);
  if (live.length !== list.length) save(live, s);
  return live;
}
