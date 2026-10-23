// Template lookup with a product-only fallback: a work whose assembly template hasn't landed yet still gets its product view.
// Empty since G-05c added CLOUD to TEMPLATES; the assemble step's mountProductOnly path stays for the next such work.
import { TEMPLATES, type Template } from './templates';

const PRODUCT_ONLY: Record<string, Template> = {};

export const workTemplate = (id: string): Template | undefined => TEMPLATES[id] ?? PRODUCT_ONLY[id];
