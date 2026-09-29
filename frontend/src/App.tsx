import { useCallback, useEffect, useRef, useState } from "react"
import { History, Gauge, Settings2 } from "lucide-react"
import { TabBar } from "@/components/TabBar"
import type { TabBarItem } from "@/components/TabBar"
import { TitleBar } from "@/components/TitleBar"
import { SpeedTestPage } from "@/pages/SpeedTestPage"
import { HistoryPage } from "@/pages/HistoryPage"
import { SettingsPage } from "@/pages/SettingsPage"
import { enforceWindowAspect } from "@/lib/aspect"
import { getSettings, inWails, saveSettings } from "@/lib/api"
import type { Settings } from "@/lib/types"
import { DEFAULT_SETTINGS } from "@/lib/types"
import { cn } from "@/lib/utils"

const TAB_ITEMS: TabBarItem[] = [
  { key: "speed", label: "测速", icon: <Gauge /> },
  { key: "history", label: "历史", icon: <History /> },
  { key: "settings", label: "设置", icon: <Settings2 /> },
]

export default function App() {
  const [tab, setTab] = useState("speed")
  const [settings, setSettings] = useState<Settings | null>(null)
  const [historyBadge, setHistoryBadge] = useState(false)
  // settings 的镜像 ref：patch 时直接读最新值，避免 setState 回调里做副作用
  const settingsRef = useRef<Settings | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    enforceWindowAspect()
    if (!inWails()) return
    getSettings()
      .then((s) => {
        settingsRef.current = s
        setSettings(s)
      })
      .catch(() => undefined)
  }, [])

  // 更新设置：立即生效（React 状态），持久化做 400ms 防抖（滑块拖动只落盘一次）
  const patchSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...(settingsRef.current ?? DEFAULT_SETTINGS), ...patch }
    settingsRef.current = next
    setSettings(next)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveSettings(next).catch(() => undefined)
    }, 400)
  }, [])

  // 切到历史页即清掉红点
  const changeTab = useCallback((key: string) => {
    setTab(key)
    if (key === "history") setHistoryBadge(false)
  }, [])

  return (
    <div className="bg-background flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <main className="min-h-0 w-full flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-3 pt-2 pb-4">
          {/* 三页常驻挂载，仅隐藏非当前页：测速中途可切页再切回，进度不丢 */}
          <div className={cn(tab !== "speed" && "hidden")}>
            <SpeedTestPage
              settings={settings}
              onPatchSettings={patchSettings}
              onFinished={() => {
                if (tab !== "history") setHistoryBadge(true)
              }}
            />
          </div>
          <div className={cn(tab !== "history" && "hidden")}>
            <HistoryPage visible={tab === "history"} />
          </div>
          <div className={cn(tab !== "settings" && "hidden")}>
            <SettingsPage settings={settings} onPatchSettings={patchSettings} />
          </div>
        </div>
      </main>
      <TabBar
        items={TAB_ITEMS.map((it) => (it.key === "history" ? { ...it, badge: historyBadge } : it))}
        current={tab}
        onChange={changeTab}
      />
    </div>
  )
}
