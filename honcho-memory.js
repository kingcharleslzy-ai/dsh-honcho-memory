// dsh-honcho-memory — DSH agent tool plugin: long-term memory over a
// self-hosted Honcho v3 REST backend.
//
// Two tools, one per canonical Honcho operation (mirroring the official
// honcho SDK 2.2.0 calls):
//   memory_store  -> session.add_messages() -> POST /v3/workspaces/{ws}/sessions/{sid}/messages
//   memory_search -> workspace search       -> POST /v3/workspaces/{ws}/search
//
// The backend auto-creates the session on first write. No API key is sent:
// point baseUrl at whatever address your Honcho instance listens on
// (a local tunnel, a LAN host, or a public URL with a reverse proxy).
//
// Configure through the loader row:
//   - id: honcho-memory
//     name: dsh-honcho-memory
//     config:
//       baseUrl: http://127.0.0.1:8001
//       workspace: hermes
//       aiPeer: deepseek
//       sessionId: dsh
import z from '@deepseek-ai/schemastery'

export const name = 'honcho-memory'
export const inject = ['tools']

export const Config = z.object({
  baseUrl: z.string(),
  workspace: z.string(),
  aiPeer: z.string(),
  sessionId: z.string(),
})

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8001',
  workspace: 'hermes',
  aiPeer: 'deepseek',
  sessionId: 'dsh',
}

function resolveConfig(config) {
  return {
    baseUrl: config?.baseUrl || DEFAULTS.baseUrl,
    workspace: config?.workspace || DEFAULTS.workspace,
    aiPeer: config?.aiPeer || DEFAULTS.aiPeer,
    sessionId: config?.sessionId || DEFAULTS.sessionId,
  }
}

async function call(cfg, method, path, body, signal) {
  const res = await fetch(cfg.baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    const detail = data && typeof data === 'object' && data.detail !== undefined
      ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))
      : res.status + ' ' + res.statusText
    throw new Error(`honcho ${method} ${path} failed (${res.status}): ${detail}`)
  }
  return data
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  ctx.tools.register({
    name: 'memory_store',
    description: '把一条记忆写入 honcho 记忆库。触发时机：做出决定、修复 bug、用户约定偏好、任务进度变化时立即记录。content 用一条自包含的短句，含关键事实。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要存的记忆内容（自包含单句，含关键事实）' },
      },
      required: ['content'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' } }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: value.ok ? `已存入记忆（id: ${value.id ?? '未知'}）` : '记忆写入失败' }],
    },
    execute: async (args, exec) => {
      const messages = await call(cfg, 'POST', `/v3/workspaces/${cfg.workspace}/sessions/${cfg.sessionId}/messages`, {
        messages: [{ content: args.content, peer_id: cfg.aiPeer }],
      }, exec?.signal)
      const first = Array.isArray(messages) ? messages[0] : messages?.messages?.[0]
      return { ok: true, id: first?.id ?? null }
    },
    timeoutMs: 30000,
  })

  ctx.tools.register({
    name: 'memory_search',
    description: '在 honcho 记忆库里语义搜索。触发时机：开始任务前搜索相关记忆；遇到报错或功能异常时搜索已记录的经验；给子代理分配任务前搜索策略。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或问题' },
        limit: { type: 'integer', description: '返回条数上限，默认 5' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => {
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 5
      const items = await call(cfg, 'POST', `/v3/workspaces/${cfg.workspace}/search`, { query: args.query, limit }, exec?.signal)
      if (!Array.isArray(items) || items.length === 0) return '没有找到相关记忆。'
      const lines = items.map((m, i) => `${i + 1}. [${m.peer_id} · ${String(m.created_at ?? '').slice(0, 16)}] ${m.content}`)
      return `找到 ${items.length} 条相关记忆：\n` + lines.join('\n')
    },
    timeoutMs: 30000,
  })
}
