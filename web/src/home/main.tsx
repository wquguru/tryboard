import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/tailwind.css';
// views/ brings its own styles; home.css flattens their backgrounds to the stage grey.
import '../views/views.css';
import './home.css';
import { App } from './App';
import { t } from '../i18n';

document.title = t('TryBoard · Free online lab for AI hardware projects');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
