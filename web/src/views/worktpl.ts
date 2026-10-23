// Template lookup with a product-only fallback: a work whose assembly template hasn't landed yet still gets its product view.
// G-05b cloud / G-17b amoclock until their assembly steps add them to TEMPLATES; then the `??` never reaches the fallback.
import { TEMPLATES, type Template } from './templates';
import { createCloudProduct } from './cloudproduct';
import { createAmoclockProduct } from './amoclockproduct';
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
