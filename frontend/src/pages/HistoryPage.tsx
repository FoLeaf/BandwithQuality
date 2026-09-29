import { useCallback, useEffect, useMemo, useState } from "react"
import { BarChart3, GitCompare, History as HistoryIcon, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { SpeedChart } from "@/components/SpeedChart"
import { StatCard } from "@/components/StatCard"
import { clearHistory, deleteHistory, getHistoryTest, inWails, listHistory } from "@/lib/api"
import type { HistoryRow, TestResult } from "@/lib/types"
import { PHASE_LABEL, PHASE_ORDER } from "@/lib/types"
import { cn, fmtMs, fmtSpeed, speedTone } from "@/lib/utils"

interface GroupedTest {
  testId: string
  startedAt: string
  rows: HistoryRow[]
}

function groupByTest(rows: HistoryRow[]): GroupedTest[] {
  const map = new Map<string, GroupedTest>()
  for (const r of rows) {
    let g = map.get(r.testId)
    if (!g) {
      g = { testId: r.testId, startedAt: r.startedAt, rows: [] }
      map.set(r.testId, g)
    }
    g.rows.push(r)
  }
  return [...map.values()]
}

function rowOf(g: GroupedTest, family: string): HistoryRow | undefined {
  return g.rows.find((r) => r.family === family)
}

function SpeedCell({ v }: { v: number }) {
  return (
    <span className={cn("tabular font-medium", speedTone(v))}>{v < 0 ? "-" : fmtSpeed(v)}</span>
  )
}

export function HistoryPage({ visible }: { visible?: boolean }) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [detail, setDetail] = useState<TestResult | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [compare, setCompare] = useState<string[]>([])
  const [compareResults, setCompareResults] = useState<TestResult[]>([])
  const [compareOpen, setCompareOpen] = useState(false)

  const reload = useCallback(async () => {
    try {
      setRows(await listHistory(200))
    } catch {
      // 桌面外运行
    }
  }, [])

  useEffect(() => {
    if (inWails()) void reload()
  }, [reload])

  // 页面常驻挂载：每次切到历史页时刷新（新测完的结果立刻可见）
  useEffect(() => {
    if (visible) void reload()
  }, [visible, reload])

  const groups = useMemo(() => groupByTest(rows), [rows])

  const openDetail = async (id: string) => {
    try {
      setDetail(await getHistoryTest(id))
      setDetailOpen(true)
    } catch (e: any) {
      toast.error("读取明细失败", { description: String(e?.message ?? e) })
    }
  }

  const toggleCompare = (id: string) => {
    setCompare((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      const next = [...prev, id].slice(-2)
      return next
    })
  }

  const openCompare = async () => {
    if (compare.length === 0) return
    try {
      const rs = await Promise.all(compare.map((id) => getHistoryTest(id)))
      setCompareResults(rs)
      setCompareOpen(true)
    } catch (e: any) {
      toast.error("读取对比数据失败", { description: String(e?.message ?? e) })
    }
  }

  const del = async (id: string) => {
    await deleteHistory(id)
    setCompare((prev) => prev.filter((x) => x !== id))
    await reload()
  }

  const clearAll = async () => {
    await clearHistory()
    setCompare([])
    await reload()
    toast.success("历史已清空")
  }

  const famRows = (r: TestResult | undefined, family: string) => r?.families.find((f) => f.family === family)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <HistoryIcon className="size-4" /> 历史记录
        </h3>
        <Badge variant="secondary">{groups.length} 次测速</Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={compare.length !== 2} onClick={() => void openCompare()}>
            <GitCompare /> 对比所选{compare.length > 0 && `（${compare.length}/2）`}
          </Button>
          <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={() => void clearAll()}>
            <Trash2 /> 清空
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <ScrollArea className="h-[520px]">
            <div className="divide-y">
              {groups.length === 0 && (
                <div className="text-muted-foreground py-16 text-center text-sm">暂无历史记录，去测一次吧</div>
              )}
              {groups.map((g) => {
                const v4 = rowOf(g, "IPv4")
                const v6 = rowOf(g, "IPv6")
                const selected = compare.includes(g.testId)
                const t = new Date(g.startedAt)
                return (
                  <div key={g.testId} className={cn("px-4 py-3", selected && "bg-accent/50")}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-[var(--primary)] size-3.5"
                        checked={selected}
                        onChange={() => toggleCompare(g.testId)}
                      />
                      <button className="hover:text-primary min-w-0 flex-1 text-left" onClick={() => void openDetail(g.testId)}>
                        <span className="font-medium">{t.toLocaleString("zh-CN", { hour12: false })}</span>
                        <span className="text-muted-foreground ml-3 text-xs">
                          {v4?.nodeName || v6?.nodeName || "—"} · 时延 {fmtMs(v4?.latencyMs ?? -1)}
                        </span>
                      </button>
                      <Button variant="ghost" size="iconSm" onClick={() => void del(g.testId)} title="删除">
                        <Trash2 className="text-muted-foreground" />
                      </Button>
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-x-6 gap-y-1 pl-6 text-xs sm:grid-cols-4">
                      {v4 && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Badge variant="secondary">v4</Badge>
                          <span>下<S_SPEED v={v4.singleDown} /></span>
                          <span>上<S_SPEED v={v4.singleUp} /></span>
                          {v4.multiDown > 0 && (
                            <>
                              <span>多下<S_SPEED v={v4.multiDown} /></span>
                              <span>多上<S_SPEED v={v4.multiUp} /></span>
                            </>
                          )}
                        </div>
                      )}
                      {v6 && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Badge variant="secondary">v6</Badge>
                          <span>下<S_SPEED v={v6.singleDown} /></span>
                          <span>上<S_SPEED v={v6.singleUp} /></span>
                          {v6.multiDown > 0 && (
                            <>
                              <span>多下<S_SPEED v={v6.multiDown} /></span>
                              <span>多上<S_SPEED v={v6.multiUp} /></span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* 明细 */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>测速明细</DialogTitle>
            <DialogDescription>
              {detail && new Date(detail.startedAt).toLocaleString("zh-CN", { hour12: false })}
              {detail?.client && ` · ${detail.client.province} ${detail.client.city} ${detail.client.oper}`}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[70vh]">
            <div className="space-y-4 pr-2">
              {detail?.families.map((f) => (
                <div key={f.family} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Badge>{f.family}</Badge>
                    <span className="text-sm">{f.node?.hostName}</span>
                    <span className="text-muted-foreground text-xs">
                      时延 {fmtMs(f.latencyMs)} · 抖动 {fmtMs(f.jitterMs)}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {PHASE_ORDER.filter((p) => f.phases.some((x) => x.phase === p)).map((p) => (
                      <StatCard
                        key={p}
                        label={PHASE_LABEL[p]}
                        value={fmtSpeed(f.phases.find((x) => x.phase === p)?.mbps ?? -1)}
                        tone={speedTone(f.phases.find((x) => x.phase === p)?.mbps ?? -1)}
                      />
                    ))}
                  </div>
                  <SpeedChart samples={f.samples} height={180} colorByPhase />
                </div>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* 对比 */}
      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart3 className="size-4" /> 两次测速对比
            </DialogTitle>
            <DialogDescription>同色系内左右比较；下行看多线程，上行同理。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {compareResults.length === 2 && (
              <>
                <div className="text-muted-foreground flex items-center justify-between text-xs">
                  {compareResults.map((r, i) => (
                    <span key={i}>
                      {new Date(r.startedAt).toLocaleString("zh-CN", { hour12: false })}
                      {" · "}
                      {r.families[0]?.node?.hostName ?? ""}
                      {i === 0 && <X className="mx-2 inline size-3 opacity-40" />}
                    </span>
                  ))}
                </div>
                <Separator />
                {["IPv4", "IPv6"].map((family) => {
                  const a = famRows(compareResults[0], family)
                  const b = famRows(compareResults[1], family)
                  if (!a && !b) return null
                  const phaseOf = (f: typeof a | undefined, p: string) =>
                    f?.phases.find((x) => x.phase === p)?.mbps ?? -1
                  const cmp = (va: number, vb: number, label: string) => (
                    <div key={label} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                      <span className="text-right">
                        <SpeedCell v={va} />
                      </span>
                      <span className="text-muted-foreground w-28 text-center text-xs">{label}</span>
                      <span className="text-left">
                        <SpeedCell v={vb} />
                      </span>
                    </div>
                  )
                  return (
                    <div key={family} className="space-y-2">
                      <Badge>{family}</Badge>
                      {cmp(phaseOf(a, "down_single"), phaseOf(b, "down_single"), "单线程下行")}
                      {cmp(phaseOf(a, "up_single"), phaseOf(b, "up_single"), "单线程上行")}
                      {cmp(phaseOf(a, "down_multi"), phaseOf(b, "down_multi"), "多线程下行")}
                      {cmp(phaseOf(a, "up_multi"), phaseOf(b, "up_multi"), "多线程上行")}
                      {cmp(a?.latencyMs ?? -1, b?.latencyMs ?? -1, "时延")}
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function S_SPEED({ v }: { v: number }) {
  return <SpeedCell v={v} />
}
