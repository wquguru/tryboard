// Template lookup with a product-only fallback: a work whose assembly template hasn't landed yet still gets its product view.
// G-04b irlamp until G-04c adds IRLAMP to TEMPLATES (product: createIrlampProduct); then the `??` never reaches the fallback.
import { TEMPLATES, type Template } from './templates';
import { createIrlampProduct } from './irlampproduct';
import { t } from '../i18n';

const PRODUCT_ONLY: Record<string, Template> = {
  irlamp: {
    id: 'irlamp',
    caption: t('IR remote night light'),
    parts: [],
    tray: [],
    intro: [t('IR remote night light'), ''],
    checks: () => [],
    effects: () => ({}),
    product: (el, h) => createIrlampProduct(el, { pin: 5, send: h.ir }),
  },
};

export const workTemplate = (id: string): Template | undefined => TEMPLATES[id] ?? PRODUCT_ONLY[id];
