import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'bun'

const SECRET_KEYS = {
  bot: ['DISCORD_TOKEN', 'CIVUP_SECRET'],
  activity: ['DISCORD_CLIENT_SECRET', 'CIVUP_SECRET'],
} as const

const [target, sourceFile, ...rawWranglerArgs] = process.argv.slice(2)
if (target !== 'bot' && target !== 'activity' || !sourceFile) {
  console.error('Usage: bun scripts/upload-worker-secrets.ts <bot|activity> <env-file> [wrangler args] [--dry-run]')
  process.exit(1)
}

const sourcePath = resolve(process.cwd(), sourceFile)
if (!existsSync(sourcePath)) {
  console.error(`Secret source file not found: ${sourcePath}`)
  process.exit(1)
}

const source = parseEnvFile(readFileSync(sourcePath, 'utf8'))
const selected: Record<string, string> = {}
for (const key of SECRET_KEYS[target]) {
  const value = source[key]?.trim() ?? ''
  if (!value) {
    console.error(`Missing required ${target} secret: ${key}`)
    process.exit(1)
  }
  selected[key] = value
}

const dryRun = rawWranglerArgs.includes('--dry-run')
const wranglerArgs = rawWranglerArgs.filter(argument => argument !== '--dry-run')
console.log(`[secrets] ${dryRun ? 'validated' : 'uploading'} ${Object.keys(selected).join(', ')}`)
if (dryRun) process.exit(0)

const result = spawnSync({
  cmd: ['bunx', 'wrangler', 'secret', 'bulk', ...wranglerArgs],
  cwd: process.cwd(),
  env: process.env,
  stdin: new TextEncoder().encode(JSON.stringify(selected)),
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(result.exitCode ?? 1)

function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!key) continue
    result[key] = stripMatchingQuotes(line.slice(separator + 1).trim())
  }
  return result
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value
  const quote = value[0]
  return (quote === '"' || quote === '\'') && value.at(-1) === quote
    ? value.slice(1, -1)
    : value
}
