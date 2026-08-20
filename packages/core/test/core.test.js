import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HonchoClient,
  TIDY_CONFIRMATION,
  chunkContent,
  contentSimilarity,
  createMemoryEngine,
  dedupeBySimilarity,
  executeConclusionTidy,
  formatSearchResults,
  isMemoryJunk,
  planConclusionTidy,
  publishSharedKnowledge,
  resolveMemoryConfig,
  sessionIdFor,
} from '../src/index.js'

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    async text() { return data === undefined ? '' : JSON.stringify(data) },
  }
}

test('configuration preserves dual peers and adds a canonical shared knowledge peer', () => {
  const config = resolveMemoryConfig({})
  assert.equal(config.userPeer, 'user')
  assert.equal(config.aiPeer, 'deepseek')
  assert.equal(config.knowledgePeer, 'shared-knowledge')
  assert.equal(config.sharedKnowledge, true)
  assert.equal(sessionIdFor(config, 'conversation-123'), 'dsh-conversation-123')
  assert.equal(sessionIdFor(resolveMemoryConfig({ sessionId: 'shared/session' }), 'ignored'), 'shared-session')
})

test('capture helpers drop injected contexts and chunk large messages', () => {
  assert.equal(isMemoryJunk('<recommended_plugins>noise</recommended_plugins>'), true)
  assert.equal(isMemoryJunk('<memory-context>old memory</memory-context>'), true)
  assert.equal(isMemoryJunk('The user prefers evidence-backed delivery.'), false)

  const input = `${'a'.repeat(700)}\n${'b'.repeat(700)}\n${'c'.repeat(700)}`
  const chunks = chunkContent(input, 1000)
  assert.equal(chunks.length, 3)
  assert.match(chunks[0], /^\[part 1\/3\]/)
})

test('near duplicate Chinese conclusions are collapsed without mixing unrelated facts', () => {
  const first = '用户要求项目上线前必须执行健康检查并留下验证证据。'
  const second = '项目上线前，用户要求执行健康检查并保留验证证据。'
  const unrelated = '用户偏好使用深色界面。'
  assert.ok(contentSimilarity(first, second) >= 0.84)
  assert.ok(contentSimilarity(first, unrelated) < 0.84)
  const result = dedupeBySimilarity([
    { id: '1', content: first },
    { id: '2', content: second },
    { id: '3', content: unrelated },
  ])
  assert.equal(result.length, 2)
})

test('English knowledge sharing vocabulary is not mistaken for duplicate meaning', () => {
  const expectation = 'The user expects Honcho to serve as shared knowledge-base infrastructure across several agents, not merely chat memory; integrations should preserve official Honcho capabilities while keeping each assistant peer perspective separate.'
  const architecture = 'The adapter keeps official upstream integrations separate, while DSH uses a host-neutral core; canonical shared knowledge uses a dedicated observer and does not merge assistant peers.'
  assert.ok(contentSimilarity(expectation, architecture) < 0.84)
  assert.equal(dedupeBySimilarity([
    { id: 'expectation', content: expectation },
    { id: 'architecture', content: architecture },
  ]).length, 2)
})

test('search result limits cannot starve shared knowledge behind local matches', () => {
  const output = formatSearchResults([
    {
      kind: 'local-conclusion',
      items: Array.from({ length: 12 }, (_, index) => ({ content: `local fact ${index}` })),
    },
    {
      kind: 'shared-knowledge',
      items: [{ content: 'canonical cross-agent fact' }],
    },
    {
      kind: 'message',
      items: [{ content: 'raw transcript evidence', peer_id: 'user' }],
    },
  ], 3)
  assert.match(output, /\[local-conclusion\].*local fact/)
  assert.match(output, /\[shared-knowledge\].*canonical cross-agent fact/)
  assert.match(output, /\[message\/user\].*raw transcript evidence/)
})

test('client exposes official peer/session/conclusion/dream endpoints with v3 shapes', async () => {
  const calls = []
  const client = new HonchoClient(
    { baseUrl: 'http://honcho.test/v3', workspace: 'test-workspace', apiKey: 'secret' },
    async (url, options = {}) => {
      calls.push({
        url: String(url),
        method: options.method,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : undefined,
      })
      if (String(url).includes('/conclusions/list')) return jsonResponse({ items: [] })
      return jsonResponse({})
    },
  )

  await client.ensureSession('session-1', {
    user: { observeMe: true, observeOthers: false },
    deepseek: { observeMe: true, observeOthers: true },
  })
  await client.peerContext('deepseek', 'user', { maxConclusions: 8 })
  await client.listConclusions('deepseek', 'user', { size: 20 })
  await client.scheduleDream('deepseek', 'user', { sessionId: 'session-1' })

  assert.ok(calls.every((call) => call.url.startsWith('http://honcho.test/v3/')))
  assert.ok(calls.every((call) => call.headers.authorization === 'Bearer secret'))
  assert.ok(calls.some((call) => call.url.endsWith('/sessions/session-1/peers')
    && call.body.user.observe_me === true
    && call.body.deepseek.observe_me === true
    && call.body.deepseek.observe_others === true))
  assert.ok(calls.some((call) => call.url.includes('/peers/deepseek/context?target=user')))
  assert.ok(calls.some((call) => call.url.endsWith('/schedule_dream')
    && call.body.observer === 'deepseek'
    && call.body.observed === 'user'))
})

test('shared knowledge is canonical, perspective-safe, and skips near duplicates', async () => {
  const calls = []
  const client = {
    async createPeer(...args) { calls.push(['createPeer', ...args]) },
    async createSession(...args) { calls.push(['createSession', ...args]) },
    async addPeers(...args) { calls.push(['addPeers', ...args]) },
    async queryConclusions() { return [] },
    async createConclusions(...args) {
      calls.push(['createConclusions', ...args])
      return [{ id: 'knowledge-1', content: args[2] }]
    },
  }
  const config = resolveMemoryConfig({})
  const result = await publishSharedKnowledge(client, config, {
    content: 'The user expects Honcho to be a shared knowledge base, not only chat memory.',
    targetPeer: 'user',
  })
  assert.equal(result.skipped, false)
  const create = calls.find((call) => call[0] === 'createConclusions')
  assert.equal(create[1], 'shared-knowledge')
  assert.equal(create[2], 'user')
  assert.equal(create[4].sessionId, 'shared-knowledge')

  client.queryConclusions = async () => [{
    id: 'existing',
    content: 'The user expects Honcho to be a shared knowledge base, not only chat memory.',
  }]
  const duplicate = await publishSharedKnowledge(client, config, {
    content: 'The user expects Honcho to be a shared knowledge base, not only chat memory.',
  })
  assert.equal(duplicate.skipped, true)
  assert.equal(duplicate.duplicate.id, 'existing')
})

test('tidy never crosses perspective pairs and requires an explicit delete token', async () => {
  const plan = planConclusionTidy([
    {
      id: 'keep',
      content: 'The user prefers small verified changes with rollback.',
      observer_id: 'deepseek',
      observed_id: 'user',
      created_at: '2026-08-20T10:00:00Z',
    },
    {
      id: 'delete',
      content: 'The user prefers small, verified changes and a rollback path.',
      observer_id: 'deepseek',
      observed_id: 'user',
      created_at: '2026-08-19T10:00:00Z',
    },
    {
      id: 'other-perspective',
      content: 'The user prefers small, verified changes and a rollback path.',
      observer_id: 'codex',
      observed_id: 'user',
    },
  ], { threshold: 0.76 })
  assert.equal(plan.clusters.length, 1)
  assert.equal(plan.deleteCount, 1)
  assert.equal(plan.clusters[0].observerId, 'deepseek')

  const deleted = []
  const client = { async deleteConclusion(id) { deleted.push(id) } }
  const dryRun = await executeConclusionTidy(client, plan)
  assert.equal(dryRun.applied, false)
  assert.deepEqual(deleted, [])
  const applied = await executeConclusionTidy(client, plan, { confirm: TIDY_CONFIRMATION })
  assert.equal(applied.applied, true)
  assert.deepEqual(deleted, [plan.clusters[0].redundant[0].id])
})

test('memory engine injects local perspective, assistant knowledge, and shared knowledge', async () => {
  const peerContextCalls = []
  const client = {
    async ensureSession() {},
    async sessionContext() {
      return {
        summary: { content: '正在升级 Honcho 记忆。' },
        peer_representation: 'The user expects verified results.',
        peer_card: ['uses macOS'],
      }
    },
    async queryConclusions(observer, observed) {
      if (observer === 'shared-knowledge') {
        return [{ content: `Shared knowledge about ${observed}` }]
      }
      return [{ content: 'Local deepseek perspective conclusion.' }]
    },
    async peerContext(...args) {
      peerContextCalls.push(args)
      return { representation: 'DeepSeek knows the DSH plugin architecture.' }
    },
    async addMessages() {},
  }
  const engine = createMemoryEngine({ config: {}, client })
  const text = await engine.loadContext('dsh-session', 'Honcho')
  assert.match(text, /Current session summary/)
  assert.match(text, /Local deepseek perspective conclusion/)
  assert.match(text, /Shared knowledge base/)
  assert.match(text, /DeepSeek knows the DSH plugin architecture/)
  assert.equal(peerContextCalls[0][0], 'deepseek')
  assert.equal(peerContextCalls[0][1], 'deepseek')
})
