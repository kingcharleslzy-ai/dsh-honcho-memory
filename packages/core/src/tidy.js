import { contentSimilarity } from './context.js'
import { isMemoryJunk } from './capture.js'

export const TIDY_CONFIRMATION = 'DELETE_DUPLICATE_CONCLUSIONS'
export const MESSAGE_TIDY_CONFIRMATION = 'DELETE_TRIVIAL_MESSAGES'

function keepScore(item) {
  const contentLength = String(item?.content || '').trim().length
  const created = Date.parse(item?.created_at || item?.createdAt || '') || 0
  return contentLength * 1_000_000 + created / 1_000_000
}

export function planConclusionTidy(items, options = {}) {
  const threshold = options.threshold ?? 0.88
  const groups = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id || !String(item.content || '').trim()) continue
    const key = `${item.observer_id || ''}\u0000${item.observed_id || ''}`
    let group = groups.find((candidate) => candidate.key === key && candidate.items.some(
      (existing) => contentSimilarity(existing.content, item.content) >= threshold,
    ))
    if (!group) {
      group = { key, items: [] }
      groups.push(group)
    }
    group.items.push(item)
  }
  const clusters = groups
    .filter((group) => group.items.length > 1)
    .map((group) => {
      const sorted = [...group.items].sort((a, b) => keepScore(b) - keepScore(a))
      return {
        observerId: sorted[0].observer_id,
        observedId: sorted[0].observed_id,
        keep: sorted[0],
        redundant: sorted.slice(1),
      }
    })
  return {
    dryRun: true,
    threshold,
    clusters,
    deleteCount: clusters.reduce((sum, cluster) => sum + cluster.redundant.length, 0),
    backup: clusters.flatMap((cluster) => [cluster.keep, ...cluster.redundant]),
  }
}

export async function executeConclusionTidy(client, plan, options = {}, signal) {
  if (options.confirm !== TIDY_CONFIRMATION) {
    return { applied: false, reason: 'confirmation-required', plan }
  }
  const deleted = []
  for (const cluster of plan?.clusters || []) {
    for (const item of cluster.redundant || []) {
      await client.deleteConclusion(item.id, signal)
      deleted.push(item.id)
    }
  }
  return { applied: true, deleted, backup: plan?.backup || [] }
}

export function planMessageTidy(items) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter((item) => item?.id && item?.session_id && isMemoryJunk(item.content))
    .map((item) => ({ ...item }))
  return {
    dryRun: true,
    deleteCount: candidates.length,
    candidates,
    backup: candidates,
  }
}

export async function executeMessageTidy(client, plan, options = {}, signal) {
  if (options.confirm !== MESSAGE_TIDY_CONFIRMATION) {
    return { applied: false, reason: 'confirmation-required', plan }
  }
  const deleted = []
  for (const item of plan?.candidates || []) {
    await client.deleteMessage(item.session_id, item.id, signal)
    deleted.push({ session_id: item.session_id, id: item.id })
  }
  return { applied: true, deleted, backup: plan?.backup || [] }
}
