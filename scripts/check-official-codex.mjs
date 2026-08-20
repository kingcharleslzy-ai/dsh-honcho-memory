#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function hasOwnedHook(hooksFile, event, verb) {
  return (hooksFile?.hooks?.[event] || []).some((group) => (
    (group.hooks || []).some((hook) => (
      typeof hook.command === 'string'
      && hook.command.includes('codex-honcho.mjs')
      && hook.command.trim().endsWith(` ${verb}`)
    ))
  ))
}

function packageRoot() {
  const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
  return join(npmRoot, '@honcho-ai', 'codex-honcho')
}

const home = homedir()
const root = packageRoot()
const packageJson = readJson(join(root, 'package.json'))
const hooksPath = join(home, '.codex', 'hooks.json')
const hooks = readJson(hooksPath)
const configPath = join(home, '.honcho', 'config.json')
const config = readJson(configPath)
const stagedBundle = join(home, '.codex', 'honcho', 'codex-honcho.mjs')
const stagedText = existsSync(stagedBundle) ? readFileSync(stagedBundle, 'utf8') : ''
const sourceParser = join(root, 'src', 'transcript', 'codex.ts')
const sourceText = existsSync(sourceParser) ? readFileSync(sourceParser, 'utf8') : ''
const host = config?.hosts?.codex || {}

const checks = [
  {
    name: 'official-package',
    ok: packageJson?.name === '@honcho-ai/codex-honcho',
    detail: packageJson ? `${packageJson.name}@${packageJson.version}` : 'not found',
  },
  {
    name: 'official-source-present',
    ok: sourceText.includes('export function readRollout'),
    detail: sourceParser,
  },
  {
    name: 'staged-bundle-present',
    ok: stagedText.startsWith('#!/usr/bin/env node'),
    detail: stagedBundle,
  },
  {
    name: 'injected-plugin-list-filtered',
    ok: stagedText.includes('"recommended_plugins"'),
    detail: stagedText.includes('"recommended_plugins"')
      ? 'active bundle has the local transcript pollution guard'
      : 'upgrade would reintroduce injected <recommended_plugins> capture',
  },
  {
    name: 'upstream-filter-gap-visible',
    ok: !sourceText.includes('"recommended_plugins"'),
    warning: true,
    detail: sourceText.includes('"recommended_plugins"')
      ? 'upstream now contains the guard; local patch can be retired after upgrade testing'
      : 'upstream 0.1.1 still needs the guard; keep the compatibility check',
  },
  ...[
    ['SessionStart', 'recall'],
    ['UserPromptSubmit', 'prompt'],
    ['PostToolUse', 'observe'],
    ['Stop', 'writeback'],
    ['PreCompact', 'writeback'],
  ].map(([event, verb]) => ({
    name: `hook-${event}`,
    ok: hasOwnedHook(hooks, event, verb),
    detail: `${event} -> ${verb}`,
  })),
  {
    name: 'shared-workspace-config',
    ok: host.enabled === true && host.workspace === 'hermes' && host.aiPeer === 'codex',
    detail: {
      enabled: host.enabled,
      workspace: host.workspace,
      aiPeer: host.aiPeer,
      endpoint: host.endpoint?.baseUrl,
    },
  },
]

const failures = checks.filter((check) => !check.ok && !check.warning)
console.log(JSON.stringify({
  ok: failures.length === 0,
  package: packageJson?.version || null,
  checks,
  failures: failures.map((check) => check.name),
}, null, 2))

if (failures.length > 0) process.exitCode = 1
