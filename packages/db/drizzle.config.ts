import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'drizzle-kit'

const d1StateDir = resolve(
  process.cwd(),
  '../../apps/bot/.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
)

function resolveDbUrl(): string {
  if (process.env.DRIZZLE_DB_URL) return process.env.DRIZZLE_DB_URL

  if (existsSync(d1StateDir)) {
    const sqliteFiles = readdirSync(d1StateDir)
      .filter(file => file.endsWith('.sqlite'))
      .sort((a, b) => b.localeCompare(a))

    const latest = sqliteFiles[0]
    if (latest) return resolve(d1StateDir, latest)
  }

  throw new Error(
    `Could not find local D1 sqlite file. Run \`nr bot:migrate\` first, or set DRIZZLE_DB_URL. Searched: ${d1StateDir}`,
  )
}

export default defineConfig({
  schema: './src/schema',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolveDbUrl(),
  },
})
