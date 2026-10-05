import process from 'node:process'
import { defineConfig } from 'drizzle-kit'
import { resolveLocalD1SqlitePath } from '../../apps/bot/scripts/local-storage.ts'

export default defineConfig({
  schema: './src/schema',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolveLocalD1SqlitePath({ override: process.env.DRIZZLE_DB_URL }),
  },
})
