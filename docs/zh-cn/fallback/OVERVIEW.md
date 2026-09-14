[English](../../en/fallback/OVERVIEW.md) · **简体中文**

# 回退域 —— 概览与文件索引

本域文档描述 FreeLLMAPI 的命名回退链系统：链如何存储、路由器如何解析活跃链（为空时拒绝）、命名链如何以 `auto:<name>` 形式暴露给客户端，以及目录同步如何与精选链交互。根目录 [`README.md`](../README.md) 与 [`OVERVIEW.md`](../OVERVIEW.md) 将其索引为操作者控制路由器可用模型的主要机制。

## 文件索引

| 文件 | 范围 |
|------|-------|
| [`01-named-chains.md`](01-named-chains.md) | 链生命周期、空链拒绝、`auto:<name>` 路由、`profiles.auto_include_new_models`，以及使空链具有权威性的提交。 |
| [`CHANGELOG.md`](CHANGELOG.md) | 本域文档修订历史。 |

## 导航

- ← [文档根目录](../README.md)
- 深度剖析：[`01-named-chains.md`](01-named-chains.md)

## 相关

- [../architecture/](../architecture/) —— 执行已解析链的路由器、评分与故障转移内部实现。
- [../api/](../api/) —— 向客户端暴露命名链的 `auto:*` 路由策略与 `GET /v1/models` 接口。
- [../providers/](../providers/) —— 为链中每一跳提供门控的按密钥额度记账与冷却。
