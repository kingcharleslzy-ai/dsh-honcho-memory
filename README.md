# dsh-honcho-memory

DSH（DeepSeek Harness）插件：把自建 Honcho v3 后端接成 DSH 的长期记忆。注册两个工具：

- **memory_store** — 写入一条记忆（对应官方 honcho SDK 的 `session.add_messages()`）
- **memory_search** — 语义搜索记忆（对应 workspace 级 `search`）

无 API key、无第三方运行时：插件直接 fetch Honcho 的 REST API，会话在首次写入时自动创建。数据仍在你的 Honcho 实例上（本机隧道、内网或公网均可）。

## 安装

```bash
dsh plugin --profile web add dsh-honcho-memory
```

装完新会话即生效（运行中的服务重启一次后加载新包）。

## 配置

默认值：`baseUrl: http://127.0.0.1:8001`、`workspace: hermes`、`aiPeer: deepseek`、`sessionId: dsh`。

在你的 profile `cordis.patch.yml` 里按 id 覆盖整行 config：

```yaml
- id: honcho-memory
  name: dsh-honcho-memory
  config:
    baseUrl: http://192.168.1.10:8001
    workspace: my-workspace
    aiPeer: my-agent
    sessionId: my-session
```

`aiPeer` 即记忆作者身份：多个 AI 共用同一 `aiPeer` 即共享同一记忆链（同链共享），各自使用不同 `aiPeer` 则同库分链。

## License

MIT
