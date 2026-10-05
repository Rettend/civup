import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

interface CssBuildResult {
  html: string
  stylesheets: string[]
  css: string
  warnings: string[]
  hasWorker: boolean
}

function buildFixture(): CssBuildResult {
  const script = fileURLToPath(new URL('./activity-css.fixture.node.ts', import.meta.url))
  const result = spawnSync('node', ['--experimental-import-meta-resolve', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    timeout: 120_000,
    // Do not inherit Cloudflare or Discord credentials into the build fixture.
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: process.env.TEMP,
      USERPROFILE: process.env.TEMP,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      CF_TELEMETRY: 'false',
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
      DO_NOT_TRACK: '1',
    },
  })
  expect(result.status, result.stderr || String(result.error ?? '')).toBe(0)
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as CssBuildResult
}

describe('Activity utility CSS in Cloudflare Build Output', () => {
  test('index loads generated grid, layout, lazy-route and responsive CSS with no placeholder', () => {
    const result = buildFixture()
    expect(result.hasWorker).toBe(true)
    expect(result.stylesheets.length).toBeGreaterThan(0)
    expect(result.warnings).toEqual([])
    expect(result.css).not.toContain('#--unocss--')
    expect(result.css).toMatch(/\.grid\s*\{[^}]*display:\s*grid/)
    expect(result.css).toMatch(/\.flex\s*\{[^}]*display:\s*flex/)
    expect(result.css).toMatch(/\.grid-cols-2\s*\{[^}]*grid-template-columns:\s*repeat\(2/)
    expect(result.css).toMatch(/\.gap-3\s*\{[^}]*gap:/)
    expect(result.css).toContain('.sm\\:grid-cols-3')
    expect(result.css).toContain('.bg-red-500')
    expect(result.css).toContain('--activity-css-fixture:1')
  }, 30_000)
})
