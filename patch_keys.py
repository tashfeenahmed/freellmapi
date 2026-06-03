import re

with open('client/src/pages/KeysPage.tsx', 'r') as f:
    content = f.read()

# Add a provider key form adjustments
content = content.replace(
    '<div className="space-y-1.5">',
    '<div className="space-y-1.5 w-full sm:w-auto">'
)
# Fix the first one that is meant to be full width
content = content.replace(
    '<div className="space-y-1.5 flex-1 min-w-[240px]">',
    '<div className="space-y-1.5 w-full sm:flex-1 sm:min-w-[240px]">'
)

content = content.replace(
    'className="w-[220px]"',
    'className="w-full sm:w-[220px]"'
)

content = content.replace(
    'className="w-[200px] font-mono text-xs"',
    'className="w-full sm:w-[200px] font-mono text-xs"'
)

content = content.replace(
    'className="w-[160px]"',
    'className="w-full sm:w-[160px]"'
)

content = content.replace(
    'className="w-[150px]"',
    'className="w-full sm:w-[150px]"'
)

content = content.replace(
    'className="w-[180px] font-mono text-xs"',
    'className="w-full sm:w-[180px] font-mono text-xs"'
)

content = content.replace(
    'className="w-[150px] font-mono text-xs"',
    'className="w-full sm:w-[150px] font-mono text-xs"'
)

# Custom Provider Section Form Adjustments
# Form buttons should span full width on mobile
content = content.replace(
    '<Button type="submit" size="sm"',
    '<Button type="submit" size="sm" className="w-full sm:w-auto"'
)

# "Configured providers" list item layout adjustment
content = content.replace(
    '<div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">',
    '<div key={k.id} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">'
)

content = content.replace(
    '<code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>',
    '<code className="text-xs font-mono flex-shrink-0 sm:flex-1 max-w-[200px] truncate sm:max-w-none">{k.maskedKey}</code>'
)

# Let the flex-1 spacer remain flex-1 or hidden on small screens
content = content.replace(
    '<div className="flex-1" />',
    '<div className="flex-1 hidden sm:block" />'
)

# Fix editing input
content = content.replace(
    'className="h-6 w-[160px] text-xs"',
    'className="h-8 w-full sm:w-[160px] text-xs"'
)

with open('client/src/pages/KeysPage.tsx', 'w') as f:
    f.write(content)

print("Keys patch applied successfully")
