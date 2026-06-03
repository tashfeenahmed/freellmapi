import re

with open('client/src/pages/FallbackPage.tsx', 'r') as f:
    content = f.read()

content = content.replace(
    'Math.round(row.reliability * 100)',
    'Math.round((row.reliability ?? 0) * 100)'
)

content = content.replace(
    'Math.round(row.speed * 100)',
    'Math.round((row.speed ?? 0) * 100)'
)

content = content.replace(
    'Math.round(row.intelligence * 100)',
    'Math.round((row.intelligence ?? 0) * 100)'
)

content = content.replace(
    'row.guardrails?.toFixed(2)',
    '(row.guardrails ?? row.headroomPenalty ?? 1).toFixed(2)'
)

with open('client/src/pages/FallbackPage.tsx', 'w') as f:
    f.write(content)

print("Types fixed")
