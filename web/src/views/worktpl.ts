// Template lookup with a product-only fallback: a work whose assembly template hasn't landed yet still gets its product view.
// G-05b cloud until G-05c adds CLOUD, G-16b dialtimer until G-16c adds its stand; then the `??` never reaches the fallback.
import { TEMPLATES, type Template } from './templates';
import { createCloudProduct } from './cloudproduct';
import { createDialtimerProduct, DIAL_BTN } from './dialtimerproduct';
import { t } from '../i18n';

const PRODUCT_ONLY: Record<string, Template> = {
  cloud: {
    id: 'cloud',
    caption: t('Temperature and humidity to the cloud'),
    parts: [],
    tray: [],
    intro: [t('Temperature and humidity to the cloud'), ''],
    checks: () => [],
    effects: () => ({}),
    product: (el, h) => createCloudProduct(el, { send: h.mqtt }),
  },
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
