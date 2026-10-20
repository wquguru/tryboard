// The whole dictionary (tests, tools); pages load only their groups via web/src/i18n/index.ts (R-20).
import type { Dict } from '../index.ts';
import site from './site.ts';
import select from './select.ts';
import app from './app.ts';

const dict: Dict = { ...app, ...select, ...site };
export default dict;
