import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const selfPath = 'scripts/audit-public-package.mjs'
const excludedDirectories = new Set(['.git', 'node_modules'])
const findings = []

const signatures = [
  ['maintainer name', new RegExp(`\\b${['Char', 'les'].join('')}\\b`, 'g')],
  ['absolute macOS user path', new RegExp(`/${['Users'].join('')}/[^/\\s]+`, 'g')],
  ['private network address', new RegExp(`${['100', '92'].join('\\.')}\\.`, 'g')],
  ['private deployment identifier', new RegExp(['hermes', 'doctor'].join('_'), 'gi')],
  ['private storage volume', new RegExp(['2TB', 'TF'].join(''), 'g')],
  ['private package scope', new RegExp(['@lzy619202200', 'honcho-memory-core'].join('/'), 'g')],
  ['real session identifier', /\b019[0-9a-f]{5}-[0-9a-f]{4}(?:-[0-9a-f-]+)?\b/gi],
  ['private infrastructure label', new RegExp(['阿里', '云'].join(''), 'g')],
  ['private organization/location', new RegExp(['杭', '州|富', '阳|启', '临'].join(''), 'g')],
]

async function walk(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) await walk(absolute, output)
    else if (entry.isFile()) output.push(absolute)
  }
  return output
}

function packageFiles(args, packageRoot = root) {
  const output = execFileSync('npm', ['pack', ...args, '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  return JSON.parse(output)[0].files.map((entry) => join(packageRoot, entry.path))
}

async function scanFile(absolute, source) {
  const path = relative(root, absolute)
  if (path === selfPath) return
  let bytes
  try {
    bytes = await readFile(absolute)
  } catch (error) {
    findings.push(`${source}:${path}: unreadable (${error.message})`)
    return
  }
  if (bytes.length > 2_000_000 || bytes.includes(0)) return
  const text = bytes.toString('utf8')
  for (const [label, pattern] of signatures) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (!match) continue
    const line = text.slice(0, match.index).split('\n').length
    findings.push(`${source}:${path}:${line}: ${label}`)
  }
}

const repositoryFiles = await walk(root)
const rootPackageFiles = packageFiles([])
const corePackageFiles = packageFiles(
  ['--workspace', 'dsh-honcho-memory-core'],
  join(root, 'packages/core'),
)

for (const file of repositoryFiles) await scanFile(file, 'repository')
for (const file of rootPackageFiles) await scanFile(file, 'npm-root')
for (const file of corePackageFiles) await scanFile(file, 'npm-core')

if (findings.length > 0) {
  console.error('Public privacy audit failed:')
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`)
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  repositoryFiles: repositoryFiles.length,
  rootPackageFiles: rootPackageFiles.length,
  corePackageFiles: corePackageFiles.length,
}, null, 2))
