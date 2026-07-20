# Android (Termux) Installation Guide

> **Status:** Experimental. Community-supported. Everything runs locally on your device.

This guide walks you through running FreeLLMAPI on an Android phone using [Termux](https://termux.dev/).

---

## Requirements

- Android 7.0 or newer
- ~500 MB free storage
- [Termux from F-Droid](https://f-droid.org/en/packages/com.termux/) (the Play Store build is outdated)

> Do not mix the Play Store and F-Droid versions.

---

## 1. Install system packages

Open Termux and run:

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs git python
```

Verify Node is 20 or newer:

```bash
node -v
```

---

## 2. Clone the repository

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
```

---

## 3. Install dependencies

```bash
npm install --no-audit --no-fund
```

You may see warnings about `better-sqlite3` - that is expected on Android. See [Known limitations](#known-limitations).

If prompted, approve the esbuild install scripts:

```bash
npm approve-scripts
```

---

## 4. Start the app

```bash
npm run dev
```

You should see:

- Server on `http://localhost:3001`
- Dashboard on `http://localhost:5173`

Open the dashboard URL in any browser on the same device.

---

## Accessing from another device on your LAN

```bash
npm run dev:lan
```

Then open `http://<your-phone-ip>:5173` on the other device.

Find your phone's IP with:

```bash
ifconfig 2>/dev/null | grep "inet "
```

---

## Keeping it running in the background

Termux may kill the process when the screen turns off. To prevent that:

```bash
termux-wake-lock
```

Release it when you are done:

```bash
termux-wake-unlock
```

For persistent access, install the [Termux:Boot](https://f-droid.org/en/packages/com.termux.boot/) add-on.

---

## Known limitations

- `better-sqlite3` does not currently ship prebuilt binaries for Android and will fail to compile without the Android NDK. Community patches provide a `node:sqlite` fallback - track progress in the project issues.
- First run takes longer on lower-end devices because of dependency install and initial migrations.
- Running Node + Vite continuously will drain battery faster than usual. Stop the dev server when not in use.

---

## Troubleshooting

### `npm install` fails on `better-sqlite3`
Expected on stock main. It is a native addon without Android prebuilts. Follow the fallback patch discussion in the tracker.

### `concurrently: not found`
Your previous `npm install` did not complete. Clean and retry:

```bash
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund
```

### Port already in use
Something else is on `3001` or `5173`. Free the port or change it in the server/client config.

### `EACCES` or permission errors
You are probably outside Termux's home directory. Stay inside `$HOME` - Android storage outside Termux is restricted.

---

## Uninstall

```bash
cd ~
rm -rf freellmapi
```

---

## Feedback

If something in this guide is wrong or outdated on your device, please open an issue with:

- Termux version
- Android version
- Device model
- Full error output
