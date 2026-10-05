// Credential-free, two-environment build used by activity-css.test.ts. Never
// starts a dev server or loads the Activity's target data, source, or env files.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBuilder, createLogger } from 'vite-plus'
import { activityClientBuildEnvironment, readActivityBuildStyles } from '../scripts/cloudflare-worker/activity-build.ts'

const activityRoot = fileURLToPath(new URL('../apps/activity/', import.meta.url))
const appImportBase = pathToFileURL(join(activityRoot, 'package.json')).href
// The Node fixture enables the parent-URL resolver so app-only dependencies
// resolve through their public ESM exports, not a private package entry path.
const { cloudflare } = await import(import.meta.resolve('@cloudflare/vite-plugin', appImportBase))
const { default: UnoCSS } = await import(import.meta.resolve('unocss/vite', appImportBase))
const { presetWind4 } = await import(import.meta.resolve('unocss', appImportBase))
const temporaryRoot = join(tmpdir(), 'opencode')
await mkdir(temporaryRoot, { recursive: true })
const root = await mkdtemp(join(temporaryRoot, 'activity-css-build-'))

try {
  await writeFile(join(root, 'package.json'), '{"name":"activity-css-fixture","type":"module"}')
  await writeFile(
    join(root, 'cloudflare.config.ts'),
    `export default {
    worker: {
      name: 'activity-css-fixture',
      entrypoint: 'worker.js',
      compatibilityDate: '2026-10-01',
      env: { ASSETS: { type: 'assets' } },
      assets: { notFoundHandling: 'single-page-application' },
    },
  }`,
  )
  await writeFile(
    join(root, 'worker.js'),
    'export default { fetch(request, env) { return env.ASSETS.fetch(request) } }',
  )
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><head></head><body><main class="grid grid-cols-2 gap-3"></main><script type="module" src="/main.jsx"></script></body></html>',
  )
  await writeFile(
    join(root, 'main.jsx'),
    'import "virtual:uno.css"; document.querySelector("main").classList.add("flex", "items-center"); import("./lazy.jsx")',
  )
  await writeFile(join(root, 'lazy.jsx'), 'export const classes = "sm:grid-cols-3 bg-red-500"')

  const warnings: string[] = []
  const logger = createLogger('silent')
  logger.warn = message => {
    warnings.push(message)
  }
  const builder = await createBuilder({
    root,
    configFile: false,
    envDir: false,
    logLevel: 'silent',
    customLogger: logger,
    environments: { client: activityClientBuildEnvironment(root) },
    plugins: [
      UnoCSS({
        configFile: false,
        presets: [presetWind4()],
        preflights: [{ getCSS: () => ':root { --activity-css-fixture: 1; }' }],
      }),
      cloudflare({
        remoteBindings: false,
        persistState: false,
        experimental: { newConfig: { cfBuildOutput: true, types: { generate: false } } },
      }),
    ],
  })
  await builder.buildApp()

  const assetsRoot = activityClientBuildEnvironment(root).build!.outDir!
  const { html, stylesheets, css } = readActivityBuildStyles(assetsRoot)
  const worker = await readFile(join(root, '.cloudflare/output/v0/workers/default/bundle/index.js'), 'utf8')
  process.stdout.write(`${JSON.stringify({ html, stylesheets, css, warnings, hasWorker: worker.includes('fetch') })}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
