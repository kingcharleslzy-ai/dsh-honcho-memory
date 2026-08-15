// dsh-honcho-memory — DSH agent tool plugin: long-term memory over a
// self-hosted Honcho v3 REST backend.
//
// Three capabilities:
//   1. memory_store  -> session.add_messages() -> POST /v3/workspaces/{ws}/sessions/{sid}/messages
//   2. memory_search -> workspace search       -> POST /v3/workspaces/{ws}/search
//   3. 会话开始自动注入：每个新 agent 创建时异步检索最近记忆，经
//      agent.ctx.systemPrompt.context 注册动态上下文，之后每次组装按需求值。
//
// The backend auto-creates the session on first write. No API key is sent.
//
// Configure through the loader row:
//   - id: honcho-memory
//     name: dsh-honcho-memory
//     config:
//       baseUrl: http://127.0.0.1:8001
//       workspace: hermes
//       aiPeer: deepseek
//       sessionId: dsh
//       autoContext: true
//       contextMaxChars: 1500
import z from '@deepseek-ai/schemastery'

export const name = 'honcho-memory'
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  baseUrl: z.string(),
  workspace: z.string(),
  aiPeer: z.string(),
  sessionId: z.string(),
  autoContext: z.boolean(),
  contextMaxChars: z.number(),
})

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8001',
  workspace: 'hermes',
  aiPeer: 'deepseek',
  sessionId: 'dsh',
  autoContext: true,
  contextMaxChars: 1500,
}

// 会话开始自动检索的三组语义查询（各取 top5 后合并去重）
const CONTEXT_QUERIES = [
  'active task 进行中 未完成的任务',
  '用户偏好 约定 习惯 规则',
  '最近决定 教训 bug 坑',
]
const CONTEXT_MAX_ITEMS = 8
const CONTEXT_FETCH_TIMEOUT_MS = 8000

function resolveConfig(config) {
  return {
    baseUrl: config?.baseUrl || DEFAULTS.baseUrl,
    workspace: config?.workspace || DEFAULTS.workspace,
    aiPeer: config?.aiPeer || DEFAULTS.aiPeer,
    sessionId: config?.sessionId || DEFAULTS.sessionId,
    autoContext: config?.autoContext ?? DEFAULTS.autoContext,
    contextMaxChars: config?.contextMaxChars || DEFAULTS.contextMaxChars,
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

async function searchMemory(cfg, query, limit, signal) {
  const items = await call(cfg, 'POST', `/v3/workspaces/${cfg.workspace}/search`, { query, limit }, signal)
  return Array.isArray(items) ? items : []
}

/** 把检索到的记忆渲染成注入文本；超长截断。 */
function renderContext(items, maxChars) {
  const seen = new Set()
  const picked = []
  for (const m of items) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    picked.push(m)
    if (picked.length >= CONTEXT_MAX_ITEMS) break
  }
  if (picked.length === 0) return ''
  const lines = picked.map((m) => {
    const when = String(m.created_at ?? '').slice(0, 10)
    const author = m.peer_id === 'Charles' ? '你' : m.peer_id
    return `- [${when} · ${author}] ${String(m.content).trim()}`
  })
  let text = '# 长期记忆（honcho）\n' + lines.join('\n') + '\n\n以上是本会话开始时自动检索的长期记忆；需要更多细节可用 memory_search 查询。'
  if (text.length > maxChars) text = text.slice(0, maxChars - 2) + '…'
  return text
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
      const items = await searchMemory(cfg, args.query, limit, exec?.signal)
      if (items.length === 0) return '没有找到相关记忆。'
      const lines = items.map((m, i) => `${i + 1}. [${m.peer_id} · ${String(m.created_at ?? '').slice(0, 16)}] ${m.content}`)
      return `找到 ${items.length} 条相关记忆：\n` + lines.join('\n')
    },
    timeoutMs: 30000,
  })

  if (!cfg.autoContext) return

  // 会话开始自动注入：每个新 agent 注册一个按组装求值的动态上下文。
  ctx.on('agent/created', ({ agent }) => {
    const agentCtx = agent?.ctx
    if (!agentCtx) return
    let memoryText = ''
    agentCtx.effect(() => {
      const disposeContext = agentCtx.systemPrompt.context({
        name: 'honcho-memory-context',
        order: 200,
        text: () => memoryText,
      })
      const controller = new AbortController()
      const signal = controller.signal
      const timeout = setTimeout(() => controller.abort(), CONTEXT_FETCH_TIMEOUT_MS)
      void Promise.all(CONTEXT_QUERIES.map((q) =>
        searchMemory(cfg, q, 5, signal).catch(() => [])
      )).then((batches) => {
        const merged = batches.flat()
        memoryText = renderContext(merged, cfg.contextMaxChars)
      }).catch(() => {
        memoryText = ''
      }).finally(() => clearTimeout(timeout))
      return () => {
        clearTimeout(timeout)
        controller.abort()
        disposeContext()
      }
    })
  })
}
