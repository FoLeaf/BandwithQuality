import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"

interface StatCardProps {
  label: string
  value: string
  unit?: string
  tone?: string
  className?: string
  hint?: string
}

/** 结果页大数字卡片 */
export function StatCard({ label, value, unit, tone, className, hint }: StatCardProps) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardContent className="px-4 pt-4 pb-3">
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>{label}</span>
          {hint && <span className="text-[10px] opacity-70">{hint}</span>}
        </div>
        <div className={cn("tabular mt-1.5 text-2xl font-semibold tracking-tight", tone)}>
          {value}
          {unit && <span className="text-muted-foreground ml-1 text-sm font-normal">{unit}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
