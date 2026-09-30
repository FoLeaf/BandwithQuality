import { useEffect, useRef, useState } from "react"

// 仪表追赶动画参数：目标值按采样间隔（500ms）才来一次，显示值在 rAF 里
// 逐帧向目标做指数逼近，帧率无关的非线性缓动，采样间隙里也有连续运动。
const TAU_UP = 220 // ms，上行追赶时间常数：起步快、收尾缓
const TAU_DOWN = 140 // ms，下行回摆更快，换相/归零不拖泥带水
const SNAP = 0.01 // Mbps，差距小于此视为到位，停帧省电

/** 显示值向目标值逐帧指数逼近（仪表盘指针与大数字卡共用，保持两处同步连续变化） */
export function useSmoothedValue(target: number): number {
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

/** 数字滚动：目标值变化时，显示值在 duration 内以 easeOutCubic 从当前值滚到新值 */
export function useCountUp(target: number, durationMs = 650): number {
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)

  useEffect(() => {
    const from = displayRef.current
    if (Math.abs(target - from) < 0.005) return
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / durationMs)
      const eased = 1 - Math.pow(1 - k, 3)
      const v = from + (target - from) * eased
      displayRef.current = v
      setDisplay(v)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])

  return display
}
