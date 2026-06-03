import re

with open('client/src/pages/FallbackPage.tsx', 'r') as f:
    content = f.read()

# Wait, how does the desktop table calculate the guardrails? Let's check.
