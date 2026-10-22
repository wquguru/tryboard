// Template lookup shared by the home cards and the product step.
import { TEMPLATES, type Template } from './templates';

export const workTemplate = (id: string): Template | undefined => TEMPLATES[id];
