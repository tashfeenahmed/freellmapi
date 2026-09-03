[English](../../../../testing/02-server-suite.md) · **简体中文**

# 服务器套件

## 布局

所有服务器测试位于 [`server/src/__tests__/`](../../../../../server/src/__tests__) 下，与 `src/` 镜像：

| 目录 | 内容 |
| --- | --- |
| `db/` | 数据库初始化/加密/加固、智能档位、node-sqlite 行为，以及 `db/migrate/`——迁移运行器测试、注册表漂移、端点身份，还有 `test:migrations` 单独运行的 `roundtrip.test.ts`。 |
| `lib/` | 纯模块单元：错误分类、加密、预算、Gemini 线上格式/schema、回退循环（含客户端中止、hedge、租约、模型停用变体）、env 漂移、模块纯度（见下文）。 |
| `providers/` | 按适配器的测试：google（参数/鉴权头/schema）、openai-compat、cohere、cloudflare、zhipu、aihorde、modelscope、pollinations、cn-providers 批量测试，外加横切行为——abort 信号、推理超时、流式首字节、声明式重试解析（#798）、max-token 上限。 |
| `routes/` | HTTP 面测试：代理/重试/回退、anthropic messages 垫片、gemini `/v1beta`、ollama 模拟、url-tokens、auth、分析、自定义提供方/端点、压缩/CSP 安全头。 |
| `services/` | 路由器/评分/fusion、健康检查（调度、节奏、错误/日志/传输）、冷却探测、目录同步（调度器/来源）、密钥并发、限额学习、降级、嵌入/媒体/转写。 |
| `integration/` | `full-flow.test.ts` ——穿过组装完成的应用的请求生命周期。 |
| `helpers/` | 共享测试工具（`auth.ts`、`acl.ts`）。 |
| `fixtures/` | 黄金文件（如 `compression-golden.json`）。 |

## 串行 fork 执行

`npm run test -w server` 以 `vitest run --pool=forks --fileParallelism=false` 运行。两个刻意的选择：

- **`--pool=forks`** 把每个测试文件隔离在全新进程里。套件操纵真实状态——better-sqlite3 数据库、`process.env`、模块级缓存（冷却映射、健康调度器）——这些绝不能在文件之间泄漏。
- **`--fileParallelism=false`** 让文件串行执行，共享资源（端口、临时数据目录）就不会在并发执行的文件之间相撞。

代价是挂钟时间；回报是约 2300 个测试的套件是确定性的。client 工作区不需要这些：它的[独立 vitest 配置](../../../../../client/vitest.config.ts)主要是为了避免加载 React/Tailwind 的 vite 插件，其测试就是默认 node 环境里的普通 TypeScript。

## 纯库导入守卫（#858）

[`src/__tests__/lib/module-purity.test.ts`](../../../../../server/src/__tests__/lib/module-purity.test.ts) 强制一条架构不变量：在 [`server/src/lib/`](../../../../../server/src/lib/) 中被声明为纯的模块（只对其参数做函数运算——无 I/O、无数据库、无配置）必须保持没有**值**导入。`import type` 依然合法，因为类型导入会在制造循环之前就被擦除。

它存在的理由：像 `error-classify.ts` 这样的纯叶子模块之所以同时被代理聊天路径、responses 路径和 fusion 面板导入，正是因为它们不依赖任何东西。加一句 `import { getDb }` 能干净地编译、通过每一个行为测试，然后悄悄把一片叶子变成一个枢纽——日后以导入循环（fusion↔proxy 案例）或某个突然需要数据库的单元测试的形式浮出水面。守卫还能识别动态导入、再导出和 `require()`。

这份清单自我维护：任何新加入的无导入库模块都会让套件失败，直到它被归类为受守卫或有意不管——这个决策必须在 diff 里大声说出来，而不是靠沉默带过。

## 环回绑定约定（#888）

每个 route/integration 测试都这样启动服务器：

```ts
const server = app.listen(0, '127.0.0.1');
if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
```

两个细节，都是承重的（#888）：

1. **显式绑定到 `127.0.0.1`。** 较老的 `app.listen(0)` 绑定的是 IPv6 通配地址 `::`，而测试却经 IPv4 请求 `http://127.0.0.1:PORT`。地址不一致意味着：某个持有同 ephemeral 端口 IPv4 监听的无关本地进程会赢得连接而不触发 `EADDRINUSE`——请求被那个进程应答了（观测到 `wrangler dev` 的 workerd 进程回复 404/501），造成随机的断言失败、JSON 解析损坏，以及大约每二到四次运行出现一次的 5 秒超时。
2. **读到 `listening` 事件之后再读 `address()`。** `listen(port, host)` 是异步解析主机名的（不同于 `listen(port)`），所以 `server.address().port` 只在该事件触发之后才可靠。

修复经过验证：在冲突进程仍在运行的那台机器上，连续十次完整套件运行全部干净通过。
