/* eslint-disable no-console */
import { mkdir, readdir, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Database as Sqlite } from 'bun:sqlite'
import { createDb, divisionRankPolicies, matches, matchParticipants, players, publicRatingCalibrations, seasonRatingConfigurations, seasons } from '@civup/db'
import { calibratePublicRatings, PUBLIC_RATING_BANDS, PUBLIC_RATING_FORMULA_VERSION } from '@civup/rating'
import { eq } from 'drizzle-orm'
import { getPlatformProxy } from 'wrangler'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'
import * as currentReport from '../../src/services/season/report.ts'
import * as currentReplay from '../../src/services/season/replay.ts'
import * as currentCiv from '../../src/services/leaderboard/civ-snapshot.ts'
import * as currentStandings from '../../src/services/season/standings.ts'
import { initializeSeasonCheckpointPage } from '../../src/services/season/checkpoints.ts'
import { initializeQualityCheckpointPage } from '../../src/services/ranked/quality-checkpoint.ts'
import { advanceCivReleaseProjection } from '../../src/services/leaderboard/civ-release.ts'

// Service/D1 benchmark only. No Discord, HTTP routes, or remote bindings.
const root = resolve(import.meta.dir, '../../../..')
const output = resolve(Bun.env.READ_MODEL_OUTPUT ?? `${root}/tmp/read-model-benchmark-${Date.now()}`)
const baseline = `${output}/baseline/apps/bot/src`
const sizes = (Bun.env.READ_MODEL_SIZES ?? '50,1000').split(',').map(Number)
if (sizes.some(n => !Number.isSafeInteger(n) || n < 5 || n > 2000)) throw new Error('Use history sizes from 5 to 2000.')
await mkdir(output, { recursive: false })
await mkdir(`${output}/baseline`)
for (const command of [['git', 'archive', '--format=tar', `--output=${output}/baseline.tar`, '7a0c1f01', 'apps/bot/src'], ['tar', '-xf', `${output}/baseline.tar`, '-C', `${output}/baseline`]]) {
  const child = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited) throw new Error('Could not extract the baseline service sources.')
}
for (const path of ['node_modules', 'packages', 'apps/bot/node_modules']) await symlink(`${root}/${path}`, `${output}/baseline/${path}`, process.platform === 'win32' ? 'junction' : 'dir')
const loadOld = (name: string) => import(pathToFileURL(`${baseline}/services/${name}.ts`).href)
const old = { report: await loadOld('season/report'), replay: await loadOld('season/replay'), civ: await loadOld('leaderboard/civ-snapshot'), standings: await loadOld('season/standings') }
const current = { report: currentReport, replay: currentReplay, civ: currentCiv, standings: currentStandings }
const newTables = new Set(['season_rating_checkpoints', 'season_checkpoint_initializations', 'division_quality_initializations', 'civ_release_projections', 'civ_release_members', 'civ_release_dirty'])
const migrations = (await readdir(`${root}/packages/db/migrations`)).filter(name => /^\d+.*\.sql$/.test(name)).sort()
const sqlValue = (v: unknown): string => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`
const quote = (v: string) => `"${v.replaceAll('"', '""')}"`
const at = (i: number) => 1_800_000_000_000 + i * 1000
const config = currentCiv.normalizeCivLeaderboardDisplayConfig({ version: 1, label: 'Benchmark release', liveFrom: 1000, betaFrom: 0, betaUntil: 1000, pendingBetaFrom: 1000,
  betaReplacement: 'one-for-one', betaSeedMatchIds: Array.from({ length: 80 }, (_, i) => `beta-${i}`) })
const results: any[] = []

async function addMatch(db: ReturnType<typeof createDb>, id: string, time: number) {
  await db.insert(matches).values({ id, seasonId: 's9', gameMode: '1v1', createdAt: time, status: 'active', draftData: JSON.stringify({ completedAt: time + 1 }) })
  await db.insert(matchParticipants).values(['p', 'q'].map((playerId, team) => ({ matchId: id, playerId, team, placement: team + 1 })))
  const [match] = await db.select().from(matches).where(eq(matches.id, id))
  return { match: match!, participants: await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, id)), acceptedAt: time + 1, now: time + 1, opponentTierByPlayerId: new Map<string, string>() }
}

async function fixture(size: number) {
  const { db: original, sqlite } = await createTestDatabase()
  const db = new Proxy(original, { get(target, key) {
    if (key === 'batch') return async (queries: any[]) => sqlite.transaction(() => queries.map(q => q.run()))()
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  try {
    await db.insert(players).values(['p', 'q'].map(id => ({ id, displayName: id, createdAt: 0 })))
    await db.insert(seasons).values([{ id: 's9', seasonNumber: 9, name: 'S9', startsAt: 1000, active: true, ratingSystem: 'rp', isolatedRatingsEnabled: true, publicReadsEnabled: true },
      { id: 's8', seasonNumber: 8, name: 'S8', startsAt: 0, endsAt: 999, isolatedRatingsEnabled: true }])
    for (const scope of ['global', 'duel']) {
      const calibration = calibratePublicRatings({ scope, version: `bench-${scope}`, sourceDigest: 'synthetic-benchmark', qualifiedHiddenScores: Array.from({ length: 101 }, (_, i) => i) })
      await db.insert(publicRatingCalibrations).values({ ...calibration, calibration, createdAt: 1000 })
      await db.insert(seasonRatingConfigurations).values({ seasonId: 's9', mode: scope, formulaVersion: PUBLIC_RATING_FORMULA_VERSION, calibrationVersion: calibration.version })
    }
    await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 's9', version: 'best-mode-one-division-v2', phase: 'active', updatedAt: 1000,
      configJson: JSON.stringify({ preparation: { unrankedRoleId: 'unranked', roleIdsByMinimum: Object.fromEntries(PUBLIC_RATING_BANDS.map(b => [b.minimum, `role-${b.minimum}`])) } }) })
    for (let i = 0; i < size; i++) {
      const input = await addMatch(db, `history-${i}`, at(i))
      await old.report.runAtomicSeasonBatch(db, (await old.report.prepareSeasonReport(db, input)).queries)
      await db.update(matches).set({ status: 'completed', completedAt: input.acceptedAt }).where(eq(matches.id, input.match.id))
    }
    sqlite.exec(`INSERT INTO season_rating_states(season_id,player_id,mode,mu,sigma,evidence,updated_at) SELECT 's8',player_id,mode,mu,sigma,evidence,updated_at FROM season_rating_states WHERE season_id='s9'`)
    for (let i = 0; i < size; i++) {
      const id = `historical-player-${String(i).padStart(5, '0')}`
      sqlite.run('INSERT INTO players(id,display_name,created_at) VALUES(?,?,?)', [id, id, 0])
      for (const mode of ['duel', 'global']) sqlite.run('INSERT INTO season_rating_states(season_id,player_id,mode,mu,sigma,evidence,updated_at) VALUES(?,?,?,?,?,?,?)',
        ['s8', id, mode, 20 + i % 30, 3, '{"gamesPlayed":100,"effectiveGames":100}', 999])
    }
    for (let i = 0; i < size + 80; i++) {
      const beta = i < 80, id = beta ? `beta-${i}` : `civ-${i}`
      sqlite.run('INSERT INTO matches(id,game_mode,status,created_at) VALUES(?,?,?,?)', [id, '1v1', 'completed', beta ? 0 : 1000])
      sqlite.run('INSERT INTO match_civ_stat_contributions(match_id,completed_match_count,contributions_json,source,mode_scope,completed_at,visible,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        [id, 1, JSON.stringify({ version: 2, poolCivIds: ['rome-trajan', 'greece-pericles'], entries: [{ civId: i % 2 ? 'rome-trajan' : 'greece-pericles', picks: 1, wins: 1, bans: 1 }] }), beta ? 'beta' : 'live', ['duel', 'duo', 'squad'][i % 3]!, beta ? i : at(i), 1, at(i)])
    }
    const lines: string[] = ['PRAGMA defer_foreign_keys=ON;']
    const rowsByTable: Array<{ name: string, rows: Record<string, unknown>[] }> = []
    const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
    const first = ['players', 'seasons', 'matches', 'public_rating_calibrations', 'public_rating_seeds', 'division_rank_policies']
    tables.sort((a, b) => (first.includes(a.name) ? first.indexOf(a.name) : 100) - (first.includes(b.name) ? first.indexOf(b.name) : 100))
    // Remove migration defaults before restoring the same captured rows.
    lines.push('DELETE FROM rating_maintenance;')
    for (const { name } of tables) {
      if (newTables.has(name)) continue
      const rows = sqlite.query(`SELECT * FROM ${quote(name)}`).all() as Record<string, unknown>[]
      if (rows.length) rowsByTable.push({ name, rows })
      for (let offset = 0; offset < rows.length; offset += 50) {
        const page = rows.slice(offset, offset + 50)
        lines.push(`INSERT OR REPLACE INTO ${quote(name)}(${Object.keys(page[0]!).map(quote).join(',')}) VALUES ${page.map(row => `(${Object.values(row).map(sqlValue).join(',')})`).join(',')};`)
      }
    }
    return { data: lines.join('\n'), rowsByTable, triggers: sqlite.query("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all() as { name: string, sql: string }[] }
  }
  finally { sqlite.close() }
}

function tracked(binding: D1Database) {
  let calls: any[] = []
  const record = async (sql: string, params: unknown[], kind: string, work: () => Promise<any>) => {
    const start = performance.now()
    try {
      const result = await work()
      calls.push({ sql, params, kind, ms: performance.now() - start, returnedRows: Array.isArray(result) ? result.length : result.results?.length ?? 0, meta: result.meta ?? null })
      return result
    }
    catch (error) { calls.push({ sql, params, kind, error: String(error) }); throw error }
  }
  const wrap = (sql: string, params: unknown[] = []): any => {
    const native = binding.prepare(sql).bind(...params)
    return { native, sql, params, bind: (...values: unknown[]) => wrap(sql, values),
      raw: (...args: any[]) => record(sql, params, 'raw', () => native.raw(...args)),
      all: () => record(sql, params, 'all', () => native.all()),
      run: () => record(sql, params, 'run', () => native.run()),
    }
  }
  const db = createDb({ prepare: wrap, batch: async (statements: any[]) => {
    const start = performance.now()
    const rows = await binding.batch(statements.map(s => s.native))
    rows.forEach((result, i) => calls.push({ sql: statements[i].sql, params: statements[i].params, kind: 'batch', ms: null, returnedRows: result.results?.length ?? 0, meta: result.meta }))
    calls.push({ kind: 'batch-timing', ms: performance.now() - start })
    return rows
  } } as unknown as D1Database)
  return { db, reset: () => { calls = [] }, calls: () => calls }
}

async function run(size: number, variant: 'before' | 'after', captured: Awaited<ReturnType<typeof fixture>>) {
  const directory = `${output}/${size}-${variant}`
  await mkdir(directory)
  const configPath = `${directory}/wrangler.json`
  await Bun.write(configPath, JSON.stringify({ name: 'local-read-model-benchmark', compatibility_date: '2026-09-01', d1_databases: [{ binding: 'DB', database_name: 'benchmark', database_id: '00000000-0000-0000-0000-000000000001' }] }))
  const schema = (await Promise.all(migrations.filter(name => Number(name.slice(0, 4)) <= 32).map(name => Bun.file(`${root}/packages/db/migrations/${name}`).text()))).join('\n')
  const triggers = captured.triggers.filter(t => !t.name.startsWith('civ_release_'))
  await Bun.write(`${directory}/fixture.sql`, `${schema}\n${triggers.map(t => `DROP TRIGGER ${quote(t.name)};`).join('\n')}`)
  await Bun.write(`${directory}/fixture-data.sql`, captured.data)
  const command = Bun.spawn(['bun', 'x', 'wrangler', 'd1', 'execute', 'benchmark', '--local', '--config', configPath, '--persist-to', `${directory}/state`, '--file', `${directory}/fixture.sql`], { cwd: `${root}/apps/bot`, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exit] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited])
  await Bun.write(`${directory}/import.log`, stdout + stderr)
  if (exit) throw new Error(`Local D1 import failed: ${directory}/import.log`)
  // Parameterized fixture inserts avoid exhausting the installed workerd SQL statement cache
  // with thousands of distinct literal INSERTs. Keep every statement within 100 bindings.
  const importer = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: `${directory}/state/v3` }, remoteBindings: false })
  try {
    await importer.env.DB.prepare('DELETE FROM rating_maintenance').run()
    for (const { name, rows } of captured.rowsByTable) {
      const columns = Object.keys(rows[0]!)
      const count = Math.max(1, Math.floor(100 / columns.length))
      let batch: D1PreparedStatement[] = []
      for (let i = 0; i < rows.length; i += count) {
        const page = rows.slice(i, i + count)
        const sql = `INSERT OR REPLACE INTO ${quote(name)}(${columns.map(quote).join(',')}) VALUES ${page.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`
        batch.push(importer.env.DB.prepare(sql).bind(...page.flatMap(row => columns.map(column => row[column]))))
        if (batch.length === 20) { await importer.env.DB.batch(batch); batch = [] }
      }
      if (batch.length) await importer.env.DB.batch(batch)
    }
    for (let i = 0; i < triggers.length; i += 5) await importer.env.DB.batch(triggers.slice(i, i + 5).map(t => importer.env.DB.prepare(t.sql)))
  }
  finally { await importer.dispose() }
  const beforeSchemaBytes = await storageBytes()
  if (variant === 'after') {
    const upgrade = (await Promise.all(migrations.filter(name => Number(name.slice(0, 4)) > 32).map(name => Bun.file(`${root}/packages/db/migrations/${name}`).text()))).join('\n')
    await Bun.write(`${directory}/upgrade.sql`, upgrade)
    const start = performance.now()
    const child = Bun.spawn(['bun', 'x', 'wrangler', 'd1', 'execute', 'benchmark', '--local', '--config', configPath, '--persist-to', `${directory}/state`, '--file', `${directory}/upgrade.sql`, '--json'], { cwd: `${root}/apps/bot`, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    await Bun.write(`${directory}/upgrade.log`, stdout + stderr)
    if (code) throw new Error(`Local schema upgrade failed: ${directory}/upgrade.log`)
    results.push({ size, variant, name: 'schema-upgrade', cliElapsedMs: performance.now() - start, note: 'Includes Wrangler startup; applied to the populated baseline database.' })
  }
  const platform = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: `${directory}/state/v3` }, remoteBindings: false })
  const binding = platform.env.DB
  const tracker = tracked(binding), db = tracker.db, api = variant === 'before' ? old : current
  const snapshots: Record<string, unknown> = {}
  async function measure(name: string, work: () => Promise<unknown>, allowFailure = false) {
    tracker.reset()
    const start = performance.now()
    let value: unknown, error: string | null = null
    try { value = await work() }
    catch (caught) {
      if (!allowFailure) throw caught
      error = String(caught)
    }
    const elapsedMs = performance.now() - start, trace = tracker.calls()
    const statements = trace.filter(c => c.sql)
    const row = { size, variant, name, error, elapsedMs, statements: statements.length, returnedRows: statements.reduce((n, c) => n + c.returnedRows, 0),
      metaStatements: statements.filter(c => c.meta).length, localMetaRowsWritten: statements.reduce((n, c) => n + (c.meta?.rows_written ?? 0), 0) }
    results.push(row)
    const explained = new Set<string>()
    for (const call of statements) {
      if (call.kind !== 'raw' || (call.returnedRows <= 20 && !call.sql.includes('max(e.public_sequence)')) || explained.has(call.sql)) continue
      explained.add(call.sql)
      try { call.queryPlan = (await binding.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).bind(...call.params).all()).results }
      catch (error) { call.queryPlanError = String(error) }
    }
    await Bun.write(`${directory}/${name}.trace.json`, JSON.stringify(trace, null, 2))
    console.log(row)
    return value
  }
  const state = async () => {
    const tables = ['player_ratings', 'season_rating_states', 'player_rating_events', 'division_rank_states', 'division_quality_credits']
    return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await binding.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).all()).results])))
  }
  async function storageBytes() {
    let bytes = 0
    for (const file of await readdir(`${directory}/state`, { recursive: true })) {
      if (!file.endsWith('.sqlite')) continue
      const local = new Sqlite(`${directory}/state/${file}`, { readonly: true })
      try { bytes += Number((local.query('PRAGMA page_count').get() as any).page_count) * Number((local.query('PRAGMA page_size').get() as any).page_size) }
      finally { local.close() }
    }
    return bytes
  }
  try {
    const initialBytes = await storageBytes()
    if (variant === 'after') await measure('preparation', async () => {
      await binding.prepare("UPDATE rating_maintenance SET state='paused', generation=1").run()
      for (const player of ['p', 'q']) for (const mode of ['duel', 'global'] as const) while (!await initializeSeasonCheckpointPage(db, 's9', player, mode, 1)) { /* bounded pages */ }
      while (!await advanceCivReleaseProjection(db, config)) { /* bounded pages */ }
      while (await currentStandings.refreshHistoricalStandings(db)) { /* changed seasons */ }
      await binding.prepare("UPDATE rating_maintenance SET state='open', generation=2").run()
    })
    const preparedBytes = await storageBytes()
    results.push({ size, variant, name: 'storage', beforeSchemaBytes, initialBytes, preparedBytes })
    for (let sample = 0; sample < 3; sample++) {
      const input = await addMatch(db, `new-${sample}`, at(size + sample))
      await measure(`report-${sample}`, async () => api.report.runAtomicSeasonBatch(db, (await api.report.prepareSeasonReport(db, input)).queries))
      await db.update(matches).set({ status: 'completed', completedAt: input.acceptedAt }).where(eq(matches.id, input.match.id))
    }
    snapshots.report = await state()
    await measure('correction', async () => api.report.runAtomicSeasonBatch(db, (await api.replay.prepareSeasonReplay(db, 's9', { matchId: `history-${size - 2}`, cancel: true }, at(size + 5))).queries))
    snapshots.correction = await state()
    await measure('civ-maintenance-after-reports', async () => {
      if (variant === 'after') while (!await advanceCivReleaseProjection(db, config)) { /* pending report/correction invalidations */ }
    })
    const civ = async () => {
      if (variant === 'after') while (!await advanceCivReleaseProjection(db, config)) { /* bounded pages */ }
      const kv = createTestKv()
      await api.civ.setCivLeaderboardDisplayConfig(kv, config)
      return api.civ.rebuildCivLeaderboardSnapshots(db, kv, ['all', 'duel', 'duo', 'squad'], at(size + 5))
    }
    snapshots.civ = [...await measure('civ-refresh', civ) as Map<string, unknown>]
    await binding.prepare("UPDATE matches SET status='cancelled' WHERE id='civ-80'").run()
    snapshots.civCancelled = [...await measure('civ-cancel-refresh', civ) as Map<string, unknown>]
    snapshots.historical = await measure('historical-cold', () => api.standings.loadSeasonStandings(db, createTestKv(), 's8'))
    await measure('historical-kv-loss', () => api.standings.loadSeasonStandings(db, createTestKv(), 's8'))
    // A missing existing-player checkpoint is initialization work, measured separately from normal reports.
    await binding.prepare("UPDATE division_rank_states SET result_json=NULL WHERE player_id='p'").run()
    const quality = variant === 'before' ? await loadOld('ranked/quality-checkpoint') : await import('../../src/services/ranked/quality-checkpoint.ts')
    await measure('quality-initialize', async () => {
      if (variant === 'after') while (!await initializeQualityCheckpointPage(db, 'guild', 'p', at(size + 5))) { /* bounded pages */ }
      const prepared = await quality.prepareQualityCheckpoint(db, 'guild', 'p', at(size + 5))
      snapshots.quality = prepared.recent
      await api.report.runAtomicSeasonBatch(db, prepared.queries)
    }, true)
    await Bun.write(`${directory}/outputs.json`, JSON.stringify(snapshots, null, 2))
    return snapshots
  }
  finally { await platform.dispose() }
}

for (const size of sizes) {
  const data = await fixture(size)
  const before = await run(size, 'before', data)
  const after = await run(size, 'after', data)
  // Version 2 adds graph distributions; closing positions and recorded peaks must agree exactly.
  const historical = after.historical as any
  delete historical.graphScores
  for (const key of ['report', 'correction', 'civ', 'civCancelled', 'historical']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error(`Output mismatch: size ${size}, ${key}. Inspect outputs.json.`)
  }
  for (const key of ['effectiveGames', 'highRankWins', 'eliteWins']) if (Math.abs((before.quality as any)[key] - (after.quality as any)[key]) > 1e-7) throw new Error(`Quality mismatch: ${key}`)
  await Bun.write(`${output}/results.json`, JSON.stringify({ baseline: '7a0c1f01', engine: 'Wrangler getPlatformProxy / local D1', fixture: 'synthetic; active divisions; two-player rated history; mixed-scope civ contributions; historical population grows with fixture size',
    limitations: 'Service JavaScript runs in Bun; D1 executes in workerd. Timings include the local binding bridge. raw() does not expose D1 metadata; returned rows are not billed reads. No production cost claims.', results }, null, 2))
}
console.log(`Saved comparison: ${output}/results.json`)
