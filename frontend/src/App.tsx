import { useEffect, useState } from "react"
import { History, Gauge, Settings2 } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SpeedTestPage } from "@/pages/SpeedTestPage"
import { HistoryPage } from "@/pages/HistoryPage"
import { SettingsPage } from "@/pages/SettingsPage"
import { getSettings, inWails } from "@/lib/api"
import type { Settings } from "@/lib/types"

export default function App() {
  const [tab, setTab] = useState("speed")
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    if (!inWails()) return
    getSettings().then(setSettings).catch(() => undefined)
  }, [])

  // 测速完成后刷新设置缓存（设置页保存后也会触发）
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && inWails()) {
        getSettings().then(setSettings).catch(() => undefined)
      }
    }
    document.addEventListener("visibilitychange", onVis)
    return () => document.removeEventListener("visibilitychange", onVis)
  }, [])

  return (
    <div className="bg-background mx-auto flex h-screen max-w-4xl flex-col px-4 pt-4 pb-3">
      <header className="mb-3 flex items-center gap-3">
        <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg text-lg font-bold">
          速
        </div>
        <div>
          <h1 className="text-base leading-tight font-semibold">泰尔测速</h1>
          <p className="text-muted-foreground text-xs leading-tight">本机 → 全球网测官方节点</p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mb-3 w-fit">
          <TabsTrigger value="speed">
            <Gauge /> 测速
          </TabsTrigger>
          <TabsTrigger value="history">
            <History /> 历史
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 /> 设置
          </TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <TabsContent value="speed" className="mt-0">
            <SpeedTestPage settings={settings} />
          </TabsContent>
          <TabsContent value="history" className="mt-0">
            <HistoryPage />
          </TabsContent>
          <TabsContent value="settings" className="mt-0">
            <SettingsPage />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
