[English](../../en/fallback/01-named-chains.md) · **简体中文**

# 命名回退链

> **来源：** `server/src/services/router.ts`（`activeChainOrThrow`、`resolveRoutingChain`）、`server/src/services/profile-models.ts`（`getActiveProfileId`、`autoIncludeNewModelsForProfiles`）、`server/src/routes/fallback.ts`、`server/src/routes/profiles.ts`

*回退链*是路由器为一次请求可尝试的有序模型集合。同一时刻只有一条链处于**活跃**状态；`plain auto` 始终跟随活跃链。链的存储位置取决于安装是否使用命名配置档：

- **无配置档（旧版安装）：** 全局 `fallback_config` 表。
- **命名配置档：** `profiles` 表加上每个链内模型的 `profile_models` 行，每行带有 `priority` 与 `enabled`。

在仪表盘的**回退**页面上创建、重命名、删除以及切换活跃链。配置档名称使用拉丁字母、数字、连字符与下划线（最多 20 个字符），且不得与保留的路由关键词冲突（`auto`、`smart`、`fast`、`cheap`、`budget`、`intelligence`、`speed`、`active`、`default`）。

## 生命周期：空链拒绝

当命名配置档作为活跃链时，`auto` **不是**对整个目录的放行。路由器会解析活跃链，若其中没有已启用的模型，则**抛出面向客户端的 `400`**，而非静默回落到全局表：

```
The active fallback chain '<name>' has no enabled models.
Enable models for it on the Models page, switch the active chain,
or name another one with "auto:<chain>".
```

该拒绝仅在配置档处于活跃时触发。未使用配置档的旧版安装仍保持普通的“所有模型已耗尽”路径——路由器执行（可能为空的）全局链并返回正常的耗尽错误。要点在于：空链必须表示“不允许任何模型”，而非“允许全部”。历史见[提交](#提交)。

`activeChainOrThrow`（`router.ts`）是唯一的关口：`auto`、未知的 `auto:` 后缀以及空模型字符串都会经过它。它也是 `GET /api/fallback` 与 `/token-usage` 所读取的内容，因此仪表盘与路由器对活跃链包含什么永远不会产生分歧。

## `GET /v1/models` 中的 `auto:<name>`

每个自定义路由配置档都会作为可发现的模型 ID `auto:<name>`（`cc1e985`）向客户端公示。`GET /v1/models` 会列出每个命名链及其最大上下文与可用性，连同普通的 OpenAI 形态目录以及 Claude 家族的发现 ID。客户端可通过发送 `model="auto:coding"` 按请求切换链——无需改动仪表盘，无需轮换密钥。未知链名会返回清晰的 `400`，而非静默使用活跃链。

由于命名链的行来自 `profile_models`（而非全局 `fallback_config`），两套安装可以通过同一个统一密钥运行完全不同的模型集合——链由请求的 `model` 字段选择，而非由账户决定。

## 目录同步与精选链

全新的配置档默认为 **“从空开始”**——其 `profile_models` 集合初始为空，并退出目录同步的回填。这是命名链的全部意义：操作者手动挑选“这三个模型，按此顺序”，网关便不再自行猜测。

`profiles.auto_include_new_models` 标志（`b3bf20f`）控制例外：

- **`auto_include_new_models = 0`（默认）：** 目录同步永不回填链。链保持操作者放入时的原样。在精选的编程/视觉链上关闭此项，可防止新发现的模型悄悄出现在链中。
- **`auto_include_new_models = 1`：** 每个新同步的模型都会追加到链末尾（下一个优先级，继承模型的全局 `enabled` 状态）。在需要随目录增长的“兜底”配置档上使用。

同步会执行 `autoIncludeNewModelsForProfiles`，该函数仅触及设置了标志的配置档——精选链永不被改动。

## 按行启用 / 禁用

`PUT /api/fallback` 会向活跃链写入完整的链替换，而 **全部启用 / 全部禁用** 操作（`b3bf20f`）会一次性翻转所有行。`chain_enabled` 仅是读取时的标记：被禁用的行仍会消耗提供方的免费额度，仍计入额度池，只是会在所有已启用行之后排序，并被 `activeChainOrThrow` 的“是否有已启用？”检查跳过。这正是让手写（“从空开始”）链可用的关键：页面呈现为“目录减去我关闭的部分”，排在显式添加的行之后。

## 注释，而非全局表

`fallback_config` 现在**仅**是未配置任何配置档的安装的链。一旦存在配置档，其 `profile_models` 即为权威，全局表会被绕过。把全局表当作空 `profile_models` 集合的回退，正是 `e852ff1` 修复的错误——在此之前， freshly 创建的“从空开始”配置档会把整个目录渲染为已启用，因为每个消费者都把零行解读为“未配置链”并悄悄回落到 `fallback_config`。

## 提交

| 提交 | 变更 |
|--------|--------|
| `e852ff1` | **回退链即其自身，空与否皆然。** `activeChainOrThrow` 即使在没有已启用行时也会返回活跃配置档的链，而非回落到全局 `fallback_config`。空的精选链现在以 `400` 拒绝，而非静默地在整个目录上路由。 |
| `b3bf20f` | **让手写的链保持手写。** 链可从空开始；新增的 `auto_include_new_models` 标志阻止目录同步回填精选链；路由表获得 全部启用 / 全部禁用。关闭 #895。 |
| `8bb2004` | **回退页面上的命名链管理器。** 用于创建、重命名与删除命名链的折叠手风琴，暴露客户端发送的 `auto:<name>` ID。关联 #895 #960。 |
| `cc1e985` | **将命名链列为 `auto:<name>` 模型。** 每个自定义路由配置档在 `GET /v1/models` 中以 `auto:<name>` 形式出现，并附带其最大上下文与可用性。关联 #895 #880 #960。 |
