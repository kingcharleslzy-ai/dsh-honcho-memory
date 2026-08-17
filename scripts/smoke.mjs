import { __test } from '../honcho-memory.js'


const marker = `DSH_HONCHO_SMOKE_${Date.now()}`
const cfg = __test.resolveConfig({
  baseUrl: process.env.HONCHO_BASE_URL || 'http://127.0.0.1:8001',
  apiKey: process.env.HONCHO_API_KEY || '',
  workspace: process.env.HONCHO_WORKSPACE || 'hermes',
  userPeer: process.env.HONCHO_USER_PEER || 'Charles',
  aiPeer: process.env.HONCHO_AI_PEER || 'deepseek',
  searchScope: 'session',
})
const sessionId = __test.sanitizeId(`dsh-plugin-smoke-${Date.now()}`, 'dsh-plugin-smoke')
const client = new __test.HonchoClient(cfg)
let conclusionId = null

try {
  await client.ensureSession(sessionId)
  const messages = await client.addMessages(sessionId, [
    {
      peer_id: cfg.userPeer,
      content: `${marker}: the synthetic smoke test requires an HTTP health check.`,
      metadata: { source: 'dsh-plugin-smoke', role: 'user' },
    },
    {
      peer_id: cfg.aiPeer,
      content: `${marker}: acknowledged the synthetic verification requirement.`,
      metadata: { source: 'dsh-plugin-smoke', role: 'assistant' },
    },
  ])
  if (!Array.isArray(messages) || messages.length !== 2) {
    throw new Error(`expected two stored messages, got ${JSON.stringify(messages)}`)
  }

  const conclusions = await client.createConclusion(
    sessionId,
    `${marker}: ${cfg.userPeer} requires an HTTP health check before completion.`,
    'user',
  )
  conclusionId = conclusions?.[0]?.id || null
  if (!conclusionId) throw new Error('conclusion creation returned no id')

  const matches = await client.conclusions(marker, sessionId, 5, undefined, 'session')
  if (!matches.some((item) => item.id === conclusionId)) {
    throw new Error('created conclusion was not returned by semantic query')
  }

  const context = await client.sessionContext(sessionId, marker)
  if (!Array.isArray(context?.messages) || context.messages.length < 2) {
    throw new Error('session context did not return stored messages')
  }

  const answer = await client.dialectic(
    sessionId,
    `What verification does ${cfg.userPeer} require in ${marker}?`,
    'low',
    'user',
  )
  if (!answer?.content) throw new Error('dialectic returned empty content')

  const queue = await client.queueStatus(sessionId)
  console.log(JSON.stringify({
    ok: true,
    sessionId,
    storedMessages: messages.length,
    queriedConclusions: matches.length,
    contextMessages: context.messages.length,
    dialecticChars: answer.content.length,
    queue,
  }, null, 2))
} finally {
  const ws = encodeURIComponent(cfg.workspace)
  if (conclusionId) {
    await client.call('DELETE', `/v3/workspaces/${ws}/conclusions/${encodeURIComponent(conclusionId)}`)
      .catch(() => {})
  }
  await client.call(
    'DELETE',
    `/v3/workspaces/${ws}/sessions/${encodeURIComponent(sessionId)}`,
  ).catch(() => {})
}
