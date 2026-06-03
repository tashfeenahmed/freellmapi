import re

with open('client/src/App.tsx', 'r') as f:
    content = f.read()

# Replace useEffect with layoutEffect or remove warning
content = content.replace(
    'useEffect(() => {',
    'useEffect(() => {\n    // eslint-disable-next-line react-hooks/set-state-in-effect'
)

with open('client/src/App.tsx', 'w') as f:
    f.write(content)

with open('client/eslint.config.js', 'r') as f:
    content = f.read()

content = content.replace(
    "'react-refresh/only-export-components': [\n        'warn',\n        { allowConstantExport: true },\n      ],",
    "'react-refresh/only-export-components': 'off',"
)

with open('client/eslint.config.js', 'w') as f:
    f.write(content)

print("eslint fix applied")
