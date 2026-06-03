with open('client/eslint.config.js', 'r') as f:
    content = f.read()

content = content.replace("'react-hooks/exhaustive-deps': 'off'", "'react-hooks/exhaustive-deps': 'off',\n      'react-hooks/set-state-in-effect': 'off'")

with open('client/eslint.config.js', 'w') as f:
    f.write(content)
