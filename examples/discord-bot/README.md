# FreeLLMAPI Discord bot

An AI chat bot for your Discord server. It sends every question to your FreeLLMAPI router, which picks a free model and switches providers when one hits its rate limit.

## Features

- **Mention the bot** (`@Bot what is ...?`) or **DM it**, and it replies
- **`/ask prompt:<text> [model:<id>]`** asks a question. The model option autocompletes from your router's ready models
- **`/reset`** clears the bot's memory for the current channel
- **`/models`** lists the models your router has ready (only you can see the reply)
- **Memory per channel:** remembers the last `HISTORY_LIMIT` messages
- **Optional auto-reply channels:** in these channels it answers every message, no mention needed
- Splits long answers to fit Discord's 2000-character limit and keeps code blocks intact
- Shows "typing…" while it waits, and never pings @everyone or roles

## Setup

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy it into `DISCORD_TOKEN`.
3. On the same tab, turn on **Message Content Intent** (needed to read @mentions).
4. **General Information** → copy **Application ID** into `DISCORD_CLIENT_ID`.
5. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`. Bot permissions: *Send Messages*, *Read Message History*, *View Channels*. Open the URL it generates and invite the bot to your server.

### 2. Run FreeLLMAPI

Start the router (`npm run dev` from the repo root, the desktop app, or Docker). Then copy the unified key from the dashboard's **Keys** page.

### 3. Configure and start the bot

```bash
cd examples/discord-bot
cp .env.example .env   # then fill in the values
npm install
npm run deploy-commands   # registers /ask, /reset and /models (run again only when commands change)
npm start
```

Tip: put your server ID in `DISCORD_GUILD_ID` (right-click the server → *Copy Server ID*; this needs Developer Mode). Slash commands then appear in that server right away. Without it they're registered globally, which can take up to an hour.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token (required) |
| `DISCORD_CLIENT_ID` | — | Application ID (required) |
| `DISCORD_GUILD_ID` | — | Register commands in one server only (instant) |
| `FREELLMAPI_BASE_URL` | `http://localhost:3001/v1` | Router URL |
| `FREELLMAPI_KEY` | — | Unified key (required) |
| `FREELLMAPI_MODEL` | `auto` | `auto`, `auto:fast`, `auto:coding`, or a model ID |
| `SYSTEM_PROMPT` | friendly assistant | The bot's personality |
| `HISTORY_LIMIT` | `20` | Messages remembered per channel (`0` = no memory) |
| `AUTO_REPLY_CHANNELS` | — | Comma-separated channel IDs where it answers every message |

Memory is kept in RAM, so it is lost when the bot restarts.
