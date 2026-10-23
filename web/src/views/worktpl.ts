// Template lookup with a product-only fallback: a work whose assembly template hasn't landed yet still gets its product view.
// G-05c moved cloud into TEMPLATES; G-16b dialtimer / G-17b amoclock stay here until G-16c / G-17c add their stands, then the `??` never reaches the fallback.
import { TEMPLATES, type Template } from './templates';
import { createDialtimerProduct, DIAL_BTN } from './dialtimerproduct';
import { createAmoclockProduct } from './amoclockproduct';
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
  // G-17b AMOLED clock: finished board, no assembly template until G-17c (stand / case)
  amoclock: {
    id: 'amoclock',
    caption: t('AMOLED desk clock'),
    parts: [],
    tray: [],
    intro: [t('AMOLED desk clock'), ''],
    checks: () => [],
    effects: () => ({}),
    product: (el, h) => createAmoclockProduct(el, h),
  },
};

export const workTemplate = (id: string): Template | undefined => TEMPLATES[id] ?? PRODUCT_ONLY[id];
