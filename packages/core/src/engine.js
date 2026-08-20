import { chunkContent, normalizeCapturedMessage } from './capture.js'
import { resolveMemoryConfig } from './config.js'
import { HonchoClient } from './client.js'
import { renderMemoryContext } from './context.js'
import { publishSharedKnowledge, querySharedKnowledge } from './knowledge.js'

export function timeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController()
  let timeout = setTimeout(() => controller.abort(new Error('Honcho request timed out')), timeoutMs)
  const onAbort = () => controller.abort(parentSignal.reason)
  if (parentSignal) {
    if (parentSignal.aborted) onAbort()
    else parentSignal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout)
      timeout = null
      parentSignal?.removeEventListener('abort', onAbort)
    },
  }
}

export function createMemoryEngine(options = {}) {
  const config = resolveMemoryConfig(options.config)
  const client = options.client || new HonchoClient(config, options.fetchImpl)
  const logger = options.logger || {}
  const ensuredSessions = new Map()
  const status = {
    queuedWrites: 0,
    completedWrites: 0,
    contextLoads: 0,
    knowledgeWrites: 0,
    lastSuccessAt: null,
    lastError: null,
  }
  let writeTail = Promise.resolve()

  const markSuccess = () => {
    status.lastSuccessAt = new Date().toISOString()
    status.lastError = null
  }
  const markError = (operation, error) => {
    status.lastError = `${operation}: ${error instanceof Error ? error.message : String(error)}`
    logger.warn?.(`[honcho-memory] ${status.lastError}`)
  }

  const ensureSession = (sessionId, signal) => {
    let promise = ensuredSessions.get(sessionId)
    if (!promise) {
      promise = client.ensureSession(sessionId, {
        [config.userPeer]: { observeMe: true, observeOthers: false },
        // Build both the assistant's self-representation and its directional
        // model of the user, matching Hermes' dual-peer architecture.
        [config.aiPeer]: { observeMe: true, observeOthers: true },
      }, signal).then(() => {
        markSuccess()
        return sessionId
      }).catch((error) => {
        ensuredSessions.delete(sessionId)
        throw error
      })
      ensuredSessions.set(sessionId, promise)
    }
    return promise
  }

  const enqueueWrite = (sessionId, message) => {
    const captured = normalizeCapturedMessage(message)
    if (!captured) return Promise.resolve(false)
    status.queuedWrites += 1
    writeTail = writeTail.then(async () => {
      await ensureSession(sessionId)
      const parts = chunkContent(captured.content, config.messageMaxChars)
      await client.addMessages(sessionId, parts.map((content, index) => ({
        content,
        peer_id: captured.peerId,
        created_at: captured.createdAt,
        metadata: {
          ...captured.metadata,
          memory_chunk: index + 1,
          memory_chunks: parts.length,
        },
      })))
      status.completedWrites += 1
      markSuccess()
      return true
    }).catch((error) => {
      markError('automatic transcript write', error)
      return false
    })
    return writeTail
  }

  const conclusionsFor = (observerId, observedId, query, limit, signal, sessionId) => query
    ? client.queryConclusions(observerId, observedId, query, {
      topK: limit,
      sessionId: config.searchScope === 'session' ? sessionId : undefined,
    }, signal)
    : client.listConclusions(observerId, observedId, {
      size: limit,
      reverse: true,
      sessionId: config.searchScope === 'session' ? sessionId : undefined,
    }, signal)

  const loadContext = async (sessionId, query = '', signal) => {
    const timeout = timeoutSignal(config.contextFetchTimeoutMs, signal)
    try {
      await ensureSession(sessionId, timeout.signal)
      const [context, localConclusions, sharedConclusions, aiContext] = await Promise.all([
        client.sessionContext(sessionId, query, {
          tokens: config.contextTokens,
          summary: true,
          peerTarget: config.userPeer,
          peerPerspective: config.aiPeer,
          limitToSession: false,
          searchTopK: config.maxConclusions,
          maxConclusions: config.maxConclusions,
          includeMostFrequent: true,
        }, timeout.signal),
        config.includeConclusions
          ? conclusionsFor(
            config.aiPeer,
            config.userPeer,
            query,
            config.maxConclusions,
            timeout.signal,
            sessionId,
          )
          : Promise.resolve([]),
        querySharedKnowledge(client, config, query, {}, timeout.signal),
        client.peerContext(config.aiPeer, config.aiPeer, {
          searchQuery: query || undefined,
          maxConclusions: Math.min(6, config.maxConclusions),
        }, timeout.signal).catch(() => null),
      ])
      status.contextLoads += 1
      markSuccess()
      return renderMemoryContext(
        { context, localConclusions, sharedConclusions, aiContext },
        {
          maxChars: config.contextMaxChars,
          dedupeThreshold: config.dedupeThreshold,
        },
      )
    } finally {
      timeout.dispose()
    }
  }

  const publishKnowledge = async (input, signal) => {
    const result = await publishSharedKnowledge(client, config, input, signal)
    if (!result.skipped) status.knowledgeWrites += result.created.length
    markSuccess()
    return result
  }

  return {
    client,
    config,
    status,
    ensureSession,
    enqueueWrite,
    loadContext,
    publishKnowledge,
    queryKnowledge: (query, options, signal) => querySharedKnowledge(
      client,
      config,
      query,
      options,
      signal,
    ),
    conclusionsFor,
    markError,
    async drainWrites() { await writeTail },
  }
}
