import { useEffect, useState } from "react"
import { Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getSettings, inWails, saveSettings } from "@/lib/api"
import type { Settings } from "@/lib/types"
import { MODE_LABEL } from "@/lib/types"

export function SettingsPage() {
  const [s, setS] = useState<Settings>({ mode: "both", lengthS: 5, downThreads: 8, upThreads: 4, ipv6: true })
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!inWails()) return
    getSettings()
      .then(setS)
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  const save = async () => {
    try {
      await saveSettings(s)
      toast.success("设置已保存")
    } catch (e: any) {
      toast.error("保存失败", { description: String(e?.message ?? e) })
    }
  }

  const estMinutes = ((s.lengthS + 2) * (s.mode === "both" ? 4 : 2) + 8) / 60 * (s.ipv6 ? 2 : 1)

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>测速模式</CardTitle>
          <CardDescription>与官方客户端一致的对照模式：先单线程再多线程，各测上/下行。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Tabs value={s.mode} onValueChange={(v) => setS({ ...s, mode: v })}>
            <TabsList className="w-full">
              {Object.entries(MODE_LABEL).map(([k, label]) => (
                <TabsTrigger key={k} value={k} className="flex-1">
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>每阶段时长</Label>
              <span className="tabular text-sm font-medium">{s.lengthS} 秒</span>
            </div>
            <Slider
              value={[s.lengthS]}
              min={5}
              max={13}
              step={1}
              onValueChange={([v]) => setS({ ...s, lengthS: v })}
            />
            <p className="text-muted-foreground text-xs">官方默认 5 秒；拉长可降低波动，耗时相应增加。</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>多线程下行连接数</Label>
              <span className="tabular text-sm font-medium">{s.downThreads}</span>
            </div>
            <Slider
              value={[s.downThreads]}
              min={1}
              max={32}
              step={1}
              onValueChange={([v]) => setS({ ...s, downThreads: v })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>多线程上行连接数</Label>
              <span className="tabular text-sm font-medium">{s.upThreads}</span>
            </div>
            <Slider
              value={[s.upThreads]}
              min={1}
              max={32}
              step={1}
              onValueChange={([v]) => setS({ ...s, upThreads: v })}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <Label>IPv6 测试</Label>
              <p className="text-muted-foreground mt-1 text-xs">
                检测到 IPv6 网络时附加一轮完整 IPv6 测试（开启后测速时间约翻倍）。
              </p>
            </div>
            <Switch checked={s.ipv6} onCheckedChange={(v) => setS({ ...s, ipv6: v })} />
          </div>

          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">
              预计全程约 {estMinutes < 1 ? "<1" : Math.round(estMinutes)} 分钟（含排队、探测与预热）。
            </p>
            <Button onClick={() => void save()} disabled={!inWails()}>
              <Save /> 保存设置
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>关于</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-1.5 text-sm">
          <p>泰尔测速 · BandwidthQuality — 本机到「全球网测」官方节点的网络质量测试。</p>
          <p>协议实现改造自开源项目 MiaM1ku/taierspeedtest（无 LICENSE，仅供个人学习研究）。</p>
          <p>测速结果与官方「全球网测」App 同口径：500ms 采样、跳过 2s 预热、取最高 3 个采样均值。</p>
        </CardContent>
      </Card>

      {loaded && !inWails() && (
        <p className="text-destructive text-sm">未检测到桌面运行时，设置不可保存。</p>
      )}
    </div>
  )
}
