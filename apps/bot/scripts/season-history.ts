import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

interface HistorySource {
  accountId: string
  databaseId: string
  seasons: Array<{ id: string }>
  matches: Array<{ id: string, createdAt: number, seasonId: string | null }>
}

const configPath = resolve(import.meta.dir, '../wrangler.ppl.jsonc')
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const guard = (condition: string) => `SELECT CASE WHEN ${condition} THEN 1 ELSE json_extract('Stale season history source', '$') END AS valid`

export function prepareSeasonEightHistory(source: HistorySource) {
  if (!source.accountId || !source.databaseId || !Array.isArray(source.seasons) || source.seasons.length) throw new Error('Historical initialization requires a database with no seasons.')
  if (!Array.isArray(source.matches) || !source.matches.length) throw new Error('No historical games were supplied.')
  const matches = [...source.matches].sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(matches.map(row => row.id)).size !== matches.length || matches.some(row => !row.id || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || row.seasonId !== null)) throw new Error('History contains duplicate games, invalid dates, or an existing season assignment.')
  const startsAt = Math.min(...matches.map(row => row.createdAt))
  const statements = [guard(`NOT EXISTS(SELECT 1 FROM seasons) AND (SELECT count(*) FROM matches) = ${matches.length}`)]
  for (let offset = 0; offset < matches.length; offset += 300) {
    const expected = JSON.stringify(matches.slice(offset, offset + 300).map(row => [row.id, row.createdAt]))
    statements.push(guard(`NOT EXISTS(SELECT 1 FROM json_each(${quote(expected)}) expected LEFT JOIN matches actual ON actual.id = json_extract(expected.value, '$[0]') WHERE actual.id IS NULL OR actual.created_at != json_extract(expected.value, '$[1]') OR actual.season_id IS NOT NULL)`))
  }
  statements.push(`INSERT INTO seasons(id, season_number, name, starts_at, ends_at, soft_reset, active) VALUES('s8', 8, 'Season 8', ${startsAt}, NULL, 0, 1)`)
  statements.push("UPDATE matches SET season_id = 's8' WHERE season_id IS NULL")
  if (statements.length > 500 || statements.some(statement => Buffer.byteLength(statement) > 100_000)) throw new Error('Historical initialization exceeds the atomic database limits.')
  const digest = createHash('sha256').update(JSON.stringify({ accountId: source.accountId, databaseId: source.databaseId, matches, statements })).digest('hex')
  return {
    digest, startsAt, matches: matches.length,
    includes: 'Every existing game, including imports, unranked games, tournaments, and cancelled games. Existing ratings and rating events are unchanged.',
    directRowWrites: matches.length + 1,
    conservativeEstimatedWrites: (matches.length + 1) * 8,
    productionEstimateValidated: false,
    statements,
    verification: ["SELECT id, season_number, name, starts_at, soft_reset, active FROM seasons ORDER BY starts_at", "SELECT count(*) AS total, sum(CASE WHEN season_id = 's8' THEN 1 ELSE 0 END) AS assigned FROM matches"],
  }
}

async function save(path: string, value: unknown) {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

async function target() {
  const config = await Bun.file(configPath).text()
  const accountId = config.match(/"account_id"\s*:\s*"([^"]+)"/)?.[1]
  const databaseId = config.match(/"database_name"\s*:\s*"civup"\s*,\s*"database_id"\s*:\s*"([^"]+)"/)?.[1]
  if (!accountId || !databaseId) throw new Error('Cannot identify the PPL D1 database from its Wrangler config.')
  return { accountId, databaseId }
}

async function query(statements: string[], auditPath: string) {
  const identity = await target()
  const token = Bun.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error('Load .ppl.env to access the PPL database.')
  // Create the audit marker before submitting anything; an interrupted request has unknown cost and commit state.
  await save(auditPath, { identity, submittedAt: new Date().toISOString(), statements, outcome: 'unknown until the result file is saved' })
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${identity.accountId}/d1/database/${identity.databaseId}/query`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch: statements.map(sql => ({ sql })) }), signal: AbortSignal.timeout(120_000),
  })
  const payload = await response.json() as { success?: boolean, result?: Array<{ success?: boolean, results?: unknown[], meta?: { rows_read?: number, rows_written?: number } }> }
  await save(`${auditPath}.result.json`, { status: response.status, payload })
  if (!response.ok || !payload.success || payload.result?.length !== statements.length || payload.result.some(row => !row.success)) throw new Error('Database request was not confirmed. Inspect the saved response; do not retry an apply blindly.')
  const usage = (field: 'rows_read' | 'rows_written') => payload.result!.every(row => typeof row.meta?.[field] === 'number')
    ? payload.result!.reduce((total, row) => total + row.meta![field]!, 0) : null
  console.log(JSON.stringify({ rowsRead: usage('rows_read'), rowsWritten: usage('rows_written'), auditPath }))
  return payload.result
}

async function main() {
  const [command, ...args] = Bun.argv.slice(2)
  const options = new Map<string, string>()
  let execute = false
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!
    if (key === '--execute' && !execute) { execute = true; continue }
    if (!['--input', '--output', '--confirm', '--max-estimated-writes'].includes(key) || options.has(key) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error('Invalid or duplicate option.')
    options.set(key, args[++index]!)
  }
  const output = options.get('--output')
  if (!output || !['capture', 'preview', 'apply', 'verify'].includes(command ?? '')) throw new Error('Use capture|preview|apply|verify --output new-file.json. Preview/apply/verify require --input source.json. Apply additionally requires --execute --confirm DIGEST.')
  if (execute && command !== 'apply') throw new Error('--execute is only valid with apply.')
  if (await Bun.file(output).exists()) throw new Error('Choose a new output filename; saved artifacts are not overwritten.')
  if (command === 'capture') {
    const result = await query(['SELECT id FROM seasons', 'SELECT id, created_at AS createdAt, season_id AS seasonId FROM matches ORDER BY id'], `${output}.request.json`)
    await save(output, { ...await target(), seasons: result[0]!.results, matches: result[1]!.results })
    return
  }
  const input = options.get('--input')
  if (!input) throw new Error('Provide the saved capture with --input.')
  const source = await Bun.file(input).json() as HistorySource
  const plan = prepareSeasonEightHistory(source)
  if (command === 'preview') { await save(output, plan); return }
  const identity = await target()
  if (source.accountId !== identity.accountId || source.databaseId !== identity.databaseId) throw new Error('The saved source belongs to another database.')
  if (command === 'apply') {
    const ceiling = Number(options.get('--max-estimated-writes') ?? 250000)
    if (!Number.isSafeInteger(ceiling) || ceiling < 1 || plan.conservativeEstimatedWrites > ceiling) throw new Error('The conservative write estimate exceeds the approved ceiling.')
    if (!execute || options.get('--confirm') !== plan.digest) throw new Error('Review the preview, then explicitly confirm its digest with --execute --confirm DIGEST.')
    await query(plan.statements, output)
    console.log('S8 history initialization submitted successfully. Run verify; this did not open S9 or reset ratings.')
    return
  }
  const result = await query(plan.verification, `${output}.request.json`)
  const seasons = result[0]!.results as Array<{ id: string, season_number: number, starts_at: number, soft_reset: number }>
  const counts = result[1]!.results?.[0] as { total: number, assigned: number }
  const valid = seasons.length === 1 && seasons[0]!.id === 's8' && seasons[0]!.season_number === 8 && seasons[0]!.starts_at === plan.startsAt && seasons[0]!.soft_reset === 0 && counts.total >= plan.matches && counts.assigned === counts.total
  await save(output, { valid, result })
  if (!valid) throw new Error('S8 history verification failed. Review the saved output before further work.')
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
