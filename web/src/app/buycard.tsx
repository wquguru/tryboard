// 「真买」卡（DESIGN_V2 §8.3，稿 LoopB）：网页里做成了之后，做成真的——真买、烧、上真机逐项勾。
// 自定义作品在实验台检查点全过后出现（bench.tsx），现成作品在成品步之后出现（product.tsx）；两处共用这一个组件。
import type { BuyLine } from '../catalog/templates.ts';

export interface BuyCardProps {
  /** 还要买的（已勾「我已有」的不列） */
  remaining: BuyLine[];
  /** 检查点全过时的运行指纹 */
  fingerprint: string | null;
  /** 网页证明不了、要上真机逐项勾的条目（来自本作品「必须上真机」） */
  manual: string[];
  /** 已勾的条目（存本机，由调用方读写） */
  checked: string[];
  onToggleManual: (item: string) => void;
  /** 下载 flash.bin（没有用户固件时传 null，按钮不出现） */
  onDownloadBin: (() => void) | null;
}

/** 骨架：U-18 填实现（参考价合计、复制搜索词、导出 CSV、三栏布局、手机单列） */
export function BuyCard(_p: BuyCardProps) {
  return null;
}
