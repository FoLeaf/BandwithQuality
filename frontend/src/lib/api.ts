// Wails 绑定的轻封装：直接访问 window.go.main.App / window.runtime，
// 不依赖生成的 wailsjs 目录；纯浏览器里调用会抛出可提示的错误。
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

type GoApp = {
  GetLocation(): Promise<ClientLocation>
  CheckIPv6(): Promise<boolean>
  ListNodes(opt: ListOptions): Promise<Node[] | null>
  PingNode(n: Node): Promise<number[]>
  StartTest(opts: Options): Promise<TestResult>
  StopTest(): Promise<void>
  ListHistory(limit: number): Promise<HistoryRow[] | null>
  GetHistoryTest(id: string): Promise<TestResult>
  DeleteHistory(id: string): Promise<void>
  ClearHistory(): Promise<void>
  GetSettings(): Promise<Settings>
  SaveSettings(s: Settings): Promise<void>
}

export class NotInWailsError extends Error {}

function go(): GoApp {
  const a = (window as any)?.go?.main?.App as GoApp | undefined
  if (!a) throw new NotInWailsError("未检测到桌面运行时，请在 Wails 应用内使用")
  return a
}

function rt(): any {
  const r = (window as any)?.runtime
  if (!r) throw new NotInWailsError("未检测到桌面运行时")
  return r
}

export function inWails(): boolean {
  return !!(window as any)?.go?.main?.App
}

// ---------- 绑定方法 ----------

export const getLocation = (): Promise<ClientLocation> => go().GetLocation()
export const checkIPv6 = (): Promise<boolean> => go().CheckIPv6()
export const listNodes = async (opt: ListOptions): Promise<Node[]> => (await go().ListNodes(opt)) ?? []
export const pingNode = async (n: Node): Promise<[number, number]> => {
  const r = await go().PingNode(n)
  return [r?.[0] ?? -1, r?.[1] ?? 0]
}
export const startTest = (opts: Options): Promise<TestResult> => go().StartTest(opts)
export const stopTest = (): Promise<void> => go().StopTest()
export const listHistory = async (limit = 100): Promise<HistoryRow[]> => (await go().ListHistory(limit)) ?? []
export const getHistoryTest = (id: string): Promise<TestResult> => go().GetHistoryTest(id)
export const deleteHistory = (id: string): Promise<void> => go().DeleteHistory(id)
export const clearHistory = (): Promise<void> => go().ClearHistory()
export const getSettings = async (): Promise<Settings> => {
  const s = await go().GetSettings()
  return (
    s ?? { mode: "both", lengthS: 5, downThreads: 8, upThreads: 4, ipv6: true }
  )
}
export const saveSettings = (s: Settings): Promise<void> => go().SaveSettings(s)

// ---------- 事件 ----------

export const EV_PROGRESS = "bq:progress"
export const EV_SAMPLE = "bq:sample"
export const EV_FINISHED = "bq:finished"
export const EV_ERROR = "bq:error"

export function onProgress(cb: (p: Progress) => void) {
  rt().EventsOn(EV_PROGRESS, cb)
}
export function onSample(cb: (s: Sample) => void) {
  rt().EventsOn(EV_SAMPLE, cb)
}
export function onFinish(cb: (r: TestResult) => void) {
  rt().EventsOn(EV_FINISHED, cb)
}
export function onError(cb: (msg: string) => void) {
  rt().EventsOn(EV_ERROR, cb)
}
export function offEvents() {
  try {
    rt().EventsOff(EV_PROGRESS, EV_SAMPLE, EV_FINISHED, EV_ERROR)
  } catch {
    // 忽略
  }
}
