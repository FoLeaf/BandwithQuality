// 引擎 Go 类型的 TS 镜像（与 internal/engine 的 JSON tag 一一对应）

export interface Node {
  hostId: string
  hostName: string
  hostIp: string
  port: number
  pname: string
  city: string
  oper: string
  pingMs: number
}

export interface ClientLocation {
  ip: string
  province: string
  city: string
  oper: string
}

export interface Options {
  node: Node | null
  mode: string
  lengthS: number
  intervalMs: number
  downThreads: number
  upThreads: number
  ipv6: boolean
}

export interface Sample {
  family: string
  phase: string
  index: number
  elapsedS: number
  speedMbps: number
}

export interface Progress {
  stage: string
  message: string
  percent: number
}

export interface PhaseResult {
  phase: string
  mbps: number
}

export interface FamilyResult {
  family: string
  node: Node | null
  latencyMs: number
  jitterMs: number
  phases: PhaseResult[]
  samples: Sample[]
  error?: string
}

export interface TestResult {
  client: ClientLocation
  startedAt: string
  durationS: number
  families: FamilyResult[]
}

export interface HistoryRow {
  testId: string
  startedAt: string
  family: string
  nodeName: string
  nodeIp: string
  province: string
  city: string
  oper: string
  latencyMs: number
  jitterMs: number
  singleDown: number
  singleUp: number
  multiDown: number
  multiUp: number
  durationS: number
}

export interface Settings {
  mode: string
  lengthS: number
  downThreads: number
  upThreads: number
  ipv6: boolean
}

export interface ListOptions {
  province: string
  city: string
  oper: string
  ipv6: boolean
  noPing: boolean
}

export const PHASE_LABEL: Record<string, string> = {
  down_single: "单线程下行",
  up_single: "单线程上行",
  down_multi: "多线程下行",
  up_multi: "多线程上行",
}

export const PHASE_ORDER = ["down_single", "up_single", "down_multi", "up_multi"]

export const MODE_LABEL: Record<string, string> = {
  both: "单线程 + 多线程对照",
  single: "仅单线程",
  multi: "仅多线程",
}
