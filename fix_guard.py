import re

with open('client/src/pages/FallbackPage.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    '(row.guardrails ?? row.headroomPenalty ?? 1).toFixed(2)',
    '((row.headroom ?? 1) * (row.rateLimit ?? 1)).toFixed(2)'
)

with open('client/src/pages/FallbackPage.tsx', 'w') as f:
    f.write(content)

print("Guardrails fixed")
