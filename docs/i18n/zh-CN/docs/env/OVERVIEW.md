[English](../../../../env/OVERVIEW.md) · **简体中文**

# 环境变量配置总览

## 范围

本域文档描述 FreeLLMAPI 的运行时配置面：服务器从 `.env` 读取的每一个变量、提供方 API 密钥如何静态加密存储，以及出站流量如何经由代理转发。唯一的权威来源是仓库根目录的 [`.env.example`](../../../../../.env.example)；这里的参考内容均由它（及其描述的代码路径）推导而来，绝不编造取值。

如果是第一次把安装跑起来，请看[安装与部署](../install.md)。

## 文件索引

| 文件 | 说明 |
| --- | --- |
| [01-variables.md](01-variables.md) | 按主题分组的完整变量参考（服务器/绑定、安全、限流、路由覆盖、出站代理、请求正文/媒体限制、杂项），默认值逐字取自 `.env.example`。 |
| [02-security-and-keys.md](02-security-and-keys.md) | `ENCRYPTION_KEY` 的生命周期：生成、开发环境自动生成的密钥文件、已存储提供方密钥的 AES-256-GCM 静态加密、密钥文件移出数据库的加固措施，以及数据目录权限。 |
| [03-outbound-proxies.md](03-outbound-proxies.md) | 出站代理配置：协议支持、解析链优先级（从 `PROXY_URL` 到 `HTTP_PROXY`）、`NO_PROXY` 直连豁免、Docker 的 `host.docker.internal` 坑点，以及相关的入站限流旋钮。 |

## 约定

- 变量由 [`server/src/env.ts`](../../../../../server/src/env.ts) 通过 dotenv 加载；`FREEAPI_ENV_PATH` 可为嵌入式场景指定另一处 `.env` 位置。
- `.env.example` 中被注释掉的行是可选变量；未注释的行自带生效的默认值。
- 凡是也能在运行时从仪表盘修改的变量，都会注明对应的运行时设置键，且该设置键始终优先于环境变量的取值。
