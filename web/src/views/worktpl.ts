// Template lookup by work id; every work with a product view now has an assembly template.
import { TEMPLATES, type Template } from './templates';

export const workTemplate = (id: string): Template | undefined => TEMPLATES[id];
