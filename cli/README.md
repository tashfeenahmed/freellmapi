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
| `setup-atomcode` | AtomCode (`atomcode`) |
| `setup-openclaw` | OpenClaw |
| `setup-hermes` | Hermes Agent (`hermes`) |
| `setup-cursor` | Cursor |
| `setup-generic` | Any OpenAI-compatible client |
| `launch` | Run Claude Code with credentials injected into the child process |
| `launch-codex` | Run Codex the same way |
| `list` | Print the supported tools and their base URLs |
| `keys` | Add, list, remove, or test provider keys (`keys --help`) |

## Options

| Flag | Meaning |
| --- | --- |
| `--url URL` | Gateway base URL (default `http://localhost:3001`) |
| `--api-key KEY` | Unified API key |
| `--profile NAME` | Name the generated profile/provider entry |
| `--model ID` | Pin a specific model instead of the catalog default |
| `--dry-run` | Print the diff and write nothing |

`FREELLMAPI_URL` and `FREELLMAPI_API_KEY` work in place of `--url` / `--api-key`.

## Provider keys

The `keys` commands use a **dashboard session token**. Set
`FREELLMAPI_DASHBOARD_TOKEN`, or pass `--token TOKEN` to override it. This is the
session returned by dashboard sign-in (stored in the signed-in browser's local
storage as `freellmapi_dashboard_token`). The unified `--api-key` /
`FREELLMAPI_API_KEY` used by coding agents cannot authenticate these commands.
The CLI does not log in or persist the dashboard token.

```bash
export FREELLMAPI_URL=http://localhost:3001
export FREELLMAPI_DASHBOARD_TOKEN='<dashboard-session-token>'

npx freellmapi keys add groq                 # hidden provider-key prompt
npx freellmapi keys add groq --key '<key>'   # non-interactive alternative
npx freellmapi keys list
npx freellmapi keys test groq                # check every stored Groq key
npx freellmapi keys test groq --id 7         # check one key
npx freellmapi keys remove groq --id 7
```

`keys list` prints each key's ID, platform, enabled chat model count,
enabled/disabled state, and stored health status. Counts respect the key's model
scope; custom keys count models registered to their endpoint. Credentials and
masked keys are never printed. Use the IDs from this list when a platform has
multiple keys: `remove` requires `--id` in that case, and also checks that the ID
belongs to the requested platform. With one matching key, `--id` is optional.

`add` saves the key and immediately validates it through the gateway. A failed or
inconclusive check exits with code 1 and **leaves the key saved** for later testing
or removal. `test` also exits with code 1 if any selected key is not healthy or the
gateway cannot confirm its validity (for example, after a provider network
failure). Successful commands exit with code 0; argument, authentication, and
request errors exit with code 1. Validation uses the gateway's usual health
checks, including its policy of disabling a key after repeated confirmed failures.

Keyless providers skip the prompt. Custom endpoints need a URL and model
registration, so create them in the dashboard; existing custom keys can be
listed, tested, and removed here. Requests accept `--url` / `FREELLMAPI_URL` and
`--timeout MS` (30,000 ms per request by default). `--dry-run` is not supported for
`keys`; it is rejected before any request.

## Safety

Every generator is non-destructive: it merges into your existing configuration
rather than replacing it, and takes a timestamped backup before touching a file
that already exists. `--dry-run` shows the exact diff first.

The two `launch` commands never write credentials to disk at all — they inject
them into the child process environment for that run only.

## Requirements

Node.js >= 20.18. A running FreeLLMAPI gateway
([install guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md)).

## Links

- [Clients & coding agents guide](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/clients/01-agent-clients.md)
- [Issue tracker](https://github.com/tashfeenahmed/freellmapi/issues)

MIT © Tashfeen Ahmed
