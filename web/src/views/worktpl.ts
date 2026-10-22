// Template lookup with a product-only fallback: a work whose assembly template hasn't landed yet still gets its product view.
// G-03b door until G-03c adds DOOR to TEMPLATES; once it does, the `??` below never reaches the fallback.
import { TEMPLATES, type Template } from './templates';
import { createDoorProduct } from './doorproduct';
import { t } from '../i18n';

const PRODUCT_ONLY: Record<string, Template> = {
  door: {
    id: 'door',
    caption: t('RFID door lock'),
    parts: [],
    tray: [],
    intro: [t('RFID door lock'), ''],
    checks: () => [],
    effects: () => ({}),
    product: (el) => createDoorProduct(el),
  },
};

export const workTemplate = (id: string): Template | undefined => TEMPLATES[id] ?? PRODUCT_ONLY[id];
