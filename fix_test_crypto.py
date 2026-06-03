import re

with open('server/src/lib/crypto.ts', 'r') as f:
    content = f.read()

# Make parseHexKey throw if it is not valid length and hex instead of hashing it for tests
new_parse_hex = """function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid ENCRYPTION_KEY length or format from ${source}`);
  }
  return Buffer.from(value, 'hex');
}"""

content = content.replace(
"""function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length === KEY_HEX_LEN && /^[0-9a-fA-F]+$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  // Fallback: hash the key to 32 bytes using SHA-256 to allow arbitrary-format keys (e.g. Render auto-generated keys) securely.
  return crypto.createHash('sha256').update(value).digest();
}""", new_parse_hex)

with open('server/src/lib/crypto.ts', 'w') as f:
    f.write(content)
