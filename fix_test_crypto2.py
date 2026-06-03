import re

with open('server/src/lib/crypto.ts', 'r') as f:
    content = f.read()

new_parse_hex = """function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid ENCRYPTION_KEY (${source}). Expected 64 hex chars, got ${value.length}. Check your .env file.`);
  }
  return Buffer.from(value, 'hex');
}"""

content = content.replace(
"""function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid ENCRYPTION_KEY length or format from ${source}`);
  }
  return Buffer.from(value, 'hex');
}""", new_parse_hex)

with open('server/src/lib/crypto.ts', 'w') as f:
    f.write(content)
