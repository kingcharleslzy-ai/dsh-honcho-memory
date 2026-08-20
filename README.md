# dsh-honcho-memory

DeepSeek Harness（DSH）的 Honcho v3 记忆适配器与共享知识库插件。

> [!IMPORTANT]
> 这个 npm 包**不是 Honcho 后端，也不会替你安装 Honcho**。使用前必须已有一个
> DSH 能访问的 Honcho v3 服务：使用 Honcho 官方托管服务，或自行部署官方开源
> Honcho。只有安装 DSH 插件、没有 Honcho API/数据库/后台 deriver，记忆不会工作。

更准确地说，**不是把 Honcho 安装进 DSH 的 `node_modules`**；Honcho 是独立运行的
后端服务，DSH 通过本插件访问它。使用官方托管服务时无需在本机部署；选择自托管时，
则需另外部署 Plastic Labs 官方 Honcho 服务栈。

## 它负责什么

```text
DSH ── dsh-honcho-memory ── Honcho v3 API
                                  │
                                  ├─ workspace / peers / sessions / messages
                                  ├─ conclusions / representations / peer cards
                                  ├─ context / search / dialectic
                                  └─ queue / dream
```

- 自动保存真实用户消息和模型可见回答；过滤思考链、工具噪声和系统注入。
- 每个 DSH 对话默认映射到独立 Honcho session。
- 每轮召回 session summary、用户模型、peer card、本地结论和共享知识。
- 提供七个 DSH 工具：`memory_store`、`memory_search`、`memory_context`、
  `memory_reason`、`memory_profile`、`memory_dream`、`memory_status`。
- 保留方向性视角，例如 `deepseek -> user`；不会把不同助手伪装成同一个 peer。
- 使用 `shared-knowledge -> user/shared-knowledge` 作为可选的 canonical 共享层。
- 相似结论只在读取时去重；整理工具默认 dry-run，不会静默删除后端数据。

本插件使用 Honcho 官方 v3 HTTP API，但不是 Plastic Labs 官方发布的 DSH 集成。
Codex、Hermes 等其他客户端的安装与配置也不由本插件完成。

## 前置条件：先准备 Honcho

二选一。

### 方案 A：Honcho 官方托管服务

在 [Honcho](https://app.honcho.dev/) 创建 API key，然后配置：

```yaml
baseUrl: https://api.honcho.dev
apiKey: YOUR_HONCHO_API_KEY
```

### 方案 B：自托管官方 Honcho

按 [Plastic Labs 官方仓库](https://github.com/plastic-labs/honcho) 的 Docker
方式部署。以下只是官方流程的摘要，实际变量以 Honcho 当前文档为准：

```bash
git clone https://github.com/plastic-labs/honcho.git
cd honcho
cp docker-compose.yml.example docker-compose.yml
cp .env.template .env
# 编辑 .env，配置 Honcho 所需的模型/API key
docker compose up -d --build
curl http://127.0.0.1:8000/health
```

健康检查应返回 `{"status":"ok"}`。完整服务不仅包含 API，还需要数据库、Redis
和 deriver；deriver 负责异步生成 conclusions、summary、representation、peer card
以及 dream 结果。仅有一个返回 200 的空代理并不等于完整可用。

如果 Honcho 在另一台机器上，请确保 DSH 进程能访问该地址，并使用 HTTPS、VPN
或 SSH 隧道保护网络链路。不要把未鉴权的 Honcho 端口直接暴露到公网。

## 安装 DSH 插件

```bash
dsh plugin --profile web add dsh-honcho-memory
```

然后在对应 DSH profile 的 `cordis.patch.yml` 中覆盖配置。示例：

```yaml
- id: honcho-memory
  name: dsh-honcho-memory
  config:
    baseUrl: http://127.0.0.1:8000
    apiKey: ''
    workspace: dsh
    userPeer: user
    aiPeer: deepseek
    sessionId: ''
    sessionPrefix: dsh
    autoCapture: true
    captureSubagents: false
    autoContext: true
    contextMaxChars: 4000
    contextTokens: 1600
    contextFetchTimeoutMs: 8000
    searchScope: workspace
    includeConclusions: true
    maxConclusions: 10
    dialecticReasoningLevel: low
    messageMaxChars: 24000
```

重启 DSH 后，在对话中调用 `memory_status({"check":"health"})`。`check` 是必填字段，
用于保证 DSH Code Mode 始终传递 JSON 参数对象。至少确认：

- `Honcho API：可用`；
- workspace、userPeer、aiPeer 与你的配置一致；
- queue 最终从 pending/in-progress 进入 completed；
- 新对话能够用 `memory_store` 写入并被 `memory_search` 找回。

## 默认值

0.5.2 起默认值不包含维护者身份或机器配置：

| 配置 | 默认值 |
|---|---|
| `baseUrl` | `http://127.0.0.1:8000` |
| `workspace` | `dsh` |
| `userPeer` | `user` |
| `aiPeer` | `deepseek` |
| `knowledgePeer` | `shared-knowledge` |
| `knowledgeSessionId` | `shared-knowledge` |

### 从 0.5.1 或更早版本升级

旧版本曾错误地携带维护者环境的非通用默认值。如果你以前没有在 profile 中显式写
`baseUrl`、`workspace` 和 `userPeer`，升级前必须先确认旧数据实际所在的位置，并把这
三个值写进自己的 `cordis.patch.yml`。0.5.2 不会迁移、重命名或删除已有 Honcho 数据；
只有继续使用相同 backend、workspace 和 peer ID，才会召回原有记忆。

如果你已有其他 Honcho 集成，可以让它们指向同一 backend/workspace，但每个助手应使用
不同的 `aiPeer`。跨客户端共享不会自动配置；其他客户端也必须自行安装各自的 Honcho
集成，并遵守相同的 canonical peer 约定。

## 数据与隐私

- 插件会把启用范围内的 DSH 对话发送到你配置的 `baseUrl`。
- 插件本身不包含维护者账号、服务器地址或用户身份默认值，也不提供遥测服务。
- Honcho 后端可能把内容发送给其配置的 embedding、summary、deriver 或 dialectic
  模型提供商；隐私边界取决于你自己的 Honcho 部署和模型配置。
- `memory_dream` 可能消耗后端 LLM 资源，必须明确 `confirm=true`。

## 兼容性边界

- 目标 API：Honcho v3。
- Node.js：20 或更高版本。
- 安装包内置零运行时依赖的 `dsh-honcho-memory-core`，不需要再单独安装 core。
- 已验证官方 Honcho 的 message、deriver、conclusion、context、search、dialectic 和
  queue 流程；不同 Honcho/DSH 版本组合仍应先做 `memory_status` 和小规模写入测试。
- 没有任何插件能保证对未来所有 DSH 或 Honcho 版本“完美兼容”；本项目通过契约测试
  和真实后端 smoke test 降低升级风险。

## 开发与验证

```bash
npm install
npm test
npm run audit:public
npm run smoke          # 需要可用的 Honcho；可用 HONCHO_* 环境变量覆盖配置
npm run smoke:dsh      # 通过 DSH adapter 做临时写入/读取并清理
npm run tidy:messages  # 只生成旧垃圾消息的备份与 dry-run 清单；不会自动删除
```

更多资料：

- [架构与数据模型](docs/architecture.md)
- [运行、健康检查与回滚](docs/operations.md)
- [Honcho 官方仓库](https://github.com/plastic-labs/honcho)
- [Honcho 官方 MCP](https://github.com/plastic-labs/honcho/tree/main/mcp)

## License

MIT
