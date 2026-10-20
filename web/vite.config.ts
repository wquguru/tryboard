import { defineConfig, type Plugin } from 'vite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// licenses.html is generated at build time by tools/gen_licenses.mjs (not in git); the build still works without it.
const licenses = existsSync(new URL('./licenses.html', import.meta.url)) ? { licenses: 'licenses.html' } : {};

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
  worker: { format: 'es' },
  plugins: [react(), tailwindcss(), models(), assetHashes()],
  // Level definitions (firmware/levels.json) live outside web/, so the dev server must allow the parent directory.
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    // Page files end in .html but site links have no suffix (/app -> app.html via Vite dev / preview and static hosting, DESIGN_V2 §7.2).
    // index.html is home; home / advisor / levels are old-URL redirect pages.
    rollupOptions: { input: { main: 'index.html', select: 'select.html', app: 'app.html', home: 'home.html', advisor: 'advisor.html', levels: 'levels.html', ...licenses } },
  },
});
