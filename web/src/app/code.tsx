// 底部坞「代码」页签（P2-15）：台面上正在跑的固件的源码，只读。源码是构建期从 firmware/<名> 打包的
// fw/<名>/src.json（tools/gen_fw_src.py），这里按需 fetch、按固件缓存；本模块由 dock.tsx 懒加载，不进首包。
// 上传的 .bin 只有编译产物，没有源码：说清楚原因，不猜。
import { useEffect, useMemo, useState } from "react";
import { cn } from "../ui/cn";
import { tokenize, type TokKind } from "./ctoken";
import { Icon } from "./icons";

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
    p = fetch(`./fw/${id}/src.json`)
      .then(async (r): Promise<Got> =>
        r.ok
          ? { ok: true, src: (await r.json()) as Src }
          : { ok: false, why: `示例「${id}」没有打包源码（构建时没找到 firmware/${id}/main）。` },
      )
      .catch(() => ({ ok: false, why: "源码没下载下来：网络断了？" }));
    // 下载失败不缓存，下次切过来再试
    p.then((g) => !g.ok && cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** 会话里示例固件的名字是 "<id>/flash.bin"；上传的固件用文件原名（没有斜杠） */
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

export default function CodeView({
  fw,
  phone,
  toast,
}: {
  fw: string;
  phone?: boolean;
  toast: (t: string) => void;
}) {
  const id = exampleOf(fw);
  const [got, setGot] = useState<Got | null>(null);
  const [file, setFile] = useState(0);
  useEffect(() => {
    setGot(null);
    setFile(0);
    if (!id) return;
    let live = true;
    void load(id).then((g) => live && setGot(g));
    return () => {
      live = false;
    };
  }, [id]);
  const cur = got?.ok ? got.src.files[file] : null;
  const lines = useMemo(() => (cur ? tokenize(cur.text) : []), [cur]);

  let why: string | null = null;
  if (!fw) why = "还没有固件：打开一个作品，或者拖一个 .bin 进来。";
  else if (!id)
    why = `「${fw}」是上传的编译产物（flash 镜像），里面没有源码，这里没法显示。源码在你自己的工程里；改完用 ESP-IDF / Arduino 重新编译，再把 .bin 拖进来。`;
  else if (got && !got.ok) why = got.why;
  if (why)
    return (
      <div id="codeView" data-state="none" className="min-h-0 flex-1 overflow-auto p-3 text-xs text-muted">
        <p className="m-0 flex items-start gap-2">
          <Icon n="doc" size={14} className="mt-px flex-none" />
          <span>
            <b className="font-medium text-fg">没有源码</b> · {why}
          </span>
        </p>
      </div>
    );
  if (!got?.ok || !cur)
    return (
      <div id="codeView" data-state="loading" className="p-3 text-xs text-muted">
        正在取 {id} 的源码…
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
          aria-label="源文件"
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
            title="CMakeLists.txt 里给这个固件定义的宏（与别的工程共用源码时只覆盖这些）"
          >
            -D {src.defines}
          </span>
        )}
        <span className="flex-none text-[11px] text-muted max-md:hidden">只读</span>
        <button
          type="button"
          id="codeCopy"
          className={cn(ib, phone && "size-11")}
          title="复制这个文件"
          aria-label="复制源码"
          onClick={() =>
            void navigator.clipboard?.writeText(cur.text).then(
              () => toast(`已复制 ${cur.path}`),
              () => toast("复制失败：浏览器不让写剪贴板"),
            )
          }
        >
          <Icon n="copy" size={15} />
        </button>
      </div>
      <div
        id="codeBody"
        tabIndex={0}
        aria-label={`源码 ${cur.path}`}
        className="min-h-0 flex-1 overflow-auto bg-(--scope-bg) py-1.5 font-mono text-[12.5px] leading-[1.6]"
      >
        <table className="border-collapse">
          <tbody>
            {lines.map((l, n) => (
              <tr key={n}>
                <td className="sticky left-0 bg-(--scope-bg) pr-3 pl-3 text-right align-top text-muted select-none">
                  {n + 1}
                </td>
                <td className="pr-4 whitespace-pre">
                  {l.length
                    ? l.map((t, k) =>
                        t.k ? (
                          <span key={k} className={tokCls[t.k]}>
                            {t.t}
                          </span>
                        ) : (
                          t.t
                        ),
                      )
                    : " "}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
