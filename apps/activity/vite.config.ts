import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

const devVars = loadDevVars()

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
  },
  define: {
    'import.meta.env.VITE_BOT_HOST': JSON.stringify(devVars.BOT_HOST ?? ''),
    'import.meta.env.VITE_PARTY_HOST': JSON.stringify(devVars.PARTY_HOST ?? ''),
    'import.meta.env.VITE_DISCORD_CLIENT_ID': JSON.stringify(devVars.DISCORD_CLIENT_ID ?? ''),
  },
  plugins: [
    UnoCSS(),
    solid(),
    cloudflare(),
  ],
})
