import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, ChevronRight, Server, Square, User } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { NodePickerDialog } from "@/components/NodePickerDialog"
import RubberSegment from "@/components/RubberSegment"
import { SpeedChart } from "@/components/SpeedChart"
import { SpeedGauge } from "@/components/SpeedGauge"
import {
  checkIPv6,
  getLocation,
  inWails,
  offEvents,
  onError,
  onFinish,
  onProgress,
  onSample,
  startTest,
  stopTest,
} from "@/lib/api"
import type {
  ClientLocation,
  Node,
  Options,
  Progress as ProgressEvt,
  Sample,
  Settings,
  TestResult,
} from "@/lib/types"
import { PHASE_LABEL, PHASE_ORDER } from "@/lib/types"
import { cn, fmtMs, fmtSpeed, speedTone } from "@/lib/utils"

interface SpeedTestPageProps {
  settings: Settings | null
  onPatchSettings: (patch: Partial<Settings>) => void
  /** 一次测速完成（写历史后）通知外层，用于底栏红点 */
  onFinished?: () => void
}

/** 一次测速的运行态 */
type RunState = "idle" | "running" | "done"

// 仪表盘正下方的两个分段控件：线程模式 × 地址族
const MODE_ITEMS = [
  { value: "single", label: "单线程" },
  { value: "multi", label: "多线程" },
  { value: "both", label: "单+双" },
]
const FAMILY_ITEMS = [
  { value: "v4", label: "IPv4" },
  { value: "v6", label: "IPv6" },
  { value: "both", label: "V4+V6" },
]

/** 高度折叠容器：grid-template-rows 1fr↔0fr 动画，页面自然回流 */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      style={{
        display: "grid",
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transition:
          "grid-template-rows 450ms cubic-bezier(0.4, 0, 0.2, 1), opacity 350ms ease",
      }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/** 数据区大数字卡（下载/上传） */
function BigStat({ label, up, mbps }: { label: string; up?: boolean; mbps: number }) {
  const gbps = mbps >= 1000
  const value = mbps < 0 ? "-" : gbps ? (mbps / 1000).toFixed(2) : mbps.toFixed(mbps >= 100 ? 1 : 2)
  return (
    <Card>
      <CardContent className="px-4 pt-3.5 pb-3">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {up ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
          {label}
        </div>
        <div className={cn("tabular mt-1.5 text-[32px] leading-none font-semibold tracking-tight", speedTone(mbps))}>
          {value}
          <span className="text-muted-foreground ml-1.5 text-sm font-normal">{gbps ? "Gbps" : "Mbps"}</span>
        </div>
      </CardContent>
    </Card>
  )
}

export function SpeedTestPage({ settings, onPatchSettings, onFinished }: SpeedTestPageProps) {
  const [location, setLocation] = useState<ClientLocation | null>(null)
  const [ipv6OK, setIpv6OK] = useState<boolean | null>(null)
  const [pickedNode, setPickedNode] = useState<Node | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const [run, setRun] = useState<RunState>("idle")
  const [settled, setSettled] = useState(false) // done 定格（700ms 脉冲）是否结束
  const [progress, setProgress] = useState<ProgressEvt>({ stage: "", message: "", percent: 0 })
  const [liveSamples, setLiveSamples] = useState<Sample[]>([])
  const [livePhase, setLivePhase] = useState("")
  const [result, setResult] = useState<TestResult | null>(null)
  // 数据区退出动画期间保留的内容副本：result 清空后 Collapse 收起时仍有东西可显示
  const [shownResult, setShownResult] = useState<TestResult | null>(null)
  const [resultFamily, setResultFamily] = useState("IPv4")
  const [curveOpen, setCurveOpen] = useState(false)
  const runRef = useRef(false)
  const phaseRef = useRef("")
  const holdTimer = useRef<number | undefined>(undefined)
  // 事件接线注册在挂载时，onFinished 经 ref 转发避免闭包过期
  const onFinishedRef = useRef(onFinished)
  onFinishedRef.current = onFinished

  // 出口探测 + IPv6 检测
  useEffect(() => {
    if (!inWails()) return
    getLocation()
      .then(setLocation)
      .catch((e) => toast.error("出口探测失败", { description: String(e?.message ?? e) }))
    checkIPv6()
      .then(setIpv6OK)
      .catch(() => setIpv6OK(null))
  }, [])

  // 事件接线
  useEffect(() => {
    if (!inWails()) return
    onProgress((p) => {
      setProgress(p)
    })
    phaseRef.current = ""
    onSample((s) => {
      if (phaseRef.current !== s.phase) {
        phaseRef.current = s.phase
        setLivePhase(s.phase)
        setLiveSamples([s])
      } else {
        setLiveSamples((arr) => [...arr, s])
      }
    })
    onFinish((r) => {
      runRef.current = false
      setRun("done")
      setResult(r)
      setResultFamily("IPv4")
      // 最终值定格 700ms（放大脉冲）后，数值→GO、数据区同步展开
      window.clearTimeout(holdTimer.current)
      holdTimer.current = window.setTimeout(() => setSettled(true), 700)
      onFinishedRef.current?.()
    })
    onError((msg) => {
      // toast 由 start() 的 catch 统一提示，这里复位状态并归零（停止/失败不进数据区）
      runRef.current = false
      setRun((prev) => (prev === "running" ? "idle" : prev))
      setLiveSamples([])
      setLivePhase("")
      setProgress({ stage: "", message: "", percent: 0 })
      if (msg === "测速已取消") toast.info("测速已取消")
    })
    return () => {
      offEvents()
      window.clearTimeout(holdTimer.current)
    }
  }, [])

  // 结果内容副本：result 变化时同步，供数据区在退出动画期间显示
  useEffect(() => {
    if (result) setShownResult(result)
  }, [result])

  const start = useCallback(async () => {
    if (!settings) {
      toast.error("设置尚未加载")
      return
    }
    if (runRef.current) return // 已有测速在进行（事件流尚未复位）
    const opts: Options = {
      node: pickedNode,
      mode: settings.mode,
      lengthS: settings.lengthS,
      intervalMs: 500,
      downThreads: settings.downThreads,
      upThreads: settings.upThreads,
      family: settings.family,
    }
    setSettled(false)
    setCurveOpen(false)
    setResult(null)
    setLiveSamples([])
    setLivePhase("")
    setProgress({ stage: "probe", message: "准备测速…", percent: 0 })
    setRun("running")
    runRef.current = true
    try {
      await startTest(opts)
    } catch (e: any) {
      // StartTest 拒绝时 Go 侧会同时发 bq:error（onError 负责复位），这里负责提示
      const msg = String(e?.message ?? e)
      if (msg.includes("取消") || msg.includes("canceled")) {
        setRun((prev) => (prev === "running" ? "idle" : prev))
      } else if (!msg.includes("进行")) {
        toast.error("测速失败", { description: msg })
        setRun((prev) => (prev === "running" ? "idle" : prev))
      }
    }
  }, [settings, pickedNode])

  const stop = useCallback(async () => {
    try {
      await stopTest()
    } catch {
      // 忽略
    }
  }, [])

  const displayNode = pickedNode ?? result?.families[0]?.node ?? null
  const running = run === "running"
  const liveSpeed = liveSamples.length > 0 ? Math.max(0, liveSamples[liveSamples.length - 1].speedMbps) : 0
  // 聚焦态：测速中或结束定格期间，只留表盘（GO 已淡出，其余内容全部收起）
  const focus = running || (run === "done" && !settled)
  const holding = run === "done" && !settled
  const dataOpen = run === "done" && settled && result != null

  const startDisabled = !inWails() || !settings

  const shownFamily = shownResult?.families.find((f) => f.family === resultFamily) ?? shownResult?.families[0]
  const mode = settings?.mode ?? "both"
  const family = settings?.family ?? "both"

  return (
    <div className="space-y-4">
      {/* 聚焦簇：整个大圆可点（idle=GO），测速中下方挂停止按钮 */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          title="开始测速"
          disabled={startDisabled || running}
          onClick={() => void start()}
          className="group rounded-full outline-none transition-transform duration-200 active:scale-[0.985] disabled:cursor-not-allowed"
        >
          <SpeedGauge
            size={320}
            live={focus}
            value={liveSpeed}
            phase={livePhase}
            pulsing={holding}
            phaseLabel={
              holding ? "测速完成" : running ? `${livePhase ? PHASE_LABEL[livePhase] : progress.message || "准备中"} · ${Math.round(progress.percent)}%` : undefined
            }
            center={
              focus ? undefined : (
                <div className="flex flex-col items-center transition-transform duration-200 group-enabled:group-hover:scale-105 group-disabled:opacity-50">
                  <span className="text-foreground text-[40px] leading-none font-bold tracking-[0.08em]">GO</span>
                  <span className="text-muted-foreground mt-1.5 text-xs">开始测速</span>
                </div>
              )
            }
          />
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="text-destructive/90 hover:text-destructive animate-in fade-in mt-1 flex items-center gap-1.5 text-sm transition-colors duration-300"
          >
            <Square className="size-3.5" /> 停止测速
          </button>
        ) : (
          startDisabled && (
            <p className="text-muted-foreground animate-in fade-in text-xs duration-300">
              {inWails() ? "设置加载中…" : "浏览器环境无法测速，开发预览请加 ?mock=1"}
            </p>
          )
        )}
      </div>

      {/* 数据区：测完定格结束后展开，紧贴大圆下方；再点 GO 时随 Collapse 收起回流 */}
      <Collapse open={dataOpen}>
        {shownFamily && (
          <div className="space-y-3 pt-1">
            {shownResult && shownResult.families.length > 1 && (
              <Tabs value={resultFamily} onValueChange={setResultFamily}>
                <TabsList className="h-8">
                  {shownResult.families.map((f) => (
                    <TabsTrigger key={f.family} value={f.family} className="px-3 text-xs">
                      {f.family}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}

            {shownFamily.error ? (
              <Card className="border-destructive/40">
                <CardContent className="text-destructive px-3 py-2.5 text-sm">
                  {shownFamily.family} 轮失败：{shownFamily.error}
                </CardContent>
              </Card>
            ) : (
              <>
                {/* 大数字：多线程为主口径；单线程模式取单线程值 */}
                <div className="grid grid-cols-2 gap-3">
                  <BigStat label="下载" mbps={phaseMbpsOf(shownFamily, mode === "single" ? "down_single" : "down_multi")} />
                  <BigStat label="上传" up mbps={phaseMbpsOf(shownFamily, mode === "single" ? "up_single" : "up_multi")} />
                </div>

                {/* 小字行：节点 · 用时 · 时延 · 抖动（+ 单线程口径） */}
                <div className="text-muted-foreground space-y-1 px-1 text-xs">
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {shownFamily.node && (
                      <span>
                        {shownFamily.node.hostName || shownFamily.node.hostIp}（{shownFamily.node.hostIp}）
                      </span>
                    )}
                    {shownResult && <span>用时 {shownResult.durationS.toFixed(0)} 秒</span>}
                    <span>时延 {fmtMs(shownFamily.latencyMs)}</span>
                    <span>抖动 {fmtMs(shownFamily.jitterMs)}</span>
                  </div>
                  {mode === "both" && (
                    <div className="flex flex-wrap gap-x-3">
                      <span>单线程 ↓ {fmtSpeed(phaseMbpsOf(shownFamily, "down_single"))}</span>
                      <span>↑ {fmtSpeed(phaseMbpsOf(shownFamily, "up_single"))}</span>
                    </div>
                  )}
                </div>

                {/* 完整曲线：默认收起，点击展开 */}
                <div className="px-1">
                  <button
                    type="button"
                    onClick={() => setCurveOpen((v) => !v)}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", curveOpen && "rotate-90")} />
                    完整曲线（500ms 采样，最终数值取最高 3 个采样的均值）
                  </button>
                  <Collapse open={curveOpen}>
                    <div className="pt-2">
                      <SpeedChart samples={shownFamily.samples} height={200} colorByPhase />
                      <div className="mt-2 flex flex-wrap gap-4 text-xs">
                        {PHASE_ORDER.filter((p) =>
                          mode === "both" ? true : mode === "single" ? p.endsWith("single") : p.endsWith("multi"),
                        ).map((p) => (
                          <span key={p} className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "inline-block size-2.5 rounded-sm",
                                p === "down_single" && "bg-[var(--chart-1)]",
                                p === "up_single" && "bg-[var(--chart-2)]",
                                p === "down_multi" && "bg-[var(--chart-3)]",
                                p === "up_multi" && "bg-[var(--chart-4)]",
                              )}
                            />
                            {PHASE_LABEL[p]}
                            <span className="tabular text-muted-foreground">{fmtSpeed(phaseMbpsOf(shownFamily, p))}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </Collapse>
                </div>
              </>
            )}
          </div>
        )}
      </Collapse>

      {/* 工作区：分段控件 + 出口/节点信息；聚焦（测速中/定格）时整体收起，只留表盘 */}
      <Collapse open={!focus}>
        <div className="space-y-3 pt-1">
          <div className="flex items-stretch justify-center gap-2">
            <RubberSegment
              size="sm"
              aria-label="线程模式"
              items={MODE_ITEMS}
              value={mode}
              disabled={running}
              onChange={(v) => onPatchSettings({ mode: v })}
            />
            <RubberSegment
              size="sm"
              aria-label="地址族"
              items={FAMILY_ITEMS}
              value={family}
              disabled={running}
              onChange={(v) => onPatchSettings({ family: v })}
            />
          </div>

          <div className="flex w-full items-start justify-between gap-4 pt-1">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{location ? location.oper || "未知运营商" : "探测中…"}</span>
                  {ipv6OK !== null && (
                    <Badge variant={ipv6OK ? "success" : "secondary"} className="shrink-0 px-1.5 text-[10px]">
                      {ipv6OK ? "IPv6 可用" : "IPv6 不可用"}
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate text-xs">
                  {location ? `${location.province} ${location.city} · ${location.ip}` : "正在获取出口信息"}
                </div>
              </div>
              <div className="text-muted-foreground border-muted-foreground/30 flex size-9 shrink-0 items-center justify-center rounded-full border">
                <User className="size-4" />
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="text-muted-foreground border-muted-foreground/30 flex size-9 shrink-0 items-center justify-center rounded-full border">
                <Server className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {displayNode ? displayNode.hostName || displayNode.hostIp : "自动选点"}
                </div>
                <div className="text-muted-foreground truncate text-xs">
                  {displayNode
                    ? `${displayNode.city} ${displayNode.oper}${pickedNode ? "" : " · 自动选择"}`
                    : "开始测速时自动选择"}
                </div>
                <button
                  type="button"
                  className="text-primary hover:text-primary/80 mt-0.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50"
                  disabled={running || !location}
                  onClick={() => setPickerOpen(true)}
                >
                  切换节点
                </button>
              </div>
            </div>
          </div>

          {(family === "v6" || family === "both") && ipv6OK === false && (
            <p className="text-muted-foreground text-center text-xs">
              {family === "v6" ? "未检测到 IPv6 出口，无法进行 IPv6 测速" : "未检测到 IPv6 出口，将仅测 IPv4"}
            </p>
          )}
        </div>
      </Collapse>

      {location && (
        <NodePickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          location={location}
          ipv6={false}
          current={pickedNode}
          onPick={setPickedNode}
          onUseAuto={() => {
            setPickedNode(null)
            toast.info("已切换为自动选点")
          }}
        />
      )}
    </div>
  )
}

/** 从 FamilyResult 里取某相位的 Mbps（缺失返回 -1） */
function phaseMbpsOf(f: { phases: { phase: string; mbps: number }[] } | null | undefined, phase: string): number {
  return f?.phases.find((p) => p.phase === phase)?.mbps ?? -1
}
