import { useEffect, useState } from "react"
import { History, Gauge, Settings2 } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TitleBar } from "@/components/TitleBar"
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
    <div className="bg-background flex h-screen flex-col">
      <TitleBar />
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-3 pt-2 pb-2">
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mb-2 w-fit">
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
    </div>
  )
}
