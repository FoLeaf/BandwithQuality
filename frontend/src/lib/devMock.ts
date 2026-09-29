// 开发预览 mock：仅在 vite dev（import.meta.env.DEV）且 URL 带 ?mock=1 时由 api.ts 启用，
// 在纯浏览器里模拟 Go 引擎的事件流（进度/采样/结果），用于调仪表盘与图表动画。
// 生产构建里 DEV 为 false，这些代码不会执行。
import type {
  ClientLocation,
  HistoryRow,
  ListOptions,
  Node,
  Options,
  Progress,
  Sample,
  Settings,
  TestResult,
} from "./types"
import { PHASE_LABEL } from "./types"

export function devMockActive(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("mock")
  )
}

const MOCK_LOCATION: ClientLocation = { ip: "203.0.113.7", province: "北京", city: "北京", oper: "联通" }
const MOCK_SETTINGS: Settings = { mode: "both", lengthS: 5, downThreads: 8, upThreads: 4, family: "both" }
const LATENCY_MS = 23.6
const JITTER_MS = 3.2

// 各相位峰值（Mbps），形态接近典型家宽：下行快上行慢，多线程比单线程高
const PHASE_PEAKS: Record<string, number> = {
  down_single: 465,
  up_single: 93,
  down_multi: 872,
  up_multi: 181,
}
const PHASE_SEQ = ["down_single", "up_single", "down_multi", "up_multi"]

type Handler<T> = (v: T) => void
const subs = {
  progress: new Set<Handler<Progress>>(),
  sample: new Set<Handler<Sample>>(),
  finished: new Set<Handler<TestResult>>(),
  error: new Set<Handler<string>>(),
}

export const mockOnProgress = (cb: Handler<Progress>) => subs.progress.add(cb)
export const mockOnSample = (cb: Handler<Sample>) => subs.sample.add(cb)
export const mockOnFinish = (cb: Handler<TestResult>) => subs.finished.add(cb)
export const mockOnError = (cb: Handler<string>) => subs.error.add(cb)
export function mockOffEvents() {
  subs.progress.clear()
  subs.sample.clear()
  subs.finished.clear()
  subs.error.clear()
}

function fire<T>(set: Set<Handler<T>>, v: T) {
  set.forEach((h) => h(v))
}

let timers: number[] = []
let running = false
function at(ms: number, fn: () => void) {
  timers.push(window.setTimeout(fn, ms))
}

/** 速率曲线：快速爬坡 + 轻微抖动，形态接近真实吞吐 */
function curve(elapsedS: number, peak: number): number {
  const ramp = 1 - Math.exp(-elapsedS / 1.1)
  const wobble = 1 + 0.06 * Math.sin(elapsedS * 3.1) + 0.04 * Math.sin(elapsedS * 7.7)
  return Math.max(1, peak * (0.25 + 0.75 * ramp) * wobble)
}

/** 与引擎口径一致：取最高 3 个采样的均值 */
function top3Avg(xs: number[]): number {
  const top = [...xs].sort((a, b) => b - a).slice(0, 3)
  return top.length ? +(top.reduce((a, b) => a + b, 0) / top.length).toFixed(2) : 0
}

export function mockStartTest(opts: Options): Promise<TestResult> {
  if (running) return Promise.reject(new Error("已有测速在进行"))
  running = true
  timers = []

  const lengthS = Math.max(2, opts.lengthS || 5)
  const intervalMs = Math.max(100, opts.intervalMs || 500)
  const preheatMs = 800 // 真实引擎为 2000，mock 缩短以便快速看到动画
  const phases =
    opts.mode === "single"
      ? PHASE_SEQ.filter((p) => p.endsWith("single"))
      : opts.mode === "multi"
        ? PHASE_SEQ.filter((p) => p.endsWith("multi"))
        : PHASE_SEQ
  const famName = opts.family === "v6" ? "IPv6" : "IPv4"

  const samplesByPhase: Record<string, Sample[]> = {}
  const result: TestResult = {
    client: MOCK_LOCATION,
    startedAt: new Date().toISOString(),
    durationS: 0,
    families: [
      {
        family: famName,
        node: null,
        latencyMs: LATENCY_MS,
        jitterMs: JITTER_MS,
        phases: [],
        samples: [],
      },
    ],
  }

  let t = 100
  at(t, () => fire(subs.progress, { stage: "probe", message: "正在选择测速节点…", percent: 4 }))
  at((t += 700), () => fire(subs.progress, { stage: "latency", message: "正在测量时延…", percent: 12 }))
  at((t += 600), () =>
    fire(subs.progress, { stage: "latency_done", message: "时延测量完成", percent: 20, latencyMs: LATENCY_MS, jitterMs: JITTER_MS }),
  )

  phases.forEach((phase, i) => {
    const peak = PHASE_PEAKS[phase] ?? 100
    at((t += 400), () =>
      fire(subs.progress, { stage: phase, message: `正在${PHASE_LABEL[phase] ?? phase}…`, percent: 20 + (75 * i) / phases.length }),
    )
    const phaseStart = t
    const n = Math.floor((lengthS * 1000) / intervalMs)
    for (let k = 1; k <= n; k++) {
      const elapsedS = +((k * intervalMs) / 1000).toFixed(2)
      at(phaseStart + preheatMs + k * intervalMs, () => {
        const s: Sample = { family: famName, phase, index: k, elapsedS, speedMbps: +curve(elapsedS, peak).toFixed(2) }
        ;(samplesByPhase[phase] ??= []).push(s)
        fire(subs.sample, s)
      })
    }
    t = phaseStart + preheatMs + n * intervalMs
  })

  at((t += 500), () => {
    const fam = result.families[0]
    fam.phases = phases.map((p) => ({ phase: p, mbps: top3Avg((samplesByPhase[p] ?? []).map((s) => s.speedMbps)) }))
    fam.samples = phases.flatMap((p) => samplesByPhase[p] ?? [])
    result.durationS = +(t / 1000).toFixed(1)
    fire(subs.progress, { stage: "done", message: "测速完成", percent: 100 })
    running = false
    fire(subs.finished, result)
  })

  return Promise.resolve(result)
}

export function mockStopTest(): Promise<void> {
  if (!running) return Promise.resolve()
  running = false
  timers.forEach((id) => window.clearTimeout(id))
  timers = []
  fire(subs.error, "测速已取消")
  return Promise.resolve()
}

export const mockGetLocation = (): Promise<ClientLocation> => Promise.resolve(MOCK_LOCATION)
export const mockCheckIPv6 = (): Promise<boolean> => Promise.resolve(true)
export const mockGetSettings = (): Promise<Settings> => Promise.resolve({ ...MOCK_SETTINGS })
export const mockSaveSettings = (s: Settings): Promise<void> => {
  Object.assign(MOCK_SETTINGS, s)
  return Promise.resolve()
}
export const mockListNodes = (_opt: ListOptions): Promise<Node[]> => Promise.resolve([])
export const mockPingNode = (): Promise<number[]> => Promise.resolve([-1, 0])
export const mockListHistory = (): Promise<HistoryRow[]> => Promise.resolve([])
export const mockNoop = (): Promise<void> => Promise.resolve()
