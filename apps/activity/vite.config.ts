import type { Plugin } from 'vite'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { cloudflare } from '@cloudflare/vite-plugin'
import solid from '@solidjs/vite-plugin'
import { createGenerator } from 'unocss'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite-plus'
import { cloudflareLocalPersistenceDirectory, resolveCloudflareTarget } from '../../config/cloudflare-targets'
import { activityClientBuildEnvironment } from '../../scripts/cloudflare-worker/activity-build'
import { browserBuildMetadataFile } from '../../scripts/cloudflare-worker/artifacts'
import unoConfig from './uno.config'

type UnoGenerator = Awaited<ReturnType<typeof createGenerator>>

function loadDevVars(): Record<string, string> {
  try {
    const content = readFileSync('.dev.vars', 'utf-8')
    const vars: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx > 0) vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
    }
    return vars
  } catch {
    return {}
  }
}

function browserBuildIdentity(target: string, mode: string, browserApplicationId: string): Plugin {
  return {
    name: 'civup-browser-build-identity',
    apply: 'build',
    generateBundle() {
      if (this.environment.name !== 'client') return
      this.emitFile({
        type: 'asset',
        fileName: browserBuildMetadataFile,
        source: JSON.stringify({ target, mode, browserApplicationId }),
      })
    },
  }
}

function devUnoCssLink(): Plugin {
  let generator: UnoGenerator | null = null

  return {
    name: 'dev-unocss-link',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use('/__dev/uno.css', async (_req, res) => {
        try {
          generator ??= await createGenerator(unoConfig)
          const { css } = await generator.generate(await collectDevUnoTokens(generator), { preflights: true })

          res.setHeader('Content-Type', 'text/css')
          res.setHeader('Cache-Control', 'no-store')
          res.end(css)
        } catch (error) {
          console.error('[dev-unocss-link] Failed to serve UnoCSS:', error)
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/css')
          res.end(`/* UnoCSS extraction error: ${error} */`)
        }
      })
    },

    transformIndexHtml() {
      return [
        {
          tag: 'link',
          attrs: { rel: 'stylesheet', href: '/__dev/uno.css' },
          injectTo: 'head',
        },
      ]
    },
  }
}

async function collectDevUnoTokens(generator: UnoGenerator): Promise<Set<string>> {
  const tokens = new Set<string>()
  const files = [resolve(import.meta.dirname, 'index.html')]

  collectUnoSourceFiles(resolve(import.meta.dirname, 'src'), files)
  for (const file of files) {
    const extracted = await generator.applyExtractors(readFileSync(file, 'utf-8'), file)
    for (const token of extracted) tokens.add(token)
  }
  return tokens
}

function collectUnoSourceFiles(path: string, files: string[]) {
  const entries = readdirSync(path, { withFileTypes: true })
  for (const entry of entries) {
    const absolutePath = resolve(path, entry.name)
    if (entry.isDirectory()) {
      collectUnoSourceFiles(absolutePath, files)
      continue
    }

    if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|html|css)$/.test(entry.name)) continue
    files.push(absolutePath)
  }
}

function buildAssetRevisionMap(): Record<string, string> {
  const assetRoot = resolve(import.meta.dirname, 'public/assets')
  const revisions: Record<string, string> = {}
  const pending = [assetRoot]

  while (pending.length > 0) {
    const currentDir = pending.pop()
    if (!currentDir) continue

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = resolve(currentDir, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
        continue
      }

      if (!entry.isFile()) continue

      const assetUrl = `/${relative(resolve(import.meta.dirname, 'public'), absolutePath)
        .split(sep)
        .join('/')}`
      const revision = createHash('sha1').update(readFileSync(absolutePath)).digest('hex').slice(0, 10)
      revisions[assetUrl] = revision
    }
  }

  return revisions
}

const assetRevisionMap = buildAssetRevisionMap()

export default defineConfig(({ mode }) => {
  if (mode !== 'development' && mode !== 'production')
    throw new Error('Choose development or production for the Activity build mode.')
  const target = resolveCloudflareTarget(process.env.CIVUP_TARGET, {
    localTargetsFile: process.env.CIVUP_LOCAL_TARGETS_FILE,
  })
  const discordClientId =
    mode === 'development'
      ? (process.env.DISCORD_CLIENT_ID ?? loadDevVars().DISCORD_CLIENT_ID ?? '').trim()
      : target.discord.applicationId
  if (!discordClientId) throw new Error('DISCORD_CLIENT_ID is required to build the Activity')

  return {
    envDir: false,
    environments: {
      client: activityClientBuildEnvironment(import.meta.dirname),
    },
    resolve: {
      alias: [{ find: '~', replacement: resolve(import.meta.dirname, 'src') }],
      dedupe: ['solid-js', '@solidjs/web'],
    },
    server: {
      port: 5173,
      strictPort: true,
      allowedHosts: ['activity-dev.rettend.me'],
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store',
      },
    },
    preview: { host: '0.0.0.0', port: 5173, strictPort: true },
    optimizeDeps: {
      exclude: ['solid-js', '@solidjs/web', '@solidjs/router'],
    },
    define: {
      '__ASSET_REVISION_MAP__': JSON.stringify(assetRevisionMap),
      'import.meta.env.VITE_DISCORD_CLIENT_ID': JSON.stringify(discordClientId),
    },
    plugins: [
      UnoCSS(),
      devUnoCssLink(),
      solid(),
      browserBuildIdentity(process.env.CIVUP_TARGET!, mode, discordClientId),
      cloudflare({
        remoteBindings: false,
        persistState: { path: resolve(import.meta.dirname, '../..', cloudflareLocalPersistenceDirectory) },
        experimental: { newConfig: { cfBuildOutput: true, types: { generate: false } } },
      }),
    ],
  }
})
