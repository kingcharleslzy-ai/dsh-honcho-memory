import { HonchoClient, resolveMemoryConfig } from 'dsh-honcho-memory-core'

import { apply } from '../honcho-memory.js'

const sessionId = `dsh-adapter-smoke-${Date.now()}`
const rawConfig = {
  baseUrl: process.env.HONCHO_BASE_URL || 'http://127.0.0.1:8000',
  apiKey: process.env.HONCHO_API_KEY || '',
  workspace: process.env.HONCHO_WORKSPACE || 'dsh',
  userPeer: process.env.HONCHO_USER_PEER || 'user',
  aiPeer: process.env.HONCHO_AI_PEER || 'deepseek',
  sessionId,
  autoCapture: false,
  autoContext: false,
}
const tools = new Map()
const ctx = {
  logger: { warn(message) { console.error(message) } },
  tools: { register(tool) { tools.set(tool.name, tool) } },
  on() { return () => {} },
}
const exec = {
  agent: { id: sessionId },
  signal: new AbortController().signal,
}
const config = resolveMemoryConfig(rawConfig)
const client = new HonchoClient(config)
let temporaryConclusionId = ''

try {
  apply(ctx, rawConfig)
  const expected = [
    'memory_context',
    'memory_dream',
    'memory_profile',
    'memory_reason',
    'memory_search',
    'memory_status',
    'memory_store',
  ]
  const registered = [...tools.keys()].sort()
  if (JSON.stringify(registered) !== JSON.stringify(expected)) {
    throw new Error(`unexpected DSH tools: ${registered.join(', ')}`)
  }

  const marker = `DSH_ADAPTER_SHARED_${Date.now()}`
  const stored = await tools.get('memory_store').execute({
    content: `${marker}: DSH can publish canonical knowledge for other Honcho hosts.`,
    peer: 'shared',
    scope: 'shared',
  }, exec)
  temporaryConclusionId = stored.match(/id: ([A-Za-z0-9_-]+)/)?.[1] || ''
  if (!temporaryConclusionId) throw new Error(`DSH memory_store failed:\n${stored}`)
  const storedDirect = await client.listConclusions(
    config.knowledgePeer,
    config.knowledgePeer,
    { size: 20, reverse: true },
  )
  const storedItem = storedDirect.find((item) => item.id === temporaryConclusionId)
  if (!storedItem) {
    throw new Error(`DSH canonical write was not directly readable: ${temporaryConclusionId}`)
  }
  const storedSearch = `[shared-knowledge] ${storedItem.content}`

  const legacySearch = await tools.get('memory_search').execute(
    { query: 'OK.', limit: 20, scope: 'workspace' },
    exec,
  )
  if (/^\d+\. \[message\/[^\]]+\] OK\.$/m.test(legacySearch)) {
    throw new Error(`DSH search exposed a trivial legacy message:\n${legacySearch}`)
  }
  const status = await tools.get('memory_status').execute({ check: 'health' }, exec)
  if (!status.includes('Honcho API：可用') || !status.includes('shared knowledge readable: yes')) {
    throw new Error(`DSH status was not healthy:\n${status}`)
  }
  console.log(JSON.stringify({
    ok: true,
    sessionId,
    registered,
    canonicalWrite: stored,
    canonicalRecall: storedSearch,
    legacyMessageFilter: 'ok',
    status,
  }, null, 2))
} finally {
  if (temporaryConclusionId) {
    await client.deleteConclusion(temporaryConclusionId).catch(() => {})
  }
  await client.deleteSession(sessionId).catch(() => {})
}
