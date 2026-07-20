# Android (Termux) installation

> Experimental and community-supported. FreeLLMAPI runs locally on the Android device.

FreeLLMAPI can run in [Termux](https://termux.dev/) without an Android NDK toolchain. On Android, the server uses Node's built-in SQLite driver instead of the native `better-sqlite3` package.

## Requirements

- Android 7 or newer
- About 1 GB of free storage
- [Termux from F-Droid](https://f-droid.org/packages/com.termux/) (the Play Store build is outdated)
- Node.js 22.13 or newer; Node 24 LTS is recommended

Do not mix Termux or add-on packages from different stores.

## Install

Update Termux and install the required packages:

```bash
pkg update
pkg upgrade -y
pkg install -y nodejs-lts git
```

Confirm that Node is new enough for `node:sqlite`:

```bash
node --version
```

Then clone and start FreeLLMAPI:

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
npm install --no-audit --no-fund
npm run dev
```

An installation warning for the optional `better-sqlite3` package is harmless on Android. If npm asks you to approve dependency install scripts, approve the `esbuild` script and run `npm install` again.

Open `http://localhost:5173` in a browser on the phone. The API is available at `http://localhost:3001/v1`.

## Access from another device

The dashboard contains API keys and administrative controls. Only expose it on a trusted network.

```bash
HOST=0.0.0.0 npm run dev:lan
```

Find the phone's local address with Android's Wi-Fi settings or:

```bash
ip addr show wlan0
```

Open `http://PHONE_IP:5173` from another device on the same network. Do not port-forward these development servers directly to the internet; use a private VPN such as Tailscale if remote access is required.

## Keep the process awake

Android may suspend Termux when the screen turns off. Install the Termux:API add-on from the same store as Termux, then run:

```bash
pkg install -y termux-api
termux-wake-lock
```

Release the lock when the server is stopped:

```bash
termux-wake-unlock
```

## Troubleshooting

### `node:sqlite` is unavailable

Upgrade the Termux packages and verify that `node --version` reports 22.13 or newer:

```bash
pkg update
pkg upgrade -y
pkg install -y nodejs-lts
```

### `concurrently: not found`

The dependency installation did not complete. Run `npm install --no-audit --no-fund` again and address the first non-optional error it reports.

### Port already in use

Stop the process using port 3001 or 5173, or configure a different `PORT` in the repository's `.env` file.

### The process stops when the screen turns off

Use `termux-wake-lock` and disable battery optimization for Termux in Android settings.

## Updating

Stop the running development server, then run:

```bash
git pull --ff-only
npm install --no-audit --no-fund
npm run dev
```

When reporting an Android issue, include the Android version, Termux source and version, device architecture, `node --version`, and the complete error output.
