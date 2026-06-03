import re

with open('client/src/pages/FallbackPage.tsx', 'r') as f:
    content = f.read()

mobile_card_row_code = """
function MobileCardRow({ row, rank, draggable, dragHandle, onToggle }: { row: Row; rank: number; draggable: boolean; dragHandle?: React.ReactNode; onToggle: (id: number, enabled: boolean) => void }) {
  return (
    <div className={`p-4 border-b last:border-0 bg-card flex flex-col gap-3 ${row.enabled ? '' : 'opacity-50'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {draggable && <div className="text-muted-foreground/50">{dragHandle}</div>}
          <div className="flex items-center justify-center size-5 rounded bg-muted text-xs font-mono text-muted-foreground tabular-nums">
            {rank}
          </div>
          <div className="flex flex-col">
            <span className="font-medium text-sm leading-tight">{row.displayName}</span>
            <span className="text-[11px] text-muted-foreground">{row.platform}</span>
          </div>
        </div>
        <Switch checked={row.enabled} onCheckedChange={(c) => onToggle(row.modelDbId, c)} />
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
          <span className="size-2 rounded-sm" style={{ background: '#22c55e' }} />
          <span><span className="text-muted-foreground">Rel:</span> {Math.round(row.reliability * 100)}%</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
          <span className="size-2 rounded-sm" style={{ background: '#3b82f6' }} />
          <span><span className="text-muted-foreground">Spd:</span> {Math.round(row.speed * 100)}%</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
          <span className="size-2 rounded-sm" style={{ background: '#a855f7' }} />
          <span><span className="text-muted-foreground">Int:</span> {Math.round(row.intelligence * 100)}%</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
          <span>🛡️ <span className="text-muted-foreground">Grd:</span> {row.guardrails?.toFixed(2)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between mt-1 px-1">
        <div className="flex items-center gap-2">
          {row.penalty != null && row.penalty > 0 && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">−{row.penalty} pen</span>
          )}
          {row.totalRequests != null && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">{row.totalRequests} obs</span>
          )}
        </div>
        <div className="font-mono text-xs font-medium tabular-nums text-right">
          Score: {row.score?.toFixed(2)}
        </div>
      </div>
    </div>
  )
}
"""

# Insert MobileCardRow before SortableRow
content = content.replace('function SortableRow({ row, rank, onToggle }', mobile_card_row_code + 'function SortableRow({ row, rank, onToggle }')

with open('client/src/pages/FallbackPage.tsx', 'w') as f:
    f.write(content)

print("MobileCardRow added successfully")
