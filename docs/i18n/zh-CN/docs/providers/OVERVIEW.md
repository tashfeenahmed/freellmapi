[English](../../../../providers/OVERVIEW.md) · **简体中文**

# 提供方集成总览

## 范围

本域文档描述 FreeLLMAPI 的提供方层：网关聚合了哪些平台、每个平台如何鉴权和适配，以及按密钥的额度记账、冷却和健康检查如何让各家免费额度在同一个 OpenAI 兼容 API 之下保持可用。

权威来源是 [`shared/types.ts`](../../../../../shared/types.ts)（`Platform` 联合类型）、[`server/src/providers/index.ts`](../../../../../server/src/providers/index.ts)（运行时注册表）和 [`server/src/providers/base.ts`](../../../../../server/src/providers/base.ts)（适配器契约）。公开目录的招牌数字——约 29 家免费提供方、251 个模型系列、358 个免费端点（约合每月 40 亿词元的在册容量）——来自 [README 的提供方表格](../../README.md)；目录实际跟踪的平台比类型联合声明的要少，因为联合中的部分成员已退役，或者由用户自定义而非由目录管理。

## 文件索引

| 文件 | 说明 |
| --- | --- |
| [01-supported-platforms.md](01-supported-platforms.md) | `shared/types.ts` 中声明的每个平台一行：鉴权方式（带密钥/免密钥）、适配器类（原生/OpenAI 兼容）以及集成注意事项。每种分组都有明确的数量。 |
| [02-quotas-and-cooldowns.md](02-quotas-and-cooldowns.md) | RPM/RPD 与 TPM/TPD 窗口记账、并发租约与可选上限、冷却阶梯及其来源分类、基于探测的提前恢复、从 `Retry-After` 响应头和错误正文解析退避时间（#798），以及为什么健康检查绝不能烧掉计量额度（#882）。 |
| [03-adding-a-new-provider.md](03-adding-a-new-provider.md) | 贡献者走查：扩展 `Platform` 联合、选择适配器、注册选项（超时、免密钥、额外请求头）、密钥校验语义、目录播种策略，以及新提供方应当随附的测试。 |

## 约定

- 适配器位于 [`server/src/providers/`](../../../../../server/src/providers/)；在那里注册的每个平台立即出现在 `/v1` 路由上——没有单独的启用步骤。
- 模型行有两种播种途径：发布期名册用版本化迁移，此后的目录托管内容一律走经过签名的托管目录（`services/catalog-sync.ts`，以 `hasProvider` 为门槛）。
- 额度上限是数据而非代码：每条目录模型行上的 `rpm_limit` / `rpd_limit` / `tpm_limit` / `tpd_limit` 列驱动预限流；见 [02-quotas-and-cooldowns.md](02-quotas-and-cooldowns.md)。
