**English** · [简体中文](../../zh-cn/clients/02-supported-agents.md)

# Supported agents

[← Back to README](../../../README.md) · [Clients & coding agents](01-agent-clients.md)

<div align="center">
<table>
<tr>
<td align="center" width="150"><img src="../../../repo-assets/agents/claude-code.png" width="44" alt="Claude Code"><br/><b>Claude Code</b></td>
<td align="center" width="150"><img src="../../../repo-assets/agents/codex.png" width="44" alt="Codex CLI"><br/><b>Codex CLI</b></td>
<td align="center" width="150"><img src="../../../repo-assets/agents/gemini-cli.png" width="44" alt="Gemini CLI"><br/><b>Gemini CLI</b></td>
<td align="center" width="150"><img src="../../../repo-assets/agents/cursor.png" width="44" alt="Cursor"><br/><b>Cursor</b></td>
</tr>
<tr>
<td align="center"><img src="../../../repo-assets/agents/cline.png" width="44" alt="Cline"><br/><b>Cline</b></td>
<td align="center"><img src="../../../repo-assets/agents/roo-code.png" width="44" alt="Roo Code"><br/><b>Roo Code</b></td>
<td align="center"><img src="../../../repo-assets/agents/opencode.png" width="44" alt="OpenCode"><br/><b>OpenCode</b></td>
<td align="center"><img src="../../../repo-assets/agents/aider.png" width="44" alt="Aider"><br/><b>Aider</b></td>
</tr>
<tr>
<td align="center"><img src="../../../repo-assets/agents/continue.png" width="44" alt="Continue"><br/><b>Continue</b></td>
<td align="center"><img src="../../../repo-assets/agents/goose.png" width="44" alt="Goose"><br/><b>Goose</b></td>
<td align="center"><img src="../../../repo-assets/agents/qwen-code.png" width="44" alt="Qwen Code"><br/><b>Qwen Code</b></td>
<td align="center"><img src="../../../repo-assets/agents/kilo-code.png" width="44" alt="Kilo Code"><br/><b>Kilo Code</b></td>
</tr>
<tr>
<td align="center"><img src="../../../repo-assets/agents/crush.png" width="44" alt="Crush"><br/><b>Crush</b></td>
<td align="center"><img src="../../../repo-assets/agents/zed.png" width="44" alt="Zed"><br/><b>Zed</b></td>
<td align="center"><img src="../../../repo-assets/agents/jetbrains.png" width="44" alt="JetBrains AI"><br/><b>JetBrains AI</b></td>
<td align="center"><img src="../../../repo-assets/agents/deepseek-harness.png" width="44" alt="DeepSeek Harness"><br/><b>DeepSeek Harness</b></td>
</tr>
<tr>
<td align="center"><img src="../../../repo-assets/agents/atomcode.png" width="44" alt="AtomCode"><br/><b>AtomCode</b></td>
<td align="center"><img src="../../../repo-assets/agents/openclaw.png" width="44" alt="OpenClaw"><br/><b>OpenClaw</b></td>
<td align="center"><img src="../../../repo-assets/agents/hermes-agent.png" width="44" alt="Hermes Agent"><br/><b>Hermes Agent</b></td>
<td align="center"><img src="../../../repo-assets/agents/pi.png" width="44" alt="Pi"><br/><b>Pi</b></td>
</tr>
<tr>
<td align="center"><img src="../../../repo-assets/agents/reasonix.png" width="44" alt="Reasonix"><br/><b>Reasonix</b></td>
</tr>
</table>
</div>

Every agent below talks to the same local gateway. Most configure themselves
with one command; it reads your live `/v1/models` catalog, backs up the
existing config and merges into it, so your other providers stay put:

```bash
npx freellmapi setup-<agent> --url http://localhost:3001 --api-key <unified-key>
```

Add `--dry-run` to see the diff first, `--profile <name>` to add a second entry
instead of taking over the default, or `--model <id>` to pin a model. The
Agents page in the dashboard shows the same commands with your key filled in.

| Agent | Setup | Base URL |
| --- | --- | --- |
| Claude Code | `setup-claude` or `launch` | root |
| Codex CLI | `setup-codex` or `launch-codex` | `/v1` (Responses) |
| Gemini CLI | manual, native wire | `/v1beta` |
| Cline | `setup-cline` | `/v1` |
| Roo Code | `setup-roo` | `/v1` |
| Continue | `setup-continue` | `/v1` |
| Aider | `setup-aider` | `/v1` |
| OpenCode | `setup-opencode` | `/v1` |
| Goose | `setup-goose` | `/v1` |
| Qwen Code | `setup-qwen` | `/v1` (or native `/v1beta`) |
| Kilo Code | `setup-kilo` | `/v1` |
| Crush | `setup-crush` | `/v1` |
| DeepSeek Harness | `setup-dsh` | `/v1` |
| MiMo Code | `setup-mimo` | `/v1` |
| AtomCode | `setup-atomcode` | `/v1` |
| OpenClaw | `setup-openclaw` | `/v1` |
| Hermes Agent | `setup-hermes` | `/v1` |
| Pi | `setup-pi` | `/v1` |
| Reasonix | `setup-reasonix` | `/v1` |
| Zed, JetBrains AI | [Ollama emulation](01-agent-clients.md#ollama-clients) | Ollama `/api` |
| Cursor | `setup-cursor` prints the guide | public `https://…/v1` |
| Anything else | `setup-generic` prints a ready block | `/v1` |

Claude Code takes the server root because it appends the Anthropic Messages
path itself; every OpenAI-compatible agent takes the `/v1` URL. Per-tool
details (which file is written, where the key lives, one-shot test commands)
are in [Clients & coding agents](01-agent-clients.md#coding-agents).
