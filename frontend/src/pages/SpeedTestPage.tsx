import { useCallback, useEffect, useRef, useState } from "react"
import { Activity, ChevronDown, Globe, MapPin, RefreshCw, Square, Wifi } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { NodePickerDialog } from "@/components/NodePickerDialog"
import { SpeedChart } from "@/components/SpeedChart"
import { SpeedGauge } from "@/components/SpeedGauge"
import { StatCard } from "@/components/StatCard"
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
}

/** 一次测速的运行态 */
type RunState = "idle" | "running" | "done"

export function SpeedTestPage({ settings }: SpeedTestPageProps) {
  const [location, setLocation] = useState<ClientLocation | null>(null)
  const [ipv6OK, setIpv6OK] = useState<boolean | null>(null)
  const [pickedNode, setPickedNode] = useState<Node | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const [run, setRun] = useState<RunState>("idle")
  const [progress, setProgress] = useState<ProgressEvt>({ stage: "", message: "", percent: 0 })
  const [liveSamples, setLiveSamples] = useState<Sample[]>([])
  const [livePhase, setLivePhase] = useState("")
  const [latencyInfo, setLatencyInfo] = useState<{ latencyMs: number; jitterMs: number } | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)
  const [resultFamily, setResultFamily] = useState("IPv4")
  const runRef = useRef(false)
  const phaseRef = useRef("")

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
      if (p.latencyMs !== undefined) {
        setLatencyInfo({ latencyMs: p.latencyMs, jitterMs: p.jitterMs ?? 0 })
      }
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
    })
    onError((msg) => {
      // toast 由 start() 的 catch 统一提示，这里只复位状态
      runRef.current = false
      setRun((prev) => (prev === "running" ? "idle" : prev))
      if (msg === "测速已取消") setLatencyInfo(null)
    })
    return () => offEvents()
  }, [])

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
      ipv6: settings.ipv6 && (ipv6OK ?? false),
    }
    setResult(null)
    setLiveSamples([])
    setLivePhase("")
    setLatencyInfo(null)
    setProgress({ stage: "probe", message: "准备测速…", percent: 0 })
    setRun("running")
    runRef.current = true
    try {
      await startTest(opts)
    } catch (e: any) {
      // StartTest 拒绝时 Go 侧会同时发 bq:error（onError 负责复位），这里负责提示
      const msg = String(e?.message ?? e)
      if (msg.includes("取消") || msg.includes("canceled")) {
        toast.info("测速已取消")
        setRun((prev) => (prev === "running" ? "idle" : prev))
      } else if (!msg.includes("进行")) {
        toast.error("测速失败", { description: msg })
        setRun((prev) => (prev === "running" ? "idle" : prev))
      }
    }
  }, [settings, pickedNode, ipv6OK])

  const stop = useCallback(async () => {
    try {
      await stopTest()
    } catch {
      // 忽略
    }
  }, [])

  const nodeShown = pickedNode
  const running = run === "running"
  const liveSpeed = liveSamples.length > 0 ? Math.max(0, liveSamples[liveSamples.length - 1].speedMbps) : 0
  const liveColor = livePhase.startsWith("up") ? "var(--chart-2)" : "var(--chart-1)"
  // 空闲且无数据：开始按钮在仪表盘中心；测完/中断：按钮移到面板下方
  const centerStart = run === "idle" && liveSamples.length === 0
  const belowStart = !running && (run === "done" || liveSamples.length > 0)

  // 结果族的展示
  const shownFamily = result?.families.find((f) => f.family === resultFamily) ?? result?.families[0]
  const phaseMbps = (phase: string) => shownFamily?.phases.find((p) => p.phase === phase)?.mbps ?? -1
  const mode = settings?.mode ?? "both"
  const showSingle = mode === "both" || mode === "single"
  const showMulti = mode === "both" || mode === "multi"

  return (
    <div className="space-y-4">
      {/* 顶部：出口信息 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
          <div className="flex items-center gap-2 text-sm">
            <Globe className="text-primary size-4" />
            <span className="font-medium">出口</span>
            <span className="tabular text-muted-foreground">{location ? location.ip : "探测中…"}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="text-primary size-4" />
            <span className="text-muted-foreground">
              {location ? `${location.province} ${location.city} ${location.oper}` : "…"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Wifi className="text-primary size-4" />
            {ipv6OK === null ? (
              <span className="text-muted-foreground">IPv6 未知</span>
            ) : ipv6OK ? (
              <Badge variant="success">IPv6 可用</Badge>
            ) : (
              <Badge variant="secondary">IPv6 不可用</Badge>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={running} onClick={() => setPickerOpen(true)}>
              <ChevronDown />
              {nodeShown ? `已指定：${nodeShown.hostName || nodeShown.hostIp}` : "自动选点"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 控制条：进度与停止（开始按钮在仪表盘中心/面板下方） */}
      <div className="flex items-center gap-4">
        {running && (
          <Button variant="destructive" className="min-w-32" onClick={() => void stop()}>
            <Square /> 停止测速
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
            <span className={cn("truncate", running ? "text-foreground" : "text-muted-foreground")}>
              {run === "idle" &&
                (centerStart ? "就绪 · 点击仪表盘中央按钮开始测速" : "已就绪 · 可重新开始测速")}
              {running && progress.message}
              {run === "done" && "测速完成"}
            </span>
            {running && <span className="tabular text-muted-foreground">{Math.round(progress.percent)}%</span>}
          </div>
          <Progress value={running ? progress.percent : run === "done" ? 100 : 0} />
        </div>
      </div>

      {/* 实时面板：左仪表盘 + 右趋势图（常驻） */}
      <Card>
        <CardContent className="px-5 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm font-medium">
            <Activity className="text-primary size-4" />
            实时速率
            <Badge variant="secondary">{PHASE_LABEL[livePhase] ?? (running ? "…" : "待机")}</Badge>
            {latencyInfo && (
              <>
                <Badge variant="outline" className="tabular gap-1 font-normal">
                  时延 {fmtMs(latencyInfo.latencyMs)}
                </Badge>
                <Badge variant="outline" className="tabular gap-1 font-normal">
                  抖动 {fmtMs(latencyInfo.jitterMs)}
                </Badge>
              </>
            )}
          </div>
          <div className="grid items-center gap-4 lg:grid-cols-[300px_1fr]">
            <SpeedGauge
              value={liveSpeed}
              phase={livePhase}
              label={livePhase ? PHASE_LABEL[livePhase] : running ? "准备中" : ""}
              className="justify-self-center"
              center={
                centerStart ? (
                  <StartCircleButton onClick={() => void start()} disabled={!inWails() || !settings} />
                ) : undefined
              }
            />
            <div className="w-full">
              <SpeedChart samples={liveSamples} height={250} color={liveColor} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 测速完成后：开始按钮移到面板下方 */}
      {belowStart && (
        <div className="animate-in fade-in slide-in-from-bottom-3 flex justify-center duration-500">
          <StartCircleButton onClick={() => void start()} disabled={!inWails() || !settings} small />
        </div>
      )}

      {/* 结果 */}
      {result && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-semibold">测速结果</h3>
            {result.families.length > 1 && (
              <Tabs value={resultFamily} onValueChange={setResultFamily}>
                <TabsList className="h-8">
                  {result.families.map((f) => (
                    <TabsTrigger key={f.family} value={f.family} className="px-3 text-xs">
                      {f.family}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}
            {shownFamily?.node && (
              <span className="text-muted-foreground text-sm">
                {shownFamily.node.hostName || shownFamily.node.hostIp}（{shownFamily.node.hostIp}）
              </span>
            )}
            <span className="text-muted-foreground ml-auto text-xs">用时 {result.durationS.toFixed(0)} 秒</span>
          </div>

          {shownFamily?.error && (
            <Card className="border-destructive/40">
              <CardContent className="px-5 py-4 text-sm text-destructive">
                {shownFamily.family} 轮失败：{shownFamily.error}
              </CardContent>
            </Card>
          )}

          {!shownFamily?.error && shownFamily && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {showSingle && (
                  <>
                    <StatCard
                      label="单线程下载"
                      value={fmtSpeed(phaseMbps("down_single")).replace(" Mbps", "").replace(" Gbps", "")}
                      unit={phaseMbps("down_single") >= 1000 ? "Gbps" : "Mbps"}
                      tone={speedTone(phaseMbps("down_single"))}
                    />
                    <StatCard
                      label="单线程上传"
                      value={fmtSpeed(phaseMbps("up_single")).replace(" Mbps", "").replace(" Gbps", "")}
                      unit={phaseMbps("up_single") >= 1000 ? "Gbps" : "Mbps"}
                      tone={speedTone(phaseMbps("up_single"))}
                    />
                  </>
                )}
                {showMulti && (
                  <>
                    <StatCard
                      label="多线程下载"
                      value={fmtSpeed(phaseMbps("down_multi")).replace(" Mbps", "").replace(" Gbps", "")}
                      unit={phaseMbps("down_multi") >= 1000 ? "Gbps" : "Mbps"}
                      tone={speedTone(phaseMbps("down_multi"))}
                    />
                    <StatCard
                      label="多线程上传"
                      value={fmtSpeed(phaseMbps("up_multi")).replace(" Mbps", "").replace(" Gbps", "")}
                      unit={phaseMbps("up_multi") >= 1000 ? "Gbps" : "Mbps"}
                      tone={speedTone(phaseMbps("up_multi"))}
                    />
                  </>
                )}
              </div>

              <Card>
                <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 px-5 py-4 text-sm">
                  <span className="flex items-center gap-2">
                    <RefreshCw className="text-primary size-4" />
                    时延
                    <span className="tabular font-semibold">{fmtMs(shownFamily.latencyMs)}</span>
                  </span>
                  <Separator orientation="vertical" className="h-4" />
                  <span>
                    抖动
                    <span className="tabular ml-2 font-semibold">{fmtMs(shownFamily.jitterMs)}</span>
                  </span>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="px-5 py-4">
                  <div className="text-muted-foreground mb-2 text-xs">
                    完整采样曲线（500ms 采样，最终数值取最高 3 个采样的均值，与官方口径一致）
                  </div>
                  <SpeedChart samples={shownFamily.samples} height={260} colorByPhase />
                  <div className="mt-2 flex flex-wrap gap-4 text-xs">
                    {PHASE_ORDER.filter((p) => (mode === "both" ? true : mode === "single" ? p.endsWith("single") : p.endsWith("multi"))).map(
                      (p) => (
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
                          <span className="tabular text-muted-foreground">{fmtSpeed(phaseMbps(p))}</span>
                        </span>
                      ),
                    )}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}

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

/** 圆形开始按钮：空闲时居中于仪表盘，测完后在面板下方再现 */
function StartCircleButton({ onClick, disabled, small }: { onClick: () => void; disabled?: boolean; small?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title="开始测速"
      className={cn(
        "bg-primary text-primary-foreground ring-primary/10 shadow-primary/30 hover:bg-primary/95 rounded-full font-semibold shadow-lg ring-8 transition-all duration-300 hover:scale-105 active:scale-95 disabled:pointer-events-none disabled:opacity-50",
        small ? "size-20 text-sm" : "size-24 text-[15px]",
      )}
    >
      开始测速
    </button>
  )
}
