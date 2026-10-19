import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class names; later Tailwind classes win so callers can override component defaults. */
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
