import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCloudflareLocalTargets } from '../../../config/cloudflare-targets.ts'
import { createMaintenanceClient, maintenanceCacheKey } from '../scripts/maintenance-cloudflare.ts'

// These operational scripts stay ignored. A clean checkout does not need them.
const experimentsUrl = new URL('../../../ppl/ppl-leader-rank-experiments.ts', import.meta.url).href
const experiments = existsSync(fileURLToPath(experimentsUrl)) ? await import(experimentsUrl) : null
const leaderId = 'china-yongle'
const row = { player_id: 'fixture-player', picks: 10, wins: 6 }
const fixtureTargetOptions = {
  localTargets: loadCloudflareLocalTargets(
    fileURLToPath(new URL('../../../tests/cloudflare-targets.fixture.json', import.meta.url).href),
  ),
}

function fixture(target: 'standard' | 'ppl', allowRead = false) {
  let calls = 0
  const runtime = createMaintenanceClient({ target }, 'remote', fixtureTargetOptions, {
    env: {},
    runner() {
      calls++
      if (!allowRead) throw new Error('Unexpected storage request in cache-only verification')
      return { exitCode: 0, stdout: JSON.stringify([{ success: true, results: [row], meta: {} }]), stderr: '' }
    },
  })
  return { runtime, calls: () => calls }
}

describe.skipIf(!experiments)('leader experiment cache boundary', () => {
  test('ignores both old cache layouts without making a storage request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode', 'leader-rank-legacy-'))
    const { runtime, calls } = fixture('ppl')
    const options = { config: 'ppl', database: 'civup', cacheDir: root, live: false }
    try {
      await mkdir(join(root, leaderId))
      const old = JSON.stringify({ generatedAt: 'fixture', source: { database: 'civup', leaderId }, rows: [row] })
      await writeFile(join(root, leaderId, 'source.json'), old)
      await writeFile(join(root, `civup-${leaderId}.json`), old)
      await expect(experiments!.loadLeaderRows(leaderId, options, runtime)).rejects.toThrow('Missing matching')
      expect(calls()).toBe(0)
      expect(await readFile(join(root, leaderId, 'source.json'), 'utf8')).toBe(old)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('checks cached identity and leader even inside the selected cache directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode', 'leader-rank-identity-'))
    const { runtime, calls } = fixture('ppl')
    const options = { config: 'ppl', database: 'civup', cacheDir: root, live: false }
    const source = { ...runtime.provenance, leaderId }
    const cachePath = join(root, maintenanceCacheKey(runtime.provenance), leaderId, 'source.json')
    try {
      await mkdir(dirname(cachePath), { recursive: true })
      for (const field of ['accountId', 'databaseId', 'namespaceId', 'location', 'target', 'leaderId']) {
        await writeFile(cachePath, JSON.stringify({ source: { ...source, [field]: 'wrong' }, rows: [row] }))
        await expect(experiments!.loadLeaderRows(leaderId, options, runtime)).rejects.toThrow('Missing matching')
      }
      await writeFile(cachePath, JSON.stringify({ source: { database: 'civup', leaderId }, rows: [row] }))
      await expect(experiments!.loadLeaderRows(leaderId, options, runtime)).rejects.toThrow('Missing matching')
      await writeFile(cachePath, JSON.stringify({ source, rows: [row] }))
      expect(await experiments!.loadLeaderRows(leaderId, options, runtime)).toEqual({ source: 'cache', rows: [row] })
      expect(calls()).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('writes provenance after a fixture read and isolates same-name target databases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode', 'leader-rank-write-'))
    const ppl = fixture('ppl', true)
    const standard = fixture('standard')
    const options = { config: 'ppl', database: 'civup', cacheDir: root, live: true }
    try {
      expect(ppl.runtime.selection.d1.name).toBe(standard.runtime.selection.d1.name)
      expect(await experiments!.loadLeaderRows(leaderId, options, ppl.runtime)).toEqual({ source: 'live', rows: [row] })
      const cachePath = join(root, maintenanceCacheKey(ppl.runtime.provenance), leaderId, 'source.json')
      const saved = JSON.parse(await readFile(cachePath, 'utf8'))
      expect(saved.source).toEqual({ ...ppl.runtime.provenance, leaderId })
      expect(ppl.calls()).toBe(1)
      expect(await experiments!.loadLeaderRows(leaderId, options, ppl.runtime)).toEqual({
        source: 'cache',
        rows: [row],
      })
      expect(ppl.calls()).toBe(1)
      await expect(
        experiments!.loadLeaderRows(leaderId, { ...options, live: false }, standard.runtime),
      ).rejects.toThrow('Missing matching')
      expect(standard.calls()).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
