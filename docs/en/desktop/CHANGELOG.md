**English** · [简体中文](../../zh-cn/desktop/CHANGELOG.md)

# Changelog — desktop

| Commit | Date | Summary |
| --- | --- | --- |
| `90aaa5b` | 2026-08-24 | Desktop log file plus a passwords, logs and uninstall FAQ (#1002) — `desktop/src/logger.ts` `FileSink` + rotation + tray open folders |
| `4774cf0` | 2026-08-23 | Bring the desktop boot sequence up to server parity and bump to 0.8.7 (#1017) — `server-host.ts` mirrors `index.ts` steps, cross-checked by `server-host-boot.test.ts` |
| `73178f3` | 2026-08-23 | Fix: outlive the reverse proxy's idle connection pool (#1116) — keepAlive path touches server-host |
| `d8fae97` | 2026-08-23 | Add an rpm target to the Linux desktop build (#981) — `electron-builder.yml` `rpm x64` beside `deb` |
| `3b6f40e` | 2026-08-23 | Bump desktop to v0.9.0 (#1044) — version bump |
| `9196ed0` | 2026-08-23 | Mac builds are signed and notarized — closes #373 #943 (#1035) |
| `e70d130` | 2026-08-23 | Notarize the DMG itself, not just the app inside it (#1036) |
| `c8e05f0` | 2026-08-23 | Bump desktop to v0.9.1 (#1115) |

Regenerate: `git log --oneline -- desktop/`
