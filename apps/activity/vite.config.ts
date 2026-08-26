import type { Plugin } from 'vite'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { cloudflare } from '@cloudflare/vite-plugin'
import { createGenerator } from 'unocss'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
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
      if (eqIdx > 0) {
        vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
      }
    }
    return vars
  }
  catch {
    return {}
  }
}

function loadProductionDiscordClientId(): string {
  const configPath = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH ?? 'wrangler.json'
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, configPath), 'utf-8')) as {
    vars?: { DISCORD_CLIENT_ID?: unknown }
  }
  return typeof config.vars?.DISCORD_CLIENT_ID === 'string' ? config.vars.DISCORD_CLIENT_ID.trim() : ''
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
        }
        catch (error) {
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

      const assetUrl = `/${relative(resolve(import.meta.dirname, 'public'), absolutePath).split(sep).join('/')}`
      const revision = createHash('sha1').update(readFileSync(absolutePath)).digest('hex').slice(0, 10)
      revisions[assetUrl] = revision
    }
  }

  return revisions
}

const assetRevisionMap = buildAssetRevisionMap()

export default defineConfig(({ command, mode }) => {
  const discordClientId = mode === 'development'
    ? (process.env.DISCORD_CLIENT_ID ?? loadDevVars().DISCORD_CLIENT_ID ?? '').trim()
    : loadProductionDiscordClientId()
  if (!discordClientId) throw new Error('DISCORD_CLIENT_ID is required to build the Activity')

  return {
    envDir: false,
    build: {
      outDir: 'dist/client',
    },
    resolve: {
      alias: [
        { find: /^solid-js$/, replacement: 'solid-js/dist/solid.js' },
        { find: /^solid-js\/web$/, replacement: 'solid-js/web/dist/web.js' },
        { find: /^solid-js\/store$/, replacement: 'solid-js/store/dist/store.js' },
        { find: '~', replacement: resolve(import.meta.dirname, 'src') },
      ],
    },
    server: {
      allowedHosts: [
        'activity-dev.rettend.me',
      ],
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store',
      },
    },
    optimizeDeps: {
      exclude: ['solid-js', 'solid-js/web', 'solid-js/store', '@solidjs/router'],
    },
    define: {
      '__ASSET_REVISION_MAP__': JSON.stringify(assetRevisionMap),
      'import.meta.env.VITE_DISCORD_CLIENT_ID': JSON.stringify(discordClientId),
    },
    plugins: [
      UnoCSS(),
      devUnoCssLink(),
      solid({ dev: false, hot: false }),
      ...(command === 'serve' ? [cloudflare()] : []),
    ],
  }
})
