# Changelog

Revision history for `docs/deployment/`, listing the commits that shaped the Docker operations and maintenance behavior documented here. Most recent first.

| Commit | Date | Summary |
| --- | --- | --- |
| `a9895bc` | 2026-08-20 | Fix batch of routing, streaming, deployment quick wins (#941). |
| `29eb340` | 2026-08-06 | feat: in-dashboard update checker, single Settings update surface (#635). |
| `5d51fec` | 2026-08-03 | docs(docker): why a container cannot reach providers the host can (#737) — source of the troubleshooting section in [01-docker.md](01-docker.md). |
| `5e5da26` | 2026-08-02 | fix(version,desktop): serve release version to every install (#718). |
| `c6589ff` | 2026-07-19 | fix(docker): copy server/node_modules into runtime so proxy loads undici (#550). |
| `a66f752` | 2026-07-06 | security: first-run setup code, key file out of DB, CSV export hardening (#477). |
| `f4cd7b4` | 2026-06-27 | catalog controls, persistence backup, declarative config — basis for the config/backup sections in [02-updates-and-backup.md](02-updates-and-backup.md). |
| `1da10bf` | 2026-05-31 | fix(docker): build toolchain for better-sqlite3 native compile (#143). |
| `606397f` | 2026-05-30 | feat(docker): Docker + GHCR support, multi-arch & localhost-bind (#129). |

Regenerate with `git log --oneline -- Dockerfile docker-compose.yml .dockerignore`.
