import { useCallback, useEffect, useRef, useState } from "react"
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
  armed,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
  danger?: boolean
  /** 待确认态（如测速进行中点关闭需二次点击）：琥珀色提示 */
  armed?: boolean
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "hover:bg-muted flex h-10 w-10 items-center justify-center text-[var(--muted-foreground)] transition-colors outline-none",
        danger && "hover:bg-destructive hover:text-white",
        armed && "bg-amber-500/15 text-amber-600",
      )}
    >
      {children}
    </button>
  )
}

/** 无边框窗口的自绘标题栏：拖拽区 + 最小化/最大化/关闭 */
export function TitleBar({ running = false }: { running?: boolean }) {
  const [maximised, setMaximised] = useState(false)
  // 测速进行中点关闭：先进入待确认态（3 秒内再点才退出），避免误关中断测速
  const [armClose, setArmClose] = useState(false)
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!running) setArmClose(false)
  }, [running])

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

  const close = useCallback(() => {
    if (running && !armClose) {
      setArmClose(true)
      window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(() => setArmClose(false), 3000)
      return
    }
    window.clearTimeout(closeTimer.current)
    setArmClose(false)
    try {
      quitApp()
    } catch {
      // 忽略
    }
  }, [running, armClose])

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
        <span className="text-[13px] font-medium">BandwithQuality</span>
      </div>

      <div style={noDragStyle} className="ml-auto flex h-full items-stretch">
        <WindowButton label="最小化" onClick={() => { try { windowMinimise() } catch { /* 忽略 */ } }}>
          <Minus className="size-4" />
        </WindowButton>
        <WindowButton label={maximised ? "还原" : "最大化"} onClick={toggleMax}>
          {maximised ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
        </WindowButton>
        <WindowButton
          label={armClose ? "测速进行中，再点一次确认退出" : "关闭"}
          danger
          armed={armClose}
          onClick={close}
        >
          <X className="size-4" />
        </WindowButton>
      </div>
    </div>
  )
}
