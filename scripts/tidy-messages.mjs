#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  HonchoClient,
  MESSAGE_TIDY_CONFIRMATION,
  executeMessageTidy,
  planMessageTidy,
  resolveMemoryConfig,
} from 'dsh-honcho-memory-core'

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

function loadConfig() {
  const hostName = process.env.HONCHO_HOST || 'codex'
  const shared = readJson(join(homedir(), '.honcho', 'config.json'))
  const provider = hostName.startsWith('hermes')
    ? readJson(join(homedir(), '.hermes', 'honcho.json'))
    : shared
  const host = provider.hosts?.[hostName] || shared.hosts?.[hostName] || {}
  return resolveMemoryConfig({
    baseUrl: process.env.HONCHO_BASE_URL
      || host.endpoint?.baseUrl
      || provider.endpoint?.baseUrl
      || provider.baseUrl
      || shared.endpoint?.baseUrl
      || shared.baseUrl,
    apiKey: process.env.HONCHO_API_KEY || host.apiKey || provider.apiKey || shared.apiKey,
    workspace: process.env.HONCHO_WORKSPACE || host.workspace || provider.workspace || shared.workspace,
  })
}

function optionValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function listAllPages(loadPage) {
  const output = []
  for (let page = 1; ; page += 1) {
    const result = await loadPage(page)
    const items = Array.isArray(result) ? result : (result?.items || [])
    output.push(...items)
    const pages = Number(result?.pages || 1)
    if (page >= pages) return output
  }
}

async function collectMessages(client) {
  const sessions = await listAllPages((page) => client.listSessions({ page, size: 100 }))
  const messages = []
  for (const session of sessions) {
    const sessionId = session.id || session.session_id
    if (!sessionId) continue
    const items = await listAllPages((page) => client.listMessages(
      sessionId,
      { page, size: 100, reverse: false },
    ))
    messages.push(...items.map((item) => ({ ...item, session_id: sessionId })))
  }
  return { sessions, messages }
}

function defaultBackupPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(homedir(), '.honcho', 'backups', `trivial-messages-${timestamp}.json`)
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const confirm = optionValue(args, '--confirm')
const backupPath = resolve(optionValue(args, '--backup') || defaultBackupPath())
const config = loadConfig()
const client = new HonchoClient(config)
const { sessions, messages } = await collectMessages(client)
const plan = planMessageTidy(messages)

mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 })
writeFileSync(backupPath, `${JSON.stringify({
  created_at: new Date().toISOString(),
  endpoint: config.baseUrl,
  workspace: config.workspace,
  session_count: sessions.length,
  scanned_message_count: messages.length,
  ...plan,
}, null, 2)}\n`, { mode: 0o600 })

if (!apply) {
  console.log(JSON.stringify({
    applied: false,
    dryRun: true,
    workspace: config.workspace,
    scannedSessions: sessions.length,
    scannedMessages: messages.length,
    deleteCount: plan.deleteCount,
    backupPath,
    confirmation: MESSAGE_TIDY_CONFIRMATION,
    candidates: plan.candidates.map((item) => ({
      session_id: item.session_id,
      id: item.id,
      created_at: item.created_at,
      peer_id: item.peer_id,
      content: item.content,
    })),
  }, null, 2))
  process.exit(0)
}

const result = await executeMessageTidy(client, plan, { confirm })
console.log(JSON.stringify({
  ...result,
  backupPath,
}, null, 2))
if (!result.applied) process.exitCode = 2
