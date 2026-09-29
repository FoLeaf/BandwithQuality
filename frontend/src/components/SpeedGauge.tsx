import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"

/** speedtest.net 式非线性刻度：各档位在弧上均匀分布 */
const STOPS = [0, 5, 10, 50, 100, 250, 500, 750, 1000, 1500]
const START_ANGLE = 135 // 底部左侧
const SWEEP = 270 // 顺时针扫过角度

// 分区着色（奥迪转速表式，常显）：<700 白，700-1100 橙，>=1100 红
const ZONE_ORANGE = 700
const ZONE_RED = 1100
const COLOR_ORANGE = "#f97316"
const COLOR_RED = "#ef4444"
const COLOR_WHITE = "#ffffff"
const DIM = 0.35 // 未点亮透明度
const LIT = 1 // 点亮透明度

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
  /** down_* / up_*，决定中心读数的相位色 */
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

/** 值 → 弧上位置比例（分段线性插值，超过上限钳制） */
function valueToFraction(v: number): number {
  const c = Math.max(0, Math.min(v, STOPS[STOPS.length - 1]))
  for (let i = 1; i < STOPS.length; i++) {
    if (c <= STOPS[i]) {
      const seg = (c - STOPS[i - 1]) / (STOPS[i] - STOPS[i - 1])
      return (i - 1 + seg) / (STOPS.length - 1)
    }
  }
  return 1
}

function zoneColor(v: number): string {
  if (v >= ZONE_RED) return COLOR_RED
  if (v >= ZONE_ORANGE) return COLOR_ORANGE
  return COLOR_WHITE
}

/** 主刻度（STOPS 档位）+ 每段 4 根小刻度，均按真实数值定位 */
const TICKS = STOPS.flatMap((s, i) => {
  const ticks = [{ value: s, major: true }]
  if (i < STOPS.length - 1) {
    for (let k = 1; k <= 4; k++) {
      ticks.push({ value: s + ((STOPS[i + 1] - s) * k) / 4, major: false })
    }
  }
  return ticks
})

function fmtLive(v: number): string {
  if (v >= 1000) return (v / 1000).toFixed(2)
  return v.toFixed(v >= 100 ? 1 : 2)
}

/** 实时速率仪表盘：奥迪虚拟座舱风格——深色表盘 + 分区刻度点亮 + 橙色指针 + 中心数字；center 插槽用于空闲态放开始按钮 */
export function SpeedGauge({ value, phase, label, size = 280, className, center }: SpeedGaugeProps) {
  const display = useSmoothedValue(value)
  const needleAngle = START_ANGLE + valueToFraction(display) * SWEEP
  const isUp = phase?.startsWith("up")
  const phaseColor = isUp ? "var(--chart-2)" : "var(--chart-1)"

  // center 消失后保留最近一次内容 300ms，让淡出动画播完
  const [lastCenter, setLastCenter] = useState(center)
  useEffect(() => {
    if (center != null) setLastCenter(center)
  }, [center])
  const hasCenter = center != null

  const cx = 120
  const cy = 120
  const rTickOuter = 100
  const rTickMajorInner = 86
  const rTickMinorInner = 94
  const rLabel = 72
  // 指针/数字与中心插件的交叉淡入淡出
  const readoutOpacity = hasCenter ? 0 : 1

  return (
    <div className={cn("relative select-none", className)} style={{ width: size }}>
      <svg viewBox="0 0 240 240" width={size} className="overflow-visible">
        <defs>
          <radialGradient id="gaugeFace" cx="50%" cy="42%" r="66%">
            <stop offset="0%" stopColor="#31313a" />
            <stop offset="68%" stopColor="#1f1f25" />
            <stop offset="100%" stopColor="#111114" />
          </radialGradient>
          <linearGradient id="gaugeBezel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e4e4e7" />
            <stop offset="50%" stopColor="#6f6f78" />
            <stop offset="100%" stopColor="#cfcfd4" />
          </linearGradient>
          <linearGradient id="gaugeNeedle" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fb923c" />
            <stop offset="100%" stopColor="#ea580c" />
          </linearGradient>
          <filter id="gaugeDrop" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" floodColor="#000" floodOpacity="0.45" />
          </filter>
        </defs>

        {/* 表盘面 + 金属外圈 */}
        <circle cx={cx} cy={cy} r={104} fill="url(#gaugeFace)" filter="url(#gaugeDrop)" />
        <circle cx={cx} cy={cy} r={104} fill="none" stroke="url(#gaugeBezel)" strokeWidth={3} />
        <circle cx={cx} cy={cy} r={64} fill="none" stroke="#fff" strokeOpacity={0.06} strokeWidth={1} />

        {/* 刻度环：分区色常显，指针扫过后点亮 */}
        {TICKS.map(({ value: v, major }) => {
          const a = START_ANGLE + valueToFraction(v) * SWEEP
          const lit = needleAngle >= a - 0.01
          const inner = major ? rTickMajorInner : rTickMinorInner
          const p1 = polar(cx, cy, rTickOuter, a)
          const p2 = polar(cx, cy, inner, a)
          return (
            <line
              key={`${major ? "M" : "m"}${v}`}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              stroke={zoneColor(v)}
              strokeWidth={major ? 3.2 : 1.4}
              strokeLinecap="butt"
              style={{ opacity: lit ? LIT : DIM, transition: "opacity 150ms ease" }}
            />
          )
        })}
        {/* 档位数字（主刻度内侧，直立） */}
        {STOPS.map((s) => {
          const a = START_ANGLE + valueToFraction(s) * SWEEP
          const lit = needleAngle >= a - 0.01
          const p = polar(cx, cy, rLabel, a)
          return (
            <text
              key={s}
              x={p.x}
              y={p.y}
              dy="0.35em"
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              fill={zoneColor(s)}
              style={{ opacity: lit ? 0.95 : DIM, transition: "opacity 150ms ease" }}
            >
              {s}
            </text>
          )
        })}

        {/* 指针（锥形，恒定奥迪橙，绕轴心旋转；仅淡出保留过渡） */}
        <g
          style={{
            transform: `rotate(${needleAngle}deg)`,
            transformOrigin: `${cx}px ${cy}px`,
            opacity: readoutOpacity,
            transition: "opacity 300ms ease",
          }}
        >
          <path
            d={`M ${cx - 22} ${cy - 2.6} L ${cx + 40} ${cy - 1.8} L ${cx + 84} ${cy - 0.4} L ${cx + 84} ${cy + 0.4} L ${cx + 40} ${cy + 1.8} L ${cx - 22} ${cy + 2.6} Z`}
            fill="url(#gaugeNeedle)"
            filter="url(#gaugeDrop)"
          />
        </g>
        {/* 金属轴心 */}
        <circle
          cx={cx}
          cy={cy}
          r={9.5}
          fill="#1c1c20"
          stroke="#a1a1aa"
          strokeWidth={1.6}
          style={{ opacity: readoutOpacity, transition: "opacity 300ms ease" }}
        />
        <circle
          cx={cx}
          cy={cy}
          r={3}
          fill={COLOR_ORANGE}
          style={{ opacity: readoutOpacity, transition: "opacity 300ms ease" }}
        />
      </svg>

      {/* 中心实时数字（落在底部缺口区，不与指针相交；跟随平滑值逐帧计数） */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-6 flex flex-col items-center"
        style={{ opacity: readoutOpacity, transform: hasCenter ? "translateY(8px)" : "translateY(0)", transition: "opacity 300ms ease, transform 300ms ease" }}
      >
        <span className="text-[40px] leading-none font-semibold tracking-tight text-[#fafafa] tabular-nums">{fmtLive(display)}</span>
        <div className="mt-1.5 flex items-center gap-1 text-xs" style={{ color: phaseColor }}>
          {isUp ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
          <span>{display >= 1000 ? "Gbps" : "Mbps"}</span>
        </div>
        {label && <div className="mt-0.5 text-xs text-white/60">{label}</div>}
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
