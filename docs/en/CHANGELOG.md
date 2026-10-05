**English** · [简体中文](../zh-cn/CHANGELOG.md)

# Changelog — en

| Commit | Date | Summary |
| --- | --- | --- |
| _(via #1414)_ | 2026-10-04 | providers: quota polling — `BaseProvider.fetchQuota` / `quota_api` observations piggybacked on the health pass with a per-key 15-min throttle (issue #1403 phase 1); SiliconFlow `/v1/user/info` balance registered, string-encoded balances accepted |
| _(via #1414)_ | 2026-10-04 | health: `POST /api/health/quota/:keyId` — manual provider-balance poll that bypasses the 15-min throttle; `hasQuotaProbe` distinguishes specless platforms (400) from failing probes (#1403) |
| `ef1b9ce` | 2026-09-05 | language-switcher line on every page, root-README anchors fixed from inside docs/, cli config page path (#1167) |
| `eab992f` | 2026-09-02 | scaffold per-language en/ top-level (landed via #1164) |
| `eab992f` | 2026-09-02 | move English domains under en/ (17 domains) (landed via #1164) |
| `eab992f` | 2026-09-02 | fix link depths after move (landed via #1164) |
| `eab992f` | 2026-09-02 | fix root flat-file violations and name collisions (landed via #1164) |
| `eab992f` | 2026-09-02 | complete desktop, cli, troubleshooting and glossary domains (landed via #1164) |
| `eab992f` | 2026-09-02 | document Idempotency-Key safe retries (landed via #1164) |
| `eab992f` | 2026-09-02 | cover PROXY_MODE, FETCH_RELAY_TOKEN, TRUST_PROXY, QUOTA_OBSERVATIONS_* (landed via #1164) |
| `eab992f` | 2026-09-02 | create proxy domain and move Fetch Relay into it (landed via #1164) |

Regenerate: `git log --oneline -- docs/en/`
