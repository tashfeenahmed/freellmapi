import re

with open('client/src/components/page-header.tsx', 'r') as f:
    content = f.read()

old_header = """export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex items-end justify-between gap-6 pb-6 mb-6 border-b">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}"""

new_header = """export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 md:gap-6 pb-6 mb-6 border-b">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0 w-full md:w-auto mt-2 md:mt-0">{actions}</div>}
    </div>
  )
}"""

if old_header in content:
    content = content.replace(old_header, new_header)
    with open('client/src/components/page-header.tsx', 'w') as f:
        f.write(content)
    print("Patch applied successfully")
else:
    print("Old Header code not found")
