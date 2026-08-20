export const REASONING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'max'])

export const DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:8000',
  apiKey: '',
  workspace: 'dsh',
  userPeer: 'user',
  aiPeer: 'deepseek',
  sessionId: '',
  sessionPrefix: 'dsh',
  autoCapture: true,
  captureSubagents: false,
  autoContext: true,
  contextMaxChars: 4000,
  contextTokens: 1600,
  contextFetchTimeoutMs: 8000,
  searchScope: 'workspace',
  includeConclusions: true,
  maxConclusions: 10,
  dialecticReasoningLevel: 'low',
  messageMaxChars: 24000,
  sharedKnowledge: true,
  knowledgePeer: 'shared-knowledge',
  knowledgeSessionId: 'shared-knowledge',
  knowledgeMaxConclusions: 10,
  dedupeThreshold: 0.84,
})

export function clampInteger(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.max(min, Math.min(value, max)) : fallback
}

export function clampNumber(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(value, max)) : fallback
}

export function sanitizeId(value, fallback = 'honcho') {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 500)
  return normalized || fallback
}

export function resolveMemoryConfig(config = {}) {
  const level = REASONING_LEVELS.has(config.dialecticReasoningLevel)
    ? config.dialecticReasoningLevel
    : DEFAULTS.dialecticReasoningLevel
  return {
    baseUrl: String(config.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    apiKey: String(config.apiKey || DEFAULTS.apiKey).trim(),
    workspace: sanitizeId(config.workspace || DEFAULTS.workspace, 'honcho'),
    userPeer: sanitizeId(config.userPeer || DEFAULTS.userPeer, 'user'),
    aiPeer: sanitizeId(config.aiPeer || DEFAULTS.aiPeer, 'assistant'),
    sessionId: config.sessionId ? sanitizeId(config.sessionId, 'dsh') : '',
    sessionPrefix: sanitizeId(config.sessionPrefix || DEFAULTS.sessionPrefix, 'dsh'),
    autoCapture: config.autoCapture ?? DEFAULTS.autoCapture,
    captureSubagents: config.captureSubagents ?? DEFAULTS.captureSubagents,
    autoContext: config.autoContext ?? DEFAULTS.autoContext,
    contextMaxChars: clampInteger(config.contextMaxChars, DEFAULTS.contextMaxChars, 500, 20000),
    contextTokens: clampInteger(config.contextTokens, DEFAULTS.contextTokens, 200, 12000),
    contextFetchTimeoutMs: clampInteger(
      config.contextFetchTimeoutMs,
      DEFAULTS.contextFetchTimeoutMs,
      500,
      60000,
    ),
    searchScope: config.searchScope === 'session' ? 'session' : 'workspace',
    includeConclusions: config.includeConclusions ?? DEFAULTS.includeConclusions,
    maxConclusions: clampInteger(config.maxConclusions, DEFAULTS.maxConclusions, 1, 100),
    dialecticReasoningLevel: level,
    messageMaxChars: clampInteger(config.messageMaxChars, DEFAULTS.messageMaxChars, 1000, 25000),
    sharedKnowledge: config.sharedKnowledge ?? DEFAULTS.sharedKnowledge,
    knowledgePeer: sanitizeId(config.knowledgePeer || DEFAULTS.knowledgePeer, 'shared-knowledge'),
    knowledgeSessionId: sanitizeId(
      config.knowledgeSessionId || DEFAULTS.knowledgeSessionId,
      'shared-knowledge',
    ),
    knowledgeMaxConclusions: clampInteger(
      config.knowledgeMaxConclusions,
      DEFAULTS.knowledgeMaxConclusions,
      1,
      100,
    ),
    dedupeThreshold: clampNumber(config.dedupeThreshold, DEFAULTS.dedupeThreshold, 0.5, 1),
  }
}

export function sessionIdFor(config, hostSessionId) {
  if (config.sessionId) return config.sessionId
  const suffix = sanitizeId(hostSessionId || 'global', 'global')
  return sanitizeId(`${config.sessionPrefix}-${suffix}`, `${config.sessionPrefix}-global`)
}

export function pathId(value) {
  return encodeURIComponent(String(value))
}
