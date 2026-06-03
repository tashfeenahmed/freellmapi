with open('client/src/App.tsx', 'r') as f:
    content = f.read()

content = content.replace('// eslint-disable-next-line react-hooks/set-state-in-effect\n', '')

with open('client/src/App.tsx', 'w') as f:
    f.write(content)
