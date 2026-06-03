import re

with open('client/src/pages/PlaygroundPage.tsx', 'r') as f:
    content = f.read()

# SelectTrigger className="w-[260px]" -> "w-full sm:w-[260px]"
content = content.replace(
    'className="w-[260px]"',
    'className="w-full sm:w-[260px]"'
)

# max-w-[78%] -> max-w-[85%] md:max-w-[78%]
content = content.replace(
    'className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${',
    'className={`max-w-[85%] md:max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${'
)

# p-6 -> p-4 md:p-6
content = content.replace(
    'className="flex-1 overflow-y-auto p-6 space-y-4"',
    'className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4"'
)

# textarea min-h-[40px] -> min-h-[44px]
content = content.replace(
    'min-h-[40px]',
    'min-h-[44px]'
)

with open('client/src/pages/PlaygroundPage.tsx', 'w') as f:
    f.write(content)

print("Playground patch applied successfully")
