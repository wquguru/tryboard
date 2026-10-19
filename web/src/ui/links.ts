// 站内地址只在这里拼（DESIGN_V2 §7.2）：不带 .html 后缀，靠 Vite 开发 / 预览服务器和静态托管把 /app 映射到 app.html。
// 以后改成路径化地址（/works/weather/shop，DECISIONS 2026-10-18 暂缓的第二步）只改这个文件。
// 一律相对 ./，因为 base 是 './'（pack_artifact 打包、子路径部署都靠它）。

import type { StepId } from '../app/types';

export const HOME = './';
export const SELECT = './select';
export const LICENSES = './licenses';

/** 工作台：作品某一步；cp 选中检查点，example 是空白作品上开的示例 */
export function lab(work: string, step: StepId = 'bench', opt: { cp?: string; example?: string } = {}): string {
  const q = new URLSearchParams({ work });
  if (opt.example) q.set('example', opt.example);
  if (opt.cp) q.set('cp', opt.cp);
  return `./app?${q}#${step}`;
}

export const BLANK_LAB = lab('blank');

/** 选板结果进采购（work=custom）：参数串由 advisor/state.ts encode(s, true) 给出 */
export const customLab = (params: string, step: StepId = 'shop') => `./app?work=custom${params ? `&${params}` : ''}#${step}`;

/** 选板结果的分享地址（不带「我已有」） */
export const selectLink = (params: string) => `${SELECT}${params ? `?${params}` : ''}`;

/** 文档型页面（首页、选板）的站点导航 */
export const SITE_NAV: [string, string][] = [
  [HOME, '作品'],
  [SELECT, '选板'],
  [BLANK_LAB, '实验台'],
];
