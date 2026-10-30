# Mobile dev hub 01: FreeLLMAPI on Android (Termux)

> **Status: documented, unverified on-device.** Every command below is taken
> from this repository's files (cited inline) or marked as a general Termux
> suggestion. None of it has been run on an Android phone for this guide.
> Android support is **experimental and community-supported** upstream
> ([docs/en/install/02-android-termux.md](../en/install/02-android-termux.md)).

FreeLLMAPI runs on the phone itself. On Android the server uses Node's built-in
`node:sqlite` driver instead of the native `better-sqlite3` module
(`server/src/db/index.ts`, `server/src/db/node-sqlite.ts`), so no Android NDK
toolchain is needed.

- [1. Prerequisites](#1-prerequisites)
- [2. Install](#2-install)
- [3. ENCRYPTION_KEY and `.env`](#3-encryption_key-and-env)
- [4. Start: development vs production](#4-start-development-vs-production)
- [5. URLs, ports and health checks](#5-urls-ports-and-health-checks)
- [6. Provider credentials](#6-provider-credentials)
- [7. Stop and restart](#7-stop-and-restart)
- [8. Update safely](#8-update-safely)
- [9. Battery management](#9-battery-management)
- [10. Troubleshooting](#10-troubleshooting)
- [Manual verification checklist](#manual-verification-checklist)

## 1. Prerequisites

From the upstream Termux guide:

- Android 7 or newer.
- About 1 GB of free storage.
- **Termux from F-Droid.** The Play Store build is outdated. Don't mix Termux
  and its add-ons (such as Termux:API) from different stores.
- **Node.js 22.13 or newer.** `node:sqlite` needs it. Node 24 LTS is recommended.

The repository also sets an upper bound: `package.json` declares
`"node": ">=20.18.0 <25.0.0"` and `"npm": ">=10.0.0"`. Combined with the
Android requirement, the usable range on a phone is **Node 22.13 up to (but
not including) 25**.

```bash
pkg update
pkg upgrade -y
pkg install -y nodejs-lts git
node --version   # need v22.13.0 or later, and below v25
npm --version    # need 10.0.0 or later
```

A one-line check that applies both bounds:

```bash
node -e 'const [a,b]=process.versions.node.split(".").map(Number);const ok=(a>22||(a===22&&b>=13))&&a<25;console.log(process.version, ok?"OK":"UNSUPPORTED");process.exit(ok?0:1)'
```

> Unverified: which Node version Termux's `nodejs-lts` package ships today.
> If it reports 25 or later, npm prints an engine warning, and
> `scripts/dev-bootstrap.sh` refuses to run.

## 2. Install

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install --no-audit --no-fund
```

What to expect, per the upstream guide:

- A warning about the optional `better-sqlite3` package is harmless on Android.
  It is listed in `server/package.json` under `optionalDependencies`.
- If npm asks you to approve dependency install scripts, approve the `esbuild`
  script and run `npm install` again. The root `package.json` `allowScripts`
  lists `better-sqlite3`, `esbuild` and `msw`.

**Alternative.** `scripts/dev-bootstrap.sh` checks the Node and npm versions,
runs `npm install` only when `package-lock.json` has changed, and creates
`.env` with a fresh key only if no `.env` exists yet:

```bash
bash scripts/dev-bootstrap.sh
```

## 3. ENCRYPTION_KEY and `.env`

`ENCRYPTION_KEY` (64 hex characters = 32 bytes) encrypts every provider key
stored in the SQLite database with AES-256-GCM. **If you lose or change it,
every stored provider key becomes undecryptable.**

Behaviour, from `server/src/lib/crypto.ts`:

- When `NODE_ENV` is not `production` and no key is set, the server generates
  one and saves it as `.encryption-key` (mode 0600) next to the database. The
  install docs advise against relying on this with real provider keys.
- When `NODE_ENV=production`, the server refuses to start without
  `ENCRYPTION_KEY`.
- A malformed value fails at boot with
  `Invalid ENCRYPTION_KEY ... expected 64 hex chars`.

Generate the key straight into the file, so it never appears on screen or in
shell history. Run this from the repository root, and only if `.env` doesn't
exist yet (`flag: "wx"` refuses to overwrite):

```bash
umask 077
node -e '
const fs = require("fs"), c = require("crypto");
fs.writeFileSync(".env",
  "ENCRYPTION_KEY=" + c.randomBytes(32).toString("hex") + "\nPORT=3001\nHOST=127.0.0.1\n",
  { mode: 0o600, flag: "wx" });'
ls -l .env                      # expect -rw-------
grep -c '^ENCRYPTION_KEY=' .env # expect 1 (prints a count, not the key)
git check-ignore -v .env        # expect a match from .gitignore
```

Notes:

- **Don't `cp .env.example .env`.** Its `ENCRYPTION_KEY` is a placeholder.
- **`HOST=127.0.0.1` matters.** Without it the server listens on `::`, which
  means all interfaces (`server/src/lib/config.ts`). On a phone that joins
  public Wi-Fi, that would expose the API to the network.
- **Back up the key** to somewhere you control outside Termux, such as a
  password manager. Never put it in Git, chat, screenshots or cloud notes.
- `.env`, `server/data/`, `*.db` and `.encryption-key` are all listed in
  `.gitignore`.

## 4. Start: development vs production

| | Development (Vite) | Production build |
|---|---|---|
| Command | `npm run dev` | `npm run build` once, then `node server/dist/index.js` |
| What runs | `concurrently`: the server via `tsx watch src/index.ts` on **3001** and the Vite dev server on **5173** | One Node process on **3001** serving the API and the built dashboard (`client/dist`) |
| Dashboard URL | `http://localhost:5173` | `http://localhost:3001` |
| API base URL | `http://localhost:3001/v1` (Vite also proxies `/api` and `/v1` to `127.0.0.1:3001`, per `client/vite.config.ts`) | `http://localhost:3001/v1` |
| Reloads on edit | Yes, with hot module reload | No; rebuild after changing code |
| Resource use | Higher: two processes and file watchers | Lower at runtime; **the build itself is heavy** (`tsc`, plus `vite build` of the dashboard) |
| Key fallback | Auto-generated `.encryption-key` if none is set | Same, unless `NODE_ENV=production`, which requires the key |

Development, as the upstream guide documents it:

```bash
npm run dev
```

Production, from README "Local development":

```bash
npm run build
node server/dist/index.js
```

> Unverified on-device: the production build has not been measured on a phone.
> `vite build` reports a dashboard chunk of about 1.7 MB minified and may need
> substantial RAM. If the build is killed, use `npm run dev` instead.

LAN access is **off by default**. The upstream guide shows
`HOST=0.0.0.0 npm run dev:lan`, which exposes the dashboard on 5173 and the API
on 3001 to your network. Use it only on a trusted network. Never port-forward
to the internet; for remote access the upstream guide recommends a private VPN
such as Tailscale.

## 5. URLs, ports and health checks

| What | URL |
|---|---|
| Health (no auth) | `http://127.0.0.1:3001/api/ping` returns `{"status":"ok","timestamp":"…"}` |
| Dashboard (dev) | `http://localhost:5173` |
| Dashboard (production) | `http://localhost:3001` |
| OpenAI-compatible API | `http://localhost:3001/v1` |
| Anthropic Messages API | `http://localhost:3001` (clients append `/v1/messages`) |
| API docs | `http://localhost:3001/v1/docs` |

Checks, from a second Termux session:

```bash
curl -s http://127.0.0.1:3001/api/ping
# expect {"status":"ok",...}

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/v1/models
# expect 401: the API refuses requests without the unified key

# dev mode only: the same health check through the Vite proxy
curl -s http://localhost:5173/api/ping
```

Use the hostname `localhost` for Vite, as Vite itself prints it. Vite listens on
whatever `localhost` resolves to, which may be IPv6 (`::1`) rather than
`127.0.0.1` on some devices (unverified on Android). Port 5173 exists only in
development. A production server (`node server/dist/index.js`) serves the API
and the dashboard together on **3001**, so there the health check is the 3001
one above.

To list models with the unified key without putting the key in your shell
history, read it from a 0600 file:

```bash
umask 077; mkdir -p ~/.config/freellmapi-hub
read -rs K; printf 'Authorization: Bearer %s\n' "$K" > ~/.config/freellmapi-hub/unified.hdr; unset K
curl -s -H @"$HOME/.config/freellmapi-hub/unified.hdr" http://127.0.0.1:3001/v1/models | head -c 400
```

The server's startup log says the unified key "is intentionally not printed to
logs". You copy it from the dashboard's **Keys** page header.

## 6. Provider credentials

Enter provider keys **only in the dashboard**. The server encrypts them into
`server/data/freeapi.db`, which Git ignores.

1. Open the dashboard (section 5) in the phone's browser.
2. On first run, create the admin account (email and password, at least 8
   characters). A browser on the same device needs no setup code. A code is
   printed in the server log only for setup from another device.
3. Open **Keys**, choose a provider, paste its key and save. Copy keys from your
   password manager, not from notes or chat.
4. Reorder the **Fallback Chain** if you want a different priority.
5. Copy the **unified API key** (`freellmapi-…`) from the Keys page header. It
   is the only credential your clients need.

Keep provider keys out of:

- **`.env`, shell rc files and Git.** Run `git status` before every commit;
  `server/data/` and `.env` should never appear in it.
- **Command lines and history.** Use the dashboard or the `read -rs` pattern
  above.
- **`FREEAPI_CONFIG_JSON` / `FREEAPI_CONFIG_PATH`,** unless you need declarative
  setup. The install docs warn that these hold plaintext secrets.

## 7. Stop and restart

A foreground server stops with **Ctrl+C** in the Termux session running it.
That stops both dev processes, because `concurrently` runs them together.

Restart:

```bash
cd ~/freellmapi
npm run dev                      # development
# or
node server/dist/index.js        # production (after npm run build)
```

Optional, and not from the repo's docs: run the server in `tmux` so it keeps
running when you close the Termux session window.

```bash
pkg install -y tmux
tmux new -d -s freellmapi 'cd ~/freellmapi && npm run dev'
tmux attach -t freellmapi        # watch logs; Ctrl+B then D to detach
tmux kill-session -t freellmapi  # stop
```

If a server was left running, find it before starting another:

```bash
curl -s http://127.0.0.1:3001/api/ping && echo "already running"
pgrep -af 'server/dist/index.js|tsx watch src/index.ts|vite'
```

## 8. Update safely

1. **Stop the server** (section 7).
2. **Back up** the database and keys while the server is stopped. The DB uses
   WAL mode, so the `-wal` and `-shm` files are copied too when they exist.
   `server/data/.encryption-key` exists only if the server ever started
   without `ENCRYPTION_KEY` and generated its own; without it, a database
   encrypted with that key can't be read.

   ```bash
   cd ~/freellmapi
   umask 077; b=~/freellmapi-backup-$(date +%Y%m%d-%H%M%S); mkdir -p "$b"
   for f in .env server/data/.encryption-key server/data/freeapi.db \
            server/data/freeapi.db-wal server/data/freeapi.db-shm; do
     if [ -e "$f" ]; then cp "$f" "$b"/; fi   # plain cp: copies get mode 600 from umask
   done
   ls -la "$b"   # names and sizes only; never cat or share these files
   ```

3. **Update** with fast-forward only, so local edits are never merged
   silently:

   ```bash
   git status --short     # should be empty; commit or stash your own edits first
   git pull --ff-only
   npm install --no-audit --no-fund
   npm run build          # production only
   ```

4. **Start again** and repeat the checks in section 5.

Keep the same `.env` (the same `ENCRYPTION_KEY`) across updates. Database
migrations run on startup.

## 9. Battery management

Android may suspend or kill Termux when the screen is off or the app is in
the background. A wake lock keeps the CPU running for Termux.

First check whether the command is already there. Don't assume it is:

```bash
command -v termux-wake-lock && command -v termux-wake-unlock
```

If both print a path, skip the install. If not, the upstream guide installs the
Termux:API add-on, from the same store as Termux:

```bash
pkg install -y termux-api   # plus the Termux:API app itself
command -v termux-wake-lock # should now print a path
```

I believe `termux-wake-lock` normally ships with Termux's preinstalled
`termux-tools` package, so the check may pass before any install. That's
unverified; follow whatever `command -v` reports on your device. If it's still
missing after `pkg install -y termux-api`, try `pkg install -y termux-tools`
(also unverified).

Use it while the server runs:

```bash
termux-wake-lock            # before starting the server
termux-wake-unlock          # after you stop it
```

To verify the lock took effect, look at Termux's persistent notification
after `termux-wake-lock`: it should indicate that a wake lock is held (for
example, by offering to release it). The exact wording is unverified and may
differ between Termux versions.

Also disable **battery optimization for Termux** in Android settings.

Not verified, and not from the repo:

- Some vendors (Samsung, Xiaomi and others) add their own background-kill
  rules beyond stock Android.
- Android 12 and later may stop background child processes (the "phantom
  process" limit).

If the server dies while the phone is idle, check those settings first. Expect
the process to stop sometimes; it's a phone, not a server.

## 10. Troubleshooting

| Symptom | Likely cause and fix | Source |
|---|---|---|
| `node:sqlite` is unavailable / "requires Node.js 22.13 or newer" | Node too old. Run `pkg update && pkg upgrade -y && pkg install -y nodejs-lts`, then recheck section 1. | upstream guide, `server/src/db/node-sqlite.ts` |
| `concurrently: not found` | Dependency install didn't finish. Re-run `npm install --no-audit --no-fund` and fix the first non-optional error. | upstream guide |
| `EADDRINUSE` / port already in use | Another server is still running (section 7). Stop it, or set a different `PORT` in `.env`. | upstream guide |
| `Invalid ENCRYPTION_KEY … expected 64 hex chars` | Malformed `.env` value. Restore it from your backup; don't generate a new one if the DB already holds keys. | `server/src/lib/crypto.ts` |
| `ENCRYPTION_KEY is required in production` | `NODE_ENV=production` without a key. Add it to `.env` (section 3). | `server/src/lib/crypto.ts` |
| Provider keys fail after restoring or moving the DB | `ENCRYPTION_KEY` differs from the one that encrypted them. Use the original key; to change keys deliberately, use `npm run rotate-encryption-key` (see the install docs). | `docs/en/install/01-install.md` |
| Engine warning on install, or bootstrap refuses to run | Node 25 or later; the repo supports below 25. | `package.json`, `scripts/dev-bootstrap.sh` |
| `better-sqlite3` install warning | Harmless on Android. | upstream guide |
| Forgot dashboard password | Click **Forgot password?** on the login page; a one-time code (valid 15 minutes) is printed in the server's terminal. | README FAQ |
| Server stops with the screen off | Battery management (section 9). | upstream guide |
| Dashboard says it can't reach the server (dev) | The 3001 server process failed; read the `server` lines in the `npm run dev` output. | `client/vite.config.ts` proxy |

When reporting an Android issue upstream, include the Android version, the
Termux source and version, the device architecture, `node --version` and the
complete error output, **with every key redacted**.

## Manual verification checklist

None of these have been checked on-device yet. Tick each one on the phone.

**Prerequisites**
- [ ] Termux installed from F-Droid; Termux:API (if used) from the same source.
- [ ] `node --version` is ≥ 22.13 and < 25; the one-line check prints `OK`.
- [ ] `npm --version` is ≥ 10.

**Install**
- [ ] `git clone` and `npm install --no-audit --no-fund` finish; the only
      error-level output is the optional `better-sqlite3` warning.
- [ ] `ls node_modules/.bin/concurrently` exists.

**Secrets**
- [ ] `.env` was created with the `node -e` snippet; `ls -l .env` shows `-rw-------`.
- [ ] The key was never printed: scroll back and check.
- [ ] `git check-ignore -v .env server/data/freeapi.db` matches both.
- [ ] A copy of `ENCRYPTION_KEY` is stored outside Termux.

**Start (development)**
- [ ] `npm run dev` shows the server line `Server running on http://127.0.0.1:3001`
      (it shows `http://[::]:3001` if `HOST` isn't set) and a Vite URL on 5173.
- [ ] `curl -s http://127.0.0.1:3001/api/ping` returns `"status":"ok"`.
- [ ] `/v1/models` without a key returns `401`.
- [ ] `http://localhost:5173` opens the dashboard in the phone's browser.

**Bind address**
- [ ] From another device on the same Wi-Fi, `http://PHONE_IP:3001/api/ping`
      does **not** respond while `HOST=127.0.0.1` is set.

**Production (optional)**
- [ ] `npm run build` finishes without being killed; note how long it took.
- [ ] `node server/dist/index.js` serves the dashboard at `http://localhost:3001`.

**Credentials**
- [ ] Admin account created from the phone's browser.
- [ ] One provider key added on **Keys**; `git status` shows nothing new.
- [ ] Unified key copied; `/v1/models` with it (from the 0600 header file)
      returns `200`.
- [ ] A test chat request returns `200` with an `X-Routed-Via` header, which
      is the first proof the gateway really works:
      ```bash
      curl -si http://127.0.0.1:3001/v1/chat/completions \
        -H @"$HOME/.config/freellmapi-hub/unified.hdr" -H 'content-type: application/json' \
        -d '{"model":"auto","messages":[{"role":"user","content":"say ok"}],"max_tokens":8}' \
        | grep -i -E '^HTTP|x-routed-via'
      ```

**Lifecycle**
- [ ] Ctrl+C stops both processes; `pgrep -af 'tsx watch|vite'` prints nothing.
- [ ] After a restart, logging in still works and the provider key is still
      listed (the database persisted).
- [ ] `command -v termux-wake-lock` prints a path (note whether that needed
      `termux-api`, `termux-tools`, or neither), and after running it the
      Termux notification shows a wake lock is held.
- [ ] With `termux-wake-lock` and battery optimization off, the server answers
      `/api/ping` after 15 minutes with the screen off.
- [ ] In dev mode, `curl -s http://localhost:5173/api/ping` returns
      `"status":"ok"` through the Vite proxy.
- [ ] A backup (section 8) contains `.env` and `freeapi.db`, plus
      `.encryption-key` if `server/data/.encryption-key` exists.
- [ ] `git pull --ff-only && npm install` followed by a restart keeps your data.
