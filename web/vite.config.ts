import { defineConfig, type Plugin } from 'vite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// licenses.html 由 tools/gen_licenses.mjs 在构建期生成（不进仓库）；没生成时照样能 build
const licenses = existsSync(new URL('./licenses.html', import.meta.url)) ? { licenses: 'licenses.html' } : {};

/** 外部 3D 模型（P1-09）：assets/models/<名字>/ 里的 glb、SOURCES.md、LICENSE 原样发布到 models/<名字>/，
 *  开发服务器直接从 assets 读。CC BY-SA 模型连同许可与来源一起可下载（LICENSING.md 第 1 行）。原始 STEP（src/）不发布。 */
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

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [react(), tailwindcss(), models()],
  // 关卡定义 firmware/levels.json 在 web/ 外面，开发服务器要放行上一级目录
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    // 页面文件带 .html，站内链接不带后缀（/app → app.html 由 Vite 开发 / 预览服务器和静态托管映射，DESIGN_V2 §7.2）。
    // index.html 是首页；home / advisor / levels 是旧地址跳转页
    rollupOptions: { input: { main: 'index.html', select: 'select.html', app: 'app.html', home: 'home.html', advisor: 'advisor.html', levels: 'levels.html', ...licenses } },
  },
});
