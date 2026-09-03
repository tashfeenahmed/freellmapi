[English](../../../../testing/01-running-tests.md) · **简体中文**

# 运行测试

## 根链

仓库根目录的 `npm test` 按顺序运行（[package.json](../../../../../package.json)）：

| 步骤 | 命令 | 覆盖内容 |
| --- | --- | --- |
| `test:bootstrap` | `node --test scripts/dev-bootstrap.test.mjs` | 开发引导脚本。 |
| `test:hooks` | `node --test .claude/hooks/contributing-check.test.mjs` | 贡献者检查 hook 逻辑。 |
| server | `npm run test -w server` | Vitest 套件（见 [02-server-suite.md](02-server-suite.md)）。 |
| cli | `npm run test -w cli` | Setup-CLI 测试（工具、配置文件合并、index）。 |
| client | `npm run test -w client --if-present` | 客户端 vitest 套件加 i18n 一致性检查。 |

desktop 工作区有自己的一小组套件（`desktop/src/__tests__/window-chrome.test.ts`），但不属于根链；它用自带工具经 `npm --prefix desktop` 运行。

## 按工作区的命令

### Server (`server/package.json`)

```
npm run test -w server            # vitest run --pool=forks --fileParallelism=false
npm run test:watch -w server      # watch mode
npm run test:migrations -w server # migration roundtrip only
```

`test:migrations` 只瞄准一个文件——[`src/__tests__/db/migrate/roundtrip.test.ts`](../../../../../server/src/__tests__/db/migrate/roundtrip.test.ts)——把每条已记录的迁移上滚再下滚，证明往返无损。动过 `src/db/migrate/` 下面的任何东西之后都要跑它。

2026 年 8 月新增的测试文件，扩充了覆盖率：
- `src/__tests__/routes/logs.test.ts` —— 服务器日志查看器的持久化与 API
- `src/__tests__/routes/custom-transcription.test.ts` —— 自定义 STT 模型注册与转写用法
- `src/__tests__/lib/provider-identity.test.ts` —— 自定义端点身份分类（#889）

### Client (`client/package.json`)

```
npm run test -w client            # vitest run && npm run check:i18n
npm run check:i18n -w client      # scripts/check-i18n.mjs
```

`check:i18n` 校验每个语言文件的键/占位符一致性；缺失或占位符损坏的翻译会让套件失败，而不只是构建失败。

### 其余部分

`npm run build` 也必须通过——CI 在测试之后构建所有工作区，所以类型错误即使躲过单元测试也会在那里浮出。

## CI 摘要

[`.github/workflows/ci.yml`](../../../../../.github/workflows/ci.yml) 运行在 `ubuntu-24.04` 上，针对 `main` 的推送和 PR 触发，是一个横跨 Node **20 和 22** 矩阵的单一 `test` 任务——正好是受支持引擎区间（`>=20.18 <25`)的两端。Node 20 是基线，历史上曾抓住被较新的本地 Node 掩盖的崩溃；22 是多数贡献者在用的 LTS。步骤按顺序：

1. checkout + setup-node（带 npm 缓存）
2. `npm install`
3. **检查迁移往返**：`npm run test:migrations`（在主套件之前，让 schema 漂移尽早失败）
4. `npm test`（上面的根链）
5. `npm run build`

`fail-fast: false` 保证一个 Node 版本的失败不会掩盖另一个的结果。
