import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { main: 'index.html', advisor: 'advisor.html' } },
  },
});
