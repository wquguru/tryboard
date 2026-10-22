import { defineConfig, type Plugin } from 'vite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// licenses.html is generated at build time by tools/gen_licenses.mjs (not in git); the build still works without it.
const licenses = existsSync(new URL('./licenses.html', import.meta.url)) ? { licenses: 'licenses.html' } : {};
// changelog.html likewise comes from tools/gen_changelog.mjs (web/changelog.yaml, F-12).
const changelog = existsSync(new URL('./changelog.html', import.meta.url)) ? { changelog: 'changelog.html' } : {};
const DICT = /\/i18n\/(zh|ja|ko)\/(\w+)\.ts$/;
// Dictionary chunks are named i18n-<locale>-<group> so perf.mjs and the HTML preload can find them (R-20).
const chunkFileNames = (c: { facadeModuleId: string | null }) => {
  const m = DICT.exec(c.facadeModuleId ?? '');
  return m ? `assets/i18n-${m[1]}-${m[2]}-[hash].js` : 'assets/[name]-[hash].js';
};

/** External 3D models (P1-09): glb, SOURCES.md and LICENSE in assets/models/<name>/ ship as is to models/<name>/; dev reads assets.
 *  CC BY-SA models are downloadable with licence and source (LICENSING.md row 1); the original STEP (src/) is not shipped. */
function models(): Plugin {
  const dir = fileURLToPath(new URL('../assets/models', import.meta.url));
  const PUBLISH = /^(.+\.glb|SOURCES\.md|LICENSE(\.md)?)$/;
  const files = () =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .flatMap((d) => readdirSync(path.join(dir, d.name)).filter((f) => PUBLISH.test(f)).map((f) => `${d.name}/${f}`))
      : [];
  const type = (f: string) => (f.endsWith('.glb') ? 'model/gltf-binary' : 'text/plain; charset=utf-8');
  return {
    name: 'tb-models',
    configureServer(server) {
      server.middlewares.use('/models', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        if (!files().includes(rel)) return next();
        res.setHeader('Content-Type', type(rel));
        res.end(readFileSync(path.join(dir, rel)));
      });
    },
    generateBundle() {
      for (const f of files()) this.emitFile({ type: 'asset', fileName: `models/${f}`, source: readFileSync(path.join(dir, f)) });
    },
  };
}

/** R-20: preload this page's dictionary groups for the visitor's locale from the HTML, so they download alongside the entry
 *  instead of after it. The locale pick mirrors detectLocale() in src/i18n/index.ts; dev has no bundle and skips this. */
function dictPreload(): Plugin {
  return {
    name: 'tb-dict-preload',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const groups = html.match(/<html[^>]*\sdata-i18n="([^"]*)"/)?.[1];
        if (!ctx.bundle || !groups) return html;
        const map: Record<string, Record<string, string>> = {};
        for (const f of Object.keys(ctx.bundle)) {
          const m = f.match(/^assets\/i18n-(zh|ja|ko)-(\w+)-[^/]*\.js$/);
          if (m) (map[m[1]] ??= {})[m[2]] = `./${f}`;
        }
        const code = `(function(){try{var m=${JSON.stringify(map)},g=${JSON.stringify(groups.split(/\s+/))},q=new URLSearchParams(location.search).get('lang'),l=q==='en'||m[q]?q:null;if(!l)try{var s=localStorage.getItem('tb-lang');if(s==='en'||m[s])l=s}catch(e){}if(!l)for(var n=navigator.languages||[navigator.language],i=0;i<n.length&&!l;i++){var p=(n[i]||'').toLowerCase().split('-')[0];if(p==='en'||m[p])l=p}var d=m[l];if(d)g.forEach(function(k){if(!d[k])return;var e=document.createElement('link');e.rel='modulepreload';e.crossOrigin='';e.href=d[k];document.head.appendChild(e)})}catch(e){}})()`;
        return { html, tags: [{ tag: 'script', children: code, injectTo: 'head-prepend' }] };
      },
    },
  };
}

/** R-19: content hashes of wasm / ROM / firmware / fonts.css (tools/asset_hashes.py, run by build_web.sh) inlined into every page,
 *  so versioned URLs cost no extra request and a wasm-only change leaves JS chunk names alone. Missing file: plain URLs. */
function assetHashes(): Plugin {
  const file = fileURLToPath(new URL('./asset-hashes.json', import.meta.url));
  return {
    name: 'tb-asset-hashes',
    // post: after Vite rewrites the public link to ./fonts/fonts.css for base './'
    transformIndexHtml: { order: 'post', handler(html) {
      if (!existsSync(file)) return html;
      const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
      const css = map['fonts/fonts.css'];
      return {
        html: css ? html.replace(/href="(\.?\/fonts\/fonts\.css)"/g, `href="$1?v=${css}"`) : html,
        tags: [{ tag: 'script', children: `window.__TB_ASSETS__=${JSON.stringify(map)}`, injectTo: 'head-prepend' }],
      };
    } },
  };
}

export default defineConfig({
  base: './',
  worker: { format: 'es', rollupOptions: { output: { chunkFileNames } } },
  plugins: [react(), tailwindcss(), models(), dictPreload(), assetHashes()],
  // Level definitions (firmware/levels.json) live outside web/, so the dev server must allow the parent directory.
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    // Page files end in .html but site links have no suffix (/app -> app.html via Vite dev / preview and static hosting, DESIGN_V2 §7.2).
    // index.html is home; home / advisor / levels are old-URL redirect pages.
    rollupOptions: {
      input: { main: 'index.html', select: 'select.html', app: 'app.html', home: 'home.html', advisor: 'advisor.html', levels: 'levels.html', ...licenses, ...changelog, embed: 'embed.html' },
      output: { chunkFileNames },
    },
  },
});
