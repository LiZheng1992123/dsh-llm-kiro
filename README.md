# dsh-llm-kiro

[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/@lizheng1992123/dsh-llm-kiro)](https://www.npmjs.com/package/@lizheng1992123/dsh-llm-kiro)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

将 DeepSeek Harness 的 LLM 接缝（`ctx.llm`）路由到本机 **Kiro CLI** 的适配器插件（`@lizheng1992123/dsh-llm-kiro`），基于 kiro-cli 自带的 [`acp`](https://kiro.dev/docs/cli/acp/) 子命令（Agent Client Protocol，JSON-RPC 2.0 over stdio）。

它注册 `kiro` provider 路由，让 harness 的模型请求复用本机 `kiro-cli` 的登录态——**无需任何凭据或设置项**。模型目录从 kiro-cli 实时拉取。

## 特性

- **无配置接入**：完全复用本机 `kiro-cli` 登录态（IAM Identity Center / Builder ID），不需要 API key 或 settings 段。
- **零运行时依赖**：不依赖任何 agent SDK——ACP 客户端是纯 Node `child_process` + 手写 JSON-RPC（约 200 行），没有 postinstall，安装无需批准构建脚本。
- **长驻会话**：每个宿主 session id 对应一个 warm `kiro-cli acp` 子进程，对话延续、工具轮次都发生在会话内部；`maxSessions` 上限内按插入序 LRU 淘汰。
- **工具桥接**：宿主工具通过**每会话一个 loopback HTTP MCP server**（`dsh-host`）暴露给内层模型；模型调用到达 MCP server 后 park，宿主在下一轮请求里回传结果，按 callId 配对（120s 内未回传则超时取消）。
- **原生工具隔离**：kiro 以 `--trust-tools=`（零信任）启动，一切工具调用都经过 ACP `session/request_permission` 回调——只有 `@dsh-host` MCP 工具被放行，内层模型的原生工具（fs、bash 等）一律拒绝。
- **真实上下文占用**：kiro 在流中通过 `_kiro.dev/metadata` 上报 `contextUsagePercentage`，插件按模型窗口折算成 `inputTokens` 上报——UI 上下文环与自动压缩阈值用的是 **kiro 侧的真实占用**（含其 preset 开销），而不是字符估算；估算仅作未上报时的兜底。
- **模型目录**：`kiro-cli chat --list-models --format json` 实时拉取（含 `context_window_tokens`），TTL 缓存 + 并发共享 + 超时保护，失败回退静态目录。
- **思考档位**：每个模型广告 `low / medium / high / xhigh / max` 五档（kiro-cli `--effort`），选择后在会话重建时生效。
- **旁路请求**：标题生成、compaction 等 side-channel 请求走冷启动一次性 ACP 会话，不占用 warm 会话，且复用主会话模型。
- **代理自动接入**：`cliPath` 为默认值时自动探测已安装的 kiro-proxy 进程级代理包装器（`~/.local/bin/kiro-proxy`），插件派生的 kiro-cli 进程随之走代理，无需在宿主全局环境 export 任何代理变量。
- **溢出可恢复**：内层报错文本经 dsh-llm 的 `isContextWindowExceededError` / `isQuotaExceededError` 分类为 `CONTEXT_WINDOW_EXCEEDED` / `QUOTA_EXCEEDED` 上报，harness 的溢出自动恢复（配合 `compaction-basic`）可以接管。

## 适配原理

### 1. LLM 接缝适配（`ctx.llm` → kiro-cli）

| harness 接缝 | 本插件实现 |
| --- | --- |
| `providerInfo(provider)` | 返回 `kiro`（Kiro CLI）的展示名 |
| `listModels(provider)` | 实时拉取 kiro-cli 模型目录 |
| `resolveModel(provider, model)` | 从 live catalog / 静态表解析模型元数据（上下文窗口、思考档位、输出上限） |
| `stream(options)` | 把一次 `GenerateOptions` 转成 ACP `session/prompt` 并流式回传 `StreamChunk` |

`stream()` 的分流与 qoder 插件一致：warm 会话路径（有 `sessionId` 且无 `purpose`）复用内层 ACP 会话；side-channel 路径走 `coldStream()` 一次性调用。

### 2. 会话模型适配

- **一宿主会话对应一 warm kiro-cli ACP 会话**：`KiroSessionManager` 以宿主 `sessionId` 为键维护子进程，超出 `maxSessions` 按插入序 LRU 淘汰。
- **增量 feed**：kiro 服务端持有会话状态，宿主每轮只把新用户轮次与改写消息渲染成纯文本 prompt（`planContinuation` 与 qoder 插件同逻辑）；工具结果不进入文本 feed（走 MCP）。
- **重建检测**：宿主 surface 被改写（compaction 折叠历史等）导致消息数变少或结构变化时，`planContinuation` 返回 `rebuild: true`，插件 dispose 旧会话并按新 surface 冷启动，dsh 侧压缩与 kiro 内部状态不会产生双份状态。
- **模型/档位切换**：`--model` / `--effort` 是 kiro-cli acp 的**启动期参数**，切换时插件销毁旧子进程、以新参数冷启动并重喂宿主历史（文本级延续）。这是与 qoder 插件（运行期 `setModel`）的一个差异。

### 3. 工具桥接适配（HTTP MCP）

1. 每个内层会话启动前，插件在 `127.0.0.1` 随机端口起一个极简 streamable-HTTP MCP server（`dsh-host`），经 `session/new` 的 `mcpServers` 传入；
2. 宿主 `ToolSchema.parameters` 是 JSON Schema，**原样透传**为 MCP `inputSchema`（无需 zod 转换）；
3. 模型的工具调用以 HTTP `tools/call` 到达（参数完整携带），插件据此向宿主发出 `tool-call` 块并 park 响应；
4. **turn 结束时机（settle window）**：ACP 的 `session/prompt` 是一次长 RPC，模型被工具阻塞时没有任何"暂停"事件。插件在最后一次 MCP 调用后静默 400ms（窗口内并发的并行调用会并入同一轮），随后以 `tool-calls` 结束宿主轮次；
5. 宿主下一轮请求 `deliverToolResults()` 按 callId 解析 park 的 handler，kiro 继续该 prompt RPC——对 kiro 而言只是"MCP 工具执行了一次"；
6. 迟到的并行调用（落在两轮间隙）会被缓存到下一轮开头补发，避免 prompt RPC 卡死到 120s 超时。

### 4. 权限门控

kiro-cli 以 `--trust-tools=`（不信任任何工具）启动，所有工具调用都触发 `session/request_permission`：插件对 `_meta.kiro.mcpServerName === 'dsh-host'`（或标题含 `@dsh-host/`）的调用自动 allow，其余（内层模型的原生 fs/bash 等）自动 deny。内层模型只能经由宿主 MCP 工具行动。

### 5. 上下文占用计量

kiro 流中的 `_kiro.dev/metadata` 通知携带 `contextUsagePercentage`（以及 credit 计量 `meteringUsage`）。插件按 `resolveModel` 广告的同一窗口折算：

```ts
inputTokens = contextUsagePercentage / 100 × contextWindow
```

这比 qoder 插件的 chars/4 估算更准（包含 kiro preset 自身开销）。未上报时（如冷启动首帧之前）回退到 chars/4 估算，口径与 harness `estimate.ts` 一致。

### 6. 错误分类与压缩分工

与 qoder 插件一致：压缩由 dsh（compaction-basic）执行，插件只充当 LLM 后端；内层报错文本经共享分类器映射为 harness 可路由的错误码。dsh 压缩改写 surface 后，插件检测 `rebuild` 并重建内层会话，不存在"两边各压一遍"。

> **注意**：kiro-cli 自身也有内部 compaction。它以增量 feed 运行，内部压缩不影响 dsh 侧状态，但意味着超长会话中 kiro 可能遗忘 dsh 尚未压缩的早期细节。建议沿用 dsh 侧较低的 `thresholdRatio`（如 0.6），让 dsh 压缩先于 kiro 内部压缩触发。

## 安装

前置条件：本机已安装并登录 kiro-cli（`kiro-cli whoami` 可运行）。插件完全复用 kiro-cli 登录态，不需要 API key 或 settings 段。

> **运行环境要求**：kiro-cli ACP 的会话状态落库在 `~/Library/Application Support/kiro-cli/data.sqlite3`（macOS）。运行 dsh server 的环境必须对该目录可写，否则 `session/new` 会无声挂起（只读沙箱中已实证）。正常部署无此限制。

### 从发布包引入

```sh
pnpm pack   # 生成 lizheng1992123-dsh-llm-kiro-<version>.tgz
dsh plugin --profile <profile> add lizheng1992123-dsh-llm-kiro-<version>.tgz
dsh --profile <profile> --dump-config | grep llm-kiro   # 验证
```

无 postinstall、无构建脚本批准流程。重启服务后模型选择器出现 `kiro`。

### 手动挂载（可选）

```yaml
- id: llm-kiro
  name: '@lizheng1992123/dsh-llm-kiro'
```

## 配置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `maxSessions` | number | `8` | 同时保持 warm 的内层 kiro-cli 会话上限（超出按插入序 LRU 淘汰） |
| `modelCacheTtlSeconds` | number | `300` | CLI 模型目录的缓存保鲜秒数 |
| `cliPath` | string | `kiro-cli` | kiro-cli 可执行文件名或绝对路径。默认值会自动探测 kiro-proxy 包装器（见下节）；填真实 CLI 的绝对路径则强制直连 |

## 代理（kiro-proxy 自动探测）

插件通过 `spawn` / `execFile` 直接拉起 kiro-cli，不经过交互式 shell，因此 kiro-cli-proxy 项目注入 `~/.zshrc` 的 shell 函数对插件不生效。为此插件在 `cliPath` 保持默认值 `kiro-cli` 时按以下顺序解析实际启动的可执行文件：

1. `~/.local/bin/kiro-proxy`（kiro-cli-proxy 的标准安装位置，存在且可执行则优先）；
2. `PATH` 中的 `kiro-proxy`；
3. 都没有则回退到裸 `kiro-cli`（直连）。

探测到包装器时，插件 spawn 的每个 kiro-cli 进程（warm ACP 会话、模型目录拉取、side-channel 冷调用）都会经 `kiro-proxy` 注入 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，代理配置的唯一事实来源仍是 `~/.kiro/settings/cli-proxy.json`——`kiro-proxy --proxy-off` / `--proxy-set` / `--proxy-bypass-add` 对插件同样生效。插件启动时会打一条日志说明命中的解析结果。

注意两点：

- **绕过方式**：显式把 `cliPath` 设为真实 CLI 的绝对路径（如 `~/.local/bin/kiro-cli`）即跳过包装器、强制直连。
- **回环依赖 noProxy**：宿主工具经 `http://127.0.0.1:<port>` 的 loopback MCP server 桥接给内层模型，`cli-proxy.json` 的 `http.noProxy` 必须保留 `127.0.0.1` / `localhost`（默认即包含），否则工具桥会被代理掐断。
- warm 会话是长驻进程，代理变量只在 spawn 时注入；改完 `cli-proxy.json` 后新会话生效，旧会话随 LRU 淘汰或重建后更新。

## 上下文管理与压缩

与 qoder 插件相同的建议：加载 `dsh-compaction-basic` 与 `dsh-token-meter`，并把 `thresholdRatio` 调低到 0.6，让压力压缩远早于溢出触发：

```yaml
- id: compaction-basic
  config:
    auto: true
    thresholdRatio: 0.6
    retainRatio: 0.16
```

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：`ctx.llm.registerAdapter(['kiro'], adapter)` |
| `src/adapter.ts` | `KiroAdapter`：模型列表/解析/流式生成，warm 会话管理、续轮规划、side-channel 冷调用 |
| `src/session.ts` | `KiroSession`：ACP 子进程生命周期、turn 状态机、工具 park/resume、usage 上报（真实占用优先）、错误分类 |
| `src/acp.ts` | 极简 ACP JSON-RPC 2.0 stdio 客户端（跳过 stdout 混入的 Rust 日志行；应答 `session/request_permission`） |
| `src/mcpserver.ts` | 每会话 loopback streamable-HTTP MCP server（JSON Schema 原样透传） |
| `src/models.ts` | 实时模型目录拉取（TTL 缓存、并发共享、超时、静态回退） |
| `src/clipath.ts` | CLI 可执行文件解析：`kiro-proxy` 包装器自动探测与直连回退 |
| `src/catalog.ts` | 静态模型表（回退用） |
| `src/render.ts` | 宿主消息 → 内层纯文本 feed |
| `smoke.mjs` | 端到端冒烟测试（不依赖 harness，直接驱动 adapter） |

## 已知限制

- **模型/思考档位切换会重建内层会话**（kiro-cli 的 `--model` / `--effort` 是进程启动参数）；对话以宿主历史重喂，文本级延续。
- **kiro 会话在 CLI 侧持久化**：每次会话重建都会在 kiro-cli 的会话存储里留下一条记录，可用 `kiro-cli chat --list-sessions` / `--delete-session <id>` 清理。
- **图片消息**：宿主图片块目前在 feed 中渲染为 `[图片附件]` 占位符（kiro ACP 声明支持图像输入，透传留待后续版本）。
- **turn 结束依赖 400ms 静默窗口**（ACP 没有工具等待事件）；极端慢的并行工具调用风扇可能拆成两轮，功能不受影响。

## 开发与构建

```sh
pnpm install
pnpm test        # vitest 单元测试
pnpm run build   # tsc 产出 lib/types/*.d.ts，tsdown 产出 lib/index.js
node smoke.mjs   # 端到端冒烟测试（需要本机已登录 kiro-cli）
pnpm pack        # 生成 lizheng1992123-dsh-llm-kiro-<version>.tgz
```

## License

[MIT](LICENSE)
