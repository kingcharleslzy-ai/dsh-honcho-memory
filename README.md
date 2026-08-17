# dsh-honcho-memory

DeepSeek Harness（DSH）的 Honcho v3 长期记忆插件。普通对话会自动写入 Honcho；每一轮模型请求前，插件会按当前问题取回 session summary、用户画像、peer card 和相关 conclusions，并通过 DSH 的动态 runtime context 注入。

这版结构参考了 Honcho 的官方 SDK/API 设计与 Hermes 的第一方 Honcho provider：

- [Honcho 官方仓库与 v3 文档](https://github.com/plastic-labs/honcho)
- [Honcho 官方 TypeScript SDK](https://github.com/plastic-labs/honcho/tree/main/sdks/typescript)
- [Honcho 官方 MCP Server](https://github.com/plastic-labs/honcho/tree/main/mcp)
- [Hermes 官方 Honcho provider](https://github.com/NousResearch/hermes-agent/tree/main/plugins/memory/honcho)

## 主要能力

- **自动双向写入**：只保存真实用户消息和模型可见回答；插件上下文、工具结果、思考链不会误写。
- **会话隔离**：默认每个 DSH 会话映射为独立的 `dsh-<session-id>` Honcho session。
- **双 peer 观察**：默认 `Charles`（用户）与 `deepseek`（助手）；助手观察用户并形成专属 representation。
- **首轮可用的自动召回**：在 DSH 的 `system-prompt/assemble` 阶段等待有上限的 Honcho 请求，避免异步结果赶不上当前轮。
- **共享记忆冷启动**：若 `deepseek -> Charles` 画像尚未形成，会退回 Honcho 的 omniscient user representation，因此可利用同 workspace 中已有的用户知识。
- **可诊断**：失败会写入 DSH 日志，`memory_status` 会显示队列、自动写入数、上下文加载数和最近错误。

## 工具

| 工具 | 用途 |
|---|---|
| `memory_store` | 直接创建持久 conclusion；普通聊天无需手工重复保存 |
| `memory_search` | 合并搜索 AI 视角 conclusions 与原始消息 |
| `memory_context` | 获取 summary、representation、peer card、相关 conclusions |
| `memory_reason` | 调用 Honcho dialectic 做跨会话综合推理 |
| `memory_status` | 检查后端、当前 session 队列和插件运行状态 |

## 安装

```bash
dsh plugin --profile web add dsh-honcho-memory
```

安装或升级后重启 DSH 服务，让运行中的 profile 加载新包。

## 默认配置

```yaml
- id: honcho-memory
  name: dsh-honcho-memory
  config:
    baseUrl: http://127.0.0.1:8001
    apiKey: ''
    workspace: hermes
    userPeer: Charles
    aiPeer: deepseek
    sessionId: ''              # 空 = 每个 DSH 会话独立；非空 = 固定共享 session
    sessionPrefix: dsh
    autoCapture: true
    captureSubagents: false
    autoContext: true
    contextMaxChars: 3000
    contextTokens: 1400
    contextFetchTimeoutMs: 6000
    searchScope: workspace      # workspace | session
    includeConclusions: true
    maxConclusions: 10
    dialecticReasoningLevel: low
    messageMaxChars: 24000
```

本机或关闭鉴权的自建 Honcho 不需要 `apiKey`。Honcho Cloud 或启用 Bearer 鉴权的实例可在 profile 配置中填写。

## 0.3.x 升级说明

0.3.x 把所有记忆写入固定 session `dsh`，而且只保存模型主动调用 `memory_store` 的内容。0.4.0 默认改为：

1. 每个 DSH 会话独立；
2. 用户和助手消息自动写入；
3. `memory_store` 直接写 conclusion，不再伪装成助手聊天消息；
4. 召回按 `deepseek -> Charles` 视角工作。

旧 `dsh` session 不会被删除。若必须维持旧行为，可显式配置 `sessionId: dsh`；更推荐保留新默认，让旧数据作为历史留存。

## 开发与验证

```bash
npm test
npm run smoke
```

`npm run smoke` 默认连接 `http://127.0.0.1:8001` 的 `hermes` workspace，创建临时 session，验证消息、conclusion、语义检索、context、dialectic 和 queue API，然后删除测试数据。可用 `HONCHO_BASE_URL`、`HONCHO_API_KEY`、`HONCHO_WORKSPACE`、`HONCHO_USER_PEER`、`HONCHO_AI_PEER` 覆盖。

## DeepSeek 后端注意事项

DeepSeek V4 默认开启 thinking。对 Honcho deriver 这类结构化事实提取，长或重复批次可能把输出预算全部耗在 `reasoning_content`，导致最终 JSON 为空。自建 Honcho 使用 DeepSeek 时，建议：

- `structured_output_mode = "json_object"`
- 在 deriver 的 provider `extra_body` 中设置 `thinking.type = "disabled"`
- 设置较短的 age flush，避免短会话长期停留在 pending

相关上游资料：

- [DeepSeek Thinking Mode 官方说明](https://api-docs.deepseek.com/guides/thinking_mode)
- [Honcho #716：OpenAI-compatible reasoning models 产生零 observations](https://github.com/plastic-labs/honcho/issues/716)

## License

MIT
