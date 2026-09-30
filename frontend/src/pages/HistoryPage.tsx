import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BarChart3, GitCompare, History as HistoryIcon, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

/** 一个地址族的测速摘要：徽标 + 节点/时延 + 标签对齐的速度格 */
function FamilyBlock({ row }: { row: HistoryRow }) {
  const cells: { label: string; v: number }[] = []
  if (row.multiDown > 0) {
    cells.push({ label: "多线程 ↓", v: row.multiDown }, { label: "多线程 ↑", v: row.multiUp })
  }
  if (row.singleDown > 0) {
    cells.push({ label: "单线程 ↓", v: row.singleDown }, { label: "单线程 ↑", v: row.singleUp })
  }
  return (
    <div className="mt-2.5 pl-6">
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="secondary" className="shrink-0 px-1.5">
          {row.family === "IPv4" ? "v4" : "v6"}
        </Badge>
        <span className="text-muted-foreground min-w-0 truncate">{row.nodeName || row.nodeIp}</span>
        <span className="text-muted-foreground/70 shrink-0">时延 {fmtMs(row.latencyMs)}</span>
      </div>
      <div className={cn("mt-1.5 grid gap-x-4 gap-y-1.5", cells.length > 2 ? "grid-cols-4" : "grid-cols-2")}>
        {cells.map((c) => (
          <div key={c.label}>
            <div className="text-muted-foreground/80 text-[10px] leading-none">{c.label}</div>
            <div className="mt-1 text-sm">
              <SpeedCell v={c.v} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function HistoryPage({ visible }: { visible?: boolean }) {
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [detail, setDetail] = useState<TestResult | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [compare, setCompare] = useState<string[]>([])
  const [compareResults, setCompareResults] = useState<TestResult[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  // 两步确认：删除/清空先进入待确认态，3 秒内再点一次才执行（超时自动取消）
  const [armDel, setArmDel] = useState<string | null>(null)
  const [armClear, setArmClear] = useState(false)
  const armTimer = useRef<number | undefined>(undefined)

  const reload = useCallback(async () => {
    try {
      setRows(await listHistory(200))
      setUnavailable(false)
    } catch {
      setUnavailable(true)
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
    try {
      await deleteHistory(id)
    } catch (e: any) {
      toast.error("删除失败", { description: String(e?.message ?? e) })
      return
    }
    setCompare((prev) => prev.filter((x) => x !== id))
    await reload()
  }

  const clearAll = async () => {
    try {
      await clearHistory()
    } catch (e: any) {
      toast.error("清空失败", { description: String(e?.message ?? e) })
      return
    }
    setCompare([])
    await reload()
    toast.success("历史已清空")
  }

  const confirmDel = (id: string) => {
    if (armDel !== id) {
      setArmDel(id)
      setArmClear(false)
      window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => setArmDel(null), 3000)
      return
    }
    window.clearTimeout(armTimer.current)
    setArmDel(null)
    void del(id)
  }

  const confirmClear = () => {
    if (!armClear) {
      setArmClear(true)
      setArmDel(null)
      window.clearTimeout(armTimer.current)
      armTimer.current = window.setTimeout(() => setArmClear(false), 3000)
      return
    }
    window.clearTimeout(armTimer.current)
    setArmClear(false)
    void clearAll()
  }

  const famRows = (r: TestResult | undefined, family: string) => r?.families.find((f) => f.family === family)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <HistoryIcon className="size-4" /> 历史记录
        </h3>
        <Badge variant="secondary">{groups.length} 次测速</Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={compare.length !== 2} onClick={() => void openCompare()}>
            <GitCompare /> 对比所选{compare.length > 0 && `（${compare.length}/2）`}
          </Button>
          <Button
            variant={armClear ? "destructive" : "outline"}
            size="sm"
            disabled={rows.length === 0}
            onClick={confirmClear}
          >
            <Trash2 /> {armClear ? "确认清空" : "清空"}
          </Button>
        </div>
      </div>

      {/* 列表直接铺在页面背景上，不再套一层卡片 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y pt-1">
          {groups.length === 0 && (
            <div className="text-muted-foreground py-16 text-center text-sm">
              {unavailable ? "历史记录不可用（本地存储打开失败）" : "暂无历史记录，去测一次吧"}
            </div>
          )}
          {groups.map((g) => {
            const v4 = rowOf(g, "IPv4")
            const v6 = rowOf(g, "IPv6")
            const selected = compare.includes(g.testId)
            const t = new Date(g.startedAt)
            return (
              <div
                key={g.testId}
                className={cn("-mx-2 mt-1 rounded-lg px-2 py-3 first:mt-0", selected && "bg-accent/40")}
              >
                <div className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    className="accent-[var(--primary)] size-3.5 shrink-0"
                    checked={selected}
                    onChange={() => toggleCompare(g.testId)}
                  />
                  <button className="min-w-0 flex-1 text-left" onClick={() => void openDetail(g.testId)}>
                    <span className="font-medium">{t.toLocaleString("zh-CN", { hour12: false })}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() => confirmDel(g.testId)}
                    title={armDel === g.testId ? "再点一次确认删除" : "删除"}
                  >
                    <Trash2 className={armDel === g.testId ? "text-destructive" : "text-muted-foreground"} />
                  </Button>
                </div>
                {v4 && <FamilyBlock row={v4} />}
                {v6 && <FamilyBlock row={v6} />}
              </div>
            )
          })}
        </div>
      </ScrollArea>

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
