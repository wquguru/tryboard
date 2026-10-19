import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/tailwind.css';
import { App } from './App';
import { t } from '../i18n';

document.title = t('Pick a board · TryBoard');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
