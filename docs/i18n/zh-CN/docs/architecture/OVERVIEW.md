[English](../../../../architecture/OVERVIEW.md) · **简体中文**

# 架构域 —— 概览与文件索引

本目录包含 FreeLLMAPI 服务端架构的深度文档。根目录的 [`architecture.md`](../../../../architecture.md) 仍是高层索引；这些文件把各子系统展开并给出实现细节。

## 文件索引

| 文件 | 范围 |
|------|-------|
| [`01-routing-and-bandit-scoring.md`](01-routing-and-bandit-scoring.md) | Thompson 采样老虎机路由器、可靠性后验、因子权重（可靠性/速度/智能/余量/限流）、10% 探索底线、带模型级耗尽诊断的回退循环 |
| [`02-quota-and-cooldown-engine.md`](02-quota-and-cooldown-engine.md) | RPM/RPD/TPM/TPD 核算、并发租约、冷却阶梯（90s → 2m → 10m → 1h → 1d）、基于探测的提前恢复、从错误正文/头部退避 (#798)、提供方额度池化（openrouter::free、google::project） |
| [`03-streaming-pipeline.md`](03-streaming-pipeline.md) | 纯 SSE 流式（零 WebSocket）、OpenAI chat/completions、Anthropic Messages tool_use 块渲染、Gemini `/v1beta`、Responses API 适配、流中错误处理 |
| [`04-degraded-mode-and-failover.md`](04-degraded-mode-and-failover.md) | 降级模式状态机 (f412e97)、重试预算耗尽时的对冲/中止 (1d2226a)、X-Fallback-Detail 头 (8cb75ac)、裸 safe/unsafe 分类输出回退 (a961d93) |
| [`05-catalog-sync.md`](05-catalog-sync.md) | 从 freellmapi.co 的实时签名目录同步、模型年龄闸（30 天）、付费/免费层、迁移播种 vs 托管目录 |
| [`06-observability.md`](06-observability.md) | 服务器日志查看器（环形缓冲 + 持久化 warn/error）、`/api/logs` API、请求分析、日志脱敏 |
| [`CHANGELOG.md`](CHANGELOG.md) | 本域文档修订历史，从触及架构相关代码的提交播种而来 |

## 导航

- ← [文档根目录](../README.md)
- ↑ [高层架构索引](../../../../architecture.md)