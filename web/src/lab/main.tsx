// 空白实验台入口。不包 StrictMode：开发时的双挂载会建两个 worker、两个 WebGL 上下文（清理逻辑照样写全）。
import { createRoot } from 'react-dom/client';
import '../ui/tailwind.css';
// 装配视图（views/assembly.ts）的样式；app.html、home.html 也用它，所以留着不并进 Tailwind
import '../views/views.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
