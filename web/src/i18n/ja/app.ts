// App group (R-20): lab-only area files, loaded by app.html after site and select; each area file is owned by the code that uses it.
import type { Dict } from '../index.ts';
import lab from './lab.ts';
import course from './course.ts';
import views from './views.ts';
import data from './data.ts';
import checks from './checks.ts';
import steps from './steps.ts';
import net from './net.ts';

const dict: Dict = { ...data, ...checks, ...views, ...lab, ...course, ...steps, ...net };
export default dict;
