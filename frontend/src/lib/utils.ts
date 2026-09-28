import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 速率格式化：>1000 自动切 Gbps */
export function fmtSpeed(v: number): string {
  if (v < 0) return "-"
  if (v >= 1000) return (v / 1000).toFixed(2) + " Gbps"
  return v.toFixed(v >= 100 ? 1 : 2) + " Mbps"
}

export function fmtSpeedShort(v: number): number {
  if (v < 0) return 0
  if (v >= 1000) return Number((v / 1000).toFixed(2))
  return Number(v.toFixed(1))
}

/** 时延格式化 */
export function fmtMs(v: number): string {
  if (v < 0) return "-"
  if (v < 10) return v.toFixed(1) + " ms"
  return Math.round(v) + " ms"
}

/** 速率档位色（与官方结果图口径一致） */
export function speedTone(v: number): string {
  if (v < 0 || v <= 20) return "text-destructive"
  if (v <= 150) return "text-amber-500"
  return "text-emerald-600"
}
