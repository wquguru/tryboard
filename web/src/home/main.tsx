import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/tailwind.css';
// 卡片预览里的成品示意 / 成品视图（views/）自带样式；home.css 把它们的底色统一成台面浅灰
import '../views/views.css';
import './home.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
