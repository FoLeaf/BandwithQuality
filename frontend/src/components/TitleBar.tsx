import { useCallback, useEffect, useState } from "react"
import { Minus, Square, X, Copy } from "lucide-react"
import { inWails, quitApp, windowIsMaximised, windowMinimise, windowToggleMaximise } from "@/lib/api"
import { cn } from "@/lib/utils"

const dragStyle = { "--wails-draggable": "drag" } as React.CSSProperties
const noDragStyle = { "--wails-draggable": "no-drag" } as React.CSSProperties

function WindowButton({
  onClick,
  label,
  children,
  danger,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "hover:bg-muted flex h-10 w-10 items-center justify-center text-[var(--muted-foreground)] transition-colors outline-none",
        danger && "hover:bg-destructive hover:text-white",
      )}
    >
      {children}
    </button>
  )
}

/** 无边框窗口的自绘标题栏：拖拽区 + 最小化/最大化/关闭 */
export function TitleBar() {
  const [maximised, setMaximised] = useState(false)

  const syncMaximised = useCallback(() => {
    if (!inWails()) return
    try {
      setMaximised(windowIsMaximised())
    } catch {
      // 忽略
    }
  }, [])

  useEffect(() => {
    syncMaximised()
    // 无边框下窗口尺寸变化（拖拽边缘、最大化）时同步按钮态
    window.addEventListener("resize", syncMaximised)
    return () => window.removeEventListener("resize", syncMaximised)
  }, [syncMaximised])

  const toggleMax = useCallback(() => {
    try {
      windowToggleMaximise()
      setMaximised(windowIsMaximised())
    } catch {
      // 忽略
    }
  }, [])

  return (
    <div
      style={dragStyle}
      onDoubleClick={() => {
        if (inWails()) toggleMax()
      }}
      className="bg-background/80 flex h-10 shrink-0 items-center border-b pl-3 select-none"
    >
      <div className="flex items-center gap-2">
        <div className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded text-[11px] font-bold">
          速
        </div>
        <span className="text-[13px] font-medium">泰尔测速</span>
        <span className="text-muted-foreground hidden text-xs sm:inline">· 全球网测</span>
      </div>

      <div style={noDragStyle} className="ml-auto flex h-full items-stretch">
        <WindowButton label="最小化" onClick={() => { try { windowMinimise() } catch { /* 忽略 */ } }}>
          <Minus className="size-4" />
        </WindowButton>
        <WindowButton label={maximised ? "还原" : "最大化"} onClick={toggleMax}>
          {maximised ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
        </WindowButton>
        <WindowButton label="关闭" danger onClick={() => { try { quitApp() } catch { /* 忽略 */ } }}>
          <X className="size-4" />
        </WindowButton>
      </div>
    </div>
  )
}
