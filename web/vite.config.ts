import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // 关卡定义 firmware/levels.json 在 web/ 外面，开发服务器要放行上一级目录
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { main: 'index.html', advisor: 'advisor.html', home: 'home.html', levels: 'levels.html', app: 'app.html' } },
  },
});
