// Dock "Code" tab (P2-15): read-only source of the running firmware, from fw/<name>/src.json packed at build time
// (tools/gen_fw_src.py), fetched and cached per firmware; lazy-loaded by dock.tsx. Uploaded .bin files have no source.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { cn } from "../ui/cn";
import { tokenize, type TokKind } from "./ctoken";
import { Icon } from "./icons";
import { assetUrl } from "../assetver";

interface SrcFile {
  path: string;
  text: string;
}
interface Src {
  id: string;
  files: SrcFile[];
  defines: string;
}
type Got = { ok: true; src: Src } | { ok: false; why: string };
const cache = new Map<string, Promise<Got>>();
function load(id: string): Promise<Got> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(assetUrl(`./fw/${id}/src.json`))
      .then(async (r): Promise<Got> =>
        r.ok
          ? { ok: true, src: (await r.json()) as Src }
          : { ok: false, why: t('Example "{id}" has no packed source (firmware/{id}/main was not found at build time).', { id }) },
      )
      .catch(() => ({ ok: false, why: t("Couldn't download the source: are you offline?") }));
    // Failures aren't cached; retry next time the tab opens.
    p.then((g) => !g.ok && cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** Example firmware is named "<id>/flash.bin" in a session; uploads keep their file name (no slash). */
export const exampleOf = (fw: string) => /^([\w-]+)\/flash\.bin$/.exec(fw)?.[1] ?? null;

const tokCls: Record<TokKind, string> = {
  com: "text-muted italic",
  str: "text-warn-ink",
  pre: "text-accent-ink",
  kw: "text-accent-ink font-medium",
  type: "text-ok-ink",
  num: "text-bad-ink",
  mac: "font-medium",
  "": "",
};

const ib =
  "inline-flex size-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted hover:bg-field hover:text-fg";

/** Beginner lessons (H-03): open `file` (path as packed, relative to firmware/) and mark `lines` (1-based). */
export interface CodeHighlight {
  file: string;
  lines: number[];
  /** Extra controls drawn at the end of this 1-based line (H-06 delay chips). */
  chip?: { line: number; node: ReactNode };
}

export default function CodeView({
  fw,
  phone,
  toast,
  highlight,
}: {
  fw: string;
  phone?: boolean;
  toast: (msg: string) => void;
  highlight?: CodeHighlight | null;
}) {
  const id = exampleOf(fw);
  const [got, setGot] = useState<Got | null>(null);
  const [file, setFile] = useState(0);
  const hlFile = highlight?.file;
  useEffect(() => {
    setGot(null);
    setFile(0);
    if (!id) return;
    let live = true;
    void load(id).then((g) => {
      if (!live) return;
      setGot(g);
      const i = g.ok && hlFile ? g.src.files.findIndex((f) => f.path === hlFile) : -1;
      if (i >= 0) setFile(i);
    });
    return () => {
      live = false;
    };
  }, [id, hlFile]);
  const cur = got?.ok ? got.src.files[file] : null;
  const lines = useMemo(() => (cur ? tokenize(cur.text) : []), [cur]);
  const hl = useMemo(
    () => new Set(highlight && cur?.path === highlight.file ? highlight.lines : []),
    [highlight, cur],
  );
  const hlKey = [...hl].join(",");
  const body = useRef<HTMLDivElement>(null);
  // Keep the highlighted line in view inside the pane only (scrollIntoView would also move the fixed dock)
  useEffect(() => {
    const el = body.current;
    const row = el?.querySelector<HTMLElement>("tr[data-hl]");
    if (!el || !row) return;
    const top = row.offsetTop;
    if (top < el.scrollTop + 8 || top + row.offsetHeight > el.scrollTop + el.clientHeight - 8)
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    // H-06: the delay chips sit a few lines below the followed line; keep them reachable too
    const chipRow = el.querySelector<HTMLElement>("tr[data-chips]");
    if (chipRow && chipRow.offsetTop > row.offsetTop) {
      const bottom = chipRow.offsetTop + chipRow.offsetHeight + 8;
      if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = Math.min(row.offsetTop - 4, bottom - el.clientHeight);
    }
  }, [hlKey, lines]);

  let why: string | null = null;
  if (!fw) why = t('No firmware yet: open a project or drop in a .bin.');
  else if (!id)
    why = t('"{fw}" is an uploaded build output (flash image) with no source inside, so nothing can be shown. The source is in your own project; rebuild with ESP-IDF / Arduino and drop the .bin in again.', { fw });
  else if (got && !got.ok) why = got.why;
  if (why)
    return (
      <div id="codeView" data-state="none" className="min-h-0 flex-1 overflow-auto p-3 text-xs text-muted">
        <p className="m-0 flex items-start gap-2">
          <Icon n="doc" size={14} className="mt-px flex-none" />
          <span>
            <b className="font-medium text-fg">{t("No source")}</b> · {why}
          </span>
        </p>
      </div>
    );
  if (!got?.ok || !cur)
    return (
      <div id="codeView" data-state="loading" className="p-3 text-xs text-muted">
        {t('Fetching the source of {id}…', { id: id ?? '' })}
      </div>
    );
  const src = got.src;
  return (
    <div id="codeView" data-state="ok" data-fw={src.id} className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex flex-none items-center gap-1.5 border-b border-line-soft px-2 py-1",
          phone && "py-1.5",
        )}
      >
        <div
          role="tablist"
          aria-label={t("Source files")}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {src.files.map((f, i) => (
            <button
              key={f.path}
              type="button"
              role="tab"
              data-file={f.path}
              aria-selected={i === file}
              title={`firmware/${f.path}`}
              onClick={() => setFile(i)}
              className={cn(
                "flex-none cursor-pointer rounded-md border border-transparent bg-transparent px-2 font-mono text-[11.5px] whitespace-nowrap text-muted hover:text-fg aria-selected:border-line aria-selected:bg-field aria-selected:text-fg",
                phone ? "h-11 px-3 text-[12.5px]" : "h-6",
              )}
            >
              {f.path}
            </button>
          ))}
        </div>
        {src.defines && (
          <span
            className="flex-none truncate font-mono text-[11px] text-muted max-md:hidden"
            title={t("Macros CMakeLists.txt defines for this firmware (only these differ when sharing source with other projects)")}
          >
            -D {src.defines}
          </span>
        )}
        <span className="flex-none text-[11px] text-muted max-md:hidden">{t("Read-only")}</span>
        <button
          type="button"
          id="codeCopy"
          className={cn(ib, phone && "size-11")}
          title={t("Copy this file")}
          aria-label={t("Copy source")}
          onClick={() =>
            void navigator.clipboard?.writeText(cur.text).then(
              () => toast(t('Copied {path}', { path: cur.path })),
              () => toast(t("Copy failed: the browser won't allow clipboard writes")),
            )
          }
        >
          <Icon n="copy" size={15} />
        </button>
      </div>
      {highlight && (
        <div id="codeFollow" className="flex-none border-b border-line-soft px-3 py-1 text-[11px] text-muted">
          {t("Highlight follows events (not step debugging)")}
        </div>
      )}
      <div
        id="codeBody"
        ref={body}
        tabIndex={0}
        aria-label={t('Source {path}', { path: cur.path })}
        className="min-h-0 flex-1 overflow-auto bg-(--scope-bg) py-1.5 font-mono text-[12.5px] leading-[1.6]"
      >
        <table className="min-w-full border-collapse">
          <tbody>
            {lines.map((l, n) => (
              <tr key={n} data-line={n + 1} data-hl={hl.has(n + 1) ? "" : undefined} data-chips={highlight?.chip?.line === n + 1 ? "" : undefined} className="data-hl:bg-accent-bg">
                <td
                  className={cn(
                    "sticky left-0 bg-(--scope-bg) pr-3 pl-3 text-right align-top text-muted select-none",
                    hl.has(n + 1) && "bg-accent-bg text-accent-ink shadow-[inset_3px_0_0_var(--accent)]",
                  )}
                >
                  {n + 1}
                </td>
                <td className="pr-4 whitespace-pre">
                  {l.length
                    ? l.map((tk, k) =>
                        tk.k ? (
                          <span key={k} className={tokCls[tk.k]}>
                            {tk.t}
                          </span>
                        ) : (
                          tk.t
                        ),
                      )
                    : " "}
                  {highlight?.chip?.line === n + 1 && <span className="ml-3 inline-flex align-middle font-sans">{highlight.chip.node}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
