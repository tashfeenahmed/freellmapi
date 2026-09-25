[English](../../en/fallback/CHANGELOG.md) · **简体中文**

# 回退域 —— 变更日志

`docs/fallback/` 的文档修订历史，取自与回退相关的提交。

## 2026-08-25

- **docs(fallback): 搭建回退域** —— 新建 `docs/fallback/` 域，含 `OVERVIEW.md` + `CHANGELOG.md`，以及 `01-named-chains.md`，涵盖链生命周期、空链 `400` 拒绝（`activeChainOrThrow`）、`auto:<name>` 在 `GET /v1/models` 中的暴露，以及 `profiles.auto_include_new_models`，并附有权威的空链提交 `e852ff1`、`b3bf20f`、`8bb2004`、`cc1e985`。

## 2026-08-23 —— 前置历史

- **e852ff1** 让回退链表示其自身，空与否皆然 (#1023)
- **b3bf20f** 让回退链可手工构建并保持原样 (#1004)
- **8bb2004** 在回退页面新增命名链管理器 (#988)
- **cc1e985** 将命名回退链列为 `auto:<name>` 模型 (#986)
