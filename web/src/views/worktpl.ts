// Template lookup with a product-only fallback: a work whose assembly template hasn't landed yet still gets its product view.
// G-05c moved cloud, G-16c dialtimer and G-17c amoclock into TEMPLATES, so the fallback is empty until the next such work.
import { TEMPLATES, type Template } from './templates';

const PRODUCT_ONLY: Record<string, Template> = {};

export const workTemplate = (id: string): Template | undefined => TEMPLATES[id] ?? PRODUCT_ONLY[id];
