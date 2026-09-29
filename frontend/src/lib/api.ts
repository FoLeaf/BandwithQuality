// Wails 绑定的轻封装：直接访问 window.go.main.App / window.runtime，
// 不依赖生成的 wailsjs 目录；纯浏览器里调用会抛出可提示的错误。
// 例外：vite dev 下 URL 带 ?mock=1 时整层切换为本地模拟数据流（见 devMock.ts）。
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
import { DEFAULT_SETTINGS } from "./types"
import {
  devMockActive,
  mockAutoSelectNode,
  mockCheckIPv6,
  mockGetHistoryTest,
  mockGetLocation,
  mockGetSettings,
  mockListHistory,
  mockListNodes,
  mockNoop,
  mockOffEvents,
  mockOnError,
  mockOnFinish,
  mockOnProgress,
  mockOnSample,
  mockPingNode,
  mockSaveSettings,
  mockStartTest,
  mockStopTest,
} from "./devMock"

const MOCK = devMockActive()

type GoApp = {
  GetLocation(): Promise<ClientLocation>
  CheckIPv6(): Promise<boolean>
  ListNodes(opt: ListOptions): Promise<Node[] | null>
  AutoSelectNode(): Promise<Node | null>
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
  return MOCK || !!(window as any)?.go?.main?.App
}

// ---------- 窗口控制（无边框自绘标题栏用） ----------

export const windowMinimise = (): void => rt().WindowMinimise()
export const windowToggleMaximise = (): void => rt().WindowToggleMaximise()
export const windowIsMaximised = (): boolean => !!rt().WindowIsMaximised()
export const quitApp = (): void => rt().Quit()

// ---------- 绑定方法 ----------

export const getLocation = (): Promise<ClientLocation> => (MOCK ? mockGetLocation() : go().GetLocation())
export const checkIPv6 = (): Promise<boolean> => (MOCK ? mockCheckIPv6() : go().CheckIPv6())
export const listNodes = async (opt: ListOptions): Promise<Node[]> => (MOCK ? await mockListNodes(opt) : (await go().ListNodes(opt)) ?? [])
export const autoSelectNode = (): Promise<Node | null> =>
  MOCK ? mockAutoSelectNode() : go().AutoSelectNode().catch(() => null)
export const pingNode = async (n: Node): Promise<[number, number]> => {
  const r = MOCK ? await mockPingNode() : await go().PingNode(n)
  return [r?.[0] ?? -1, r?.[1] ?? 0]
}
export const startTest = (opts: Options): Promise<TestResult> => (MOCK ? mockStartTest(opts) : go().StartTest(opts))
export const stopTest = (): Promise<void> => (MOCK ? mockStopTest() : go().StopTest())
export const listHistory = async (limit = 100): Promise<HistoryRow[]> => (MOCK ? mockListHistory() : (await go().ListHistory(limit)) ?? [])
export const getHistoryTest = (id: string): Promise<TestResult> =>
  MOCK ? mockGetHistoryTest(id) : go().GetHistoryTest(id)
export const deleteHistory = (id: string): Promise<void> => (MOCK ? mockNoop() : go().DeleteHistory(id))
export const clearHistory = (): Promise<void> => (MOCK ? mockNoop() : go().ClearHistory())
export const getSettings = async (): Promise<Settings> => {
  if (MOCK) return mockGetSettings()
  const s = await go().GetSettings()
  return s ?? { ...DEFAULT_SETTINGS }
}
export const saveSettings = (s: Settings): Promise<void> => (MOCK ? mockSaveSettings(s) : go().SaveSettings(s))

// ---------- 事件 ----------

export const EV_PROGRESS = "bq:progress"
export const EV_SAMPLE = "bq:sample"
export const EV_FINISHED = "bq:finished"
export const EV_ERROR = "bq:error"

export function onProgress(cb: (p: Progress) => void) {
  if (MOCK) return mockOnProgress(cb)
  rt().EventsOn(EV_PROGRESS, cb)
}
export function onSample(cb: (s: Sample) => void) {
  if (MOCK) return mockOnSample(cb)
  rt().EventsOn(EV_SAMPLE, cb)
}
export function onFinish(cb: (r: TestResult) => void) {
  if (MOCK) return mockOnFinish(cb)
  rt().EventsOn(EV_FINISHED, cb)
}
export function onError(cb: (msg: string) => void) {
  if (MOCK) return mockOnError(cb)
  rt().EventsOn(EV_ERROR, cb)
}
export function offEvents() {
  if (MOCK) {
    mockOffEvents()
    return
  }
  try {
    rt().EventsOff(EV_PROGRESS, EV_SAMPLE, EV_FINISHED, EV_ERROR)
  } catch {
    // 忽略
  }
}
