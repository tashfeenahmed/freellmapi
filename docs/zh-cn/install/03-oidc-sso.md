[English](../../en/install/03-oidc-sso.md) · **简体中文**

# 使用 OpenID Connect (OIDC) 进行控制台单点登录

FreeLLMAPI 支持为控制台启用可选的 **OpenID Connect (OIDC)** 单点登录，采用标准的 **Authorization Code + PKCE (S256)** 流程（基于 `openid-client` v6）。兼容 **Authentik**、**Authelia**、**Pocket ID**、**Keycloak** 等自托管身份提供商，也支持 **Okta**、**Microsoft Entra ID**、**Google** 等托管 IdP。

OIDC 完全是**可选功能**。未配置 `OIDC_ISSUER_URL` 与 `OIDC_CLIENT_ID` 时，本地、Docker 与桌面端安装的行为与此前完全一致，不会发起任何外部请求。

---

## 工作方式

- **控制台登录：** 启用 OIDC 后，登录页会显示 **使用 \<提供商\> 登录** 按钮，默认与邮箱密码登录并存；若设置 `OIDC_DISABLE_PASSWORD_LOGIN=true`，则会隐藏并禁用本地密码登录。
- **API 密钥不受影响：** OIDC 仅用于控制台登录。`/v1/*`、`/v1beta/*`、`/mcp` 与 Ollama 接口仍继续使用你的 FreeLLMAPI API 密钥鉴权。
- **默认拒绝（Fail-Closed）访问控制：** 控制台内的每个用户都拥有全部上游 API 密钥的完整管理权限。因此，除非配置了 `OIDC_ALLOWED_EMAILS` / `OIDC_ALLOWED_GROUPS`，或显式设置 `OIDC_ALLOW_ANY_USER=true`（由 IdP 侧控制应用访问权限），否则默认拒绝自动创建新账号。
- **已有本地账号关联：** 若已存在本地控制台账号，通过 OIDC 使用相同且已验证的邮箱登录时，系统会自动关联你的 `(issuer, sub)` 身份。你可以保留密码登录作为备用，也可以用 `OIDC_DISABLE_PASSWORD_LOGIN=true` 仅允许 SSO。
- **敏感操作（查看/导出密钥）：** 通过 OIDC 自动创建的无密码账号在查看或导出上游密钥时无法输入本地密码。弹窗会显示 **通过 \<提供商\> 重新验证** 按钮，触发一次即时 OIDC 校验（`prompt=login`、`max_age=60`），验证通过后 5 分钟内允许查看或导出密钥。
- **应急恢复：** 如果 IdP 不可用且开启了 `OIDC_DISABLE_PASSWORD_LOGIN=true`，取消该环境变量（或运行 `npm run reset-password -w server`）即可恢复本地密码登录。

---

## 环境变量

所有选项均可通过 `.env` / Docker Compose 配置，也可写入 `FREEAPI_CONFIG_JSON` / `FREEAPI_CONFIG_PATH` 的 `oidc` 字段（环境变量优先级更高）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OIDC_ISSUER_URL` | *(未设置)* | 必填。OIDC 签发者基础地址（提供 `/.well-known/openid-configuration`）。 |
| `OIDC_CLIENT_ID` | *(未设置)* | 必填。在 IdP 中注册的 Client ID。 |
| `OIDC_CLIENT_SECRET` | *(未设置)* | 可选。机密客户端的 Client Secret；纯 PKCE 公开客户端（如 Pocket ID）可留空。 |
| `OIDC_REDIRECT_URI` | *(自动推导)* | 显式回调地址（`https://你的域名/api/auth/oidc/callback`）。**位于反向代理后强烈建议设置。** |
| `OIDC_SCOPES` | `openid email profile` | 空格分隔的 OIDC Scope。若 IdP 将用户组放在 `groups` Scope 中，请将其加入。 |
| `OIDC_PROVIDER_NAME` | `SSO` | 控制台登录按钮显示的名称。 |
| `OIDC_ALLOWED_EMAILS` | *(未设置)* | 逗号分隔的允许邮箱白名单（不区分大小写）。 |
| `OIDC_ALLOWED_GROUPS` | *(未设置)* | 逗号分隔的允许用户组白名单，匹配 `OIDC_GROUPS_CLAIM`（同时检查 ID Token 与 UserInfo）。 |
| `OIDC_GROUPS_CLAIM` | `groups` | 携带用户组列表的 Claim 名称。 |
| `OIDC_AUTO_PROVISION` | `true` *(存在准入控制时)* | 首次 OIDC 登录时自动创建无密码控制台账号。若未配置白名单且 `OIDC_ALLOW_ANY_USER` 不为 `true`，则自动拒绝。设为 `false` 表示仅允许已存在的本地账号登录。 |
| `OIDC_ALLOW_ANY_USER` | `false` | 显式允许该 Issuer 下任意已认证用户自动创建账号（仅在 IdP 已限制应用访问权限时启用）。 |
| `OIDC_DISABLE_PASSWORD_LOGIN` | `false` | 隐藏邮箱密码登录并使 `POST /api/auth/login` 返回 403。 |
| `OIDC_AUTO_REDIRECT` | `false` | 未登录访问控制台时直接跳转到 IdP（出错时停止自动跳转，避免死循环）。 |
| `OIDC_REQUIRE_VERIFIED_EMAIL` | `true` | 要求 IdP 返回 `email_verified: true` 后才允许关联或创建账号。 |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | *(未设置)* | 若已设置且 IdP 支持 `end_session_endpoint`，退出登录时会同时跳转至 IdP 端登出。 |
| `OIDC_ALLOW_INSECURE_HTTP` | `false` | 允许访问非本机的明文 `http://` 局域网 Issuer（`http://localhost` / `127.0.0.1` 始终自动允许）。 |

> **位于反向代理后（Caddy / Nginx / Traefik）：** 请同时配置 `TRUST_PROXY=1` 与 `OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback`，确保回调地址与 IdP 中的注册值完全一致。

---

## 声明式配置（`FREEAPI_CONFIG_JSON`）

除了环境变量外，也可以在 `FREEAPI_CONFIG_JSON` 或 `FREEAPI_CONFIG_PATH` 中配置 `oidc`：

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

## 常见 IdP 配置示例

在 IdP 中注册的回调地址统一为：

```text
https://<你的-freellmapi-域名>/api/auth/oidc/callback
```

### Authentik

1. 在 Authentik 中创建 **OAuth2/OpenID Provider**（`Client type: Confidential`，重定向 URI 填 `https://llm.example.com/api/auth/oidc/callback`），并绑定到新的 **Application**（如 slug 为 `freellmapi`）。
2. 配置 FreeLLMAPI：

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

### Authelia

1. 在 Authelia 的 `configuration.yml` 中 `identity_providers.oidc.clients` 下添加客户端：

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

2. 配置 FreeLLMAPI：

```env
TRUST_PROXY=1
OIDC_ISSUER_URL=https://auth.example.com
OIDC_CLIENT_ID=freellmapi
OIDC_CLIENT_SECRET=<明文-client-secret>
OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback
OIDC_PROVIDER_NAME=Authelia
OIDC_SCOPES=openid email profile groups
OIDC_ALLOWED_GROUPS=admins
```

### Pocket ID

Pocket ID 支持 Passkey 与纯 PKCE 公开客户端（无需 Client Secret）：

1. 在 Pocket ID 中新建 **OIDC Client**，勾选 **Public Client (PKCE)**，回调地址填 `https://llm.example.com/api/auth/oidc/callback`。
2. 配置 FreeLLMAPI：

```env
TRUST_PROXY=1
OIDC_ISSUER_URL=https://id.example.com
OIDC_CLIENT_ID=<pocket-id-client-id>
OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback
OIDC_PROVIDER_NAME=Pocket ID
OIDC_ALLOWED_EMAILS=you@example.com
```

### Keycloak

1. 在目标 Realm（如 `myrealm`）中创建 **OpenID Connect** 客户端，开启 **Client authentication** 与 **Standard flow**，PKCE 方法设为 **S256**，回调地址填 `https://llm.example.com/api/auth/oidc/callback`。
2. 如需按组授权，请添加 **Group Membership** Mapper，Token Claim Name 设为 `groups`。
3. 配置 FreeLLMAPI：

```env
TRUST_PROXY=1
OIDC_ISSUER_URL=https://keycloak.example.com/realms/myrealm
OIDC_CLIENT_ID=freellmapi
OIDC_CLIENT_SECRET=<client-secret>
OIDC_REDIRECT_URI=https://llm.example.com/api/auth/oidc/callback
OIDC_PROVIDER_NAME=Keycloak
OIDC_ALLOWED_GROUPS=freellmapi-admins
```
