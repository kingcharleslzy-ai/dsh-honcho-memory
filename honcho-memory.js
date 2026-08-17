// dsh-honcho-memory — DSH agent tool plugin: long-term memory over a
// self-hosted Honcho v3 REST backend.
//
// Three capabilities:
//   1. memory_store  -> session.add_messages() -> POST /v3/workspaces/{ws}/sessions/{sid}/messages
//   2. memory_search -> session/workspace search -> POST /v3/workspaces/{ws}/sessions/{sid}/search
//   3. 会话开始自动注入：每个新 agent 创建时异步检索最近记忆，经
//      agent.ctx.systemPrompt.context 注册动态上下文，之后每次组装按需求值。
//
// v0.3.0 改进（记忆噪音治理）：
//   - 搜索默认限定在本插件的 session（searchScope: 'session'），不再把
//     workspace 里其他助手（Hermes 等）的原始聊天记录搜进上下文；
//   - 自动注入时合并 honcho 自动整理产物 conclusions（list 最新 N 条），
//     记忆分层：先结论（整理后）后消息（事实记录）；
//   - isJunk 过滤：琐碎应声（好的/继续/OK…）、<prior_memory_file> 导入残留、
//     纯符号、超长块；按内容规范化去重（不只按 message id）；
//   - memory_store 写入前防呆：拒绝琐碎内容，超长内容拒绝并提示精简。
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
//       searchScope: session        // 'session'（默认，只搜本会话记忆链）| 'workspace'
//       includeConclusions: true    // 注入时是否合并 honcho conclusions
//       maxConclusions: 6           // 合并的结论条数上限
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
  searchScope: z.string(),
  includeConclusions: z.boolean(),
  maxConclusions: z.number(),
})

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8001',
  workspace: 'hermes',
  aiPeer: 'deepseek',
  sessionId: 'dsh',
  autoContext: true,
  contextMaxChars: 1500,
  searchScope: 'session',
  includeConclusions: true,
  maxConclusions: 6,
}

// 会话开始自动检索的三组语义查询（各取 top5 后合并去重）
const CONTEXT_QUERIES = [
  'active task 进行中 未完成的任务',
  '用户偏好 约定 习惯 规则',
  '最近决定 教训 bug 坑',
]
const CONTEXT_MAX_ITEMS = 8
const CONTEXT_FETCH_TIMEOUT_MS = 8000

// ---------------------------------------------------------------------------
// 垃圾过滤与去重
// ---------------------------------------------------------------------------

// 琐碎应声/指令：短且无信息量。长度 <= 12 且完全匹配模式才判定为垃圾，
// 避免误伤 "继续分析"、"好的 开始吧" 这类仍有上下文意义的短句。
const TRIVIAL_RE = /^(好的?|好|嗯|哦|噢|嗯嗯|昂|ok|okay|收到|可以|对|是|是的|没错|继续|继续吧|接着来|重启了|重启|配置成功|搞定|明白|知道了|知道|谢谢|谢了|多谢|不错|哈哈|呵呵|在吗|你好|你好 你能收到吗|你能收到吗|能看到吗|就这样|没问题|可以吧|好了|赞|nice|yes|no|y|n|1|2|3|test|测试)$/i
const SYMBOL_ONLY_RE = /^[\s\p{P}\p{S}…。，！？!?~～、·•]+$/u

function isJunk(content) {
  const c = String(content ?? '').trim()
  if (!c) return true
  if (c.startsWith('<prior_memory_file')) return true // 导入残留（各会话重复）
  if (SYMBOL_ONLY_RE.test(c)) return true
  if (c.length <= 12 && TRIVIAL_RE.test(c)) return true
  if (c.length > 4000) return true // 超长块：多为整段聊天/导入残留，不适合当记忆
  return false
}

/** 内容规范化 key：折叠空白、去大小写，用于跨会话去重。 */
function normKey(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 按内容去重（同内容只留最新一条），保留传入顺序。 */
function dedupeByContent(items) {
  const seen = new Map()
  const out = []
  for (const m of items) {
    const k = normKey(m.content)
    if (seen.has(k)) continue
    seen.set(k, true)
    out.push(m)
  }
  return out
}

// ---------------------------------------------------------------------------
// Honcho REST
// ---------------------------------------------------------------------------

function resolveConfig(config) {
  return {
    baseUrl: config?.baseUrl || DEFAULTS.baseUrl,
    workspace: config?.workspace || DEFAULTS.workspace,
    aiPeer: config?.aiPeer || DEFAULTS.aiPeer,
    sessionId: config?.sessionId || DEFAULTS.sessionId,
    autoContext: config?.autoContext ?? DEFAULTS.autoContext,
    contextMaxChars: config?.contextMaxChars || DEFAULTS.contextMaxChars,
    searchScope: config?.searchScope === 'workspace' ? 'workspace' : 'session',
    includeConclusions: config?.includeConclusions ?? DEFAULTS.includeConclusions,
    maxConclusions: Number.isInteger(config?.maxConclusions) && config.maxConclusions > 0
      ? Math.min(config.maxConclusions, 20)
      : DEFAULTS.maxConclusions,
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

/** session 级语义搜索：只搜本插件维护的记忆链。 */
async function searchSession(cfg, query, limit, signal) {
  const items = await call(cfg, 'POST', `/v3/workspaces/${cfg.workspace}/sessions/${cfg.sessionId}/search`, { query, limit }, signal)
  return Array.isArray(items) ? items : []
}

/** workspace 级语义搜索：跨会话（含其他助手原始聊天记录，噪音多）。 */
async function searchWorkspace(cfg, query, limit, signal) {
  const items = await call(cfg, 'POST', `/v3/workspaces/${cfg.workspace}/search`, { query, limit }, signal)
  return Array.isArray(items) ? items : []
}

/** honcho 自动整理产物：workspace 内全部 conclusions（按时间倒序取最新）。 */
async function listConclusions(cfg, limit, signal) {
  const data = await call(cfg, 'POST', `/v3/workspaces/${cfg.workspace}/conclusions/list`, {}, signal)
  const items = Array.isArray(data?.items) ? data.items : []
  return items
    .filter((c) => c && !isJunk(c.content))
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, limit)
}

async function searchMemory(cfg, query, limit, signal) {
  return cfg.searchScope === 'workspace'
    ? searchWorkspace(cfg, query, limit, signal)
    : searchSession(cfg, query, limit, signal)
}

/** 关键词评分：内容命中查询词越多越相关（用于对 conclusions 排序）。 */
function scoreByQueries(content, queries) {
  const c = normKey(content)
  let score = 0
  for (const q of queries) {
    for (const token of q.split(/[\s,，、]+/)) {
      const t = normKey(token)
      if (t.length >= 2 && c.includes(t)) score += 1
    }
  }
  return score
}

/**
 * 把检索到的记忆渲染成注入文本；超长截断。
 * items 支持两种来源：conclusion（honcho 整理产物）与 message（会话内消息）。
 */
function renderContext(items, maxChars) {
  const picked = dedupeByContent(items)
    .filter((m) => !isJunk(m.content))
    .slice(0, CONTEXT_MAX_ITEMS)
  if (picked.length === 0) return ''
  const lines = picked.map((m) => {
    const when = String(m.created_at ?? '').slice(0, 10)
    const isConclusion = m.kind === 'conclusion'
    const author = isConclusion
      ? '结论'
      : m.peer_id === 'Charles' ? '你' : m.peer_id
    const prefix = isConclusion ? '💡' : '·'
    return `- ${prefix} [${when} · ${author}] ${String(m.content).trim()}`
  })
  let text = '# 长期记忆（honcho）\n' + lines.join('\n') + '\n\n以上为 honcho 自动整理的结论与本会话记忆链（已过滤琐碎/重复）；需要更多细节可用 memory_search 查询。'
  if (text.length > maxChars) text = text.slice(0, maxChars - 2) + '…'
  return text
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  ctx.tools.register({
    name: 'memory_store',
    description: '把一条记忆写入 honcho 记忆库。触发时机：做出决定、修复 bug、用户约定偏好、任务进度变化时立即记录。content 用一条自包含的短句，含关键事实。琐碎应声（好的/继续 等）会被拒绝，无需存储。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要存的记忆内容（自包含短句，含关键事实，建议 ≤ 1500 字符）' },
      },
      required: ['content'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' }, reason: { type: 'string' } },
        required: ['ok'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `已存入记忆（id: ${value.id ?? '未知'}）`
          : `记忆写入被拒绝：${value.reason ?? '未知原因'}`,
      }],
    },
    execute: async (args, exec) => {
      const content = String(args.content ?? '').trim()
      if (isJunk(content)) {
        return { ok: false, reason: '内容过于琐碎或为导入残留，不值得长期记忆' }
      }
      if (content.length > 2000) {
        return { ok: false, reason: `内容过长（${content.length} 字符），请精简为自包含短句（≤ 2000）` }
      }
      const messages = await call(cfg, 'POST', `/v3/workspaces/${cfg.workspace}/sessions/${cfg.sessionId}/messages`, {
        messages: [{ content, peer_id: cfg.aiPeer }],
      }, exec?.signal)
      const first = Array.isArray(messages) ? messages[0] : messages?.messages?.[0]
      return { ok: true, id: first?.id ?? null }
    },
    timeoutMs: 30000,
  })

  ctx.tools.register({
    name: 'memory_search',
    description: '在 honcho 记忆库里语义搜索（默认只搜本会话记忆链，可用 scope=workspace 跨会话搜索）。触发时机：开始任务前搜索相关记忆；遇到报错或功能异常时搜索已记录的经验；给子代理分配任务前搜索策略。琐碎/重复结果会自动过滤。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或问题' },
        limit: { type: 'integer', description: '返回条数上限，默认 5' },
        scope: { type: 'string', enum: ['session', 'workspace'], description: '搜索范围：session（默认，只搜本插件记忆链）或 workspace（跨会话，噪音多）' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => {
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 5
      const scope = args.scope === 'workspace' ? 'workspace' : cfg.searchScope
      const items = await (scope === 'workspace'
        ? searchWorkspace(cfg, args.query, limit * 2, exec?.signal)
        : searchSession(cfg, args.query, limit * 2, exec?.signal))
      const clean = dedupeByContent(items).filter((m) => !isJunk(m.content)).slice(0, limit)
      if (clean.length === 0) return '没有找到相关记忆（检索到 ' + items.length + ' 条，但均为琐碎/重复内容，已过滤）。'
      const lines = clean.map((m, i) => `${i + 1}. [${m.peer_id} · ${String(m.created_at ?? '').slice(0, 16)}] ${m.content}`)
      return `找到 ${clean.length} 条相关记忆（已过滤 ${items.length - clean.length} 条琐碎/重复）：\n` + lines.join('\n')
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
      void (async () => {
        const batches = await Promise.all([
          ...CONTEXT_QUERIES.map((q) => searchMemory(cfg, q, 5, signal).catch(() => [])),
          cfg.includeConclusions
            ? listConclusions(cfg, cfg.maxConclusions, signal).catch(() => [])
            : Promise.resolve([]),
        ])
        const messages = batches.slice(0, CONTEXT_QUERIES.length).flat()
          .map((m) => ({ ...m, kind: 'message' }))
        const conclusions = batches[CONTEXT_QUERIES.length].map((c) => ({ ...c, kind: 'conclusion' }))
        // 结论按关键词相关性排序（结合三组查询词），再按时间倒序兜底
        conclusions.sort((a, b) => {
          const sa = scoreByQueries(a.content, CONTEXT_QUERIES)
          const sb = scoreByQueries(b.content, CONTEXT_QUERIES)
          if (sa !== sb) return sb - sa
          return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
        })
        memoryText = renderContext([...conclusions, ...messages], cfg.contextMaxChars)
      })().catch(() => {
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
