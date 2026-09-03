[English](../../../../env/03-outbound-proxies.md) · **简体中文**

# 出站代理

FreeLLMAPI 如何把发往提供方的流量经由代理转发、多个变量同时设置时谁说了算，以及随之而来的 Docker 网络坑点。

来源：[`.env.example`](../../../../../.env.example)（代理配置块）、[`docker-compose.yml`](../../../../../docker-compose.yml)，以及 [`docs/install.md`](../install.md) 中的容器网络说明。

- [代理链优先级](#代理链优先级)
- [协议支持](#协议支持)
- [`NO_PROXY` 直连豁免](#no_proxy-直连豁免)
- [Docker：`127.0.0.1` 指的是容器](#docker-127001-指的是容器)
- [相关的入站限流旋钮](#相关的入站限流旋钮)

## 代理链优先级

发往提供方请求的出站代理通常在仪表盘里设置（密钥 → 出站代理）；环境变量是为无界面的安装准备的。当多个来源同时存在时，解析顺序为：

```
PROXY_URL → dashboard setting → ALL_PROXY → HTTPS_PROXY → HTTP_PROXY
```

标准变量的全小写拼写同样会被读取（`all_proxy`、`https_proxy`、`http_proxy`）。

| 变量 | 在链中的角色 |
| --- | --- |
| `PROXY_URL` | FreeLLMAPI 显式的代理设置；最高优先级。 |
| 仪表盘设置 | 密钥 → 出站代理；胜过通用的环境变量。 |
| `ALL_PROXY` | 标准的兜底代理变量。 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 常规的按协议变量，优先级最低。 |

## 协议支持

接受的协议：`http`、`https`、`socks4`、`socks4a`、`socks5`、`socks5h`。

带 `h`/`a` 的变体（`socks5h`、`socks4a`）在代理端而非本地解析 DNS，这正是 DNS 污染网络下想要的。示例：

```env
PROXY_URL=socks5h://127.0.0.1:1080
```

## `NO_PROXY` 直连豁免

`NO_PROXY` 列出必须直连的主机，绕开上面胜出的那个代理：

```env
NO_PROXY=localhost,127.0.0.1,.internal.corp
```

- 条目之间用逗号分隔。
- 裸域名同时涵盖其子域名。
- 特殊值 `*` 彻底禁用代理。

## Docker：`127.0.0.1` 指的是容器

在容器内部，`127.0.0.1` 是容器自己——不是你的机器（#733）。如果你的代理客户端跑在宿主机上（Clash、v2rayN、sing-box 或公司代理），需要两处调整：

1. 让 FreeLLMAPI 指向宿主机的地址而不是环回地址：

   ```env
   PROXY_URL=socks5h://host.docker.internal:7890
   ```

2. 确保代理监听的不只是环回地址（在 Clash 里是 `allow-lan: true`）。

随附的 `docker-compose.yml` 通过一条 `extra_hosts` 条目把 `host.docker.internal` 映射到宿主机网关，所以在原生 Linux Docker 上同样可用，并不限于已经内置这个名字的 Docker Desktop：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

另一种与此无关、却同样会让容器失联而宿主机安然无恙的情况：在纯 IPv6 的宿主机上，默认桥接网络只有 IPv4，于是容器什么都够不着——DNS 也一样。在 `/etc/docker/daemon.json` 里启用 IPv6（`"ipv6": true`、`"ip6tables": true`，以及一段 `"fixed-cidr-v6"` 网段）并重启 Docker。

想分辨自己撞上的是哪种情况，直接问容器本身：

```bash
docker compose exec freellmapi node -e "fetch('https://generativelanguage.googleapis.com/').then(r=>console.log('ok',r.status)).catch(e=>console.log('fail',e.cause?.code||e.message))"
```

## 相关的入站限流旋钮

虽然都带「proxy」这个名字，下面这两个变量限的是「进入」FreeLLMAPI 自身的流量，而不是发往提供方的出站调用：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PROXY_RATE_LIMIT_RPM` | `120` | 每个客户端 IP 每分钟可发送的 `/v1` 代理请求上限。`0` 关闭。 |
| `ADMIN_RATE_LIMIT_RPM` | `600` | 每个客户端 IP 每分钟可发送的 `/api` 仪表盘请求上限——一道防洪水闸；登录有自己的按邮箱锁定机制，密钥导出则有自己严格得多的上限。`0` 关闭。 |

完整描述见 [01-variables.md](01-variables.md#限流)。
