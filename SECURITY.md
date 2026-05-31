# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via GitHub's **[Security advisories → Report a vulnerability](https://github.com/raveracker/freellmapi/security/advisories/new)**.
We aim to acknowledge reports within a few days and will coordinate a fix and
disclosure timeline with you.

## Scope & operational notes

FreeLLMAPI is a **single-user** proxy. Its security model assumes:

- The `/v1` endpoint is reached only over the deployed TLS entry point and is
  authenticated by the unified API key — never expose the key or endpoint publicly.
- `ENCRYPTION_KEY` decrypts every stored provider key; treat it as a crown-jewel
  secret and keep it out of version control (it lives only in `.env` / a vault).
- Deployments should restrict ingress to known networks (see `ORACLE_CLOUD.md`,
  Phase 9) rather than leaving the endpoint open to the internet.

## Automated safeguards in this repo

- Secret scanning + push protection (blocks committing known secret formats)
- Dependabot security alerts and update PRs
- CodeQL static analysis on PRs and weekly
- Branch protection on `main` (PR + passing CI required before merge)
