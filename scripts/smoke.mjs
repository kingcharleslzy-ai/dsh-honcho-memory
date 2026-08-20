import {
  HonchoClient,
  publishSharedKnowledge,
  resolveMemoryConfig,
} from 'dsh-honcho-memory-core'

const marker = `DSH_HONCHO_SMOKE_${Date.now()}`
const config = resolveMemoryConfig({
  baseUrl: process.env.HONCHO_BASE_URL || 'http://127.0.0.1:8000',
  apiKey: process.env.HONCHO_API_KEY || '',
  workspace: process.env.HONCHO_WORKSPACE || 'dsh',
  userPeer: process.env.HONCHO_USER_PEER || 'user',
  aiPeer: process.env.HONCHO_AI_PEER || 'deepseek',
  searchScope: 'session',
})
const sessionId = `dsh-plugin-smoke-${Date.now()}`
const client = new HonchoClient(config)
const conclusionIds = []

async function waitForDeriver(sessionId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await client.queueStatus({ sessionId })
    const total = last.total_work_units ?? 0
    const active = (last.pending_work_units ?? 0) + (last.in_progress_work_units ?? 0)
    if (total > 0 && active === 0 && (last.completed_work_units ?? 0) > 0) return last
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`deriver queue did not settle: ${JSON.stringify(last)}`)
}

try {
  await client.ensureSession(sessionId, {
    [config.userPeer]: { observeMe: true, observeOthers: false },
    [config.aiPeer]: { observeMe: true, observeOthers: true },
  })
  const messages = await client.addMessages(sessionId, [
    {
      peer_id: config.userPeer,
      content: `${marker}: the synthetic smoke test requires an HTTP health check.`,
      metadata: { source: 'dsh-plugin-smoke', role: 'user' },
    },
    {
      peer_id: config.aiPeer,
      content: `${marker}: acknowledged the synthetic verification requirement.`,
      metadata: { source: 'dsh-plugin-smoke', role: 'assistant' },
    },
  ])
  if (!Array.isArray(messages) || messages.length !== 2) {
    throw new Error(`expected two stored messages, got ${JSON.stringify(messages)}`)
  }

  const queue = await waitForDeriver(sessionId)
  const derived = await client.listConclusions(config.aiPeer, config.userPeer, {
    size: 30,
    reverse: true,
    sessionId,
  })
  if (derived.length === 0) throw new Error('deriver completed without creating a conclusion')
  conclusionIds.push(...derived.map((item) => item.id).filter(Boolean))

  const shared = await publishSharedKnowledge(client, config, {
    content: `${marker}: shared verification knowledge is visible across agent hosts.`,
    targetPeer: config.knowledgePeer,
    sessionId,
  })
  const sharedConclusionId = shared.created?.[0]?.id || null
  if (!sharedConclusionId) throw new Error('shared knowledge creation returned no id')
  conclusionIds.push(sharedConclusionId)

  const matches = await client.queryConclusions(
    config.aiPeer,
    config.userPeer,
    `${marker} HTTP health check`,
    { topK: 5, sessionId },
  )
  if (!matches.some((item) => conclusionIds.includes(item.id))) {
    throw new Error('derived conclusion was not returned by semantic query')
  }

  const sharedMatches = await client.queryConclusions(
    config.knowledgePeer,
    config.knowledgePeer,
    marker,
    { topK: 5, sessionId },
  )
  if (!sharedMatches.some((item) => item.id === sharedConclusionId)) {
    throw new Error('created shared knowledge was not returned by canonical query')
  }

  const context = await client.sessionContext(sessionId, marker, {
    tokens: 1400,
    summary: true,
    peerTarget: config.userPeer,
    peerPerspective: config.aiPeer,
    maxConclusions: 10,
  })
  if (!Array.isArray(context?.messages) || context.messages.length < 2) {
    throw new Error('session context did not return stored messages')
  }

  const answer = await client.dialectic(
    config.aiPeer,
    config.userPeer,
    `What verification does ${config.userPeer} require in ${marker}?`,
    { sessionId, reasoningLevel: 'low' },
  )
  if (!answer?.content) throw new Error('dialectic returned empty content')

  console.log(JSON.stringify({
    ok: true,
    sessionId,
    storedMessages: messages.length,
    derivedConclusions: derived.length,
    queriedLocalConclusions: matches.length,
    queriedSharedKnowledge: sharedMatches.length,
    contextMessages: context.messages.length,
    dialecticChars: answer.content.length,
    queue,
  }, null, 2))
} finally {
  for (const conclusionId of conclusionIds) {
    await client.deleteConclusion(conclusionId).catch(() => {})
  }
  await client.deleteSession(sessionId).catch(() => {})
}
