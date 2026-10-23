// Template lookup with a product-only fallback: a work whose assembly template hasn't landed yet still gets its product view.
// G-05c moved cloud into TEMPLATES; G-16b dialtimer stays here until G-16c adds its stand, then the `??` never reaches the fallback.
import { TEMPLATES, type Template } from './templates';
import { createDialtimerProduct, DIAL_BTN } from './dialtimerproduct';
import { t } from '../i18n';

const PRODUCT_ONLY: Record<string, Template> = {
  dialtimer: {
    id: 'dialtimer',
    caption: t('Dial timer'),
    parts: [],
    tray: [],
    intro: [t('Dial timer'), ''],
    checks: () => [],
    effects: () => ({}),
    product: (el, h) => createDialtimerProduct(el, { enc: h.enc, touch: h.touch, btn: h.boardBtn && ((d) => h.boardBtn!(DIAL_BTN, d)) }),
  },
};

export const workTemplate = (id: string): Template | undefined => TEMPLATES[id] ?? PRODUCT_ONLY[id];
