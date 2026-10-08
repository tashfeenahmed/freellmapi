[English](../../en/clients/02-supported-agents.md) · **简体中文**

# 支持的智能体

[← 返回 README](../../../README.md) · [客户端与编程智能体](01-agent-clients.md)

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

下列智能体都连接同一个本地网关。大多数只需一条命令即可完成配置：它读取你实时的
`/v1/models` 目录，先备份现有配置再合并写入，你的其他服务商配置保持不变：

```bash
npx freellmapi setup-<agent> --url http://localhost:3001 --api-key <unified-key>
```

加 `--dry-run` 先查看差异，`--profile <name>` 新增一个条目而不改动默认设置，
`--model <id>` 固定使用某个模型。控制台的 Agents 页面会显示同样的命令，并自动填入你的密钥。

| 智能体 | 配置方式 | Base URL |
| --- | --- | --- |
| Claude Code | `setup-claude` 或 `launch` | root |
| Codex CLI | `setup-codex` 或 `launch-codex` | `/v1` (Responses) |
| Gemini CLI | 手动配置，原生协议 | `/v1beta` |
| Cline | `setup-cline` | `/v1` |
| Roo Code | `setup-roo` | `/v1` |
| Continue | `setup-continue` | `/v1` |
| Aider | `setup-aider` | `/v1` |
| OpenCode | `setup-opencode` | `/v1` |
| Goose | `setup-goose` | `/v1` |
| Qwen Code | `setup-qwen` | `/v1` （或原生 `/v1beta`） |
| Kilo Code | `setup-kilo` | `/v1` |
| Crush | `setup-crush` | `/v1` |
| DeepSeek Harness | `setup-dsh` | `/v1` |
| MiMo Code | `setup-mimo` | `/v1` |
| AtomCode | `setup-atomcode` | `/v1` |
| OpenClaw | `setup-openclaw` | `/v1` |
| Hermes Agent | `setup-hermes` | `/v1` |
| Pi | `setup-pi` | `/v1` |
| Reasonix | `setup-reasonix` | `/v1` |
| Zed, JetBrains AI | [Ollama 模拟](01-agent-clients.md#ollama-客户端) | Ollama `/api` |
| Cursor | `setup-cursor` 输出配置指南 | 公网 `https://…/v1` |
| 其他客户端 | `setup-generic` 输出可直接使用的配置 | `/v1` |

Claude Code 使用服务器根地址，因为它会自行追加 Anthropic Messages 路径；所有 OpenAI
兼容的智能体都使用 `/v1` 地址。各工具的细节（写入哪个文件、密钥存放位置、一次性测试命令）见
[客户端与编程智能体](01-agent-clients.md#编程智能体)。
