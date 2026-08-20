import { isMemoryJunk } from './capture.js'
import { contentSimilarity, dedupeBySimilarity } from './context.js'

export async function querySharedKnowledge(client, config, query, options = {}, signal) {
  if (!config.sharedKnowledge) return []
  const topK = options.topK ?? config.knowledgeMaxConclusions
  const targets = [...new Set(options.targets || [config.userPeer, config.knowledgePeer])]
  const results = await Promise.all(targets.map((target) => query
    ? client.queryConclusions(
      config.knowledgePeer,
      target,
      query,
      { topK, sessionId: options.sessionId },
      signal,
    )
    : client.listConclusions(
      config.knowledgePeer,
      target,
      { size: topK, reverse: true, sessionId: options.sessionId },
      signal,
    )))
  return dedupeBySimilarity(results.flat(), config.dedupeThreshold).slice(0, topK)
}

export async function publishSharedKnowledge(client, config, input, signal) {
  const content = String(input?.content || '').trim()
  if (isMemoryJunk(content)) return { created: [], skipped: true, reason: 'empty-or-trivial' }
  if (content.length > 4000) throw new Error(`Shared knowledge is too long (${content.length} chars)`)
  const targetPeer = input.targetPeer || config.userPeer
  const sessionId = input.sessionId ?? config.knowledgeSessionId
  // Get-or-create without metadata so a later publish never overwrites
  // metadata another administrator attached to this canonical peer.
  await client.createPeer(config.knowledgePeer, {}, signal)
  await client.createPeer(targetPeer, {}, signal)
  await client.createSession(sessionId, {}, signal)
  await client.addPeers(sessionId, {
    [config.knowledgePeer]: { observeMe: true, observeOthers: true },
    [targetPeer]: { observeMe: true, observeOthers: false },
  }, signal)

  const candidates = await client.queryConclusions(
    config.knowledgePeer,
    targetPeer,
    content,
    { topK: 8 },
    signal,
  )
  const duplicate = candidates.find((item) => (
    contentSimilarity(item.content, content) >= config.dedupeThreshold
  ))
  if (duplicate) return { created: [], skipped: true, duplicate }

  const created = await client.createConclusions(
    config.knowledgePeer,
    targetPeer,
    content,
    { sessionId },
    signal,
  )
  return { created: Array.isArray(created) ? created : [], skipped: false }
}
