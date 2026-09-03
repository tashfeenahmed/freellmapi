[English](../../../../testing/OVERVIEW.md) · **简体中文**

# 测试总览

## 范围

本域文档描述 FreeLLMAPI 如何被测试：跨 monorepo 各工作区的本地命令矩阵、服务器套件的布局与约定（串行 fork 执行、模块纯度守卫、环回绑定），以及 #629 引入的端到端编程智能体兼容性套件。

来源：根目录 [`package.json`](../../../../../package.json) 的测试链、各工作区的 `package.json` 脚本（[server](../../../../../server/package.json)、[client](../../../../../client/package.json)）、[`.github/workflows/ci.yml`](../../../../../.github/workflows/ci.yml)，以及 [`server/src/__tests__/`](../../../../../server/src/__tests__) 下的各个套件本身。

## 文件索引

| 文件 | 说明 |
| --- | --- |
| [01-running-tests.md](01-running-tests.md) | 完整的本地矩阵——根链执行顺序、按工作区的命令、迁移往返检查——以及 CI 在 ubuntu-24.04 上运行内容的摘要。 |
| [02-server-suite.md](02-server-suite.md) | `src/__tests__/` 目录布局、vitest 为什么用 `--pool=forks --fileParallelism=false` 运行、纯库导入守卫（#858），以及绑定到环回的约定（#888）。 |
| [03-compatibility-suite.md](03-compatibility-suite.md) | 来自 #629 的端到端编程智能体兼容性套件：覆盖什么、位于哪里、证明了什么。 |

## 约定

- 唯一入口：仓库根目录的 `npm test` 按顺序运行 bootstrap 和 hook 检查，然后是 server、cli、client 工作区。
- 服务器测试是确定性且注意副作用的：不发起真实的提供方调用，服务器绑定 `127.0.0.1`，共享状态通过在 fork 池中串行运行文件来隔离。
- CI 是同一个矩阵，跑在受支持 Node 区间的两端（20 和 22）——如果本地 `npm test && npm run build` 通过，CI 也应当同意。
