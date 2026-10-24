// Packed firmware source (fw/<name>/src.json, tools/gen_fw_src.py), fetched once per firmware.
// Split from code.tsx so the phone lesson sheet (H-07) can show a few lines without the lazy code-tab chunk.
import { t } from "../i18n";
import { assetUrl } from "../assetver";

export interface SrcFile {
  path: string;
  text: string;
}
export interface Src {
  id: string;
  files: SrcFile[];
  defines: string;
}
export type Got = { ok: true; src: Src } | { ok: false; why: string };
const cache = new Map<string, Promise<Got>>();
export function loadSrc(id: string): Promise<Got> {
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
