# dsh-honcho-memory

DSH（DeepSeek Harness）插件：把自建 Honcho v3 后端接成 DSH 的长期记忆。

三个能力：

- **memory_store** — 写入一条记忆（对应官方 honcho SDK 的 `session.add_messages()`；琐碎内容会被拒绝）
- **memory_search** — 语义搜索记忆（默认 session 级，可选 workspace 级）
- **会话开始自动注入** — 每个新 agent 创建时异步检索最近记忆（活跃任务 / 用户偏好 / 最近决定与教训三组查询 + honcho 自动整理的 conclusions），经 `agent.ctx.systemPrompt.context` 注册为动态上下文，每次组装按需求值；后端不可达时静默降级为空

无 API key、无第三方运行时：插件直接 fetch Honcho 的 REST API，会话在首次写入时自动创建。数据仍在你的 Honcho 实例上（本机隧道、内网或公网均可）。

## v0.3.0：记忆噪音治理

旧版本用 **workspace 级搜索**，会把 workspace 里其他助手（如 Hermes）各会话的**原始聊天记录**（"好的"、"继续"、"OK" 等琐碎应声、重复导入的 `<prior_memory_file>` 大块）一并搜进上下文，浪费 token 且干扰模型。0.3.0 的改进：

1. **搜索默认限定本插件的 session**（`searchScope: session`），只搜自己维护的记忆链；需要跨会话时用 `scope=workspace` 显式指定。
2. **合并 honcho 自动整理产物 conclusions**：honcho 后端的 dream 机制会把原始消息归纳成结论（观察者视角），注入时先展示结论（整理后）、再展示消息（事实记录），实现记忆分层。
3. **垃圾过滤 + 内容去重**：琐碎应声、`<prior_memory_file>` 导入残留、纯符号、超长块一律过滤；按内容规范化去重（不只按 message id）。
4. **写入防呆**：`memory_store` 拒绝琐碎内容与超长内容。

## 安装

```bash
dsh plugin --profile web add dsh-honcho-memory
```

装完新会话即生效（运行中的服务重启一次后加载新包）。

## 配置

默认值：`baseUrl: http://127.0.0.1:8001`、`workspace: hermes`、`aiPeer: deepseek`、`sessionId: dsh`、`autoContext: true`、`contextMaxChars: 1500`、`searchScope: session`、`includeConclusions: true`、`maxConclusions: 6`。

在你的 profile `cordis.patch.yml` 里按 id 覆盖整行 config：

```yaml
- id: honcho-memory
  name: dsh-honcho-memory
  config:
    baseUrl: http://192.168.1.10:8001
    workspace: my-workspace
    aiPeer: my-agent
    sessionId: my-session
    autoContext: true
    contextMaxChars: 2000
    searchScope: session      # session（默认）| workspace
    includeConclusions: true  # 注入时合并 honcho conclusions
    maxConclusions: 6         # 合并的结论条数上限
```

`aiPeer` 即记忆作者身份：多个 AI 共用同一 `aiPeer` 即共享同一记忆链（同链共享），各自使用不同 `aiPeer` 则同库分链。

## License

MIT
