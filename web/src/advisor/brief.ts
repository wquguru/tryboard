// 占位：给 AI 的任务书由选板页代理实现（签名固定），合并时以那边为准。这里只给实验台「复制给 AI 的任务书」一个能用的最小版本。
import type { SelectState } from './state.ts';
import { TEMPLATES } from './data.ts';

export function briefMarkdown(s: SelectState): string {
  const t = TEMPLATES.find((x) => x.id === s.t);
  return [`# ${t?.title ?? '我的项目'}`, '', `板子：${s.board || '按选板推荐'}`, `零件：${[...(t?.parts ?? []).filter((p) => !s.rm.includes(p)), ...s.add].join('、') || '无'}`, '', '用 ESP-IDF 5.x 写固件，只交 flash.bin（合并镜像，从 0x0 开始）。'].join('\n');
}
