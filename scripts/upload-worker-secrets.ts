/* eslint-disable no-console */
import type { CloudflareTarget, CloudflareWorker } from '../config/cloudflare-targets'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { spawnSync } from 'bun'
import {
  cloudflareSecretKeys,
  resolveCloudflareTarget,
  resolveCloudflareTargetName,
} from '../config/cloudflare-targets'

export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!key) continue
    const value = line.slice(separator + 1).trim()
    const quote = value[0]
    result[key] =
      value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value
  }
  return result
}

export function selectWorkerSecrets(worker: CloudflareWorker, source: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {}
  for (const key of cloudflareSecretKeys[worker]) {
    const value = source[key]?.trim() ?? ''
    if (!value) throw new Error(`Missing required ${worker} secret: ${key}`)
    selected[key] = value
  }
  return selected
}

export function secretUploadCommand(worker: CloudflareWorker, target: CloudflareTarget): string[] {
  const require = createRequire(new URL('../apps/bot/package.json', import.meta.url))
  const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js')
  // cf beta.12 accepts only an argument or disk file for secrets, not stdin.
  return ['node', wrangler, 'secret', 'bulk', '--name', target.workers[worker]]
}

function main(): number {
  const [worker, sourceFile, ...args] = process.argv.slice(2)
  if ((worker !== 'bot' && worker !== 'activity') || !sourceFile) {
    throw new Error(
      'Usage: bun scripts/upload-worker-secrets.ts <bot|activity> <env-file> --target <standard|ppl> [--dry-run|--print-commands]',
    )
  }

  let targetName = process.env.CIVUP_TARGET
  let dryRun = false
  let printCommands = false
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]
    if (argument === '--target') {
      targetName = args[++i]
      if (!targetName || targetName.startsWith('--')) throw new Error('--target requires standard or ppl.')
    } else if (argument === '--dry-run') dryRun = true
    else if (argument === '--print-commands') printCommands = true
    else throw new Error(`Unknown secret upload option: ${argument}`)
  }

  const name = resolveCloudflareTargetName(targetName)
  const target = resolveCloudflareTarget(name, { localTargetsFile: process.env.CIVUP_LOCAL_TARGETS_FILE })
  const cmd = secretUploadCommand(worker, target)
  if (printCommands) {
    console.log(
      JSON.stringify({ target: name, accountId: target.accountId, worker: target.workers[worker], cmd }, null, 2),
    )
    return 0
  }

  const sourcePath = resolve(process.cwd(), sourceFile)
  if (!existsSync(sourcePath)) throw new Error(`Secret source file not found: ${sourcePath}`)
  const selected = selectWorkerSecrets(worker, parseEnvFile(readFileSync(sourcePath, 'utf8')))
  console.log(
    `[secrets] ${dryRun ? 'validated' : 'uploading'} ${Object.keys(selected).join(', ')} for ${name}/${worker}`,
  )
  if (dryRun) return 0

  // Avoid discovering another target's project config. Only the chosen account
  // and Worker name reach Wrangler; the secret values travel over stdin.
  const cwd = mkdtempSync(join(tmpdir(), 'civup-worker-secrets-'))
  try {
    const result = spawnSync({
      cmd,
      cwd,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId, CIVUP_TARGET: name },
      stdin: new TextEncoder().encode(JSON.stringify(selected)),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return result.exitCode ?? 1
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[secrets] ${error instanceof Error ? error.message : 'Secret upload failed'}`)
    process.exitCode = 1
  }
}
