import assert from 'node:assert/strict'
import test from 'node:test'

import { __test, apply } from '../honcho-memory.js'


function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    async text() { return data === undefined ? '' : JSON.stringify(data) },
  }
}


test('default configuration uses per-DSH sessions and dual peers', () => {
  const cfg = __test.resolveConfig({})
  assert.equal(cfg.userPeer, 'user')
  assert.equal(cfg.aiPeer, 'deepseek')
  assert.equal(cfg.sessionId, '')
  assert.equal(cfg.searchScope, 'workspace')
  assert.equal(__test.sessionIdFor(cfg, 'conversation-123'), 'dsh-conversation-123')

  const fixed = __test.resolveConfig({ sessionId: 'shared/session' })
  assert.equal(__test.sessionIdFor(fixed, 'ignored'), 'shared-session')
})


test('capture maps only real user and visible model text', () => {
  const cfg = __test.resolveConfig({})
  const user = __test.captureFromEvent(cfg, {
    type: 'user/message',
    seq: 3,
    time: 1_700_000_000_000,
    data: {
      id: 'u1',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '记住我偏好简洁报告' }, { type: 'image' }],
    },
  })
  assert.equal(user.peerId, 'user')
  assert.equal(user.content, '记住我偏好简洁报告')
  assert.equal(user.metadata.role, 'user')

  const assistant = __test.captureFromEvent(cfg, {
    type: 'assistant/message',
    seq: 8,
    time: 1_700_000_000_100,
    data: {
      message: {
        id: 'a1',
        source: { kind: 'model', provider: 'deepseek', model: 'v4' },
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'text', text: '已经完成并验证。' },
        ],
      },
    },
  })
  assert.equal(assistant.peerId, 'deepseek')
  assert.equal(assistant.content, '已经完成并验证。')
  assert.equal(assistant.metadata.model, 'v4')

  assert.equal(__test.captureFromEvent(cfg, {
    type: 'user/message',
    data: { source: { kind: 'plugin', plugin: 'test' }, content: [{ type: 'text', text: 'context' }] },
  }), null)
  assert.equal(__test.captureFromEvent(cfg, {
    type: 'assistant/message',
    data: { message: { source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'only reasoning' }] } },
  }), null)
})


test('context rendering combines summary, representation, card, and conclusions', () => {
  const text = __test.renderAutoContext(
    {
      summary: { content: '正在修复记忆插件。' },
      peer_representation: '用户重视可验证结果。',
      peer_card: ['使用 macOS', '偏好中文交付说明'],
    },
    [
      { content: '用户要求上线前执行健康检查。' },
      { content: '用户要求上线前执行健康检查。' },
    ],
    3000,
  )
  assert.match(text, /Current session summary/)
  assert.match(text, /用户重视可验证结果/)
  assert.match(text, /使用 macOS/)
  assert.equal(text.match(/上线前执行健康检查/g)?.length, 1)
  assert.match(text, /<memory-context>/)
})


test('long transcript messages are chunked without data loss', () => {
  const input = `${'a'.repeat(700)}\n${'b'.repeat(700)}\n${'c'.repeat(700)}`
  const chunks = __test.chunkContent(input, 1000)
  assert.equal(chunks.length, 3)
  assert.ok(chunks.every((chunk) => chunk.length <= 1020))
  assert.match(chunks[0], /^\[part 1\/3\]/)
})


test('plugin initializes peers, injects first-turn context, and auto-writes both roles', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ url: String(url), method: options.method, body })
    if (String(url).includes('/context?')) {
      return jsonResponse({
        summary: { content: '本会话正在测试自动记忆。' },
        peer_representation: 'The user prefers evidence-backed fixes.',
        peer_card: [],
        messages: [],
      })
    }
    if (String(url).endsWith('/conclusions/query')) {
      return jsonResponse([{ content: '用户要求自动记录用户和助手消息。' }])
    }
    if (String(url).endsWith('/messages')) {
      return jsonResponse([{ id: `m${calls.length}` }], 201)
    }
    return jsonResponse({})
  }

  const rootHandlers = new Map()
  const agentHandlers = new Map()
  const tools = new Map()
  const promptContexts = new Map()
  const ctx = {
    logger: { warn() {} },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    on(name, handler) { rootHandlers.set(name, handler); return () => rootHandlers.delete(name) },
  }
  const agentCtx = {
    systemPrompt: {
      context(entry) { promptContexts.set(entry.name, entry); return () => promptContexts.delete(entry.name) },
    },
    on(name, handler) { agentHandlers.set(name, handler); return () => agentHandlers.delete(name) },
    effect(setup) { this.cleanup = setup() },
  }
  const session = {
    id: 'session-42',
    header: {},
  }
  const agent = { id: 'session-42', session, ctx: agentCtx }

  try {
    apply(ctx, {})
    assert.deepEqual([...tools.keys()].sort(), [
      'memory_context',
      'memory_dream',
      'memory_profile',
      'memory_reason',
      'memory_search',
      'memory_status',
      'memory_store',
    ])

    rootHandlers.get('agent/created')({ agent })
    agentHandlers.get('agent/inbox/claimed')({
      message: { source: { kind: 'user' }, content: [{ type: 'text', text: '我的工作习惯是什么？' }] },
      turn: 1,
    })
    const assembly = { sections: [], contexts: [{ name: 'honcho-memory-context', text: '' }], tools: [], variables: {} }
    const assembled = await agentHandlers.get('system-prompt/assemble')(
      assembly,
      { signal: new AbortController().signal },
      async () => assembly,
    )
    assert.match(assembled.contexts[0].text, /本会话正在测试自动记忆/)
    assert.match(assembled.contexts[0].text, /自动记录用户和助手消息/)

    rootHandlers.get('session/event')(session, {
      type: 'user/message',
      seq: 1,
      time: Date.now(),
      data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '用户消息' }] },
    })
    rootHandlers.get('session/event')(session, {
      type: 'assistant/message',
      seq: 2,
      time: Date.now(),
      data: {
        message: {
          id: 'a1',
          source: { kind: 'model', provider: 'deepseek', model: 'v4' },
          content: [{ type: 'text', text: '助手消息' }],
        },
      },
    })

    for (let index = 0; index < 20; index += 1) {
      const messageCalls = calls.filter((call) => call.url.endsWith('/messages'))
      if (messageCalls.length === 2) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const messageCalls = calls.filter((call) => call.url.endsWith('/messages'))
    assert.equal(messageCalls.length, 2)
    assert.equal(messageCalls[0].body.messages[0].peer_id, 'user')
    assert.equal(messageCalls[1].body.messages[0].peer_id, 'deepseek')
    assert.ok(calls.some((call) => call.url.includes('/sessions/dsh-session-42/peers')))
  } finally {
    agentCtx.cleanup?.()
    globalThis.fetch = originalFetch
  }
})


test('memory_store publishes canonical shared knowledge by default', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ url: String(url), method: options.method, body })
    if (String(url).endsWith('/conclusions/query')) return jsonResponse([])
    if (String(url).endsWith('/conclusions') && options.method === 'POST') {
      return jsonResponse([{ id: 'shared-1', ...body.conclusions[0] }], 201)
    }
    return jsonResponse({})
  }

  const tools = new Map()
  const ctx = {
    logger: { warn() {} },
    tools: { register(tool) { tools.set(tool.name, tool) } },
    on() { return () => {} },
  }
  try {
    apply(ctx, { autoCapture: false, autoContext: false })
    const output = await tools.get('memory_store').execute(
      { content: 'Honcho is a shared knowledge base across agent hosts.' },
      { agent: { id: 'session-1' }, signal: new AbortController().signal },
    )
    assert.match(output, /已发布到共享知识库/)
    const create = calls.find((call) => call.url.endsWith('/conclusions')
      && call.method === 'POST')
    assert.equal(create.body.conclusions[0].observer_id, 'shared-knowledge')
    assert.equal(create.body.conclusions[0].observed_id, 'user')
    assert.equal(create.body.conclusions[0].session_id, 'shared-knowledge')
  } finally {
    globalThis.fetch = originalFetch
  }
})
