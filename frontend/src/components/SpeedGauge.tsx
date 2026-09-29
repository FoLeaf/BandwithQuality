import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"

/** speedtest.net 式非线性刻度：各档位在弧上均匀分布 */
const STOPS = [0, 5, 10, 50, 100, 250, 500, 750, 1000, 1500]
const START_ANGLE = 135 // 底部左侧
const SWEEP = 270 // 顺时针扫过角度

// 仪表追赶动画参数：目标值按采样间隔（500ms）才来一次，显示值在 rAF 里
// 逐帧向目标做指数逼近，帧率无关的非线性缓动，采样间隙里也有连续运动。
const TAU_UP = 220 // ms，上行追赶时间常数：起步快、收尾缓
const TAU_DOWN = 140 // ms，下行回摆更快，换相/归零不拖泥带水
const SNAP = 0.01 // Mbps，差距小于此视为到位，停帧省电

function useSmoothedValue(target: number): number {
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)
  const targetRef = useRef(target)

  useEffect(() => {
    targetRef.current = target
    const gap = Math.abs(target - displayRef.current)
    if (gap <= SNAP) {
      if (gap > 0) {
        displayRef.current = target
        setDisplay(target)
      }
      return
    }
    let raf = 0
    let last = 0
    const step = (now: number) => {
      // 后台标签页恢复时 dt 可能很大，钳制避免指针暴冲
      const dt = last ? Math.min(now - last, 100) : 16.7
      last = now
      const t = targetRef.current
      let d = displayRef.current
      d += (t - d) * (1 - Math.exp(-dt / (t < d ? TAU_DOWN : TAU_UP)))
      if (Math.abs(t - d) <= SNAP) d = t
      displayRef.current = d
      setDisplay(d)
      if (d !== t) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target])

  return display
}

interface SpeedGaugeProps {
  /** 目标速率 Mbps（最新采样值），显示值会平滑追赶 */
  value: number
  /** down_* / up_*，决定进度弧与图标颜色 */
  phase?: string
  /** 仪表盘下方阶段名（空则不显示） */
  label?: string
  size?: number
  className?: string
  /** 传入时居中显示该内容（如开始按钮），并淡出指针与数字 */
  center?: React.ReactNode
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const s = polar(cx, cy, r, a0)
  const e = polar(cx, cy, r, a1)
  const large = a1 - a0 > 180 ? 1 : 0
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`
}

/** 值 → 弧上位置比例（分段线性插值，超过上限钳制） */
export function valueToFraction(v: number): number {
  const c = Math.max(0, Math.min(v, STOPS[STOPS.length - 1]))
  for (let i = 1; i < STOPS.length; i++) {
    if (c <= STOPS[i]) {
      const seg = (c - STOPS[i - 1]) / (STOPS[i] - STOPS[i - 1])
      return (i - 1 + seg) / (STOPS.length - 1)
    }
  }
  return 1
}

function fmtLive(v: number): string {
  if (v >= 1000) return (v / 1000).toFixed(2)
  return v.toFixed(v >= 100 ? 1 : 2)
}

/** 实时速率仪表盘：进度弧 + 指针 + 中心数字（rAF 平滑追赶）；center 插槽用于空闲态放开始按钮 */
export function SpeedGauge({ value, phase, label, size = 280, className, center }: SpeedGaugeProps) {
  const display = useSmoothedValue(value)
  const frac = valueToFraction(display)
  const angle = START_ANGLE + frac * SWEEP
  const isUp = phase?.startsWith("up")
  const arcColor = isUp ? "var(--chart-2)" : "var(--chart-1)"

  // center 消失后保留最近一次内容 300ms，让淡出动画播完
  const [lastCenter, setLastCenter] = useState(center)
  useEffect(() => {
    if (center != null) setLastCenter(center)
  }, [center])
  const hasCenter = center != null

  const cx = 120
  const cy = 112
  const r = 88
  const rLabel = 62
  // 指针/数字与中心插件的交叉淡入淡出
  const readoutOpacity = hasCenter ? 0 : 1

  return (
    <div className={cn("relative select-none", className)} style={{ width: size }}>
      <svg viewBox="0 0 240 205" width={size} className="overflow-visible">
        {/* 轨道 */}
        <path d={arcPath(cx, cy, r, START_ANGLE, START_ANGLE + SWEEP)} fill="none" stroke="var(--muted)" strokeWidth={14} strokeLinecap="round" />
        {/* 进度弧（角度由 rAF 逐帧驱动，不用 CSS transition） */}
        {frac > 0.001 && (
          <path d={arcPath(cx, cy, r, START_ANGLE, angle)} fill="none" stroke={arcColor} strokeWidth={14} strokeLinecap="round" style={{ opacity: 0.9 }} />
        )}
        {/* 刻度 */}
        {STOPS.map((s, i) => {
          const a = START_ANGLE + (i / (STOPS.length - 1)) * SWEEP
          const p = polar(cx, cy, rLabel, a)
          return (
            <text
              key={s}
              x={p.x}
              y={p.y + 4}
              textAnchor="middle"
              fontSize={11}
              fill={s <= 10 ? "var(--foreground)" : "var(--muted-foreground)"}
              fontWeight={s <= 10 ? 600 : 400}
            >
              {s}
            </text>
          )
        })}
        {/* 指针（绕轴心旋转，角度由 rAF 逐帧驱动；仅淡出保留过渡） */}
        <g
          style={{
            transform: `rotate(${angle}deg)`,
            transformOrigin: `${cx}px ${cy}px`,
            opacity: readoutOpacity,
            transition: "opacity 300ms ease",
          }}
        >
          <line x1={cx - 18} y1={cy} x2={cx + r - 26} y2={cy} stroke="var(--foreground)" strokeWidth={3.5} strokeLinecap="round" />
          <line x1={cx - 18} y1={cy} x2={cx + 18} y2={cy} stroke="var(--foreground)" strokeWidth={7} strokeLinecap="round" />
        </g>
        <circle cx={cx} cy={cy} r={6.5} fill="var(--foreground)" style={{ opacity: readoutOpacity, transition: "opacity 300ms ease" }} />
        <circle cx={cx} cy={cy} r={2.5} fill="var(--background)" style={{ opacity: readoutOpacity, transition: "opacity 300ms ease" }} />
      </svg>

      {/* 中心实时数字（跟随平滑值逐帧计数） */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-1 flex flex-col items-center"
        style={{ opacity: readoutOpacity, transform: hasCenter ? "translateY(8px)" : "translateY(0)", transition: "opacity 300ms ease, transform 300ms ease" }}
      >
        <div className="flex items-end gap-1">
          <span className="text-foreground tabular text-4xl leading-none font-semibold tracking-tight">{fmtLive(display)}</span>
        </div>
        <div className="mt-1 flex items-center gap-1 text-xs" style={{ color: arcColor }}>
          {isUp ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
          <span>{display >= 1000 ? "Gbps" : "Mbps"}</span>
        </div>
        {label && <div className="text-muted-foreground mt-0.5 text-xs">{label}</div>}
      </div>

      {/* 中心插槽（开始按钮等）：保持挂载以播放进出场动画 */}
      {lastCenter != null && (
        <div
          className={cn("absolute inset-0 flex items-center justify-center", !hasCenter && "pointer-events-none")}
          style={{
            opacity: hasCenter ? 1 : 0,
            transform: hasCenter ? "scale(1)" : "scale(0.6)",
            transition: "opacity 300ms ease, transform 300ms cubic-bezier(0.34, 1.4, 0.64, 1)",
          }}
        >
          {lastCenter}
        </div>
      )}
    </div>
  )
}
