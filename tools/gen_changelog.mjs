// F-12 / F-12b: web/changelog.yaml -> web/changelog{,.zh,.ja,.ko}.html (static, one per locale), public/changelog{,.zh,.ja,.ko}.xml (Atom),
// sitemap.xml, robots.txt. Audits every entry first; any violation exits 2 so the build stops. Usage: node tools/gen_changelog.mjs [--in f] [--out f] [--pub dir]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { absUrl, esc, feedUrl, fmtDay, fmtMonth, htmlLang, ICON, LOCS, page, SITE, translator } from './static_shell.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.indexOf(k) > 0 ? process.argv[process.argv.indexOf(k) + 1] : d);
const src = path.resolve(root, arg('--in', 'web/changelog.yaml'));
const out = path.resolve(root, arg('--out', 'web/changelog.html'));
const pub = path.resolve(root, arg('--pub', 'web/public'));
const web = path.join(root, 'web');
const today = new Date().toISOString().slice(0, 10);

// ---- Minimal YAML: `entries:` then `- key: value` items; values are scalars or [a, b] flow lists
function parseYaml(text) {
  const entries = [];
  const errs = [];
  let cur = null;
  let seenRoot = false;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*#/.test(line)) return;
    if (line === 'entries:') return void (seenRoot = true);
    const m = /^(\s*)(- )?([a-z_]+):(?: (.*))?$/.exec(line);
    if (!seenRoot || !m || (!m[2] && !cur)) return void errs.push(`line ${i + 1}: cannot parse "${line.trim()}"`);
    if (m[2]) entries.push((cur = { line: i + 1 }));
    let v = (m[4] ?? '').trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
    else if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (m[3] in cur) errs.push(`line ${i + 1}: duplicate key ${m[3]}`);
    cur[m[3]] = v;
  });
  if (!seenRoot) errs.push('missing top-level "entries:"');
  return { entries, errs };
}

// ---- Audit rules
const TAGS = { new: 'New', improve: 'Improved', announce: 'Announcement', removed: 'Removed' };
const CHIPS = ['C3', 'S3', 'ESP32', 'Arduino'];
const NEED = ['date', 'tag', 'title', 'desc', 'link', 'cta'];
// F-12b: title / desc / cta also as title_zh ... cta_ko; CJK says the same in roughly half the characters
const TEXT = ['title', 'desc', 'cta'];
const OTHER = ['zh', 'ja', 'ko'];
for (const l of OTHER) NEED.push(...TEXT.map((k) => `${k}_${l}`));
const MAX = { en: { title: 60, desc: 200 }, zh: { title: 30, desc: 100 }, ja: { title: 36, desc: 110 }, ko: { title: 40, desc: 130 } };
// Titles say what readers get; the English Fix / Refactor opener has these equivalents
const FIX_OPENER = { en: /^(fix|fixed|fixes|refactor)\b/i, zh: /^(修复|修正|重构)/, ja: /^(修正|リファクタ)/, ko: /^(수정|버그 수정|리팩터)/ }; // lint: allow-cjk
// Plan IDs (F-08g, U-07, M5-09, P1-12) and build / test jargon readers should never see
const PLAN_ID = /\b[A-Z][A-Z0-9]?-\d{2}[a-z]?\b/;
const JARGON = /\b(wasm|webassembly|worker|HLE|golden|accept(\.sh)?|fingerprint|MMIO|VHCI|netif|webtest|lint|refactor(ed)?|WIP)\b/i;
// Entry pages come from the vite input table; old-address redirects and the iframe-only embed are not linkable
const vite = fs.readFileSync(path.join(web, 'vite.config.ts'), 'utf8');
const inputLine = /input: \{([^}]*)\}/.exec(vite)?.[1] ?? '';
const entryFiles = new Set([...inputLine.matchAll(/'(\w+)\.html'/g)].map((m) => m[1]).concat([...inputLine.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1])));
const NOT_PUBLIC = new Set(['home', 'advisor', 'levels', 'embed']);
const PUBLIC = [...entryFiles].filter((f) => !NOT_PUBLIC.has(f)).map((f) => (f === 'index' ? '/' : `/${f}`));
const EXAMPLES = new Set(JSON.parse(fs.readFileSync(path.join(root, 'firmware/examples.json'), 'utf8')).map((e) => e.id));
const workUnion = /export type WorkId = ([^;]+);/.exec(fs.readFileSync(path.join(web, 'src/app/types.ts'), 'utf8'))?.[1] ?? '';
const WORKS = new Set([...workUnion.matchAll(/'(\w+)'/g)].map((m) => m[1]));

function audit(entries) {
  const bad = [];
  for (const e of entries) {
    const at = `line ${e.line}${e.title ? ` "${e.title}"` : ''}`;
    const no = (msg) => bad.push(`${at}: ${msg}`);
    for (const k of NEED) if (!e[k] || (Array.isArray(e[k]) && !e[k].length)) no(`missing ${k}`);
    for (const k of Object.keys(e)) if (k !== 'line' && k !== 'chips' && !NEED.includes(k)) no(`unknown key ${k}`);
    if (e.date && (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || isNaN(Date.parse(e.date)))) no(`bad date ${e.date} (want YYYY-MM-DD)`);
    if (e.date > today) no(`date ${e.date} is in the future`);
    if (e.tag && !(e.tag in TAGS)) no(`unknown tag ${e.tag} (want ${Object.keys(TAGS).join(' | ')})`);
    if (e.chips !== undefined && !Array.isArray(e.chips)) no('chips must be a [list]');
    for (const c of Array.isArray(e.chips) ? e.chips : []) if (!CHIPS.includes(c)) no(`unknown chip ${c} (want ${CHIPS.join(' | ')})`);
    for (const l of ['en', ...OTHER]) {
      const key = (k) => (l === 'en' ? k : `${k}_${l}`);
      for (const k of ['title', 'desc']) if (String(e[key(k)] ?? '').length > MAX[l][k]) no(`${key(k)} is ${e[key(k)].length} chars (max ${MAX[l][k]})`);
      if (FIX_OPENER[l].test(e[key('title')] ?? '')) no(`${key('title')} starts with a fix / refactor word; say what readers get`);
      // Plan IDs and jargon stay out of every language (translations keep Latin terms like MQTT, so the same patterns apply)
      for (const k of TEXT) {
        const s = String(e[key(k)] ?? '');
        const hit = PLAN_ID.exec(s)?.[0] ?? JARGON.exec(s)?.[0];
        if (hit) no(`${key(k)} uses internal term "${hit}"`);
      }
    }
    if (e.link) {
      if (!/^\/(?!\/)/.test(e.link)) no(`link ${e.link} is not an in-site path (start with /)`);
      else {
        const u = new URL(e.link, 'https://x.invalid');
        const p = u.pathname.replace(/\.html$/, '').replace(/\/index$/, '/');
        if (!PUBLIC.includes(p)) no(`link ${e.link}: ${p} is not a public entry page (${PUBLIC.join(' ')})`);
        const ex = u.searchParams.get('example');
        const wk = u.searchParams.get('work');
        if (ex && !EXAMPLES.has(ex)) no(`link ${e.link}: example ${ex} is not in firmware/examples.json`);
        if (wk && !WORKS.has(wk)) no(`link ${e.link}: work ${wk} is not a WorkId`);
      }
    }
  }
  return bad;
}

const { entries, errs } = parseYaml(fs.readFileSync(src, 'utf8'));
const bad = [...errs, ...audit(entries)];
if (!entries.length) bad.push('no entries');
if (bad.length) {
  console.error(`[changelog] ${path.relative(root, src)}: ${bad.length} problem(s)`);
  for (const b of bad) console.error(`  - ${b}`);
  process.exit(2);
}

// ---- Shared data (newest first; same-day entries keep file order). Anchors and ids come from the English title in every locale
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const list = entries.map((e, i) => ({ ...e, chips: e.chips ?? [], i, id: `${e.date}-${slug(e.title)}` })).sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i);
const months = [];
for (const e of list) {
  const k = e.date.slice(0, 7);
  if (months.at(-1)?.key !== k) months.push({ key: k, items: [] });
  months.at(-1).items.push(e);
}
const newest = list[0].date;
const rel = (link) => `.${link}`; // site pages link with ./ (base './', sub-path deploys)
const abs = (link) => `${SITE}${link}`;
const field = (e, k, loc) => (loc === 'en' ? e[k] : e[`${k}_${loc}`]);

// ---- HTML
const PILL = {
  new: 'bg-accent-bg text-accent-ink',
  improve: 'bg-ok-bg text-ok-ink',
  announce: 'bg-warn-bg text-warn-ink',
  removed: 'bg-field text-muted',
};
const RSS = ICON('M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16M5 19.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z', 16);
const FILTERS = [['all', 'All'], ['new', 'New'], ['improve', 'Improved'], ['announce', 'Announcements']];
const filterJs = `
    <script>
      // Filter by data-tag; without JS the buttons stay hidden and every entry shows
      (function () {
        var g = document.getElementById('clFilter'), arts = document.querySelectorAll('article[data-tag]');
        g.hidden = false;
        g.addEventListener('click', function (ev) {
          var b = ev.target.closest('[data-filter]');
          if (!b) return;
          var f = b.dataset.filter, n = 0;
          g.querySelectorAll('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          arts.forEach(function (a) { var on = f === 'all' || a.dataset.tag === f; a.hidden = !on; if (on) n++; });
          document.querySelectorAll('main section[id]').forEach(function (s) { s.hidden = !s.querySelector('article:not([hidden])'); });
          document.getElementById('clEmpty').hidden = n > 0;
        });
      })();
    </script>`;

function renderHtml(loc) {
  const T = translator(loc);
  const feed = feedUrl(loc);
  const article = (e) => `<article id="${e.id}" data-tag="${e.tag}" class="flex gap-4 border-t border-line-soft py-5 first:border-t-0 max-md:flex-col max-md:gap-1.5">
          <time datetime="${e.date}" class="w-[88px] flex-none pt-0.5 font-mono text-[12px] text-muted">${fmtDay(loc, e.date, false)}</time>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5"><span class="rounded-full px-2 py-px text-[11px] font-semibold ${PILL[e.tag]}">${esc(T(TAGS[e.tag]))}</span>${e.chips.map((c) => `<span class="rounded border border-line px-1.5 font-mono text-[10.5px] text-muted">${esc(c)}</span>`).join('')}</div>
            <h3 class="mt-2 mb-1 text-[16px] leading-[1.4] font-bold"><a href="${esc(rel(e.link))}" class="text-fg hover:text-accent-ink">${esc(field(e, 'title', loc))}</a></h3>
            <p class="m-0 text-[14px] leading-[1.7] text-muted">${esc(field(e, 'desc', loc))}</p>
            <a href="${esc(rel(e.link))}" class="cl-cta mt-1.5 inline-flex items-center text-[13px] font-medium text-accent-ink hover:underline max-md:min-h-11">${esc(field(e, 'cta', loc))} →</a>
          </div>
        </article>`;
  const cur = months[0];
  const updated = T.html(cur.items.length === 1 ? 'Updated {date} · {n} update in {month}' : 'Updated {date} · {n} updates in {month}', {
    date: `<time datetime="${newest}">${esc(fmtDay(loc, newest))}</time>`,
    n: cur.items.length,
    month: esc(fmtMonth(loc, cur.key, true)),
  });
  const main = `<main class="cl mx-auto w-full max-w-[1040px] flex-1 px-6 pt-14 pb-16 max-md:px-4 max-md:pt-8 max-md:pb-12">
      <p class="m-0 font-mono text-[11px] tracking-[0.12em] text-muted">${esc(T('Changelog').toUpperCase())}</p>
      <h1 class="mt-2 mb-0 text-[32px] leading-[1.2] font-bold max-md:text-[26px]">${esc(T("What's new in TryBoard"))}</h1>
      <p class="mt-3 mb-0 max-w-[620px] text-[15px] leading-[1.7] text-muted">${esc(T('New boards, parts and lab tools, newest first. Every entry links to the page where you can try it in your browser — no board needed.'))}</p>
      <div class="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <a href="${feed}" type="application/atom+xml" class="inline-flex min-h-10 items-center gap-2 rounded-lg bg-accent px-4 text-[13px] font-semibold text-on-accent hover:bg-accent-strong max-md:min-h-11">${RSS}${esc(T('Subscribe (Atom)'))}</a>
        <span class="text-[12px] text-muted">${updated}</span>
      </div>
      <div class="mt-10 flex gap-12 max-md:mt-7 max-md:flex-col max-md:gap-6">
        <aside class="w-[220px] flex-none max-md:w-full">
          <div id="clFilter" role="group" aria-label="${esc(T('Filter updates'))}" hidden class="flex flex-wrap gap-1.5 max-md:-mx-4 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-4 max-md:pb-1 [&[hidden]]:hidden">
            ${FILTERS.map(([k, label]) => `<button type="button" data-filter="${k}" aria-pressed="${k === 'all'}" class="min-h-8 flex-none cursor-pointer rounded-full border border-line bg-surface px-3 text-[12px] text-muted hover:border-hover-line aria-pressed:border-accent-line aria-pressed:bg-accent-bg aria-pressed:font-semibold aria-pressed:text-accent-ink max-md:min-h-11 max-md:px-4">${esc(T(label))}</button>`).join('')}
          </div>
          <nav aria-label="${esc(T('Months'))}" class="mt-6 max-md:hidden">
            <p class="m-0 mb-1.5 font-mono text-[10.5px] tracking-[0.1em] text-muted">${esc(T('Months').toUpperCase())}</p>
            ${months.map((m) => `<a href="#${m.key}" class="flex min-h-8 items-center justify-between rounded-md px-2 text-[13px] text-fg hover:bg-field">${esc(fmtMonth(loc, m.key))}<span class="font-mono text-[11px] text-muted">${m.items.length}</span></a>`).join('\n            ')}
          </nav>
          <div class="mt-6 rounded-[10px] border border-line p-3.5 max-md:hidden">
            <b class="text-[13px]">${esc(T('Follow along'))}</b>
            <p class="mt-1 mb-2 text-[12px] leading-[1.6] text-muted">${esc(T('Add the Atom feed to your reader to hear about new boards and parts.'))}</p>
            <a href="${feed}" type="application/atom+xml" class="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent-ink hover:underline">${RSS}${feed.slice(2)}</a>
          </div>
        </aside>
        <div class="min-w-0 flex-1">
          ${months.map((m) => `<section id="${m.key}" aria-labelledby="${m.key}-h" class="mb-8">
        <h2 id="${m.key}-h" class="m-0 border-b border-line pb-2 font-mono text-[12px] font-semibold tracking-[0.12em] text-muted">${esc(fmtMonth(loc, m.key).toUpperCase())}</h2>
        ${m.items.map(article).join('\n        ')}
          </section>`).join('\n          ')}
          <p id="clEmpty" hidden class="text-[13px] text-muted">${esc(T('No updates with this label yet.'))}</p>
        </div>
      </div>
    </main>`;
  const title = T("Changelog · What's new in TryBoard");
  const description = T('New boards, parts and lab tools in TryBoard, the browser ESP32 simulator, newest first. Every entry links to a page where you can try it without a board.');
  const url = absUrl('changelog', loc);
  const ld = { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url, inLanguage: htmlLang(loc), description, dateModified: newest, isPartOf: { '@type': 'WebSite', name: 'TryBoard', url: `${SITE}/` } };
  return page({
    locale: loc,
    base: 'changelog',
    title,
    description,
    css: './src/changelog/changelog.css',
    label: T('Changelog'),
    main,
    head: `
    <link rel="alternate" type="application/atom+xml" title="${esc(T('TryBoard changelog'))}" href="${feed}" />
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
    script: filterJs,
  });
}

// ---- Atom 1.0 per locale: feed id / alternate / self point at that locale's page and file; entry ids = locale page URL + anchor
const x = (s) => esc(s).replace(/'/g, '&apos;');
function renderAtom(loc) {
  const T = translator(loc);
  const pageAbs = absUrl('changelog', loc);
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${htmlLang(loc)}">
  <title>${x(T('TryBoard changelog'))}</title>
  <subtitle>${x(T('New boards, parts and lab tools in TryBoard, newest first.'))}</subtitle>
  <id>${x(pageAbs)}</id>
  <link rel="alternate" type="text/html" href="${x(pageAbs)}"/>
  <link rel="self" type="application/atom+xml" href="${x(abs(feedUrl(loc).slice(1)))}"/>
  <updated>${newest}T00:00:00Z</updated>
  <author><name>TryBoard</name></author>
  <icon>${x(abs('/favicon.svg'))}</icon>
${list
  .map(
    (e) => `  <entry>
    <id>${x(`${pageAbs}#${e.id}`)}</id>
    <title>${x(field(e, 'title', loc))}</title>
    <updated>${e.date}T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="${x(abs(e.link))}"/>
    <category term="${e.tag}" label="${x(T(TAGS[e.tag]))}"/>${e.chips.map((c) => `\n    <category term="${x(c)}"/>`).join('')}
    <summary>${x(field(e, 'desc', loc))}</summary>
  </entry>`,
  )
  .join('\n')}
</feed>
`;
}

// ---- sitemap.xml + robots.txt (lastmod: newest entry for /changelog, build day for generated /licenses, else last git commit of the page)
const gitDay = (f) => {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', f], { cwd: web, encoding: 'utf8' }).trim() || today;
  } catch {
    return today;
  }
};
const lastmod = (p) => (p === '/changelog' ? newest : p === '/licenses' ? today : gitDay(p === '/' ? 'index.html' : `${p.slice(1)}.html`));
// Static pages exist once per locale: every version gets its own <url> listing all versions + x-default (Google hreflang sitemap form)
const LOCALIZED = new Set(['/changelog', '/licenses']);
const urlRows = PUBLIC.flatMap((p) => {
  if (!LOCALIZED.has(p)) return [`  <url><loc>${x(abs(p))}</loc><lastmod>${lastmod(p)}</lastmod></url>`];
  const b = p.slice(1);
  const alts = LOCS.map((l) => `<xhtml:link rel="alternate" hreflang="${htmlLang(l)}" href="${x(absUrl(b, l))}"/>`).join('') + `<xhtml:link rel="alternate" hreflang="x-default" href="${x(absUrl(b, 'en'))}"/>`;
  return LOCS.map((l) => `  <url><loc>${x(absUrl(b, l))}</loc><lastmod>${lastmod(p)}</lastmod>${alts}</url>`);
});
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlRows.join('\n')}
</urlset>
`;
const robots = `User-agent: *\nAllow: /\nDisallow: /embed\n\nSitemap: ${abs('/sitemap.xml')}\n`;

// Locale files sit next to --out / in --pub: changelog.html + changelog.zh.html ..., changelog.xml + changelog.zh.xml ...
const outFor = (loc) => (loc === 'en' ? out : out.replace(/\.html$/, `.${loc}.html`));
fs.mkdirSync(pub, { recursive: true });
for (const loc of LOCS) {
  fs.writeFileSync(outFor(loc), renderHtml(loc));
  fs.writeFileSync(path.join(pub, feedUrl(loc).slice(2)), renderAtom(loc));
}
fs.writeFileSync(path.join(pub, 'sitemap.xml'), sitemap);
fs.writeFileSync(path.join(pub, 'robots.txt'), robots);
console.log(`[changelog] wrote ${LOCS.map((l) => path.relative(root, outFor(l))).join(', ')} (${list.length} entries, newest ${newest}), ${LOCS.map((l) => feedUrl(l).slice(2)).join(', ')}, sitemap.xml (${urlRows.length} URLs: ${PUBLIC.join(' ')}), robots.txt`);
