# freellmapi

Point your coding agent at a [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)
gateway in one command. The generators read the models your server is actually
serving and write the config file each tool expects.

```bash
npx freellmapi setup-claude --url http://localhost:3001 --api-key <your-key>
```

No install step, no account. The unified API key comes from your FreeLLMAPI
dashboard (or the tray popover in the desktop app).

## Commands

| Command | Tool |
| --- | --- |
| `setup-claude` | Claude Code |
| `setup-codex` | Codex CLI |
| `setup-cline` | Cline |
| `setup-continue` | Continue |
| `setup-aider` | Aider |
| `setup-opencode` | OpenCode |
| `setup-goose` | Goose |
| `setup-qwen` | Qwen Code |
| `setup-roo` | Roo Code |
| `setup-kilo` | Kilo Code |
| `setup-crush` | Crush |
| `setup-dsh` | DeepSeek Harness (`dsh`) |
| `setup-mimo` | MiMo Code (`mimo`) |
| `setup-cursor` | Cursor |
| `setup-generic` | Any OpenAI-compatible client |
| `launch` | Run Claude Code with credentials injected into the child process |
| `launch-codex` | Run Codex the same way |
| `list` | Print the supported tools and their base URLs |

## Options

| Flag | Meaning |
| --- | --- |
| `--url URL` | Gateway base URL (default `http://localhost:3001`) |
| `--api-key KEY` | Unified API key |
| `--profile NAME` | Name the generated profile/provider entry |
| `--model ID` | Pin a specific model instead of the catalog default |
| `--dry-run` | Print the diff and write nothing |

`FREELLMAPI_URL` and `FREELLMAPI_API_KEY` work in place of `--url` / `--api-key`.

## Safety

Every generator is non-destructive: it merges into your existing configuration
rather than replacing it, and takes a timestamped backup before touching a file
that already exists. `--dry-run` shows the exact diff first.

The two `launch` commands never write credentials to disk at all — they inject
them into the child process environment for that run only.

## Requirements

Node.js >= 20.18. A running FreeLLMAPI gateway
([install guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/install.md)).

## Links

- [Clients & coding agents guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/clients/01-agent-clients.md)
- [Issue tracker](https://github.com/tashfeenahmed/freellmapi/issues)

MIT © Tashfeen Ahmed
