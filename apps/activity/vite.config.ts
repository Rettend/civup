import type { Plugin } from 'vite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { cloudflare } from '@cloudflare/vite-plugin'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

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

function extractCssFromJsModule(js: string): string | null {
  const match = js.match(/__vite__css\s*=\s*"([\s\S]*?)"/)
  if (match?.[1]) {
    return match[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return null
}

function devUnoCssLink(): Plugin {
  return {
    name: 'dev-unocss-link',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use('/__dev/uno.css', async (_req, res) => {
        try {
          const result = await server.transformRequest('virtual:uno.css')
          const css = result?.code ? extractCssFromJsModule(result.code) : null

          res.setHeader('Content-Type', 'text/css')
          res.setHeader('Cache-Control', 'no-store')
          res.end(css ?? '/* UnoCSS: no styles extracted */')
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

const devVars = loadDevVars()

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value != null && value !== '') return value
  }
  return ''
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

const viteDiscordClientId = firstNonEmpty(process.env.VITE_DISCORD_CLIENT_ID, process.env.DISCORD_CLIENT_ID, devVars.DISCORD_CLIENT_ID)
const viteActivityHost = firstNonEmpty(process.env.VITE_ACTIVITY_HOST, devVars.VITE_ACTIVITY_HOST)
const assetRevisionMap = buildAssetRevisionMap()

export default defineConfig({
  resolve: {
    alias: {
      '~': resolve(import.meta.dirname, 'src'),
    },
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
  define: {
    '__ASSET_REVISION_MAP__': JSON.stringify(assetRevisionMap),
    'import.meta.env.VITE_DISCORD_CLIENT_ID': JSON.stringify(viteDiscordClientId),
    'import.meta.env.VITE_ACTIVITY_HOST': JSON.stringify(viteActivityHost),
  },
  plugins: [
    UnoCSS(),
    devUnoCssLink(),
    solid(),
    cloudflare(),
  ],
})
