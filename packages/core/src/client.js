import { pathId } from './config.js'

function cleanQuery(query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, typeof value === 'boolean' ? String(value) : String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

function normalizeBaseUrl(value) {
  return String(value || 'http://127.0.0.1:8000')
    .replace(/\/+$/, '')
    .replace(/\/v3$/, '')
}

function snakePeerConfig(config = {}) {
  const output = {}
  const observeMe = config.observeMe ?? config.observe_me
  const observeOthers = config.observeOthers ?? config.observe_others
  if (observeMe !== undefined) output.observe_me = observeMe
  if (observeOthers !== undefined) output.observe_others = observeOthers
  return output
}

export class HonchoClient {
  constructor(config = {}, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== 'function') throw new TypeError('HonchoClient requires fetch')
    this.baseUrl = normalizeBaseUrl(config.baseUrl)
    this.workspace = config.workspace || 'dsh'
    this.apiKey = String(config.apiKey || '').trim()
    this.fetchImpl = fetchImpl
  }

  workspacePath(suffix = '') {
    return `/v3/workspaces/${pathId(this.workspace)}${suffix}`
  }

  async request(method, path, { body, query, signal, headers: extraHeaders } = {}) {
    const headers = { accept: 'application/json', ...extraHeaders }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const response = await this.fetchImpl(
      `${this.baseUrl}${path}${cleanQuery(query)}`,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
    )
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!response.ok) {
      const detail = data && typeof data === 'object' && data.detail !== undefined
        ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))
        : `${response.status} ${response.statusText}`
      const error = new Error(`Honcho ${method} ${path} failed (${response.status}): ${detail}`)
      error.status = response.status
      error.detail = data
      throw error
    }
    return data
  }

  call(method, path, body, signal) {
    return this.request(method, path, { body, signal })
  }

  ensureWorkspace(options = {}, signal) {
    return this.request('POST', '/v3/workspaces', {
      body: {
        id: this.workspace,
        metadata: options.metadata,
        configuration: options.configuration,
      },
      signal,
    })
  }

  listWorkspaces(options = {}, signal) {
    return this.request('POST', '/v3/workspaces/list', {
      body: { filters: options.filters },
      query: { page: options.page, size: options.size, reverse: options.reverse },
      signal,
    })
  }

  updateWorkspace({ metadata, configuration } = {}, signal) {
    return this.request('PUT', this.workspacePath(), { body: { metadata, configuration }, signal })
  }

  getWorkspace(signal) {
    return this.ensureWorkspace({}, signal)
  }

  createPeer(peerId, options = {}, signal) {
    return this.request('POST', this.workspacePath('/peers'), {
      body: {
        id: peerId,
        metadata: options.metadata,
        configuration: options.configuration
          ? { observe_me: options.configuration.observeMe ?? options.configuration.observe_me }
          : undefined,
      },
      signal,
    })
  }

  listPeers(options = {}, signal) {
    return this.request('POST', this.workspacePath('/peers/list'), {
      body: { filters: options.filters },
      query: { page: options.page, size: options.size, reverse: options.reverse },
      signal,
    })
  }

  updatePeer(peerId, { metadata, configuration } = {}, signal) {
    return this.request('PUT', this.workspacePath(`/peers/${pathId(peerId)}`), {
      body: {
        metadata,
        configuration: configuration
          ? { observe_me: configuration.observeMe ?? configuration.observe_me }
          : undefined,
      },
      signal,
    })
  }

  async ensureSession(sessionId, peerConfigs = {}, signal) {
    await this.ensureWorkspace({}, signal)
    const peers = Object.keys(peerConfigs)
    await Promise.all(peers.map((peerId) => this.createPeer(peerId, {}, signal)))
    await this.request('POST', this.workspacePath('/sessions'), {
      body: { id: sessionId },
      signal,
    })
    if (peers.length > 0) await this.addPeers(sessionId, peerConfigs, signal)
    return sessionId
  }

  createSession(sessionId, options = {}, signal) {
    return this.request('POST', this.workspacePath('/sessions'), {
      body: {
        id: sessionId,
        metadata: options.metadata,
        configuration: options.configuration,
        peers: options.peers,
      },
      signal,
    })
  }

  listSessions(options = {}, signal) {
    return this.request('POST', this.workspacePath('/sessions/list'), {
      body: { filters: options.filters },
      query: { page: options.page, size: options.size, reverse: options.reverse },
      signal,
    })
  }

  updateSession(sessionId, { metadata, configuration } = {}, signal) {
    return this.request('PUT', this.workspacePath(`/sessions/${pathId(sessionId)}`), {
      body: { metadata, configuration },
      signal,
    })
  }

  deleteSession(sessionId, signal) {
    return this.request('DELETE', this.workspacePath(`/sessions/${pathId(sessionId)}`), { signal })
  }

  cloneSession(sessionId, messageId, signal) {
    return this.request('POST', this.workspacePath(`/sessions/${pathId(sessionId)}/clone`), {
      query: { message_id: messageId },
      signal,
    })
  }

  addPeers(sessionId, peers, signal) {
    const body = Array.isArray(peers)
      ? Object.fromEntries(peers.map((peer) => [typeof peer === 'string' ? peer : peer.peerId, {}]))
      : Object.fromEntries(Object.entries(peers).map(([id, config]) => [id, snakePeerConfig(config)]))
    return this.request('POST', this.workspacePath(`/sessions/${pathId(sessionId)}/peers`), {
      body,
      signal,
    })
  }

  setPeers(sessionId, peers, signal) {
    const body = Array.isArray(peers)
      ? Object.fromEntries(peers.map((peer) => [typeof peer === 'string' ? peer : peer.peerId, {}]))
      : Object.fromEntries(Object.entries(peers).map(([id, config]) => [id, snakePeerConfig(config)]))
    return this.request('PUT', this.workspacePath(`/sessions/${pathId(sessionId)}/peers`), {
      body,
      signal,
    })
  }

  removePeers(sessionId, peerIds, signal) {
    return this.request('DELETE', this.workspacePath(`/sessions/${pathId(sessionId)}/peers`), {
      body: Array.isArray(peerIds) ? peerIds : [peerIds],
      signal,
    })
  }

  listSessionPeers(sessionId, signal) {
    return this.request('GET', this.workspacePath(`/sessions/${pathId(sessionId)}/peers`), { signal })
  }

  getSessionPeerConfig(sessionId, peerId, signal) {
    return this.request(
      'GET',
      this.workspacePath(`/sessions/${pathId(sessionId)}/peers/${pathId(peerId)}/config`),
      { signal },
    )
  }

  setSessionPeerConfig(sessionId, peerId, config, signal) {
    return this.request(
      'PUT',
      this.workspacePath(`/sessions/${pathId(sessionId)}/peers/${pathId(peerId)}/config`),
      { body: snakePeerConfig(config), signal },
    )
  }

  addMessages(sessionId, messages, signal) {
    return this.request('POST', this.workspacePath(`/sessions/${pathId(sessionId)}/messages`), {
      body: { messages },
      signal,
    })
  }

  listMessages(sessionId, options = {}, signal) {
    return this.request('POST', this.workspacePath(`/sessions/${pathId(sessionId)}/messages/list`), {
      body: { filters: options.filters },
      query: { page: options.page, size: options.size, reverse: options.reverse },
      signal,
    })
  }

  getMessage(sessionId, messageId, signal) {
    return this.request(
      'GET',
      this.workspacePath(`/sessions/${pathId(sessionId)}/messages/${pathId(messageId)}`),
      { signal },
    )
  }

  updateMessage(sessionId, messageId, metadata, signal) {
    return this.request(
      'PUT',
      this.workspacePath(`/sessions/${pathId(sessionId)}/messages/${pathId(messageId)}`),
      { body: { metadata }, signal },
    )
  }

  deleteMessage(sessionId, messageId, signal) {
    return this.request(
      'DELETE',
      this.workspacePath(`/sessions/${pathId(sessionId)}/messages/${pathId(messageId)}`),
      { signal },
    )
  }

  sessionContext(sessionId, query = '', options = {}, signal) {
    return this.request('GET', this.workspacePath(`/sessions/${pathId(sessionId)}/context`), {
      query: {
        tokens: options.tokens,
        summary: options.summary ?? true,
        peer_target: options.peerTarget,
        peer_perspective: options.peerPerspective,
        limit_to_session: options.limitToSession,
        search_query: query || undefined,
        search_top_k: options.searchTopK,
        search_max_distance: options.searchMaxDistance,
        include_most_frequent: options.includeMostFrequent,
        max_conclusions: options.maxConclusions,
      },
      signal,
    })
  }

  sessionSummaries(sessionId, signal) {
    return this.request('GET', this.workspacePath(`/sessions/${pathId(sessionId)}/summaries`), { signal })
  }

  searchMessages(sessionId, query, limit = 10, scope = 'workspace', signal, options = {}) {
    const path = scope === 'session'
      ? this.workspacePath(`/sessions/${pathId(sessionId)}/search`)
      : options.peerId
        ? this.workspacePath(`/peers/${pathId(options.peerId)}/search`)
        : this.workspacePath('/search')
    return this.request('POST', path, {
      body: { query, limit, filters: options.filters },
      signal,
    }).then((items) => Array.isArray(items) ? items : [])
  }

  listConclusions(observerId, observedId, options = {}, signal) {
    const filters = {
      observer_id: observerId,
      observed_id: observedId,
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(options.filters || {}),
    }
    return this.request('POST', this.workspacePath('/conclusions/list'), {
      body: { filters },
      query: { page: options.page ?? 1, size: options.size ?? 50, reverse: options.reverse },
      signal,
    }).then((data) => Array.isArray(data?.items) ? data.items : [])
  }

  queryConclusions(observerId, observedId, query, options = {}, signal) {
    return this.request('POST', this.workspacePath('/conclusions/query'), {
      body: {
        query,
        top_k: options.topK ?? 10,
        distance: options.distance,
        filters: {
          observer_id: observerId,
          observed_id: observedId,
          ...(options.filters || {}),
          ...(options.sessionId ? { session_id: options.sessionId } : {}),
        },
      },
      signal,
    }).then((items) => Array.isArray(items) ? items : [])
  }

  createConclusions(observerId, observedId, conclusions, options = {}, signal) {
    const items = (Array.isArray(conclusions) ? conclusions : [conclusions]).map((item) => ({
      content: typeof item === 'string' ? item : item.content,
      observer_id: observerId,
      observed_id: observedId,
      session_id: typeof item === 'object' && item.sessionId !== undefined
        ? item.sessionId
        : (options.sessionId ?? null),
    }))
    return this.request('POST', this.workspacePath('/conclusions'), {
      body: { conclusions: items },
      signal,
    })
  }

  deleteConclusion(conclusionId, signal) {
    return this.request('DELETE', this.workspacePath(`/conclusions/${pathId(conclusionId)}`), { signal })
  }

  representation(observerId, observedId, options = {}, signal) {
    return this.request('POST', this.workspacePath(`/peers/${pathId(observerId)}/representation`), {
      body: {
        target: observedId,
        session_id: options.sessionId,
        search_query: options.searchQuery,
        search_top_k: options.searchTopK,
        search_max_distance: options.searchMaxDistance,
        include_most_frequent: options.includeMostFrequent,
        max_conclusions: options.maxConclusions,
      },
      signal,
    })
  }

  peerCard(observerId, observedId, signal) {
    return this.request('GET', this.workspacePath(`/peers/${pathId(observerId)}/card`), {
      query: { target: observedId },
      signal,
    })
  }

  setPeerCard(observerId, observedId, peerCard, signal) {
    return this.request('PUT', this.workspacePath(`/peers/${pathId(observerId)}/card`), {
      query: { target: observedId },
      body: { peer_card: peerCard },
      signal,
    })
  }

  peerContext(observerId, observedId, options = {}, signal) {
    return this.request('GET', this.workspacePath(`/peers/${pathId(observerId)}/context`), {
      query: {
        target: observedId,
        search_query: options.searchQuery,
        max_conclusions: options.maxConclusions,
      },
      signal,
    })
  }

  dialectic(observerId, observedId, query, options = {}, signal) {
    return this.request('POST', this.workspacePath(`/peers/${pathId(observerId)}/chat`), {
      body: {
        target: observedId,
        session_id: options.sessionId,
        query: String(query).slice(0, 10000),
        reasoning_level: options.reasoningLevel,
        response_format: options.responseFormat,
        stream: false,
      },
      signal,
    })
  }

  queueStatus(options = {}, signal) {
    return this.request('GET', this.workspacePath('/queue/status'), {
      query: {
        observer_id: options.observerId,
        sender_id: options.senderId,
        session_id: options.sessionId,
      },
      signal,
    })
  }

  scheduleDream(observerId, observedId = observerId, options = {}, signal) {
    return this.request('POST', this.workspacePath('/schedule_dream'), {
      body: {
        observer: observerId,
        observed: observedId,
        session_id: options.sessionId,
        dream_type: 'omni',
      },
      signal,
    })
  }
}
