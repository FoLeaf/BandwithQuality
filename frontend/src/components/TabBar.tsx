// 底部导航栏：受控模式（items / current / onChange），参考小程序 tab-bar 的 API 与红点用法。
import { cn } from "@/lib/utils"

export interface TabBarItem {
  key: string
  label: string
  icon: React.ReactNode
  /** 红点提示（如历史页有新结果） */
  badge?: boolean
}

interface TabBarProps {
  items: TabBarItem[]
  current: string
  onChange: (key: string) => void
  className?: string
}

export function TabBar({ items, current, onChange, className }: TabBarProps) {
  return (
    <nav
      className={cn("bg-background/95 border-border/70 flex h-14 shrink-0 items-stretch border-t select-none", className)}
      aria-label="主导航"
    >
      {items.map((item) => {
        const active = item.key === current
        return (
          <button
            key={item.key}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(item.key)}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors outline-none",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className={cn("relative transition-transform duration-200", active && "scale-110")}>
              <span className="[&>svg]:size-5">{item.icon}</span>
              {item.badge && (
                <span className="bg-destructive ring-background absolute -top-1 -right-1.5 size-2 rounded-full ring-2" />
              )}
            </span>
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}
