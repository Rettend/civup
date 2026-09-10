import { mkdir, writeFile } from 'node:fs/promises'
import { createDb } from '@civup/db'
import { initializeSeasonCheckpointPage, type RatingCheckpoint } from '../src/services/season/checkpoints.ts'
import { initializeQualityCheckpointPage } from '../src/services/ranked/quality-checkpoint.ts'
import { advanceCivReleaseProjection } from '../src/services/leaderboard/civ-release.ts'
import { refreshHistoricalStandings } from '../src/services/season/standings.ts'
import { normalizeCivLeaderboardDisplayConfig } from '../src/services/leaderboard/civ-snapshot.ts'

const options = new Map<string, string>()
let execute = false
for (let index = 2; index < Bun.argv.length; index++) {
  const key = Bun.argv[index]!
  if (key === '--execute' && !execute) { execute = true; continue }
  if (!['--config', '--output', '--max-estimated-writes', '--max-reads'].includes(key) || options.has(key) || !Bun.argv[index + 1] || Bun.argv[index + 1]!.startsWith('--')) throw new Error('Invalid option.')
  options.set(key, Bun.argv[++index]!)
}
const configPath = options.get('--config'), output = options.get('--output')
if (!configPath || !output) throw new Error('Provide --config wrangler.jsonc --output fresh-audit-directory. Preparation requires --execute and paused reporting.')
const configText = await Bun.file(configPath).text()
const accountId = configText.match(/"account_id"\s*:\s*"([^"]+)"/)?.[1]
const databaseId = configText.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1]
if (!accountId || !databaseId || !Bun.env.CLOUDFLARE_API_TOKEN) throw new Error('Load the Cloudflare credentials and a config identifying the account and database.')
const ceiling = Number(options.get('--max-estimated-writes') ?? 250000)
const readCeiling = Number(options.get('--max-reads') ?? 5_000_000)
if (!Number.isSafeInteger(ceiling) || ceiling <= 0 || !Number.isSafeInteger(readCeiling) || readCeiling <= 0) throw new Error('Invalid usage ceiling.')
await mkdir(output, { recursive: false })
let requests = 0, rowsRead = 0, rowsWritten = 0, generation: number | undefined
const save = (name: string, value: unknown) => writeFile(`${output}/${name}`, JSON.stringify(value, null, 2), { flag: 'wx' })
type Statement = { sql: string, params: unknown[] }
async function submit(batch: Statement[]) {
  const writing = batch.some(row => !/^select\b/i.test(row.sql.trim()))
  if (writing && (!execute || generation == null)) throw new Error('Writes require --execute and a captured paused generation.')
  if (writing && rowsWritten + 5000 > ceiling) throw new Error('The conservative next-batch estimate exceeds the write ceiling. Resume with a new audit directory and an explicit ceiling.')
  if (rowsRead >= readCeiling) throw new Error('The metered read ceiling was reached. Resume with a new audit directory after reviewing usage.')
  const guarded = writing ? [{ sql: `SELECT CASE WHEN EXISTS(SELECT 1 FROM rating_maintenance WHERE state='paused' AND generation=?) AND NOT EXISTS(SELECT 1 FROM rating_mutation_leases) THEN 1 ELSE json_extract('Maintenance changed','$') END`, params: [generation] }, ...batch] : batch
  const number = ++requests
  await save(`${number}.request.json`, { accountId, databaseId, at: Date.now(), batch: guarded, outcome: 'unknown until a response is recorded' })
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/raw`, {
    method: 'POST', headers: { Authorization: `Bearer ${Bun.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: guarded }), signal: AbortSignal.timeout(120000),
  })
  const payload = await response.json() as any
  await save(`${number}.response.json`, { status: response.status, payload })
  if (!response.ok || !payload.success || payload.result?.length !== guarded.length || payload.result.some((row: any) => !row.success)) throw new Error('Database outcome was not confirmed. Inspect the saved request and response before resuming.')
  for (const row of payload.result) {
    if (!Number.isSafeInteger(row.meta?.rows_read) || !Number.isSafeInteger(row.meta?.rows_written)) throw new Error('Database metering is incomplete; inspect the saved response.')
    rowsRead += row.meta.rows_read
    rowsWritten += row.meta.rows_written
  }
  return writing ? payload.result.slice(1) : payload.result
}
function prepare(sql: string, params: unknown[] = []): any {
  const statement = { sql, params }
  return { ...statement, bind: (...values: unknown[]) => prepare(sql, values),
    raw: async () => (await submit([statement]))[0].results.rows,
    all: async () => {
      const result = (await submit([statement]))[0]
      return { ...result, results: result.results.rows.map((row: unknown[]) => Object.fromEntries(result.results.columns.map((name: string, index: number) => [name, row[index]]))) }
    }, run: async () => (await submit([statement]))[0],
  }
}
const db = createDb({ prepare, batch: async (batch: Statement[]) => (await submit(batch)).map((result: any) => ({ ...result,
  results: result.results.rows.map((row: unknown[]) => Object.fromEntries(result.results.columns.map((name: string, index: number) => [name, row[index]]))),
})) } as unknown as D1Database)
const query = async (sql: string, params: unknown[] = []) => (await prepare(sql, params).all()).results as any[]
const [maintenance] = await query('SELECT state,generation,(SELECT count(*) FROM rating_mutation_leases) AS writers FROM rating_maintenance WHERE id=1')
await save('source.json', { accountId, databaseId, maintenance, execute, ceiling, readCeiling })
if (!execute) {
  await save('status.json', await query("SELECT 'rating chains' AS kind,count(*) AS remaining FROM public_rating_seeds s JOIN seasons season ON season.id=s.season_id WHERE season.rating_system='rp' AND NOT EXISTS(SELECT 1 FROM season_checkpoint_initializations i WHERE i.season_id=s.season_id AND i.player_id=s.player_id AND i.mode=s.mode AND i.complete=1)"))
}
else {
  if (maintenance?.state !== 'paused' || maintenance.writers !== 0) throw new Error('Pause reporting and wait for admitted writers before preparation.')
  generation = maintenance.generation
  let chainCursor = ['', '', '']
  for (;;) {
    const chains = await query("SELECT s.season_id,s.player_id,s.mode FROM public_rating_seeds s JOIN seasons season ON season.id=s.season_id JOIN season_rating_states r ON r.season_id=s.season_id AND r.player_id=s.player_id AND r.mode=s.mode WHERE (s.season_id,s.player_id,s.mode)>(?,?,?) AND season.rating_system='rp' AND EXISTS(SELECT 1 FROM player_rating_events e WHERE e.season_id=s.season_id AND e.player_id=s.player_id AND e.mode=s.mode) AND NOT EXISTS(SELECT 1 FROM season_checkpoint_initializations i WHERE i.season_id=s.season_id AND i.player_id=s.player_id AND i.mode=s.mode AND i.complete=1 AND i.source_revision=r.revision) ORDER BY s.season_id,s.player_id,s.mode LIMIT 100", chainCursor)
    if (!chains.length) break
    for (const chain of chains) {
      while (!await initializeSeasonCheckpointPage(db, chain.season_id, chain.player_id, chain.mode as RatingCheckpoint['mode'], generation!)) { /* Resume from the saved page. */ }
      chainCursor = [chain.season_id, chain.player_id, chain.mode]
    }
  }
  let playerCursor = ['', '']
  for (;;) {
    const players = await query("SELECT p.guild_id,r.player_id FROM division_rank_policies p JOIN player_ratings r ON r.mode='global' LEFT JOIN division_rank_states s ON s.guild_id=p.guild_id AND s.player_id=r.player_id WHERE (p.guild_id,r.player_id)>(?,?) AND p.phase='active' AND json_extract(s.result_json,'$.recent') IS NULL AND NOT EXISTS(SELECT 1 FROM division_quality_initializations i WHERE i.guild_id=p.guild_id AND i.player_id=r.player_id AND i.complete=1) ORDER BY p.guild_id,r.player_id LIMIT 100", playerCursor)
    if (!players.length) break
    for (const player of players) {
      while (!await initializeQualityCheckpointPage(db, player.guild_id, player.player_id, Date.now())) { /* Resume from the saved page. */ }
      playerCursor = [player.guild_id, player.player_id]
    }
  }
  const child = Bun.spawn(['bun', 'x', 'wrangler', 'kv', 'key', 'get', 'leaderboard:civ:config', '--binding', 'KV', '--config', configPath, '--remote'], { stdout: 'pipe', stderr: 'inherit' })
  const text = await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error('Could not capture the civ leaderboard configuration.')
  const release = normalizeCivLeaderboardDisplayConfig(JSON.parse(text))
  await save('release-config.json', release)
  if (release?.betaReplacement === 'one-for-one') {
    while (!await advanceCivReleaseProjection(db, release)) { /* Consume the next contribution page. */ }
  }
  while (await refreshHistoricalStandings(db)) { /* Publish the next changed season. */ }
  await save('completed.json', { accountId, databaseId, generation, rowsRead, rowsWritten, requests })
}
// eslint-disable-next-line no-console
console.log(JSON.stringify({ output, executed: execute, rowsRead, rowsWritten, requests }))
