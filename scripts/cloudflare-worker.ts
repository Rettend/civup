/* eslint-disable no-console */
import type { CloudflareTarget, CloudflareTargetName, CloudflareWorker } from '../config/cloudflare-targets.ts'
import type { WorkerArtifact, WorkerBuildMode } from './cloudflare-worker/artifacts.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cloudflareLocalPersistenceDirectory, resolveCloudflareTarget, resolveCloudflareTargetName } from '../config/cloudflare-targets.ts'
import { buildStampRelativePath, createBotPrebuiltDeploymentConfig, stampWorkerArtifact, verifyWorkerArtifact } from './cloudflare-worker/artifacts.ts'

export type WorkerAction = 'build' | 'deploy' | 'dev' | 'preview' | 'live'
export interface WorkerRequest {
  action: WorkerAction
  worker: CloudflareWorker
  targetName: CloudflareTargetName
  mode: WorkerBuildMode
  prebuilt: boolean
  printCommands: boolean
  forwarded: string[]
}

export interface WorkerCommand {
  kind: 'command'
  cmd: string[]
  cwd: string
  env: Record<string, string>
}
interface ArtifactStep { kind: 'stamp' | 'verify' | 'invalidate' | 'bot-deploy-config', path: string }
export interface WorkerPlan {
  request: WorkerRequest
  appRoot: string
  repositoryRoot: string
  target: CloudflareTarget
  steps: Array<WorkerCommand | ArtifactStep>
}

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

export function parseWorkerRequest(args: string[]): WorkerRequest {
  const [action, worker, ...options] = args
  if (!['build', 'deploy', 'dev', 'preview', 'live'].includes(action ?? '') || (worker !== 'bot' && worker !== 'activity')) throw new Error('Usage: cloudflare-worker.ts <build|deploy|dev|preview|live> <bot|activity> --target <standard|ppl> [--mode development|production] [--prebuilt] [--print-commands]')
  let target: string | undefined
  let mode: string | undefined
  let prebuilt = false
  let printCommands = false
  let forwarded: string[] = []
  for (let index = 0; index < options.length; index++) {
    const option = options[index]
    if (option === '--') { forwarded = options.slice(index + 1); break }
    if (option === '--target' && target === undefined) target = options[++index]
    else if (option === '--mode' && mode === undefined) mode = options[++index]
    else if (option === '--prebuilt' && !prebuilt) prebuilt = true
    else if (option === '--print-commands' && !printCommands) printCommands = true
    else throw new Error('Unknown or repeated Worker command option.')
  }
  const isLocal = action === 'dev' || action === 'live' || action === 'preview'
  mode ??= isLocal ? 'development' : 'production'
  if (mode !== 'development' && mode !== 'production') throw new Error('Choose development or production for --mode.')
  if (action === 'deploy' && mode !== 'production') throw new Error('Development builds cannot be deployed. Build in production mode for the selected target.')
  if (isLocal && mode !== 'development') throw new Error('Local Worker commands require development mode.')
  if (prebuilt && action !== 'deploy') throw new Error('--prebuilt is only supported with deploy.')
  if (forwarded.length && !isLocal) throw new Error('Extra CLI arguments are only supported by local Worker commands.')
  // Do not allow forwarded CLI options to retarget the Worker, enable remote
  // bindings, or select a different config/persistence/port than this adapter.
  const allowed = worker === 'activity' ? (action === 'preview' || action === 'dev' ? ['--strictPort'] : ['--force', '--strictPort']) : []
  if (forwarded.some(option => !allowed.includes(option))) throw new Error('Unsupported local Worker option. Activity live accepts --force and --strictPort; preview accepts --strictPort.')
  return { action: action as WorkerAction, worker, targetName: resolveCloudflareTargetName(target), mode, prebuilt, printCommands, forwarded }
}

type WorkerCli = 'cf' | 'vp' | 'wrangler' | 'cf-wrangler'

function nodeCli(root: string, worker: CloudflareWorker, name: WorkerCli): string[] {
  const appRequire = createRequire(resolve(root, `apps/${worker}/package.json`))
  const packageName = name === 'vp' ? 'vite-plus' : name === 'cf-wrangler' ? 'wrangler' : name
  const packageFile = appRequire.resolve(`${packageName}/package.json`)
  const manifest = appRequire(packageFile) as { bin: Record<string, string> }
  return ['node', '--import', pathToFileURL(resolve(root, 'scripts/cloudflare-worker/node-runtime.ts')).href, resolve(dirname(packageFile), manifest.bin[name]!)]
}

export function createWorkerPlan(request: WorkerRequest, target: CloudflareTarget, root = repositoryRoot): WorkerPlan {
  const appRoot = resolve(root, `apps/${request.worker}`)
  const stampPath = resolve(appRoot, buildStampRelativePath)
  const deploymentConfigPath = resolve(appRoot, '.cloudflare/civup-bot-deploy.json')
  const env = {
    CIVUP_TARGET: request.targetName,
    CLOUDFLARE_ACCOUNT_ID: target.accountId,
    WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
    ...(request.mode === 'production' ? { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' } : {}),
  }
  const command = (cli: WorkerCli, args: string[]): WorkerCommand => ({ kind: 'command', cmd: [...nodeCli(root, request.worker, cli), ...args], cwd: appRoot, env })
  // Invoke the same installed builder cf delegates to. cf beta.12 tries to
  // execute its JS shebang directly on Windows (EFTYPE); no global spawn patch.
  // Activity is explicit too: cf's framework registry rejects plugin 1.62.5.
  const build = command(request.worker === 'bot' ? 'cf-wrangler' : 'vp', ['build', '--mode', request.mode])
  const steps: WorkerPlan['steps'] = []
  if (request.action === 'build' || request.action === 'deploy' && !request.prebuilt)
    steps.push({ kind: 'invalidate', path: stampPath }, build, { kind: 'stamp', path: stampPath })
  if (request.action === 'deploy') {
    steps.push({ kind: 'verify', path: stampPath })
    if (request.worker === 'bot') steps.push({ kind: 'bot-deploy-config', path: deploymentConfigPath }, command('wrangler', ['deploy', '--config', deploymentConfigPath, '--no-bundle']))
    else steps.push(command('cf', ['deploy', '--prebuilt', '--mode', request.mode, '--worker', target.workers.activity]))
  }
  else if (request.action !== 'build') {
    if (request.worker === 'activity') {
      const preview = request.action === 'preview' || request.action === 'dev'
      if (preview) steps.push({ kind: 'verify', path: stampPath })
      steps.push(command('vp', [preview ? 'preview' : 'dev', '--mode', 'development', '--host', '0.0.0.0', '--port', '5173', '--strictPort', ...request.forwarded.filter(option => option !== '--strictPort')]))
    }
    else if (request.action === 'preview') {
      steps.push({ kind: 'verify', path: stampPath }, { kind: 'bot-deploy-config', path: deploymentConfigPath }, command('wrangler', ['dev', '--config', deploymentConfigPath, '--local', '--port', '8787', '--persist-to', resolve(root, cloudflareLocalPersistenceDirectory), '--env-file', resolve(appRoot, '.dev.vars'), '--show-interactive-dev-session=false', '--log-level', 'log']))
    }
    else {
      // cf's installed Wrangler dev delegate accepts only mode/host/port/local;
      // it cannot receive --persist-to. Use its new-config loader directly.
      steps.push(command('wrangler', ['dev', '--experimental-new-config', '--env', 'development', '--local', '--port', '8787', '--persist-to', resolve(root, cloudflareLocalPersistenceDirectory), '--show-interactive-dev-session=false', '--log-level', 'log']))
    }
  }
  return { request, appRoot, repositoryRoot: root, target, steps }
}

export interface WorkerLifecycleRuntime {
  run: (command: WorkerCommand) => void | Promise<void>
  print: (plan: WorkerPlan) => void
  invalidate: (path: string) => void
  stamp: typeof stampWorkerArtifact
  verify: typeof verifyWorkerArtifact
  writeBotConfig: (path: string, target: CloudflareTarget, artifact: WorkerArtifact, root: string) => void
}

export async function executeWorkerPlan(plan: WorkerPlan, runtime: WorkerLifecycleRuntime): Promise<void> {
  if (plan.request.printCommands) { runtime.print(plan); return }
  const identity = { targetName: plan.request.targetName, target: plan.target, worker: plan.request.worker, mode: plan.request.mode }
  let artifact: WorkerArtifact | undefined
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'command': await runtime.run(step); break
      case 'invalidate': runtime.invalidate(step.path); break
      case 'stamp': artifact = runtime.stamp(plan.appRoot, identity); break
      case 'verify': artifact = runtime.verify(plan.appRoot, identity); break
      case 'bot-deploy-config':
        if (!artifact) throw new Error('Verify the bot build before preparing its deployment config.')
        runtime.writeBotConfig(step.path, plan.target, artifact, plan.repositoryRoot)
        break
    }
  }
}

const runtime: WorkerLifecycleRuntime = {
  run(command) {
    const env = { ...process.env, ...command.env }
    // Retired config-path overrides must never silently select the old config.
    delete env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
    // CLOUDFLARE_ENV means a legacy Wrangler environment, not a cf build mode.
    delete env.CLOUDFLARE_ENV
    if (env.CIVUP_LOCAL_TARGETS_FILE) env.CIVUP_LOCAL_TARGETS_FILE = resolve(env.CIVUP_LOCAL_TARGETS_FILE)
    const result = spawnSync(command.cmd[0]!, command.cmd.slice(1), { cwd: command.cwd, env, stdio: 'inherit' })
    if (result.error || result.status !== 0) throw new Error(`Worker ${command.cmd[4]} command failed${result.status === null ? '' : ` (exit ${result.status})`}.`, { cause: result.error })
  },
  print(plan) { console.log(JSON.stringify(plan, null, 2)) },
  invalidate(path) { if (existsSync(path)) rmSync(path) },
  stamp: stampWorkerArtifact,
  verify: verifyWorkerArtifact,
  writeBotConfig(path, target, artifact, root) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(createBotPrebuiltDeploymentConfig(target, artifact, root), null, 2)}\n`)
  },
}

if (import.meta.main) {
  try {
    const request = parseWorkerRequest(process.argv.slice(2))
    const target = resolveCloudflareTarget(request.targetName, { localTargetsFile: process.env.CIVUP_LOCAL_TARGETS_FILE })
    await executeWorkerPlan(createWorkerPlan(request, target), runtime)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Worker command failed.')
    process.exitCode = 1
  }
}
