// Shared page shell for build-time static pages (licenses, changelog): head, header, phone drawer, footer, theme script.
// Classes match web/src/ui/site.tsx; each page's css must @source this file so Tailwind emits them. One file per locale (F-12b).
import { LOCALES } from '../web/src/i18n/index.ts';

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Site domain decided 2026-10-22 (DECISIONS); TRYBOARD_SITE_URL overrides it, e.g. for a staging host
export const SITE = (process.env.TRYBOARD_SITE_URL || 'https://tryboard.indaloop.app').replace(/\/+$/, '');
export const LOCS = LOCALES.map((l) => l.id);
export const htmlLang = (loc) => LOCALES.find((l) => l.id === loc).html;

// Build-only dictionaries: site.ts holds the shared shell keys, static.ts the rest (docs/I18N.md §3); none of it ships to these pages
const DICTS = { en: {} };
for (const l of LOCS.filter((l) => l !== 'en')) {
  DICTS[l] = { ...(await import(`../web/src/i18n/${l}/site.ts`)).default, ...(await import(`../web/src/i18n/${l}/static.ts`)).default };
}
/** Translator for one locale: T(key, vars) gives plain text; a missing translation stops the build instead of leaking English. */
export function translator(loc) {
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
  const T = (en, vars) => {
    if (loc !== 'en' && !(en in DICTS[loc])) throw new Error(`[static i18n] ${loc}: no translation for "${en}" (add it to web/src/i18n/${loc}/static.ts)`);
    return fill(loc === 'en' ? en : DICTS[loc][en], vars);
  };
  // HTML form: the translated sentence is escaped first, then {vars} go in as ready-made HTML
  T.html = (en, vars) => fill(esc(T(en)), vars);
  T.loc = loc;
  return T;
}

/** Same-locale address of a static page: ./changelog, ./changelog.zh (suffix, not a directory: every link here is relative). */
export const pageUrl = (base, loc) => `./${base}${loc === 'en' ? '' : `.${loc}`}`;
export const absUrl = (base, loc) => `${SITE}/${base}${loc === 'en' ? '' : `.${loc}`}`;
export const feedUrl = (loc) => `./changelog${loc === 'en' ? '' : `.${loc}`}.xml`;

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 2026-10-22 -> Oct 22, 2026 in English, year-month-day with CJK unit marks otherwise; year = false drops the year. */
export function fmtDay(loc, iso, year = true) {
  const [y, m, d] = [iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10)];
  if (loc === 'en') return `${MON[m - 1].slice(0, 3)} ${d}${year ? `, ${y}` : ''}`;
  if (loc === 'ko') return `${year ? `${y}년 ` : ''}${m}월 ${d}일`; // lint: allow-cjk
  return `${year ? `${y}年` : ''}${m}月${d}日`; // lint: allow-cjk
}
/** 2026-10 -> October 2026 in English, year-month with CJK unit marks otherwise; short = month only. */
export function fmtMonth(loc, ym, short = false) {
  const [y, m] = [ym.slice(0, 4), +ym.slice(5, 7)];
  if (loc === 'en') return short ? MON[m - 1] : `${MON[m - 1]} ${y}`;
  if (loc === 'ko') return short ? `${m}월` : `${y}년 ${m}월`; // lint: allow-cjk
  return short ? `${m}月` : `${y}年${m}月`; // lint: allow-cjk
}

// Header nav link classes match navLink in web/src/ui/site.tsx
const NAV_LINK = 'rounded-md px-2.5 py-[5px] text-muted hover:bg-field hover:text-fg';
// Same as SITE_NAV in web/src/ui/links.ts (no .html suffix, DESIGN_V2 §7.2); React pages pick their language themselves
const NAV = [
  ['./', 'Projects'],
  ['./select', 'Pick a board'],
  ['./app?work=blank#bench', 'Lab'],
];
// Static pages listed in the drawer bottom and the footer (same order as SiteFooter), linked in the page's own locale
const PAGES = [
  ['licenses', 'Licenses & credits'],
  ['changelog', 'Changelog'],
];
export const LOGO = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="4" width="56" height="56" rx="14" class="fill-[#0B76C8] dark:fill-[#3AA8FF]"/><g class="fill-white dark:fill-[#17181B]"><circle cx="20" cy="20" r="5"/><circle cx="32" cy="20" r="5"/><circle cx="20" cy="32" r="5"/><circle cx="32" cy="32" r="5"/><circle cx="44" cy="32" r="5"/><circle cx="20" cy="44" r="5"/><circle cx="32" cy="44" r="5"/><circle cx="44" cy="44" r="5"/></g><circle cx="44" cy="20" r="6" fill="#FFB020"/></svg>`;
export const ICON = (d, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const SEG = 'min-h-[38px] cursor-pointer rounded-lg px-3 text-muted max-md:min-h-11 aria-checked:bg-surface aria-checked:font-medium aria-checked:text-fg aria-checked:shadow-[0_1px_3px_#0000001a] aria-checked:ring-1 aria-checked:ring-line';
const FOOT_LINK = 'text-fg hover:text-accent-ink max-md:inline-flex max-md:min-h-11 max-md:items-center';
// Native <select> styled like LangSelect in web/src/ui/lang.tsx (globe icon, same sizes); the page script handles changes
const langSelect = (loc, T) =>
  `<label class="relative inline-flex flex-none items-center text-muted hover:text-fg"><svg class="pointer-events-none absolute left-2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg><select aria-label="${esc(T('Language'))}" data-lang-select class="h-8 cursor-pointer appearance-none rounded-md border border-line bg-transparent pr-2 pl-7 text-[12px] text-inherit max-md:h-11 max-md:text-[14px]">${LOCALES.map((l) => `<option value="${l.id}" lang="${l.html}"${l.id === loc ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select></label>`;

/** Language pick before first paint: ?lang (this visit, not saved, like detectLocale) > tb-lang > browser languages, the last only on
 *  the English x-default page, so a localized address from search or a shared link stays put; ?lang rides along, so no loop. */
const langScript = (base, loc) =>
  `<script>(function(){var L=${JSON.stringify(LOCS)},P=${JSON.stringify(loc)},ok=function(v){return L.indexOf(v)>=0},w=new URLSearchParams(location.search).get('lang'),s;try{s=localStorage.getItem('tb-lang')}catch(e){}if(!ok(w))w=ok(s)?s:null;if(!w&&P==='en'){var n=navigator.languages||[navigator.language];for(var i=0;i<n.length&&!w;i++){var p=String(n[i]||'').toLowerCase().split('-')[0];if(ok(p))w=p}}if(w&&w!==P)location.replace(location.pathname.replace(/[^/]*$/,${JSON.stringify(base)}+(w==='en'?'':'.'+w)+(/\\.html$/.test(location.pathname)?'.html':''))+location.search+location.hash)})()</script>`;

/** Whole page. base = 'licenses' | 'changelog'; title / description are plain text; label is the plain current-page name; main is the body HTML. */
export function page({ locale = 'en', base, title, description, css, label, main, head = '', script = '' }) {
  const T = translator(locale);
  const href = pageUrl(base, locale);
  const brand = `<a class="inline-flex flex-none items-center gap-1.5 max-md:min-h-11 max-md:gap-2" href="./" aria-label="${esc(T('TryBoard home'))}">${LOGO(22).replace('<svg ', '<svg class="max-md:size-[26px]" ')}<b class="text-[14px] max-md:text-[17px]">TryBoard</b><span class="font-mono text-[10px] tracking-[0.08em] text-muted max-md:hidden">TRYBOARD</span><span class="ml-0.5 hidden text-[13px] text-muted max-md:inline">· ${esc(label)}</span></a>`;
  const pages = PAGES.map(([b, text]) => [pageUrl(b, locale), esc(T(text))]);
  const bottom = pages
    .map(([h, text]) =>
      h === href
        ? `<a href="${h}" aria-current="page" class="flex h-11 items-center justify-between text-[15px] text-accent-ink">${text}<span class="text-[12px] font-medium">${esc(T('Current page'))}</span></a>`
        : `<a href="${h}" class="flex h-11 items-center text-[15px] text-muted hover:text-fg">${text}</a>`,
    )
    .join('\n        ');
  const alt = LOCS.map((l) => `\n    <link rel="alternate" hreflang="${htmlLang(l)}" href="${absUrl(base, l)}" />`).join('') + `\n    <link rel="alternate" hreflang="x-default" href="${absUrl(base, 'en')}" />`;
  return `<!doctype html>
<html lang="${htmlLang(locale)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- Language before first paint (F-12b; same keys as web/src/i18n/index.ts), then theme (web/src/theme.ts: tb-theme, else the system setting) -->
    ${langScript(base, locale)}
    <script>try{var t=localStorage.getItem('tb-theme')}catch(e){}document.documentElement.dataset.theme=t==='dark'||t==='light'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'</script>
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${absUrl(base, locale)}" />${alt}
    <!-- Share card (DESIGN_V2 §8.5): og.png is rendered at build time by tools/webtest/og.mjs; og:image is absolute on the site domain (DECISIONS 2026-10-22) -->
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="TryBoard" />
    <meta property="og:url" content="${absUrl(base, locale)}" />
    <meta property="og:locale" content="${htmlLang(locale).replace('-', '_')}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:image" content="https://tryboard.indaloop.app/og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />${head}
    <!-- Self-hosted fonts (P2-19, generated by tools/fonts/subset.py, OFL-1.1) -->
    <link rel="stylesheet" href="/fonts/fonts.css" />
    <!-- Styles: Tailwind with the same theme as the React pages; header / footer classes match src/ui/site.tsx -->
    <link rel="stylesheet" href="${css}" />
  </head>
  <!-- Generated at build time (tools/static_shell.mjs + the page's generator); do not edit by hand -->
  <body>
   <div class="flex min-h-screen flex-col text-[13px] leading-[1.6]">
    <header class="pg-head sticky top-0 z-[5] flex items-center gap-6 border-b border-line bg-head-bg px-6 py-3.5 backdrop-blur max-md:h-[52px] max-md:gap-2 max-md:py-0 max-md:pr-2 max-md:pl-4">
      ${brand}
      <nav aria-label="${esc(T('Site'))}" class="flex flex-wrap gap-0.5 max-md:hidden">${NAV.map(([h, text]) => `<a href="${h}" class="${NAV_LINK}">${esc(T(text))}</a>`).join('')}</nav>
      <div class="ml-auto flex items-center gap-2 max-md:hidden">
        ${langSelect(locale, T)}
        <button type="button" id="themeBtn" class="theme-btn inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-md border border-line bg-surface text-fg transition-colors hover:border-hover-line"></button>
      </div>
      <button type="button" id="siteMenu" aria-label="${esc(T('Menu'))}" aria-haspopup="dialog" aria-expanded="false" aria-controls="siteDrawer" class="ml-auto hidden size-11 flex-none cursor-pointer items-center justify-center rounded-[10px] text-fg hover:bg-field max-md:inline-flex">${ICON('M4 7h16M4 12h16M4 17h16')}</button>
    </header>
    <!-- Mobile menu drawer: same structure as MobileMenu in web/src/ui/site.tsx (no Radix here; the script below handles open / close, Esc and focus) -->
    <div id="siteDrawer" role="dialog" aria-modal="true" aria-label="${esc(T('Site menu'))}" hidden class="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg text-fg animate-[tb-drop_.18s_ease-out] [&[hidden]]:hidden">
      <div class="flex h-[52px] flex-none items-center gap-2 border-b border-line-soft pr-2 pl-4">
        <a class="inline-flex flex-none items-center gap-2" href="./" aria-label="${esc(T('TryBoard home'))}">${LOGO(26)}<b class="text-[17px]">TryBoard</b><span class="font-mono text-[10px] tracking-[0.08em] text-muted">TRYBOARD</span></a>
        <button type="button" id="siteClose" aria-label="${esc(T('Close menu'))}" class="ml-auto inline-flex size-11 cursor-pointer items-center justify-center rounded-[10px] hover:bg-field">${ICON('M6 6l12 12M18 6L6 18')}</button>
      </div>
      <nav aria-label="${esc(T('Site'))}" class="flex flex-col px-4 py-2">${NAV.map(([h, text]) => `<a href="${h}" class="flex h-16 items-center justify-between border-b border-line-soft text-[20px] font-bold text-fg">${esc(T(text))}<span class="text-muted">${ICON('M9 6l6 6-6 6', 18)}</span></a>`).join('')}</nav>
      <p class="mx-4 my-3 rounded-xl bg-field p-3.5 text-[13px] leading-[1.6] text-muted">${esc(T('On a phone you can watch, tweak values and press buttons; wiring and swapping firmware work best on a computer.'))}</p>
      <div class="mt-auto flex flex-col gap-1 border-t border-line-soft px-4 pt-4 pb-10">
        <div class="flex min-h-12 items-center justify-between text-[15px]">${esc(T('Dark mode'))}
          <div role="radiogroup" aria-label="${esc(T('Dark mode'))}" class="flex rounded-[10px] bg-field p-[3px] text-[13px]"><button type="button" role="radio" data-theme-pref="system" class="${SEG}">${esc(T('System'))}</button><button type="button" role="radio" data-theme-pref="light" class="${SEG}">${esc(T('Light'))}</button><button type="button" role="radio" data-theme-pref="dark" class="${SEG}">${esc(T('Dark'))}</button></div>
        </div>
        <div class="flex min-h-12 items-center justify-between gap-3 text-[15px]">${esc(T('Language'))}
          ${langSelect(locale, T)}
        </div>
        ${bottom}
      </div>
    </div>
    ${main}
    <footer class="pg-foot flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-t border-line px-6 py-3.5 text-[11px] text-muted max-sm:px-4 max-sm:py-3">
      <span>${esc(T('TryBoard · Run ESP32 firmware in the browser, Arduino-compatible.'))} <span lang="en">ESP32 is a trademark of Espressif Systems. TryBoard is not affiliated with Espressif.</span></span>
      ${pages.map(([h, text]) => `<span><a class="${FOOT_LINK}" href="${h}">${text}</a></span>`).join('\n      ')}
      <span><a class="${FOOT_LINK}" href="${feedUrl(locale)}" type="application/atom+xml">${esc(T('Atom feed'))}</a></span>
    </footer>
   </div>
    <script>
      // Light / dark toggle (same storage key as web/src/theme.ts; this static page is not bundled)
      (function () {
        // Icons match sun / moon in web/src/app/icons.tsx (site-wide theme key shows only the icon, DESIGN_V2 §6.3)
        var SUN = ${JSON.stringify(ICON('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4', 16))}, MOON = ${JSON.stringify(ICON('M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z', 16))};
        var TIP = ${JSON.stringify([T('Switch to light'), T('Switch to dark')])};
        var b = document.getElementById('themeBtn'), r = document.documentElement;
        function sync() { var d = r.dataset.theme === 'dark'; b.innerHTML = d ? MOON : SUN; b.title = d ? TIP[0] : TIP[1]; b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(d)); }
        b.onclick = function () { var t = r.dataset.theme === 'dark' ? 'light' : 'dark'; r.dataset.theme = t; try { localStorage.setItem('tb-theme', t); } catch (e) {} sync(); };
        sync();
        // Mobile menu: open / close, Esc, focus in and out; three-way theme ("System" removes the storage key)
        var d = document.getElementById('siteDrawer'), m = document.getElementById('siteMenu'), x = document.getElementById('siteClose');
        var segs = d.querySelectorAll('[data-theme-pref]');
        function pref() { var t; try { t = localStorage.getItem('tb-theme'); } catch (e) {} return t === 'dark' || t === 'light' ? t : 'system'; }
        function syncSeg() { var p = pref(); segs.forEach(function (s) { s.setAttribute('aria-checked', String(s.dataset.themePref === p)); }); }
        segs.forEach(function (s) { s.onclick = function () { var p = s.dataset.themePref; try { p === 'system' ? localStorage.removeItem('tb-theme') : localStorage.setItem('tb-theme', p); } catch (e) {} r.dataset.theme = p === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p; syncSeg(); sync(); }; });
        function open(on) { d.hidden = !on; m.setAttribute('aria-expanded', String(on)); document.body.style.overflow = on ? 'hidden' : ''; (on ? x : m).focus(); }
        m.onclick = function () { syncSeg(); open(true); };
        x.onclick = function () { open(false); };
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !d.hidden) open(false); });
        syncSeg();
        // Language pick: save it like setLocale in web/src/i18n/index.ts (private mode falls back to ?lang), then open that file
        document.querySelectorAll('[data-lang-select]').forEach(function (sel) {
          sel.onchange = function () {
            var l = sel.value, u = new URL(location.href), saved = false;
            try { localStorage.setItem('tb-lang', l); saved = localStorage.getItem('tb-lang') === l; } catch (e) {}
            u.searchParams.delete('lang');
            if (!saved) u.searchParams.set('lang', l);
            u.pathname = u.pathname.replace(/[^/]*$/, ${JSON.stringify(base)} + (l === 'en' ? '' : '.' + l) + (/\.html$/.test(u.pathname) ? '.html' : ''));
            location.href = u.toString();
          };
        });
      })();
    </script>${script}
  </body>
</html>
`;
}
