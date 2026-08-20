// dsh-honcho-memory — a thin DeepSeek Harness adapter over the shared core.
//
// Honcho remains the memory/knowledge engine. This file only translates DSH
// lifecycle events and tools into the host-neutral core API.
import z from '@deepseek-ai/schemastery'
import {
  HonchoClient,
  REASONING_LEVELS,
  clampInteger,
  chunkContent,
  createMemoryEngine,
  dedupeBySimilarity,
  formatSearchResults,
  isMemoryJunk,
  renderMemoryContext,
  resolveMemoryConfig,
  sessionIdFor,
  timeoutSignal,
} from 'dsh-honcho-memory-core'

export const name = 'honcho-memory'
export const inject = ['tools', 'systemPrompt']

// Existing fields stay unchanged so upgrades from 0.4.x keep their profile.
// Shared-knowledge settings deliberately use safe core defaults in v0.5.0.
export const Config = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  workspace: z.string(),
  userPeer: z.string(),
  aiPeer: z.string(),
  sessionId: z.string(),
  sessionPrefix: z.string(),
  autoCapture: z.boolean(),
  captureSubagents: z.boolean(),
  autoContext: z.boolean(),
  contextMaxChars: z.number(),
  contextTokens: z.number(),
  contextFetchTimeoutMs: z.number(),
  searchScope: z.string(),
  includeConclusions: z.boolean(),
  maxConclusions: z.number(),
  dialecticReasoningLevel: z.string(),
  messageMaxChars: z.number(),
})

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function captureFromEvent(config, event) {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'user/message') {
    const message = event.data
    if (message?.source?.kind !== 'user') return null
    const content = textFromBlocks(message.content)
    if (!content) return null
    return {
      peerId: config.userPeer,
      content,
      createdAt: new Date(event.time || Date.now()).toISOString(),
      metadata: {
        source: 'dsh',
        role: 'user',
        dsh_message_id: String(message.id ?? ''),
        dsh_event_seq: event.seq,
      },
    }
  }
  if (event.type === 'assistant/message') {
    const message = event.data?.message
    if (message?.source?.kind !== 'model') return null
    const content = textFromBlocks(message.content)
    if (!content) return null
    return {
      peerId: config.aiPeer,
      content,
      createdAt: new Date(event.time || Date.now()).toISOString(),
      metadata: {
        source: 'dsh',
        role: 'assistant',
        dsh_message_id: String(message.id ?? ''),
        dsh_event_seq: event.seq,
        provider: String(message.source.provider ?? ''),
        model: String(message.source.model ?? ''),
      },
    }
  }
  return null
}

function targetPeer(config, peer) {
  if (peer === 'assistant') return config.aiPeer
  if (peer === 'shared') return config.knowledgePeer
  return config.userPeer
}

function registerTools(ctx, engine) {
  const { client, config } = engine
  const toolSessionId = (exec) => sessionIdFor(config, exec?.agent?.id)
  const withToolTimeout = async (exec, operation, timeoutMs = 30000) => {
    const timeout = timeoutSignal(timeoutMs, exec?.signal)
    try { return await operation(timeout.signal) } finally { timeout.dispose() }
  }

  ctx.tools.register({
    name: 'memory_store',
    description: '把明确、持久且自包含的事实写入 Honcho。默认发布到跨 DSH/Codex/Hermes 可查询的共享知识库；scope=private 时只写当前 DeepSeek 视角。普通对话已自动保存，无需重复调用。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '自包含的长期事实、项目知识或决策，建议不超过 2000 字符' },
        peer: { type: 'string', enum: ['user', 'assistant', 'shared'], description: '事实描述谁；shared 表示通用知识主题，默认 user' },
        scope: { type: 'string', enum: ['shared', 'private'], description: '默认 shared；private 只保留当前助手视角' },
      },
      required: ['content'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => withToolTimeout(exec, async (signal) => {
      const content = String(args.content || '').trim()
      if (isMemoryJunk(content)) return '记忆未写入：内容过于琐碎、为空或属于系统注入。'
      if (content.length > 4000) return `记忆未写入：内容过长（${content.length} 字符），请提炼为自包含结论。`
      const sessionId = toolSessionId(exec)
      if (args.scope === 'private') {
        await engine.ensureSession(sessionId, signal)
        const observed = targetPeer(config, args.peer)
        const observer = config.aiPeer
        const created = await client.createConclusions(
          observer,
          observed,
          content,
          { sessionId },
          signal,
        )
        const first = Array.isArray(created) ? created[0] : null
        return `已写入当前视角的 Honcho conclusion（id: ${first?.id || 'unknown'}）。`
      }
      const result = await engine.publishKnowledge({
        content,
        targetPeer: targetPeer(config, args.peer),
      }, signal)
      if (result.skipped) {
        return `共享知识未重复写入：已有近似 conclusion（id: ${result.duplicate?.id || 'unknown'}）。`
      }
      return `已发布到共享知识库（id: ${result.created[0]?.id || 'unknown'}）。`
    }),
    timeoutMs: 35000,
  })

  ctx.tools.register({
    name: 'memory_search',
    description: '同时搜索当前助手视角 conclusions、共享知识库与原始消息。开始相关任务、核对旧决策或遇到重复故障时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的问题或关键词' },
        limit: { type: 'integer', description: '返回条数，默认 8，最大 20' },
        scope: { type: 'string', enum: ['session', 'workspace'], description: '原始消息检索范围；默认使用插件配置' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => withToolTimeout(exec, async (signal) => {
      const query = String(args.query || '').trim()
      if (!query) return '没有提供检索问题。'
      const limit = clampInteger(args.limit, 8, 1, 20)
      const scope = args.scope === 'session' || args.scope === 'workspace'
        ? args.scope
        : config.searchScope
      const sessionId = toolSessionId(exec)
      await engine.ensureSession(sessionId, signal)
      const [local, shared, messages] = await Promise.all([
        client.queryConclusions(config.aiPeer, config.userPeer, query, {
          topK: limit * 2,
          sessionId: scope === 'session' ? sessionId : undefined,
        }, signal),
        engine.queryKnowledge(query, { topK: limit * 2 }, signal),
        client.searchMessages(sessionId, query, limit * 2, scope, signal),
      ])
      return formatSearchResults([
        { kind: 'local-conclusion', items: local },
        { kind: 'shared-knowledge', items: shared },
        { kind: 'message', items: messages },
      ], limit, config.dedupeThreshold)
    }),
    timeoutMs: 35000,
  })

  ctx.tools.register({
    name: 'memory_context',
    description: '读取当前会话 summary、用户画像、助手知识表示、当前视角结论和共享知识库，获得完整而保留来源视角的背景。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选：围绕该问题筛选画像、结论与共享知识' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => withToolTimeout(exec, async (signal) => {
      const text = await engine.loadContext(
        toolSessionId(exec),
        String(args.query || '').trim(),
        signal,
      )
      return text || '当前没有可用的 Honcho 上下文。'
    }),
    timeoutMs: 35000,
  })

  ctx.tools.register({
    name: 'memory_reason',
    description: '调用 Honcho dialectic 综合推理。scope=shared 时从共享知识观察者视角推理；默认从当前 DeepSeek 视角推理用户或助手。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要让 Honcho 综合回答的问题' },
        peer: { type: 'string', enum: ['user', 'assistant', 'shared'], description: '推理对象，默认 user' },
        scope: { type: 'string', enum: ['local', 'shared'], description: '推理视角，默认 local' },
        reasoningLevel: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'max'], description: '推理等级，默认使用插件配置' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => withToolTimeout(exec, async (signal) => {
      const query = String(args.query || '').trim()
      if (!query) return '没有提供推理问题。'
      const level = REASONING_LEVELS.has(args.reasoningLevel)
        ? args.reasoningLevel
        : config.dialecticReasoningLevel
      const sessionId = toolSessionId(exec)
      await engine.ensureSession(sessionId, signal)
      const observer = args.scope === 'shared' ? config.knowledgePeer : config.aiPeer
      const response = await client.dialectic(
        observer,
        targetPeer(config, args.peer),
        query,
        { sessionId, reasoningLevel: level },
        signal,
      )
      return response?.content || response || 'Honcho dialectic 没有返回内容。'
    }),
    timeoutMs: 35000,
  })

  ctx.tools.register({
    name: 'memory_profile',
    description: '快速读取 peer card 与 representation。用于了解用户画像、助手自身知识表示，或共享知识库的静态快照；不调用 dialectic。',
    parameters: {
      type: 'object',
      properties: {
        peer: { type: 'string', enum: ['user', 'assistant', 'shared'], description: '要查看的对象，默认 user' },
        scope: { type: 'string', enum: ['local', 'shared'], description: '观察者视角，默认 local' },
        query: { type: 'string', description: '可选：过滤相关结论' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => withToolTimeout(exec, async (signal) => {
      await engine.ensureSession(toolSessionId(exec), signal)
      const observer = args.scope === 'shared' ? config.knowledgePeer : config.aiPeer
      const target = targetPeer(config, args.peer)
      const context = await client.peerContext(observer, target, {
        searchQuery: String(args.query || '').trim() || undefined,
        maxConclusions: config.maxConclusions,
      }, signal)
      const card = context?.peer_card || context?.peerCard || []
      const representation = context?.representation || ''
      return [
        `observer: ${observer}`,
        `target: ${target}`,
        card.length ? `peer card:\n${card.map((item) => `- ${item}`).join('\n')}` : 'peer card: empty',
        representation ? `representation:\n${representation}` : 'representation: empty',
      ].join('\n')
    }),
    timeoutMs: 35000,
  })

  ctx.tools.register({
    name: 'memory_dream',
    description: '安排 Honcho dream，对指定视角的记忆做后台归纳、去冗余并更新 peer card。可能使用 LLM 资源，只有用户明确要求整理记忆时才调用。',
    parameters: {
      type: 'object',
      properties: {
        peer: { type: 'string', enum: ['user', 'assistant', 'shared'], description: 'dream 的观察对象，默认 user' },
        scope: { type: 'string', enum: ['local', 'shared'], description: '观察者视角，默认 local' },
        sessionOnly: { type: 'boolean', description: '是否只整理当前会话，默认 false' },
        confirm: { type: 'boolean', description: '必须为 true 才安排 dream' },
      },
      required: ['confirm'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => withToolTimeout(exec, async (signal) => {
      if (args.confirm !== true) return '未安排 dream：需要明确 confirm=true。'
      const sessionId = toolSessionId(exec)
      await engine.ensureSession(sessionId, signal)
      const observer = args.scope === 'shared' ? config.knowledgePeer : config.aiPeer
      const target = targetPeer(config, args.peer)
      await client.scheduleDream(
        observer,
        target,
        { sessionId: args.sessionOnly ? sessionId : undefined },
        signal,
      )
      return `已安排 Honcho dream：${observer} -> ${target}${args.sessionOnly ? `，session=${sessionId}` : ''}。`
    }),
    timeoutMs: 35000,
  })

  ctx.tools.register({
    name: 'memory_status',
    description: '检查 Honcho API、当前会话后台队列、DSH 自动写入与共享知识状态。端口存在但 deriver/dialectic/dream 不工作时也应从这里继续深查。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (_args, exec) => withToolTimeout(exec, async (signal) => {
      const sessionId = toolSessionId(exec)
      await engine.ensureSession(sessionId, signal)
      const [queue, shared] = await Promise.all([
        client.queueStatus({ sessionId }, signal),
        engine.queryKnowledge('', { topK: 1 }, signal).catch(() => []),
      ])
      return [
        'Honcho API：可用',
        `workspace: ${config.workspace}`,
        `session: ${sessionId}`,
        `local perspective: ${config.aiPeer} -> ${config.userPeer}`,
        `shared knowledge observer: ${config.knowledgePeer}`,
        `shared knowledge readable: ${shared.length > 0 ? 'yes' : 'empty'}`,
        `queue: completed=${queue.completed_work_units ?? queue.completed ?? 0}, in_progress=${queue.in_progress_work_units ?? queue.in_progress ?? 0}, pending=${queue.pending_work_units ?? queue.pending ?? 0}`,
        `DSH auto writes: ${engine.status.completedWrites}/${engine.status.queuedWrites}`,
        `shared knowledge writes: ${engine.status.knowledgeWrites}`,
        `context loads: ${engine.status.contextLoads}`,
        `last success: ${engine.status.lastSuccessAt || 'none'}`,
        `last error: ${engine.status.lastError || 'none'}`,
        'official capabilities: peer card, representation, context, dialectic, conclusions, session search, queue, dream',
      ].join('\n')
    }),
    timeoutMs: 35000,
  })
}

export function apply(ctx, rawConfig) {
  const config = resolveMemoryConfig(rawConfig)
  const engine = createMemoryEngine({ config, logger: ctx.logger })
  const agentStates = new WeakMap()
  registerTools(ctx, engine)

  if (config.autoCapture) {
    ctx.on('session/event', (session, event) => {
      if (!config.captureSubagents && session?.header?.origin === 'subagent') return
      const captured = captureFromEvent(config, event)
      if (!captured) return
      engine.enqueueWrite(sessionIdFor(config, session?.id), captured)
    })
  }

  if (!config.autoContext) return

  ctx.on('agent/created', ({ agent }) => {
    if (!agent?.ctx) return
    if (!config.captureSubagents && agent.session?.header?.origin === 'subagent') return
    let state = agentStates.get(agent)
    if (!state) {
      state = {
        sessionId: sessionIdFor(config, agent?.id),
        claimedTurn: 0,
        lastLoadedTurn: -1,
        query: '',
        memoryText: '',
      }
      agentStates.set(agent, state)
    }
    const agentCtx = agent.ctx
    agentCtx.effect(() => {
      const disposeContext = agentCtx.systemPrompt.context({
        name: 'honcho-memory-context',
        order: 200,
        text: () => state.memoryText,
      })
      const stopClaimed = agentCtx.on('agent/inbox/claimed', ({ message, turn }) => {
        if (message?.source?.kind !== 'user') return
        const query = textFromBlocks(message.content)
        if (!query) return
        state.claimedTurn = turn
        state.query = query
      })
      const stopAssemble = agentCtx.on(
        'system-prompt/assemble',
        async (assembly, assembleContext, next) => {
          const shouldLoad = state.lastLoadedTurn !== state.claimedTurn
            || (state.lastLoadedTurn < 0 && !state.memoryText)
          if (shouldLoad) {
            state.lastLoadedTurn = state.claimedTurn
            try {
              state.memoryText = await engine.loadContext(
                state.sessionId,
                state.query,
                assembleContext?.signal,
              )
            } catch (error) {
              engine.markError('automatic context load', error)
            }
          }
          const result = await next()
          const contexts = Array.isArray(result?.contexts)
            ? result.contexts.map((entry) => entry?.name === 'honcho-memory-context'
              ? { ...entry, text: state.memoryText }
              : entry)
            : result?.contexts
          return { ...result, contexts }
        },
      )
      void engine.ensureSession(state.sessionId)
        .catch((error) => engine.markError('session initialization', error))
      return () => {
        stopAssemble()
        stopClaimed()
        disposeContext()
      }
    })
  })
}

export const __test = {
  HonchoClient,
  captureFromEvent,
  chunkContent,
  dedupeByContent: dedupeBySimilarity,
  formatSearchResults,
  isManualMemoryJunk: isMemoryJunk,
  renderAutoContext: (context, conclusions, maxChars) => renderMemoryContext({
    context,
    localConclusions: conclusions,
    sharedConclusions: [],
    aiContext: null,
  }, { maxChars }),
  resolveConfig: resolveMemoryConfig,
  sessionIdFor,
  textFromBlocks,
}
