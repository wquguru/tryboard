import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并类名：后写的 Tailwind 类覆盖先写的同类（组件默认样式可被调用方改） */
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
