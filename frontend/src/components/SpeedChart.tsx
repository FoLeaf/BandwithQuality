import { useMemo } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { Sample } from "@/lib/types"
import { PHASE_LABEL, PHASE_ORDER } from "@/lib/types"

interface SpeedChartProps {
  /** 参与绘制的采样点（已按 phase 过滤或全量） */
  samples: Sample[]
  /** 固定高度 */
  height?: number
  /** 纵轴上限 Mbps（0 = 自动） */
  maxMbps?: number
  /** 多相位全量视图：不同相位分色 */
  colorByPhase?: boolean
  /** 基础线色 */
  color?: string
}

const PHASE_COLORS: Record<string, string> = {
  down_single: "var(--chart-1)",
  up_single: "var(--chart-2)",
  down_multi: "var(--chart-3)",
  up_multi: "var(--chart-4)",
}

interface Point {
  x: number
  y: number
  phase: string
}

/**
 * 引擎的 elapsedS 每个相位归零，直接绘制会让各相位叠在 0~5s 区间。
 * 这里按 PHASE_ORDER 把相位串成一条连续时间轴：后一相位接着前一相位的末尾。
 */
function buildTimeline(samples: Sample[]): Point[] {
  const sorted = samples.slice().sort((a, b) => a.index - b.index)
  const phases = PHASE_ORDER.filter((p) => sorted.some((s) => s.phase === p))
  const out: Point[] = []
  let offset = 0
  for (const p of phases) {
    const pts = sorted.filter((s) => s.phase === p)
    let span = 0
    for (const s of pts) {
      span = Math.max(span, s.elapsedS)
      out.push({ x: +(offset + s.elapsedS).toFixed(2), y: Math.max(0, Number(s.speedMbps.toFixed(2))), phase: p })
    }
    offset += Math.max(span, 0.5)
  }
  return out
}

/** 横轴刻度：步长从常用档位里取能容纳 ≤5 格的最小值 */
function xTicks(max: number): number[] {
  const steps = [0.5, 1, 2, 2.5, 5, 10, 15, 30, 60, 120, 300]
  const step = steps.find((s) => max / s <= 5) ?? 600
  const ts: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) ts.push(+v.toFixed(2))
  return ts
}

/** 速率曲线：x=整个测速过程的时间轴（相位顺序累进），y=Mbps */
export function SpeedChart({ samples, height = 220, maxMbps = 0, colorByPhase = false, color = "var(--chart-1)" }: SpeedChartProps) {
  const data = useMemo(() => buildTimeline(samples), [samples])

  const xMax = useMemo(() => Math.max(2, Math.ceil(data.length ? data[data.length - 1].x : 0)), [data])
  const ticks = useMemo(() => xTicks(xMax), [xMax])

  const yMax = useMemo(() => {
    if (maxMbps > 0) return maxMbps
    const m = Math.max(1, ...data.map((d) => d.y))
    const mag = Math.pow(10, Math.floor(Math.log10(m)))
    return Math.ceil((m * 1.15) / mag) * mag
  }, [data, maxMbps])

  if (data.length === 0) {
    return (
      <div
        className="text-muted-foreground/60 flex items-center justify-center rounded-lg border border-dashed text-sm"
        style={{ height }}
      >
        暂无数据
      </div>
    )
  }

  const phases = [...new Set(data.map((d) => d.phase))]

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            {phases.map((p) => {
              const c = colorByPhase ? PHASE_COLORS[p] ?? color : color
              return (
                <linearGradient key={p} id={`grad-${p}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={c} stopOpacity={0.32} />
                  <stop offset="95%" stopColor={c} stopOpacity={0.02} />
                </linearGradient>
              )
            })}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            type="number"
            dataKey="x"
            domain={[0, xMax]}
            ticks={ticks}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={(v) => `${v}s`}
            stroke="var(--border)"
            tickLine={false}
          />
          <YAxis
            domain={[0, yMax]}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}G` : `${v}`)}
            stroke="var(--border)"
            tickLine={false}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "4 4" }}
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value: any, _name: any, item: any) => [
              `${value} Mbps`,
              PHASE_LABEL[(item?.payload as any)?.phase] ?? "速率",
            ]}
            labelFormatter={(l) => `t = ${l}s`}
          />
          {phases.map((p) => (
            <Area
              key={p}
              type="monotone"
              dataKey="y"
              data={data.filter((d) => d.phase === p)}
              stroke={colorByPhase ? PHASE_COLORS[p] ?? color : color}
              fill={`url(#grad-${p})`}
              strokeWidth={2}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 3 }}
            />
          ))}
          {phases.length === 1 && (
            <Line type="monotone" dataKey="y" stroke="transparent" isAnimationActive={false} />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
