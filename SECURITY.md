# Security Policy

FreeLLMAPI holds real credentials: your provider API keys (encrypted at rest in
SQLite), a unified `/v1` bearer token, and a dashboard account. Bugs that expose
any of those are taken seriously. Thanks for reporting them responsibly.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.13.x (current) | Yes — security fixes land here |
| 0.12.x | Best effort; please upgrade |
| 0.11.x and older | No |

Fixes ship on the latest release line. There are no backported patch releases for
older lines, so the fastest way to stay patched is to track `0.13.x` (Docker users:
re-pull `:latest`).

## Reporting a vulnerability

**Preferred:** GitHub private vulnerability reporting — go to the
[Security tab](https://github.com/tashfeenahmed/freellmapi/security) and click
**Report a vulnerability**. That opens a private thread with the maintainer and
keeps the details out of public issues.

**Alternate:** email **support@freellmapi.co** with `[freellmapi security]` in the
subject.

Please do not open a public issue, PR, or discussion for a security bug until a
fix is out.

A useful report includes:

- Affected version or commit, and how you run it (Docker, `npm run dev`, desktop app).
- The impact — what an attacker gets (read keys, bypass auth, RCE, etc.).
- Steps to reproduce: the exact request, config, or `.env` settings involved.
  Redact your real provider keys.
- Server logs around the failing request, where you can share them.

## What to expect

- **Acknowledgement:** within a few days. This is a hobby project maintained by
  one person, so it is not a 24-hour SLA.
- **Fix:** best effort, prioritised by severity. Expect a rough timeline in the
  first reply, and progress updates on the same thread.
- **Disclosure:** once a fix is released. You get credit in the release notes if
  you want it — say so in your report, and tell me the name or handle to use.
- **No bug bounty.** There is no money behind this project to pay one. Credit and
  a genuine thank-you are what's on offer.

## Scope

In scope:

- The router server and its `/v1` proxy, `/api/*` admin routes, and `/mcp` endpoint.
- Dashboard authentication — the email + password account (scrypt, session tokens)
  and the unified `freellmapi-…` API key.
- Key handling: AES-256-GCM encryption at rest, `ENCRYPTION_KEY` usage, encrypted
  DB backups, key import/export.
- The Electron desktop app and its local data directory.
- The Docker image and packaging (`Dockerfile`, `docker-compose.yml`, the install
  script), including anything that leaks secrets into image layers or logs.
- Premium license key validation and the signed catalog feed.

Out of scope:

- Vulnerabilities in upstream LLM providers themselves. Report those to the
  provider. Bugs in *how this router talks to them* are in scope.
- Anything that requires the operator to deliberately expose the server to the
  public internet. FreeLLMAPI is a single-user, trusted-network tool: it binds
  `127.0.0.1` by default, `HOST_BIND=0.0.0.0` is a documented opt-in with a
  warning attached, and there is no multi-tenant auth by design. "I put it on a
  public IP and someone used my quota" is expected behaviour, not a vulnerability.
- Social engineering, phishing, physical access, or attacks that assume an
  already-compromised host or user account.
- Automated-scanner output with no demonstrated impact.

## Hardening tips for self-hosters

- **Keep the localhost binding.** Only set `HOST_BIND=0.0.0.0` on a network you
  trust, and put it behind a reverse proxy with TLS and auth if it must be
  reachable more widely. Never expose it straight to the internet.
- **Protect `ENCRYPTION_KEY` and `.env`.** They decrypt every provider key you
  have stored. Keep them out of git, off shared drives, and backed up somewhere
  safe — losing the key means losing the stored keys. In production always set
  `ENCRYPTION_KEY` explicitly rather than relying on the generated dev fallback.
- **Update.** Re-pull the Docker image (or `git pull` and rebuild) periodically;
  dependency and router fixes ride along with feature releases.
- **Rotate what leaks.** Regenerate the unified API key from the Keys page if a
  client that held it is compromised, and swap out suspect provider keys — the
  router falls over to sibling keys, so a rotation is not an outage.
