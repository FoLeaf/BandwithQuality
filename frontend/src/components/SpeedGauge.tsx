import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"

/** speedtest.net 式非线性刻度：各档位在弧上均匀分布 */
const STOPS = [0, 5, 10, 50, 100, 250, 500, 750, 1000, 1500]
const START_ANGLE = 135 // 底部左侧
const SWEEP = 270 // 顺时针扫过角度

// 几何（viewBox 260）：大圆盘 + 圆外一圈细短锋利刻度 + 最外侧档位数字
const CX = 130
const CY = 130
const R_FACE = 86 // 圆盘半径
const R_TRACK = 86 // 进度弧贴着圆盘边缘
const R_TICK_IN = 91 // 刻度起点（圆缘外留 5px 呼吸）
const R_TICK_MAJOR_OUT = 105
const R_TICK_MINOR_OUT = 99
const R_NEEDLE_OUT = 112 // 当前速度处的高亮针，比刻度更长
const R_LABEL = 115.5
const ZONE_RED = 1100
const COLOR_RED = "#ef4444"

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
  /** down_* / up_*，决定针、弧与箭头的相位色 */
  phase?: string
  /** true=测速中：中心显示实时读数；false=空闲/结果态：中心显示 center 插槽（GO） */
  live: boolean
  /** idle 态圆心内容（GO 文案）；live 消失后保留 300ms 播完淡出 */
  center?: React.ReactNode
  /** 中心读数下方的阶段小字（如「下行测速中 · 42%」） */
  phaseLabel?: string
  /** 结束定格：读数做一次放大脉冲 */
  pulsing?: boolean
  size?: number
  className?: string
}

function polar(r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) }
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

/** 锋利刻度：内侧宽 w 的底边，向外收成尖 */
function sharpTick(rIn: number, rOut: number, deg: number, w: number): string {
  const rad = (deg * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  const px = -dy
  const py = dx
  const b1x = CX + rIn * dx + (px * w) / 2
  const b1y = CY + rIn * dy + (py * w) / 2
  const b2x = CX + rIn * dx - (px * w) / 2
  const b2y = CY + rIn * dy - (py * w) / 2
  const tip = polar(rOut, deg)
  return `M ${b1x} ${b1y} L ${b2x} ${b2y} L ${tip.x} ${tip.y} Z`
}

/** 沿弧从 a0 扫到 a1 的路径 */
function arcPath(r: number, a0: number, a1: number): string {
  const p0 = polar(r, a0)
  const p1 = polar(r, a1)
  const large = a1 - a0 > 180 ? 1 : 0
  return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y}`
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

/**
 * Ookla 式速度仪表：中央深色大圆（idle 放 GO / live 放实时读数），
 * 圆外一圈细短锋利刻度 + 最外侧档位数字；当前速度处一根加长高亮针 +
 * 贴圆缘的速度弧，随相位（下/上行）变色；live 时整体放大 12% 聚焦。
 */
export function SpeedGauge({ value, phase, live, center, phaseLabel, pulsing, size = 320, className }: SpeedGaugeProps) {
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

  const needle = polar(R_TICK_IN + 2, needleAngle)
  const arcEnd = valueToFraction(display)
  const readoutOpacity = live ? 1 : 0

  return (
    <div className={cn("relative select-none", className)} style={{ width: size }}>
      <svg
        viewBox="0 0 260 260"
        width={size}
        className="overflow-visible"
        style={{
          transform: `scale(${live ? 1.12 : 1})`,
          transition: "transform 300ms ease",
        }}
      >
        <defs>
          <radialGradient id="gaugeFace" cx="50%" cy="42%" r="66%">
            <stop offset="0%" stopColor="#31313a" />
            <stop offset="68%" stopColor="#1f1f25" />
            <stop offset="100%" stopColor="#111114" />
          </radialGradient>
          <filter id="gaugeDrop" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="1.8" floodColor="#000" floodOpacity="0.5" />
          </filter>
        </defs>

        {/* 大圆盘面：深色径向渐变，细白边收口 */}
        <circle cx={CX} cy={CY} r={R_FACE} fill="url(#gaugeFace)" filter="url(#gaugeDrop)" />
        <circle cx={CX} cy={CY} r={R_FACE} fill="none" stroke="#fff" strokeOpacity={0.08} strokeWidth={1} />

        {/* 速度弧轨道 + 进度弧（贴圆缘，相位色，圆头） */}
        <circle
          cx={CX}
          cy={CY}
          r={R_TRACK}
          fill="none"
          stroke="#fff"
          strokeOpacity={0.07}
          strokeWidth={3}
        />
        {arcEnd > 0.004 && (
          <path
            d={arcPath(R_TRACK, START_ANGLE, needleAngle)}
            fill="none"
            stroke={phaseColor}
            strokeWidth={3}
            strokeLinecap="round"
            /* idle 态保留上一轮的弱化残影，不与 GO 抢视线 */
            opacity={live ? 1 : 0.25}
            style={{ transition: "stroke 200ms ease, opacity 300ms ease" }}
          />
        )}

        {/* 刻度环：细短锋利三角，红区（>=1100）保留红调 */}
        {TICKS.map(({ value: v, major }) => {
          const a = START_ANGLE + valueToFraction(v) * SWEEP
          const red = v >= ZONE_RED
          return (
            <path
              key={`${major ? "M" : "m"}${v}`}
              d={sharpTick(R_TICK_IN, major ? R_TICK_MAJOR_OUT : R_TICK_MINOR_OUT, a, major ? 2.6 : 1.5)}
              fill={red ? COLOR_RED : "#ffffff"}
              opacity={red ? (major ? 0.55 : 0.3) : major ? 0.5 : 0.26}
            />
          )
        })}
        {/* 档位数字（刻度外端外侧，直立） */}
        {STOPS.map((s) => {
          const a = START_ANGLE + valueToFraction(s) * SWEEP
          const p = polar(R_LABEL, a)
          return (
            <text
              key={s}
              x={p.x}
              y={p.y}
              dy="0.35em"
              textAnchor="middle"
              fontSize={9.5}
              fontWeight={600}
              fill={s >= ZONE_RED ? COLOR_RED : "#ffffff"}
              opacity={s >= ZONE_RED ? 0.7 : 0.6}
            >
              {s}
            </text>
          )
        })}

        {/* 当前速度针：从圆缘向外伸出的加长锋利三角，相位色 */}
        <path
          d={sharpTick(R_TICK_IN + 2, R_NEEDLE_OUT, needleAngle, 3)}
          fill={phaseColor}
          filter="url(#gaugeDrop)"
          style={{ transition: "fill 200ms ease" }}
          opacity={readoutOpacity ? 1 : 0.55}
        />
        {/* 针的根部小圆点，缝在圆缘上 */}
        <circle cx={needle.x} cy={needle.y} r={1.8} fill={phaseColor} opacity={readoutOpacity ? 1 : 0.55} />
      </svg>

      {/* 中心读数（live）：大数字 + 单位 + 相位箭头 + 阶段小字 */}
      <div
        aria-hidden={!live}
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
        style={{
          opacity: readoutOpacity,
          transform: live ? "scale(1)" : "scale(0.85)",
          transition: "opacity 300ms ease, transform 300ms ease",
        }}
      >
        <div className="flex items-center gap-2">
          {isUp ? (
            <ArrowUp className="size-6" style={{ color: phaseColor, transition: "color 200ms ease" }} />
          ) : (
            <ArrowDown className="size-6" style={{ color: phaseColor, transition: "color 200ms ease" }} />
          )}
          <span
            className={cn("tabular text-foreground text-[46px] leading-none font-semibold tracking-tight", pulsing && "gauge-pulse")}
          >
            {fmtLive(display)}
          </span>
        </div>
        <span className="text-muted-foreground mt-1.5 text-[13px]">{display >= 1000 ? "Gbps" : "Mbps"}</span>
        {phaseLabel && <span className="text-muted-foreground mt-1.5 text-xs">{phaseLabel}</span>}
      </div>

      {/* 中心插槽（GO 等）：保持挂载以播放进出场动画 */}
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
