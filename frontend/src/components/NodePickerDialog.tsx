import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, RefreshCw, Search } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { listNodes } from "@/lib/api"
import type { ClientLocation, Node } from "@/lib/types"
import { cn, fmtMs } from "@/lib/utils"

const PROVINCES = [
  "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海", "江苏",
  "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "广西",
  "海南", "重庆", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆",
]
const ISPS = ["电信", "联通", "移动"]

interface NodePickerProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  location: ClientLocation | null
  ipv6: boolean
  current: Node | null
  onPick: (n: Node) => void
  onUseAuto: () => void
}

/** 手动选点：省份/运营商切换浏览、搜索、延迟显示 */
export function NodePickerDialog({ open, onOpenChange, location, ipv6, current, onPick, onUseAuto }: NodePickerProps) {
  const [province, setProvince] = useState<string>("")
  const [oper, setOper] = useState<string>("")
  const [keyword, setKeyword] = useState("")
  const [nodes, setNodes] = useState<Node[]>([])
  const [loading, setLoading] = useState(false)
  const [pinging, setPinging] = useState(false)
  // 列表是否已补过延迟：pingMs=-1 在补测前显示「…」，补测后仍 -1 才是「不可达」
  const [pinged, setPinged] = useState(false)

  useEffect(() => {
    if (open && location) {
      setProvince((p) => p || location.province || "")
      setOper((o) => o || location.oper || "")
    }
  }, [open, location])

  const load = useCallback(
    async (withPing: boolean) => {
      setLoading(true)
      setNodes([])
      try {
        const list = await listNodes({
          province,
          city: "",
          oper,
          ipv6,
          noPing: !withPing,
        })
        setNodes(list)
        if (!withPing) setPinged(false)
      } catch (e: any) {
        toast.error("获取节点列表失败", { description: String(e?.message ?? e) })
      } finally {
        setLoading(false)
      }
    },
    [province, oper, ipv6],
  )

  // 打开或筛选变化时拉列表（不带 ping），随后补延迟
  useEffect(() => {
    if (!open) return
    load(false)
  }, [open, load])

  // 后端未 ping 的节点 pingMs 为 -1（不是 0）：列表加载后自动补一轮延迟
  const needPing = useMemo(() => nodes.some((n) => n.pingMs < 0), [nodes])
  useEffect(() => {
    if (!open || !needPing || loading || pinging) return
    setPinging(true)
    listNodes({ province, city: "", oper, ipv6, noPing: false })
      .then((list) => {
        setNodes(list)
        setPinged(true)
      })
      .catch(() => undefined)
      .finally(() => setPinging(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, needPing])

  const refreshPing = async () => {
    setPinging(true)
    try {
      const list = await listNodes({ province, city: "", oper, ipv6, noPing: false })
      setNodes(list)
      setPinged(true)
    } finally {
      setPinging(false)
    }
  }

  const filtered = useMemo(() => {
    const kw = keyword.trim()
    if (!kw) return nodes
    return nodes.filter(
      (n) =>
        n.hostName.includes(kw) ||
        n.city.includes(kw) ||
        n.pname.includes(kw) ||
        n.hostIp.includes(kw),
    )
  }, [nodes, keyword])

  // 同城/同省优先展示
  const sorted = useMemo(() => {
    if (!location) return filtered
    const score = (n: Node) =>
      (n.city === location.city ? 0 : n.pname === location.province ? 1 : 2) * 10 +
      (n.oper === location.oper ? 0 : 1)
    return filtered.slice().sort((a, b) => score(a) - score(b) || a.hostName.localeCompare(b.hostName, "zh"))
  }, [filtered, location])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择测速节点</DialogTitle>
          <DialogDescription>
            默认使用与你出口位置最匹配的节点；可切换省份浏览全国节点。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={province} onValueChange={setProvince}>
            <SelectTrigger className="w-36"><SelectValue placeholder="省份" /></SelectTrigger>
            <SelectContent className="max-h-72">
              {PROVINCES.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={oper} onValueChange={setOper}>
            <SelectTrigger className="w-28"><SelectValue placeholder="运营商" /></SelectTrigger>
            <SelectContent>
              {ISPS.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative min-w-40 flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input
              className="pl-8"
              placeholder="搜索城市 / 节点名 / IP"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <Button variant="outline" size="icon" onClick={refreshPing} title="重新测节点延迟">
            {pinging ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>

        <ScrollArea className="h-80 rounded-lg border">
          <div className="p-2">
            <button
              className="hover:bg-accent flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm"
              onClick={() => {
                onUseAuto()
                onOpenChange(false)
              }}
            >
              <span className="font-medium">自动选择（推荐）</span>
              <span className="text-muted-foreground text-xs">按出口位置三级择优</span>
            </button>
            {loading ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
                <Loader2 className="size-4 animate-spin" /> 正在获取节点…
              </div>
            ) : sorted.length === 0 ? (
              <div className="text-muted-foreground py-10 text-center text-sm">该地区暂无候选节点</div>
            ) : (
              sorted.map((n) => {
                const active = current && current.hostIp === n.hostIp && current.port === n.port
                return (
                  <button
                    key={`${n.hostId}-${n.hostIp}-${n.port}`}
                    className={cn(
                      "hover:bg-accent flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm",
                      active && "bg-accent",
                    )}
                    onClick={() => {
                      onPick(n)
                      onOpenChange(false)
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{n.hostName || `${n.city}${n.oper}`}</span>
                      <span className="text-muted-foreground block text-xs">
                        {n.pname} {n.city} · {n.hostIp}:{n.port}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant={n.city === location?.city ? "success" : "secondary"}>{n.oper || "未知"}</Badge>
                      <span
                        className={cn(
                          "tabular w-16 text-right text-xs",
                          pinged && n.pingMs < 0 ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {n.pingMs > 0 ? fmtMs(n.pingMs) : pinged ? "不可达" : "…"}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>

        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>共 {sorted.length} 个候选节点</span>
          <span className="opacity-70">延迟为 ICMP 单包快速探测，仅供参考</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
