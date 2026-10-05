import type { CloudflareTarget } from '../config/cloudflare-targets.ts'
import type { WorkerLifecycleRuntime, WorkerPlan } from '../scripts/cloudflare-worker.ts'
import type { BuildIdentity } from '../scripts/cloudflare-worker/artifacts.ts'
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { cloudflareTargets } from '../config/cloudflare-targets.ts'
import { createActivityCloudflareConfig, createBotCloudflareConfig } from '../config/cloudflare-workers.ts'
import { createWorkerPlan, executeWorkerPlan, parseWorkerRequest } from '../scripts/cloudflare-worker.ts'
import {
  browserBuildMetadataFile,
  buildStampRelativePath,
  createBotPrebuiltDeploymentConfig,
  stampWorkerArtifact,
  verifyWorkerArtifact,
} from '../scripts/cloudflare-worker/artifacts.ts'
import { fixtureLocalTargetsFile, fixturePplTarget } from './cloudflare-fixtures.ts'

const temporaryDirectories: string[] = []
const temporaryRoot = process.env.TEMP ? join(process.env.TEMP, 'opencode') : resolve('.cloudflare/test-tmp')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  mkdirSync(temporaryRoot, { recursive: true })
  const path = mkdtempSync(join(temporaryRoot, 'civup-worker-'))
  temporaryDirectories.push(path)
  return path
}

function identity(
  worker: 'bot' | 'activity' = 'activity',
  targetName: 'standard' | 'ppl' = 'standard',
  mode: 'development' | 'production' = 'production',
  target: CloudflareTarget = targetName === 'standard' ? cloudflareTargets.standard : fixturePplTarget,
): BuildIdentity {
  return { worker, targetName, target, mode }
}

function outputFixture(appRoot: string, build: BuildIdentity, browserId = build.target.discord.applicationId) {
  const outputRoot = join(appRoot, '.cloudflare/output/v0')
  const workerRoot = join(outputRoot, 'workers/default')
  const bundleRoot = join(workerRoot, 'bundle')
  mkdirSync(bundleRoot, { recursive: true })
  const config =
    build.worker === 'bot' ? createBotCloudflareConfig(build.target) : createActivityCloudflareConfig(build.target)
  const { entrypoint: _entrypoint, ...worker } = config.worker
  const modules: Record<string, { type: string }> = { 'index.js': { type: 'esm' } }
  writeFileSync(
    join(bundleRoot, 'index.js'),
    build.worker === 'bot'
      ? 'class SessionDO {} class Activity {} class MaintenanceDO {} export { SessionDO, Activity, MaintenanceDO }'
      : 'export default { fetch() {} }',
  )
  if (build.worker === 'bot') {
    modules['renderer.wasm'] = { type: 'wasm' }
    writeFileSync(join(bundleRoot, 'renderer.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    for (const weight of ['400', '700', '900']) {
      const file = `hash-inter-latin-${weight}-normal.woff2`
      modules[file] = { type: 'data' }
      writeFileSync(join(bundleRoot, file), 'font bytes')
    }
  } else {
    const assetsRoot = join(workerRoot, 'assets')
    mkdirSync(assetsRoot, { recursive: true })
    writeFileSync(
      join(assetsRoot, 'index.html'),
      '<link rel="stylesheet" href="/client.css"><script src="client.js"></script>',
    )
    writeFileSync(join(assetsRoot, 'client.js'), `const discordApplicationId = '${browserId}'`)
    writeFileSync(join(assetsRoot, 'client.css'), '.grid{display:grid}.flex{display:flex}')
    writeFileSync(
      join(assetsRoot, browserBuildMetadataFile),
      JSON.stringify({ target: build.targetName, mode: build.mode, browserApplicationId: browserId }),
    )
  }
  writeFileSync(
    join(workerRoot, 'worker.config.json'),
    JSON.stringify({ ...worker, manifest: { type: 'complete', mainModule: 'index.js', modules } }),
  )
  writeFileSync(
    join(outputRoot, 'config.json'),
    JSON.stringify({ accountId: config.accountId, buildContext: { mode: build.mode, isPreview: false } }),
  )
  return { outputRoot, workerRoot, bundleRoot }
}

function fixturePlan(args: string[]) {
  const request = parseWorkerRequest(args)
  const plan = createWorkerPlan(
    request,
    request.targetName === 'standard' ? cloudflareTargets.standard : fixturePplTarget,
  )
  const appRoot = temporaryDirectory()
  return {
    ...plan,
    appRoot,
    steps: plan.steps.map(step =>
      step.kind === 'command'
        ? step
        : Object.assign({}, step, { path: join(appRoot, '.cloudflare', basename(step.path)) }),
    ),
  }
}

function lifecycleRuntime(plan: WorkerPlan, events: string[], failBuild = false): WorkerLifecycleRuntime {
  return {
    run(command) {
      const action = command.cmd[4]!
      events.push(action)
      if (action === 'build') {
        if (failBuild) throw new Error('fixture build failed')
        outputFixture(
          plan.appRoot,
          identity(plan.request.worker, plan.request.targetName, plan.request.mode, plan.target),
        )
      }
    },
    print() {
      events.push('print')
    },
    invalidate(path) {
      events.push('invalidate')
      if (existsSync(path)) rmSync(path)
    },
    stamp(...args) {
      events.push('stamp')
      return stampWorkerArtifact(...args)
    },
    verify(...args) {
      events.push('verify')
      return verifyWorkerArtifact(...args)
    },
    writeBotConfig(path, target, artifact, root) {
      events.push('bot-deploy-config')
      const config = createBotPrebuiltDeploymentConfig(target, artifact, root)
      expect(config.main).toBe(artifact.entrypoint)
      expect(config.no_bundle).toBe(true)
      expect(config.find_additional_modules).toBe(true)
      expect(config.migrations.map(migration => migration.tag)).toEqual(['v3', 'v4', 'v5'])
      expect(config.keep_vars).toBe(target.bot.keepVars)
      expect(config.rules.flatMap(rule => rule.globs).sort()).toEqual(Object.keys(artifact.modules).sort())
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(config))
    },
  }
}

describe('Worker lifecycle command selection', () => {
  test('requires an explicit target, restricts forwarded options, and never deploys development builds', () => {
    expect(() => parseWorkerRequest(['build', 'bot'])).toThrow('CIVUP_TARGET')
    expect(() => parseWorkerRequest(['deploy', 'activity', '--target', 'standard', '--mode', 'development'])).toThrow(
      'cannot be deployed',
    )
    expect(() => parseWorkerRequest(['live', 'activity', '--target', 'standard', '--', '--remote'])).toThrow(
      'Unsupported',
    )
    expect(() => parseWorkerRequest(['build', 'activity', '--target', 'standard', '--prebuilt'])).toThrow(
      'only supported',
    )
    expect(parseWorkerRequest(['build', 'bot', '--target', 'ppl']).mode).toBe('production')
    expect(parseWorkerRequest(['live', 'activity', '--target', 'standard', '--', '--force']).mode).toBe('development')
  })

  test('uses the explicit Node Wrangler and Vite+ builders with the selected account and mode', () => {
    for (const worker of ['bot', 'activity'] as const) {
      const plan = createWorkerPlan(parseWorkerRequest(['build', worker, '--target', 'ppl']), fixturePplTarget)
      const command = plan.steps.find(step => step.kind === 'command')!
      expect(command.kind).toBe('command')
      if (command.kind !== 'command') throw new Error('Missing build command')
      expect(command.cmd[0]).toBe('node')
      expect(command.cmd[3]!.replaceAll('\\', '/')).toEndWith(
        worker === 'bot' ? '/wrangler/bin/cf-wrangler.js' : '/vite-plus/bin/vp',
      )
      expect(command.cmd.slice(4)).toEqual(['build', '--mode', 'production'])
      expect(command.env.CLOUDFLARE_ACCOUNT_ID).toBe(fixturePplTarget.accountId)
      expect(command.env.CLOUDFLARE_ACCOUNT_ID).not.toBe(cloudflareTargets.standard.accountId)
      expect(command.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe('false')
    }
  })

  test('shares persistence and preserves fixed local ports and cached versus live Activity', () => {
    const bot = createWorkerPlan(parseWorkerRequest(['dev', 'bot', '--target', 'standard']), cloudflareTargets.standard)
    const botCommand = bot.steps[0]!
    if (botCommand.kind !== 'command') throw new Error('Missing local command')
    expect(botCommand.cmd).toContain('--experimental-new-config')
    expect(botCommand.cmd).toContain('--local')
    expect(botCommand.cmd[botCommand.cmd.indexOf('--port') + 1]).toBe('8787')
    expect(botCommand.cmd[botCommand.cmd.indexOf('--persist-to') + 1]).toBe(resolve('apps/bot/.wrangler/state'))
    expect(botCommand.cmd).not.toContain('--config')
    for (const action of ['preview', 'live'] as const) {
      const activity = createWorkerPlan(
        parseWorkerRequest([action, 'activity', '--target', 'standard']),
        cloudflareTargets.standard,
      )
      expect(activity.steps.some(step => step.kind === 'verify')).toBe(action === 'preview')
      const command = activity.steps.find(step => step.kind === 'command')!
      if (command.kind !== 'command') throw new Error('Missing local command')
      expect(command.cmd.slice(4, 5)).toEqual([action === 'live' ? 'dev' : 'preview'])
      expect(command.cmd[command.cmd.indexOf('--port') + 1]).toBe('5173')
      expect(command.cmd).toContain('--strictPort')
    }
  })

  test('builds, stamps, verifies, then deploys; bot adapter never rebuilds', async () => {
    for (const worker of ['activity', 'bot'] as const) {
      const plan = fixturePlan(['deploy', worker, '--target', 'standard'])
      const events: string[] = []
      await executeWorkerPlan(plan, lifecycleRuntime(plan, events))
      expect(events).toEqual([
        'invalidate',
        'build',
        'stamp',
        'verify',
        ...(worker === 'bot' ? ['bot-deploy-config'] : []),
        'deploy',
      ])
      const command = plan.steps.at(-1)!
      if (command.kind !== 'command') throw new Error('Missing deploy command')
      expect(command.cmd).toContain(worker === 'bot' ? '--no-bundle' : '--prebuilt')
    }
  })

  test('prebuilt skips building, and a failed build or verification never reaches deployment', async () => {
    const plan = fixturePlan(['deploy', 'activity', '--target', 'standard', '--prebuilt'])
    const events: string[] = []
    await expect(executeWorkerPlan(plan, lifecycleRuntime(plan, events))).rejects.toThrow('build is missing')
    expect(events).toEqual(['verify'])
    outputFixture(plan.appRoot, identity())
    stampWorkerArtifact(plan.appRoot, identity())
    events.length = 0
    await executeWorkerPlan(plan, lifecycleRuntime(plan, events))
    expect(events).toEqual(['verify', 'deploy'])
    const rebuild = fixturePlan(['deploy', 'bot', '--target', 'ppl'])
    outputFixture(rebuild.appRoot, identity('bot', 'ppl'))
    stampWorkerArtifact(rebuild.appRoot, identity('bot', 'ppl'))
    events.length = 0
    await expect(executeWorkerPlan(rebuild, lifecycleRuntime(rebuild, events, true))).rejects.toThrow(
      'fixture build failed',
    )
    expect(events).toEqual(['invalidate', 'build'])
    expect(existsSync(join(rebuild.appRoot, buildStampRelativePath))).toBe(false)
  })

  test('command preview returns before artifact reads/writes, config generation, or child execution', async () => {
    const plan = fixturePlan(['deploy', 'bot', '--target', 'ppl', '--print-commands'])
    const events: string[] = []
    await executeWorkerPlan(plan, lifecycleRuntime(plan, events))
    expect(events).toEqual(['print'])
  })

  test('the actual CLI preview works offline and does not print inherited credentials', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/cloudflare-worker.ts', 'deploy', 'bot', '--target', 'ppl', '--prebuilt', '--print-commands'],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          CIVUP_LOCAL_TARGETS_FILE: fixtureLocalTargetsFile,
          CLOUDFLARE_API_TOKEN: 'fixture-secret-do-not-print',
          DISCORD_TOKEN: 'fixture-secret-do-not-print',
        },
      },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('fixture-secret-do-not-print')
    const plan = JSON.parse(result.stdout) as WorkerPlan
    expect(plan.target.accountId).toBe(fixturePplTarget.accountId)
    expect(plan.steps.map(step => step.kind)).toEqual(['verify', 'bot-deploy-config', 'command'])
  })
})

describe('checked Worker artifacts', () => {
  test('refuses CSS placeholders, missing utilities, or CSS not linked by index.html', () => {
    for (const mutation of ['placeholder', 'utilities', 'link'] as const) {
      const root = temporaryDirectory()
      const fixture = outputFixture(root, identity())
      const assetsRoot = join(fixture.workerRoot, 'assets')
      if (mutation === 'placeholder')
        writeFileSync(
          join(assetsRoot, 'client.css'),
          '#--unocss--{layer:__ALL__}.grid{display:grid}.flex{display:flex}',
        )
      if (mutation === 'utilities')
        writeFileSync(join(assetsRoot, 'client.css'), '@font-face { font-family: fixture; }')
      if (mutation === 'link') writeFileSync(join(assetsRoot, 'index.html'), '<script src="client.js"></script>')
      expect(() => stampWorkerArtifact(root, identity())).toThrow('missing its layout styles')
    }
  })

  test('the installed Wrangler reader accepts the derived no-bundle adapter with exact module rules', () => {
    const root = temporaryDirectory()
    const build = identity('bot', 'ppl')
    outputFixture(root, build)
    const artifact = stampWorkerArtifact(root, build)
    const config = createBotPrebuiltDeploymentConfig(build.target, artifact, resolve('.'))
    const configPath = join(root, 'prebuilt-wrangler.json')
    writeFileSync(configPath, JSON.stringify(config))
    const appRequire = createRequire(resolve('apps/bot/package.json'))
    const script = `const wrangler = require(${JSON.stringify(appRequire.resolve('wrangler'))}); const config = wrangler.unstable_readConfig({ config: process.argv[1] }, { hideWarnings: true }); console.log(JSON.stringify({ main: config.main, account: config.account_id, noBundle: config.no_bundle, baseDir: config.base_dir, additional: config.find_additional_modules, rules: config.rules, tags: config.migrations.map(item => item.tag), keepVars: config.keep_vars }));`
    const result = spawnSync('node', ['-e', script, configPath], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    })
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.main).toBe(artifact.entrypoint)
    expect(parsed.account).toBe(build.target.accountId)
    expect(parsed.noBundle).toBe(true)
    expect(parsed.baseDir).toBe(artifact.bundleDirectory)
    expect(parsed.additional).toBe(true)
    expect(parsed.rules).toEqual(config.rules)
    expect(parsed.tags).toEqual(['v3', 'v4', 'v5'])
    expect(parsed.keepVars).toBe(build.target.bot.keepVars)
  })

  test('accepts Vite build metadata and resolves partial JS manifests without making them deployable modules', () => {
    const root = temporaryDirectory()
    const fixture = outputFixture(root, identity())
    const configPath = join(fixture.workerRoot, 'worker.config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.manifest = { type: 'partial', mainModule: 'index.js', modules: {} }
    writeFileSync(configPath, JSON.stringify(config))
    mkdirSync(join(fixture.bundleRoot, '.vite'))
    writeFileSync(join(fixture.bundleRoot, '.vite/manifest.json'), '{}')
    writeFileSync(join(fixture.bundleRoot, 'chunk.js'), 'export const fixture = true')
    const artifact = stampWorkerArtifact(root, identity())
    expect(artifact.modules).toEqual({ 'chunk.js': { type: 'esm' }, 'index.js': { type: 'esm' } })
    expect(verifyWorkerArtifact(root, identity()).entrypoint).toBe(artifact.entrypoint)
  })

  test('rejects wrong targets even when both Workers have the same names', () => {
    const root = temporaryDirectory()
    outputFixture(root, identity())
    stampWorkerArtifact(root, identity())
    expect(() => verifyWorkerArtifact(root, identity('activity', 'ppl'))).toThrow('different target')
    const changedAccount = { ...cloudflareTargets.standard, accountId: fixturePplTarget.accountId }
    expect(() => verifyWorkerArtifact(root, identity('activity', 'standard', 'production', changedAccount))).toThrow(
      'different target',
    )
  })

  test('rejects changed account, browser ID, settings, duplicate Workers, or missing Worker/assets', () => {
    for (const mutation of ['account', 'browser', 'settings', 'duplicate', 'entrypoint', 'assets'] as const) {
      const root = temporaryDirectory()
      const fixture = outputFixture(root, identity())
      stampWorkerArtifact(root, identity())
      if (mutation === 'account')
        writeFileSync(
          join(fixture.outputRoot, 'config.json'),
          JSON.stringify({
            accountId: fixturePplTarget.accountId,
            buildContext: { mode: 'production', isPreview: false },
          }),
        )
      if (mutation === 'browser')
        writeFileSync(
          join(fixture.workerRoot, 'assets', browserBuildMetadataFile),
          JSON.stringify({
            target: 'standard',
            mode: 'production',
            browserApplicationId: fixturePplTarget.discord.applicationId,
          }),
        )
      if (mutation === 'settings') {
        const path = join(fixture.workerRoot, 'worker.config.json')
        const worker = JSON.parse(readFileSync(path, 'utf8'))
        worker.env.BOT.worker = 'another-bot'
        writeFileSync(path, JSON.stringify(worker))
      }
      if (mutation === 'duplicate') mkdirSync(join(fixture.outputRoot, 'workers/another'))
      if (mutation === 'entrypoint') rmSync(join(fixture.bundleRoot, 'index.js'))
      if (mutation === 'assets') rmSync(join(fixture.workerRoot, 'assets/index.html'))
      expect(() => verifyWorkerArtifact(root, identity())).toThrow()
    }
  })

  test('hashes catch changed assets and added files, and target config changes invalidate stamps', () => {
    const root = temporaryDirectory()
    const fixture = outputFixture(root, identity())
    stampWorkerArtifact(root, identity())
    writeFileSync(join(fixture.workerRoot, 'assets/client.js'), 'changed after build')
    expect(() => verifyWorkerArtifact(root, identity())).toThrow('files changed')
    outputFixture(root, identity())
    stampWorkerArtifact(root, identity())
    writeFileSync(join(fixture.workerRoot, 'assets/extra.txt'), 'unverified extra asset')
    expect(() => verifyWorkerArtifact(root, identity())).toThrow('files changed')
    const target = {
      ...cloudflareTargets.standard,
      discord: { ...cloudflareTargets.standard.discord, guildId: '123456789012345678' },
    }
    expect(() => verifyWorkerArtifact(root, identity('activity', 'standard', 'production', target))).toThrow(
      'settings changed',
    )
  })

  test('development artifacts cannot substitute for production, including dev Discord IDs', () => {
    const root = temporaryDirectory()
    const dev = identity('activity', 'standard', 'development')
    outputFixture(root, dev, '100000000000000000')
    stampWorkerArtifact(root, dev)
    expect(verifyWorkerArtifact(root, dev).browserApplicationId).toBe('100000000000000000')
    expect(() => verifyWorkerArtifact(root, identity())).toThrow('different build mode')
    expect(JSON.parse(readFileSync(join(root, buildStampRelativePath), 'utf8')).mode).toBe('development')
  })

  test('checks binary modules, DO exports, path traversal, and local environment files', () => {
    for (const mutation of ['wasm', 'font', 'export', 'traversal', 'env'] as const) {
      const root = temporaryDirectory()
      const build = identity('bot')
      const fixture = outputFixture(root, build)
      if (mutation === 'wasm') writeFileSync(join(fixture.bundleRoot, 'renderer.wasm'), 'not wasm')
      if (mutation === 'font') rmSync(join(fixture.bundleRoot, 'hash-inter-latin-400-normal.woff2'))
      if (mutation === 'export') writeFileSync(join(fixture.bundleRoot, 'index.js'), 'export default {}')
      if (mutation === 'env') writeFileSync(join(fixture.bundleRoot, '.dev.vars'), 'FIXTURE_ONLY=true')
      if (mutation === 'traversal') {
        const path = join(fixture.workerRoot, 'worker.config.json')
        const worker = JSON.parse(readFileSync(path, 'utf8'))
        worker.manifest.modules['../outside.wasm'] = { type: 'wasm' }
        writeFileSync(path, JSON.stringify(worker))
      }
      expect(() => stampWorkerArtifact(root, build)).toThrow()
    }
  })
})
