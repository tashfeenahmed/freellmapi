**English** · [简体中文](../../zh-cn/install/03-oidc-sso.md)

# Dashboard SSO with OpenID Connect (OIDC)

FreeLLMAPI supports optional **OpenID Connect (OIDC)** sign-in for the dashboard using standard **Authorization Code + PKCE (S256)** (`openid-client` v6). It works with self-hosted identity providers such as **Authentik**, **Authelia**, **Pocket ID**, and **Keycloak**, as well as hosted IdPs like **Okta**, **Microsoft Entra ID**, and **Google**.

OIDC is **completely opt-in**. When `OIDC_ISSUER_URL` and `OIDC_CLIENT_ID` are not configured, local, Docker, and desktop installs behave identically to before with zero external calls.

---

## How it works

- **Dashboard login:** When OIDC is configured, the login screen shows a **Sign in with \<Provider\>** button alongside email/password login (or replaces the password form when `OIDC_DISABLE_PASSWORD_LOGIN=true`).
- **API keys stay unchanged:** OIDC authenticates dashboard users only. `/v1/*`, `/v1beta/*`, `/mcp`, and Ollama endpoints continue to authenticate with your FreeLLMAPI API keys.
- **Fail-closed access control:** Every dashboard user has full admin access to stored provider keys. Auto-provisioning new users is therefore **refused** unless you configure `OIDC_ALLOWED_EMAILS` / `OIDC_ALLOWED_GROUPS` or explicitly set `OIDC_ALLOW_ANY_USER=true` (when access is already enforced at your IdP).
- **Existing accounts:** If you already created a local dashboard account, signing in via OIDC with the same verified email links your `(issuer, sub)` identity automatically. You can keep password login as a fallback or disable it with `OIDC_DISABLE_PASSWORD_LOGIN=true`.
- **Sensitive actions (reveal/export keys):** Passwordless OIDC accounts cannot enter a local password when revealing or exporting provider keys. Instead, the dialog shows a **Re-verify with \<Provider\>** button that runs a fresh OIDC check (`prompt=login`, `max_age=60`) and unlocks key reveal/export for 5 minutes.
- **Emergency recovery:** If your IdP is unavailable and `OIDC_DISABLE_PASSWORD_LOGIN=true`, unset `OIDC_DISABLE_PASSWORD_LOGIN` (or run `npm run reset-password -w server`) to restore local password sign-in.

---

## Environment variables

All variables can be set in `.env` / Docker Compose, or via the `oidc` object in `FREEAPI_CONFIG_JSON` / `FREEAPI_CONFIG_PATH` (environment variables take precedence).

| Variable | Default | Description |
| --- | --- | --- |
| `OIDC_ISSUER_URL` | *(unset)* | Required. Base URL of your OIDC issuer (where `/.well-known/openid-configuration` is served). |
| `OIDC_CLIENT_ID` | *(unset)* | Required. Client ID registered in your IdP. |
| `OIDC_CLIENT_SECRET` | *(unset)* | Optional. Client secret for confidential clients. Leave unset for public PKCE-only clients (such as Pocket ID). |
| `OIDC_REDIRECT_URI` | *(derived)* | Explicit callback URL (`https://your-host/api/auth/oidc/callback`). **Recommended behind a reverse proxy.** |
| `OIDC_SCOPES` | `openid email profile` | Space-separated OIDC scopes. Add `groups` if your IdP puts group claims under the `groups` scope. |
| `OIDC_PROVIDER_NAME` | `SSO` | Button label shown in the dashboard (`Sign in with <name>`). |
| `OIDC_ALLOWED_EMAILS` | *(unset)* | Comma-separated email allowlist (case-insensitive). |
| `OIDC_ALLOWED_GROUPS` | *(unset)* | Comma-separated group allowlist matched against `OIDC_GROUPS_CLAIM` (checked in ID token and UserInfo). |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim name containing the user's groups. |
| `OIDC_AUTO_PROVISION` | `true` *(when guarded)* | Create a passwordless dashboard account on first OIDC sign-in. Refused unless an allowlist or `OIDC_ALLOW_ANY_USER=true` is set. Set `false` to only allow pre-existing local accounts. |
| `OIDC_ALLOW_ANY_USER` | `false` | Explicitly allow any authenticated user from the issuer to auto-provision (use only if your IdP restricts app access). |
| `OIDC_DISABLE_PASSWORD_LOGIN` | `false` | Hide email/password login and reject `POST /api/auth/login` with HTTP 403. |
| `OIDC_AUTO_REDIRECT` | `false` | Redirect unauthenticated dashboard visits directly to the IdP (stops on error to avoid redirect loops). |
| `OIDC_REQUIRE_VERIFIED_EMAIL` | `true` | Require `email_verified: true` from the IdP before linking or provisioning. |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | *(unset)* | If set and supported by the IdP (`end_session_endpoint`), dashboard logout redirects through the IdP's RP-initiated logout. |
| `OIDC_ALLOW_INSECURE_HTTP` | `false` | Allow plain `http://` discovery/token calls to non-loopback LAN issuers (`http://localhost` / `127.0.0.1` are always allowed for local dev). |

> **Behind a reverse proxy (Caddy, Nginx, Traefik):** Set both `TRUST_PROXY=1` and `OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback`. Setting `OIDC_REDIRECT_URI` explicitly ensures the callback URL always matches what is registered in your IdP.

---

## Declarative config (`FREEAPI_CONFIG_JSON`)

Instead of individual `OIDC_*` variables, you can declare an `oidc` block in `FREEAPI_CONFIG_JSON` or `FREEAPI_CONFIG_PATH`:

```json
{
  "oidc": {
    "issuerUrl": "https://auth.example.com/application/o/freellmapi/",
    "clientId": "freellmapi",
    "clientSecret": "replace-with-client-secret",
    "redirectUri": "https://llm.example.com/api/auth/oidc/callback",
    "providerName": "Authentik",
    "scopes": "openid email profile groups",
    "allowedGroups": ["freellmapi-admins"],
    "disablePasswordLogin": true
  }
}
```

---

## Provider setup recipes

Register the callback URL in your IdP as:

```text
https://<your-freellmapi-host>/api/auth/oidc/callback
```

### Authentik

1. In Authentik, create an **OAuth2/OpenID Provider** (`Client type: Confidential`, `Signing Key: authentik Self-signed Certificate`, `Redirect URI: https://llm.example.com/api/auth/oidc/callback`).
2. Attach it to a new **Application** (slug e.g. `freellmapi`).
3. Configure FreeLLMAPI:

```env
TRUST_PROXY=1
OIDC_ISSUER_URL=https://auth.example.com/application/o/freellmapi/
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<client-secret>
OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback
OIDC_PROVIDER_NAME=Authentik
OIDC_SCOPES=openid email profile
OIDC_ALLOWED_GROUPS=freellmapi-admins
```

*(Authentik includes `groups` in the default `profile` scope; verify your property mappings if using custom group filters.)*

### Authelia

1. Add a client under `identity_providers.oidc.clients` in Authelia's `configuration.yml`:

```yaml
- client_id: freellmapi
  client_name: FreeLLMAPI
  client_secret: '$pbkdf2-sha512$...'
  public: false
  authorization_policy: two_factor
  require_pkce: true
  pkce_challenge_method: S256
  redirect_uris:
    - https://llm.example.com/api/auth/oidc/callback
  scopes:
    - openid
    - email
    - profile
    - groups
```

2. Configure FreeLLMAPI:

```env
TRUST_PROXY=1
OIDC_ISSUER_URL=https://auth.example.com
OIDC_CLIENT_ID=freellmapi
OIDC_CLIENT_SECRET=<plain-client-secret>
OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback
OIDC_PROVIDER_NAME=Authelia
OIDC_SCOPES=openid email profile groups
OIDC_ALLOWED_GROUPS=admins
```

### Pocket ID

Pocket ID supports passkeys and PKCE public clients (no client secret needed):

1. In Pocket ID, create a new **OIDC Client**, check **Public Client (PKCE)**, and set the callback URL to `https://llm.example.com/api/auth/oidc/callback`.
2. Configure FreeLLMAPI:

```env
TRUST_PROXY=1
OIDC_ISSUER_URL=https://id.example.com
OIDC_CLIENT_ID=<pocket-id-client-id>
OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback
OIDC_PROVIDER_NAME=Pocket ID
OIDC_ALLOWED_EMAILS=you@example.com
```

### Keycloak

1. Create a new **OpenID Connect** client in your realm (e.g. `myrealm`) with **Client authentication** enabled, **Standard flow** enabled, **PKCE Code Challenge Method: S256**, and Valid Redirect URI `https://llm.example.com/api/auth/oidc/callback`.
2. If using `OIDC_ALLOWED_GROUPS`, add a **Group Membership** client scope mapper with Token Claim Name `groups` (and disable **Full group path** if matching bare group names).
3. Configure FreeLLMAPI:

```env
TRUST_PROXY=1
OIDC_ISSUER_URL=https://keycloak.example.com/realms/myrealm
OIDC_CLIENT_ID=freellmapi
OIDC_CLIENT_SECRET=<client-secret>
OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback
OIDC_PROVIDER_NAME=Keycloak
OIDC_ALLOWED_GROUPS=freellmapi-admins
```
