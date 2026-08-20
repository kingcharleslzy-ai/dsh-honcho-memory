#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  HonchoClient,
  publishSharedKnowledge,
  querySharedKnowledge,
  resolveMemoryConfig,
} from 'dsh-honcho-memory-core'

function usage() {
  return [
    'Honcho shared knowledge CLI',
    '',
    '  honcho-kb status',
    '  honcho-kb search <query>',
    '  honcho-kb publish <user|shared|peer-id> <content>',
    '  honcho-kb dream <user|shared|peer-id> --confirm',
    '',
    'Environment: HONCHO_HOST=codex|hermes, HONCHO_BASE_URL, HONCHO_API_KEY, HONCHO_WORKSPACE',
  ].join('\n')
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function loadSharedConfig() {
  const hostName = process.env.HONCHO_HOST || 'codex'
  const shared = readJson(join(homedir(), '.honcho', 'config.json'))
  // Hermes' official provider owns ~/.hermes/honcho.json. Respect its
  // host-specific settings instead of duplicating them in the Codex config.
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
    workspace: process.env.HONCHO_WORKSPACE || host.workspace || provider.workspace || shared.workspace || 'dsh',
    userPeer: process.env.HONCHO_USER_PEER || provider.peerName || shared.peerName || 'user',
    aiPeer: process.env.HONCHO_AI_PEER || host.aiPeer || hostName,
  })
}

function resolveTarget(config, value) {
  if (!value || value === 'user') return config.userPeer
  if (value === 'shared') return config.knowledgePeer
  return value
}

function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

const [command, ...args] = process.argv.slice(2)
if (!command || command === '--help' || command === '-h') {
  console.log(usage())
  process.exit(0)
}

const config = loadSharedConfig()
const client = new HonchoClient(config)

try {
  if (command === 'status') {
    const [peers, sessions, queue] = await Promise.all([
      client.listPeers({ size: 100 }),
      client.listSessions({ size: 20, reverse: true }),
      client.queueStatus(),
    ])
    print({
      ok: true,
      endpoint: config.baseUrl,
      workspace: config.workspace,
      userPeer: config.userPeer,
      aiPeer: config.aiPeer,
      knowledgePeer: config.knowledgePeer,
      peers: peers.total ?? peers.items?.length ?? 0,
      sessions: sessions.total ?? sessions.items?.length ?? 0,
      queue,
    })
  } else if (command === 'search') {
    const query = args.join(' ').trim()
    if (!query) throw new Error('search requires a query')
    const items = await querySharedKnowledge(client, config, query, {}, undefined)
    print({ ok: true, query, items })
  } else if (command === 'publish') {
    const target = resolveTarget(config, args.shift())
    const content = args.join(' ').trim()
    if (!content) throw new Error('publish requires content')
    const result = await publishSharedKnowledge(client, config, {
      targetPeer: target,
      content,
    })
    print({ ok: true, target, ...result })
  } else if (command === 'dream') {
    const target = resolveTarget(config, args.shift())
    if (!args.includes('--confirm')) {
      throw new Error('dream requires --confirm because it can consume backend LLM resources')
    }
    await client.scheduleDream(config.knowledgePeer, target)
    print({ ok: true, scheduled: true, observer: config.knowledgePeer, target })
  } else {
    throw new Error(`unknown command: ${command}\n\n${usage()}`)
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    command,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
}
