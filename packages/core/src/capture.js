const SYMBOL_ONLY_RE = /^[\s\p{P}\p{S}…。，！？!?~～、·•]+$/u
const TRIVIAL_RE = /^(好的?|好|嗯|哦|ok|okay|收到|可以|对|是|是的|继续|继续吧|搞定|明白|谢谢|test|测试)$/i

const INJECTED_PREFIXES = [
  '<memory-context>',
  '<honcho-memory',
  '<prior_memory_file',
  '<environment_context>',
  '<recommended_plugins>',
  '<skills_instructions>',
  '<plugins_instructions>',
  '<apps_instructions>',
  '<collaboration_mode>',
]

export function isMemoryJunk(content) {
  const text = String(content ?? '').trim()
  if (!text || SYMBOL_ONLY_RE.test(text)) return true
  if (text.length <= 12 && TRIVIAL_RE.test(text)) return true
  return INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export function chunkContent(content, maxChars = 24000) {
  const text = String(content ?? '').trim()
  if (!text) return []
  if (text.length <= maxChars) return [text]
  const chunks = []
  let rest = text
  while (rest.length > maxChars) {
    let boundary = rest.lastIndexOf('\n', maxChars)
    if (boundary < Math.floor(maxChars * 0.6)) boundary = rest.lastIndexOf(' ', maxChars)
    if (boundary < Math.floor(maxChars * 0.6)) boundary = maxChars
    chunks.push(rest.slice(0, boundary).trim())
    rest = rest.slice(boundary).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.map((chunk, index) => chunks.length === 1
    ? chunk
    : `[part ${index + 1}/${chunks.length}] ${chunk}`)
}

export function normalizeCapturedMessage(message) {
  if (!message || typeof message !== 'object') return null
  const content = String(message.content ?? '').trim()
  const peerId = String(message.peerId ?? message.peer_id ?? '').trim()
  if (!content || !peerId || isMemoryJunk(content)) return null
  return {
    peerId,
    content,
    createdAt: message.createdAt || message.created_at || new Date().toISOString(),
    metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata : {},
  }
}
