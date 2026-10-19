// Merges the per-area dictionaries; each area file is owned by the code that uses it.
import type { Dict } from '../index.ts';
import site from './site.ts';
import lab from './lab.ts';
import views from './views.ts';
import data from './data.ts';
import checks from './checks.ts';
import steps from './steps.ts';

const dict: Dict = { ...data, ...checks, ...views, ...site, ...lab, ...steps };
export default dict;
