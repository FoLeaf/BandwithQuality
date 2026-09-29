import { Activity, Globe2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import RubberSegment from "@/components/RubberSegment"
import type { Settings } from "@/lib/types"
import { FAMILY_LABEL, FAMILY_NOTE, MODE_SHORT } from "@/lib/types"

interface SettingsPageProps {
  settings: Settings | null
  onPatchSettings: (patch: Partial<Settings>) => void
}

// 与测速页一致的分段选项
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

export function SettingsPage({ settings, onPatchSettings }: SettingsPageProps) {
  const s = settings
  const mode = s?.mode ?? "both"
  const family = s?.family ?? "both"

  const estMinutes = (((s?.lengthS ?? 5) + 2) * (mode === "both" ? 4 : 2) + 8) / 60 * (family !== "v4" ? 2 : 1)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>测速模式</CardTitle>
          <CardDescription>
            与官方客户端一致的对照模式：先单线程再多线程，各测上/下行。改动即时生效并自动保存。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Activity className="text-primary size-4" />
              <Label>线程模式</Label>
              <span className="text-muted-foreground ml-auto text-xs">{MODE_SHORT[mode]}</span>
            </div>
            <RubberSegment
              aria-label="线程模式"
              items={MODE_ITEMS}
              value={mode}
              onChange={(v) => onPatchSettings({ mode: v })}
              className="w-full"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Globe2 className="text-primary size-4" />
              <Label>地址族</Label>
              <span className="text-muted-foreground ml-auto text-xs">{FAMILY_LABEL[family]}</span>
            </div>
            <RubberSegment
              aria-label="地址族"
              items={FAMILY_ITEMS}
              value={family}
              onChange={(v) => onPatchSettings({ family: v })}
              className="w-full"
            />
            <p className="text-muted-foreground text-xs">{FAMILY_NOTE[family]}</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>每阶段时长</Label>
              <span className="tabular text-sm font-medium">{s?.lengthS ?? 5} 秒</span>
            </div>
            <Slider
              value={[s?.lengthS ?? 5]}
              min={5}
              max={13}
              step={1}
              onValueChange={([v]) => onPatchSettings({ lengthS: v })}
            />
            <p className="text-muted-foreground text-xs">官方默认 5 秒；拉长可降低波动，耗时相应增加。</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>多线程下行连接数</Label>
              <span className="tabular text-sm font-medium">{s?.downThreads ?? 8}</span>
            </div>
            <Slider
              value={[s?.downThreads ?? 8]}
              min={1}
              max={32}
              step={1}
              onValueChange={([v]) => onPatchSettings({ downThreads: v })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>多线程上行连接数</Label>
              <span className="tabular text-sm font-medium">{s?.upThreads ?? 4}</span>
            </div>
            <Slider
              value={[s?.upThreads ?? 4]}
              min={1}
              max={32}
              step={1}
              onValueChange={([v]) => onPatchSettings({ upThreads: v })}
            />
          </div>

          <p className="text-muted-foreground text-xs">
            预计全程约 {estMinutes < 1 ? "<1" : Math.round(estMinutes)} 分钟（含排队、探测与预热）。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>关于</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-1.5 text-sm">
          <p>BandwithQuality — 高性能、简洁的网络带宽测试桌面工具。</p>
          <p>500ms 采样、跳过预热段、取最高 3 个采样均值作为最终速率。</p>
        </CardContent>
      </Card>
    </div>
  )
}
