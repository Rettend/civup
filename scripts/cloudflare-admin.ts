/* eslint-disable no-console */
import type {
  CloudflareProvisioningTarget,
  CloudflareStorageLocation,
  CloudflareTarget,
  CloudflareTargetName,
} from '../config/cloudflare-targets'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'bun'
import {
  cloudflareLocalPersistenceDirectory,
  resolveCloudflareProvisioningTarget,
  resolveCloudflareTarget,
  resolveCloudflareTargetName,
} from '../config/cloudflare-targets'
import { resolveCloudflareExecutable } from './cloudflare-client'

type CreateAction = 'd1-create' | 'kv-create' | 'r2-create'
export type CloudflareAdminAction = 'migrate' | CreateAction | 'register' | 'types'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

function isCreateAction(action: string | undefined): action is CreateAction {
  return action === 'd1-create' || action === 'kv-create' || action === 'r2-create'
}

export function cloudflareCreateCommand(
  action: CreateAction,
  name: CloudflareTargetName,
  target: CloudflareProvisioningTarget,
) {
  const cli = resolveCloudflareExecutable('cf')
  const env: Record<string, string> = { CIVUP_TARGET: name, CLOUDFLARE_ACCOUNT_ID: target.accountId }
  let args: string[]
  if (action === 'd1-create') args = ['d1', 'create', '--name', target.d1.name]
  else if (action === 'kv-create') args = ['kv', 'namespaces', 'create', '--title', target.d1.name]
  else {
    if (!target.r2) throw new Error(`No R2 bucket is configured for ${name}.`)
    args = ['r2', 'buckets', 'create', '--name', target.r2.name]
  }
  return { cmd: [cli.executable, cli.entryPoint, ...args], cwd: undefined, env }
}

export function cloudflareAdminCommand(
  action: CloudflareAdminAction,
  name: CloudflareTargetName,
  target: CloudflareTarget,
  options: {
    location?: CloudflareStorageLocation
    persistenceDirectory?: string
    localTargetsFile?: string
  } = {},
) {
  if (isCreateAction(action)) return cloudflareCreateCommand(action, name, target)
  const env: Record<string, string> = {
    CIVUP_TARGET: name,
    CLOUDFLARE_ACCOUNT_ID: target.accountId,
    ...(options.localTargetsFile ? { CIVUP_LOCAL_TARGETS_FILE: resolve(options.localTargetsFile) } : {}),
  }
  const botRoot = resolve(repositoryRoot, 'apps/bot')
  if (action === 'register') {
    return {
      cmd: ['bun', `--env-file=${name === 'ppl' ? '.ppl.secrets' : '.prod.secrets'}`, 'src/register.ts'],
      cwd: botRoot,
      env: {
        ...env,
        DISCORD_APPLICATION_ID: target.discord.applicationId,
        ALLOWED_DISCORD_GUILD_ID: target.discord.guildId,
      },
    }
  }
  const cli = resolveCloudflareExecutable('cf')
  let args: string[]
  switch (action) {
    case 'migrate': {
      if (options.location !== 'local' && options.location !== 'remote')
        throw new Error('Choose --local or --remote for migrations.')
      const directory = resolve(repositoryRoot, target.d1.migrationsDirectory).replaceAll('\\', '/')
      args = [
        'd1',
        'migrations',
        'apply',
        target.d1.id,
        '--dir',
        directory,
        '--pattern',
        `${directory}/${target.d1.migrationsPattern}`,
        '--table',
        target.d1.migrationsTable,
      ]
      if (options.location === 'local')
        args.push(
          '--local',
          '--persist-to',
          resolve(repositoryRoot, options.persistenceDirectory ?? cloudflareLocalPersistenceDirectory),
        )
      break
    }
    case 'types':
      args = ['workers', 'types']
      break
  }
  return { cmd: [cli.executable, cli.entryPoint, ...args], cwd: action === 'types' ? botRoot : undefined, env }
}

export function checkMigrationResult(stdout: string): void {
  const results: unknown = JSON.parse(stdout)
  if (!Array.isArray(results) || results.some(result => !result || result.status !== '✅')) {
    throw new Error('A database migration did not complete. Check the migration output before continuing.')
  }
}

function main() {
  const [action, ...args] = process.argv.slice(2)
  if (!['migrate', 'd1-create', 'kv-create', 'r2-create', 'register', 'types'].includes(action ?? ''))
    throw new Error('Choose migrate, d1-create, kv-create, r2-create, register, or types.')
  let target = process.env.CIVUP_TARGET
  let location: CloudflareStorageLocation | undefined
  let persistenceDirectory: string | undefined
  let printCommands = false
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--target':
        target = args[++i]
        if (!target || target.startsWith('--')) throw new Error('--target requires standard or ppl.')
        break
      case '--persist-to':
        persistenceDirectory = args[++i]
        if (!persistenceDirectory || persistenceDirectory.startsWith('--'))
          throw new Error('--persist-to requires a directory.')
        break
      case '--local':
      case '--remote': {
        const next = args[i] === '--local' ? 'local' : 'remote'
        if (location && location !== next) throw new Error('Choose either --local or --remote.')
        location = next
        break
      }
      case '--print-commands':
        printCommands = true
        break
      default:
        throw new Error(`Unknown Cloudflare command option: ${args[i]}`)
    }
  }
  if (persistenceDirectory && location !== 'local') throw new Error('--persist-to requires --local.')
  const localTargetsFile = process.env.CIVUP_LOCAL_TARGETS_FILE
    ? resolve(process.env.CIVUP_LOCAL_TARGETS_FILE)
    : undefined
  const name = resolveCloudflareTargetName(target)
  const plan = isCreateAction(action)
    ? cloudflareCreateCommand(action, name, resolveCloudflareProvisioningTarget(name, { localTargetsFile }))
    : cloudflareAdminCommand(
        action as CloudflareAdminAction,
        name,
        resolveCloudflareTarget(name, { localTargetsFile }),
        { location, persistenceDirectory, localTargetsFile },
      )
  if (printCommands) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  const temporaryDirectory = plan.cwd ? undefined : mkdtempSync(join(tmpdir(), 'civup-admin-'))
  try {
    const result = spawnSync({
      cmd: plan.cmd,
      cwd: plan.cwd ?? temporaryDirectory,
      env: { ...process.env, ...plan.env, NO_COLOR: '1', CF_NO_OSC_PROGRESS: '1' },
      stdin: 'inherit',
      stdout: action === 'migrate' ? 'pipe' : 'inherit',
      stderr: 'inherit',
    })
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode || 1
      return
    }
    if (action === 'migrate') {
      const output = new TextDecoder().decode(result.stdout)
      console.log(output)
      checkMigrationResult(output)
    }
    if (action?.endsWith('-create'))
      console.log(
        'Copy the returned resource identity into the selected target in config/cloudflare-targets.ts or config/cloudflare-targets.local.json.',
      )
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cloudflare command failed.')
    process.exitCode = 1
  }
}
