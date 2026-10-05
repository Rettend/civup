import type { CloudflareTarget, CloudflareTargetName, CloudflareWorker } from '../../config/cloudflare-targets.ts'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { OutputRootConfigSchema, OutputWorkerSchema } from '@cloudflare/config'
import { createActivityCloudflareConfig, createBotCloudflareConfig, createBotLegacyDeploymentConfig } from '../../config/cloudflare-workers.ts'
import { assertActivityBuildStyles } from './activity-build.ts'

export type WorkerBuildMode = 'development' | 'production'
export const browserBuildMetadataFile = 'civup-browser-build.json'
export const buildStampRelativePath = '.cloudflare/civup-build.json'

export interface BuildIdentity {
  targetName: CloudflareTargetName
  target: CloudflareTarget
  worker: CloudflareWorker
  mode: WorkerBuildMode
}

interface BuildStamp {
  version: 1
  target: CloudflareTargetName
  accountId: string
  worker: CloudflareWorker
  workerName: string
  mode: WorkerBuildMode
  browserApplicationId: string | null
  configurationHash: string
  files: Record<string, string>
}

type OutputWorker = ReturnType<typeof OutputWorkerSchema.parse>
type ModuleType = NonNullable<OutputWorker['manifest']>['modules'][string]['type']

export interface WorkerArtifact {
  outputRoot: string
  bundleDirectory: string
  entrypoint: string
  modules: Record<string, { type: ModuleType }>
  browserApplicationId: string | null
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function expectedConfiguration(identity: BuildIdentity) {
  return identity.worker === 'bot' ? createBotCloudflareConfig(identity.target) : createActivityCloudflareConfig(identity.target)
}

function configurationHash(identity: BuildIdentity): string {
  return sha256(canonicalJson({
    config: expectedConfiguration(identity),
    ...(identity.worker === 'bot' ? { legacy: createBotLegacyDeploymentConfig(identity.target) } : {}),
  }))
}

// Build Output v0 paths and partial-manifest inference match the pinned
// @cloudflare/build-output-utils 0.8.5 reader. Validate with its public schemas.
export function inspectWorkerArtifact(appRoot: string, identity: BuildIdentity): WorkerArtifact {
  const outputRoot = resolve(appRoot, '.cloudflare/output/v0')
  const root = OutputRootConfigSchema.parse(readJson(join(outputRoot, 'config.json')))
  if (root.accountId !== identity.target.accountId) throw new Error('The build belongs to a different Cloudflare account. Build again for the selected target.')
  if (root.buildContext.mode !== identity.mode || root.buildContext.isPreview) throw new Error('The build mode does not match. Build again with the requested mode.')
  const workersRoot = join(outputRoot, 'workers')
  const workerDirectories = readdirSync(workersRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  if (workerDirectories.length !== 1 || workerDirectories[0] !== 'default') throw new Error('Expected exactly one default Worker in the build. Build again before deploying.')
  const containersRoot = join(outputRoot, 'containers')
  if (existsSync(containersRoot) && readdirSync(containersRoot).length) throw new Error('Unexpected containers in the Worker build.')
  const workerRoot = join(workersRoot, 'default')
  const worker = OutputWorkerSchema.parse(readJson(join(workerRoot, 'worker.config.json')))
  const { entrypoint: _entrypoint, ...expectedWorker } = expectedConfiguration(identity).worker
  const { manifest, ...actualWorker } = worker
  if (canonicalJson(actualWorker) !== canonicalJson(OutputWorkerSchema.parse(expectedWorker))) throw new Error('The built Worker settings do not match the selected target. Build again before deploying.')
  if (!manifest) throw new Error('The build is missing its Worker entrypoint. Build the Worker and its assets together.')
  const bundleDirectory = join(workerRoot, 'bundle')
  const bundleFiles = listFiles(bundleDirectory)
  const inferred = manifest.type === 'partial'
    ? Object.fromEntries(bundleFiles.filter(file => /\.(?:m?js|map)$/.test(file)).map(file => [file, { type: file.endsWith('.map') ? 'sourcemap' as const : 'esm' as const }]))
    : {}
  const modules = { ...inferred, ...manifest.modules }
  if (modules[manifest.mainModule]?.type !== 'esm') throw new Error('The build has no ES module Worker entrypoint.')
  for (const name of Object.keys(modules)) {
    safeModulePath(bundleDirectory, name)
    if (!bundleFiles.includes(name) || lstatSync(safeModulePath(bundleDirectory, name)).size === 0) throw new Error(`A built Worker module is missing or empty: ${name}`)
  }
  // Vite's client/server dependency manifest is build metadata, not an upload
  // module. Include it in the artifact hashes, but not Wrangler module rules.
  if (bundleFiles.some(file => !Object.hasOwn(modules, file) && !(identity.worker === 'activity' && file === '.vite/manifest.json'))) throw new Error('The Worker bundle contains files outside its module manifest.')
  const entrypoint = safeModulePath(bundleDirectory, manifest.mainModule)
  if (identity.worker === 'bot') {
    const wasm = Object.entries(modules).filter(([, module]) => module.type === 'wasm')
    if (!wasm.length || wasm.some(([name]) => readFileSync(safeModulePath(bundleDirectory, name)).subarray(0, 4).toString('hex') !== '0061736d')) throw new Error('The bot build is missing its WASM module.')
    for (const weight of ['400', '700', '900'])
      if (!Object.entries(modules).some(([name, module]) => module.type === 'data' && name.endsWith(`inter-latin-${weight}-normal.woff2`))) throw new Error(`The bot build is missing its ${weight}-weight font.`)
    const source = readFileSync(entrypoint, 'utf8')
    const exportLists = [...source.matchAll(/export\s*\{([^}]+)\}/g)].map(match => match[1]).join(',')
    for (const name of Object.keys(createBotCloudflareConfig(identity.target).worker.exports))
      if (!new RegExp(`(?:^|,)\\s*(?:\\w+\\s+as\\s+)?${name}\\s*(?:,|$)`).test(exportLists)) throw new Error(`The bot build does not export ${name}.`)
    return { outputRoot, bundleDirectory, entrypoint, modules, browserApplicationId: null }
  }
  const assetsRoot = join(workerRoot, 'assets')
  const assets = listFiles(assetsRoot)
  if (!assets.includes('index.html') || !assets.some(file => file.endsWith('.js')) || !assets.some(file => file.endsWith('.css'))) throw new Error('The Activity build is missing its browser assets.')
  assertActivityBuildStyles(assetsRoot)
  const metadata = readJson(join(assetsRoot, browserBuildMetadataFile)) as Record<string, unknown>
  if (metadata.target !== identity.targetName || metadata.mode !== identity.mode || typeof metadata.browserApplicationId !== 'string' || !metadata.browserApplicationId) throw new Error('The Activity browser build does not match the selected target or mode.')
  if (identity.mode === 'production' && metadata.browserApplicationId !== identity.target.discord.applicationId) throw new Error('The Activity browser build uses a different Discord application. Build again for the selected target.')
  return { outputRoot, bundleDirectory, entrypoint, modules, browserApplicationId: metadata.browserApplicationId }
}

export function safeModulePath(directory: string, name: string): string {
  const result = resolve(directory, name)
  if (isAbsolute(name) || name.includes('\\') || result === directory || !result.startsWith(`${directory}${sep}`) || name.split('/').some(part => part === '..' || part === '.')) throw new Error('A Worker module path escapes its build directory.')
  return result
}

function listFiles(root: string): string[] {
  const pending = [root]
  const files: string[] = []
  while (pending.length) {
    const directory = pending.pop()!
    if (!lstatSync(directory).isDirectory()) throw new Error('The build directory is missing or invalid.')
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Worker build output must not contain symbolic links.')
      if (entry.isDirectory()) {
        pending.push(path)
      }
      else if (entry.isFile()) {
        if (/^\.(?:dev\.vars|env)(?:\.|$)/.test(entry.name)) throw new Error('Worker build output must not contain local environment files.')
        files.push(relative(root, path).split(sep).join('/'))
      }
      else {
        throw new Error('Worker build output contains an unsupported file.')
      }
    }
  }
  return files.sort()
}

function fileHashes(root: string): Record<string, string> {
  return Object.fromEntries(listFiles(root).map(file => [file, sha256(readFileSync(safeModulePath(root, file)))]))
}

export function stampWorkerArtifact(appRoot: string, identity: BuildIdentity): WorkerArtifact {
  const artifact = inspectWorkerArtifact(appRoot, identity)
  const stamp: BuildStamp = {
    version: 1,
    target: identity.targetName,
    accountId: identity.target.accountId,
    worker: identity.worker,
    workerName: identity.target.workers[identity.worker],
    mode: identity.mode,
    browserApplicationId: artifact.browserApplicationId,
    configurationHash: configurationHash(identity),
    files: fileHashes(artifact.outputRoot),
  }
  writeFileSync(join(appRoot, buildStampRelativePath), `${JSON.stringify(stamp, null, 2)}\n`)
  return artifact
}

export function verifyWorkerArtifact(appRoot: string, identity: BuildIdentity): WorkerArtifact {
  const stampPath = join(appRoot, buildStampRelativePath)
  if (!existsSync(stampPath)) throw new Error('The checked Worker build is missing. Run the build command before using --prebuilt or preview.')
  const stamp = readJson(stampPath) as BuildStamp
  if (stamp.version !== 1 || stamp.target !== identity.targetName || stamp.accountId !== identity.target.accountId || stamp.worker !== identity.worker || stamp.workerName !== identity.target.workers[identity.worker]) throw new Error('The prebuilt Worker belongs to a different target, account, or Worker. Build again for the selected target.')
  if (stamp.mode !== identity.mode) throw new Error('The prebuilt Worker uses a different build mode. Build again with the requested mode.')
  if (stamp.configurationHash !== configurationHash(identity)) throw new Error('Worker settings changed since the build. Build again before using this artifact.')
  const artifact = inspectWorkerArtifact(appRoot, identity)
  if (artifact.browserApplicationId !== stamp.browserApplicationId || canonicalJson(fileHashes(artifact.outputRoot)) !== canonicalJson(stamp.files)) throw new Error('Worker build files changed after verification. Build again before using this artifact.')
  return artifact
}

export function createBotPrebuiltDeploymentConfig(target: CloudflareTarget, artifact: WorkerArtifact, repoRoot: string) {
  const config = createBotLegacyDeploymentConfig(target)
  const ruleTypes = { esm: 'ESModule', cjs: 'CommonJS', wasm: 'CompiledWasm', text: 'Text', data: 'Data', json: 'Text' } as const
  const rules = Object.entries(artifact.modules).filter(([, module]) => module.type !== 'sourcemap').map(([name, module]) => {
    if (!(module.type in ruleTypes) || /[?*[\]{}]/.test(name)) throw new Error('The bot build contains a module unsupported by the prebuilt Wrangler adapter.')
    return { type: ruleTypes[module.type as keyof typeof ruleTypes], globs: [name], fallthrough: true }
  })
  return {
    ...config,
    main: artifact.entrypoint,
    base_dir: artifact.bundleDirectory,
    no_bundle: true,
    find_additional_modules: true,
    rules,
    d1_databases: config.d1_databases.map(database => Object.assign({}, database, { migrations_dir: resolve(repoRoot, target.d1.migrationsDirectory) })),
  }
}
