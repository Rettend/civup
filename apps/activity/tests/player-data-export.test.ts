import type { PlayerDataExportEstimate, PlayerDataExportSource } from '../src/client/lib/player-data-export'
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js'
import { describe, expect, test } from 'bun:test'
import {
  buildPlayerDataWorksheets,
  createPlayerDataExport,
  createPlayerDataWorkbook,
  fetchPlayerDataExport,
  fetchPlayerDataExportEstimate,
  PLAYER_DATA_EXPORT_CONTENT_TYPE,
  publishPlayerDataExport,
} from '../src/client/lib/player-data-export'
import { cacheActivitySessionToken, clearActivitySessionToken } from '../src/client/lib/activity-session'

describe('Activity player data export', () => {
  test('fetches and validates the cheap export estimate separately from data pages', async () => {
    const requests: string[] = []
    const payload = {
      version: 1,
      estimatedAt: Date.parse('2026-07-15T12:00:00.000Z'),
      rows: { players: 1_000, ratings: 4_000, matches: 10_000, participants: 60_000, storedBans: 5_000 },
      dataPageRequests: 220,
      workerRequests: 440,
      d1RowsRead: { lowEstimate: 100_000, highEstimate: 230_000 },
      dailyFreeAllowance: { workerRequests: 100_000, d1RowsRead: 5_000_000 },
    } satisfies PlayerDataExportEstimate
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return Response.json(payload)
    }) as typeof fetch

    expect(await fetchPlayerDataExportEstimate(fetchImpl)).toEqual(payload)
    expect(requests).toEqual(['/api/activity/admin/player-data-export-estimate'])

    const malformedFetch = (async () => Response.json({ ...payload, workerRequests: -1 })) as unknown as typeof fetch
    await expect(fetchPlayerDataExportEstimate(malformedFetch)).rejects.toThrow('malformed data')
  })

  test('fetches every cursor page sequentially and accumulates progress', async () => {
    const generatedAt = Date.parse('2026-07-15T12:00:00.000Z')
    const requests: string[] = []
    const progress: string[] = []
    const pages = [
      playerPage(generatedAt, 'player-page-2', [player('p2', 'Second')], [rating('p2')]),
      playerPage(generatedAt, 'match-page-1', [player('p1', 'First')], [rating('p1')]),
      matchPage(generatedAt, null, [match('m1', 100)], [participant('m1', 'p1')], [ban('m1')]),
    ]
    let pageIndex = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return Response.json(pages[pageIndex++])
    }) as typeof fetch

    const result = await createPlayerDataExport({
      fetchImpl,
      onProgress(value) {
        progress.push(`${value.phase}:${value.players}:${value.matches}`)
      },
    })

    expect(requests).toEqual([
      '/api/activity/admin/player-data-export',
      '/api/activity/admin/player-data-export?cursor=player-page-2',
      '/api/activity/admin/player-data-export?cursor=match-page-1',
    ])
    expect(result.source.players.map(row => row.id)).toEqual(['p1', 'p2'])
    expect(result.source.ratings.map(row => row.playerId)).toEqual(['p1', 'p2'])
    expect(result.source.matches.map(row => row.id)).toEqual(['m1'])
    expect(result.filename).toBe('export-2026-07-15.xlsx')
    expect(result.blob.type).toBe(PLAYER_DATA_EXPORT_CONTENT_TYPE)
    expect(progress).toEqual([
      'players:1:0',
      'players:2:0',
      'matches:2:1',
      'workbook:2:1',
    ])
  })

  test('reports authorization and malformed payload failures clearly', async () => {
    const forbiddenFetch = (async () => Response.json({ error: 'Forbidden' }, { status: 403 })) as unknown as typeof fetch
    await expect(fetchPlayerDataExport({ fetchImpl: forbiddenFetch })).rejects.toThrow('only available to server administrators')

    const malformedFetch = (async () => Response.json({ phase: 'players', players: [] })) as unknown as typeof fetch
    await expect(fetchPlayerDataExport({ fetchImpl: malformedFetch })).rejects.toThrow('malformed data')
  })

  test('publishes the completed workbook and builds an authenticated external download URL', async () => {
    cacheActivitySessionToken('signed-session', 3600)
    try {
      const requests: Array<{ input: string, init?: RequestInit }> = []
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input: String(input), init })
        return Response.json({ ok: true, filename: 'export-2026-07-15.xlsx', size: 4 })
      }) as typeof fetch
      const published = await publishPlayerDataExport({
        blob: new Blob(['xlsx'], { type: PLAYER_DATA_EXPORT_CONTENT_TYPE }),
        filename: 'export-2026-07-15.xlsx',
        source: sampleSource(),
      }, fetchImpl)

      expect(requests[0]!.input).toBe('/api/uploads/player-data-export?filename=export-2026-07-15.xlsx')
      expect(new Headers(requests[0]!.init?.headers).get('X-CivUp-Activity-Session')).toBe('signed-session')
      expect(await new Response(requests[0]!.init?.body).text()).toBe('xlsx')
      expect(published).toEqual({
        filename: 'export-2026-07-15.xlsx',
        url: 'http://localhost/api/uploads/player-data-export/download?activitySession=signed-session',
      })
    }
    finally {
      clearActivitySessionToken()
    }
  })

  test('builds reduced, deterministic sheets and a valid formula-safe compressed XLSX', async () => {
    const source = sampleSource()
    const blob = await createPlayerDataWorkbook(source)
    const worksheets = buildPlayerDataWorksheets(source)
    const byName = new Map(worksheets.map(sheet => [sheet.name, sheet]))

    expect(worksheets.map(sheet => sheet.name)).toEqual([
      'overview',
      'players',
      'ratings',
      'matches',
      'match_participants',
      'match_bans',
    ])
    expect(byName.get('players')?.columns).toEqual(['player_id', 'display_name', 'created_at_utc', 'last_match_at_utc'])
    expect(byName.get('ratings')?.columns).toEqual(['player_id', 'mode', 'mu', 'sigma', 'games_played', 'wins', 'last_played_at_utc'])
    expect(byName.get('matches')?.columns).toEqual(['match_id', 'game_mode', 'status', 'old_bot', 'season_id', 'created_at_utc', 'completed_at_utc'])
    expect(byName.get('match_participants')?.columns).toEqual([
      'match_id',
      'player_id',
      'team',
      'civ_id',
      'placement',
      'rating_before_mu',
      'rating_before_sigma',
      'rating_after_mu',
      'rating_after_sigma',
    ])
    expect(byName.get('match_bans')?.columns).toEqual(['match_id', 'phase', 'civ_id', 'banned_by_player_id'])
    expect(Array.from(byName.get('matches')!.rows(), row => row[0])).toEqual(['m-early', 'm-late'])
    expect(Array.from(byName.get('match_participants')!.rows(), row => row[0])).toEqual(['m-early', 'm-late'])
    expect(Array.from(byName.get('players')!.rows())[0]?.[3]).toEqual(excelDate(200))
    expect(Array.from(byName.get('overview')!.rows())).toContainEqual(['Completed matches', 2])

    const zipReader = new ZipReader(new BlobReader(blob), { useWebWorkers: false })
    const entries = await zipReader.getEntries()
    const entriesByName = new Map(entries.map(entry => [entry.filename, entry]))
    expect(entriesByName.has('[Content_Types].xml')).toBe(true)
    expect(entriesByName.has('xl/workbook.xml')).toBe(true)
    expect(entriesByName.has('xl/styles.xml')).toBe(true)
    for (let index = 1; index <= 6; index += 1) expect(entriesByName.has(`xl/worksheets/sheet${index}.xml`)).toBe(true)

    const playersEntry = entriesByName.get('xl/worksheets/sheet2.xml')!
    const overviewEntry = entriesByName.get('xl/worksheets/sheet1.xml')!
    if (overviewEntry.directory) throw new Error('Overview worksheet was a directory')
    expect(await overviewEntry.getData(new TextWriter())).toContain('<dimension ref="A1:F')
    if (playersEntry.directory) throw new Error('Players worksheet was a directory')
    const playersXml = await playersEntry.getData(new TextWriter())
    expect(playersXml).toContain('t="inlineStr"')
    expect(playersXml).toContain('=1+1 &amp; &lt;unsafe&gt;')
    expect(playersXml).not.toContain('<f>')
    expect(playersEntry.compressedSize).toBeLessThan(playersEntry.uncompressedSize)
    await zipReader.close()
  })

  test('streams a worksheet above common spread-argument limits', async () => {
    const source = emptySource()
    source.matches.push(match('m1', 1))
    for (let index = 0; index < 70_000; index += 1) {
      source.bans.push({ matchId: 'm1', phase: index, civId: `civ-${index % 100}`, bannedBy: `p-${index % 8}` })
    }

    const blob = await createPlayerDataWorkbook(source)
    expect(blob.size).toBeGreaterThan(0)
  }, 30_000)

  test('rejects exports that would use unsafe browser memory before building the workbook', async () => {
    const source = emptySource()
    source.bans = new Array(500_001).fill(ban('m1'))

    await expect(createPlayerDataWorkbook(source)).rejects.toThrow('too large to build safely')
  })
})

function sampleSource(): PlayerDataExportSource {
  const source = emptySource()
  source.players.push(
    player('p2', 'Normal'),
    player('p1', '=1+1 & <unsafe>'),
  )
  source.ratings.push(rating('p1'))
  source.matches.push(match('m-late', 200), match('m-early', 100))
  source.participants.push(participant('m-late', 'p1'), participant('m-early', 'p1'))
  source.bans.push(ban('m-late'), ban('m-early'))
  return source
}

function emptySource(): PlayerDataExportSource {
  return {
    generatedAt: Date.parse('2026-07-15T12:00:00.000Z'),
    cutoffAt: Date.parse('2026-07-15T12:00:00.000Z'),
    players: [],
    ratings: [],
    matches: [],
    participants: [],
    bans: [],
  }
}

function player(id: string, displayName: string) {
  return { id, displayName, createdAt: 10 }
}

function rating(playerId: string) {
  return { playerId, mode: 'ffa', mu: 25, sigma: 8, gamesPlayed: 2, wins: 1, lastPlayedAt: 20 }
}

function match(id: string, createdAt: number) {
  return { id, gameMode: 'ffa', status: 'completed', isOld: false, seasonId: null, createdAt, completedAt: createdAt }
}

function participant(matchId: string, playerId: string) {
  return {
    matchId,
    playerId,
    team: null,
    civId: 'civ-rome',
    placement: 1,
    ratingBeforeMu: 24,
    ratingBeforeSigma: 8,
    ratingAfterMu: 25,
    ratingAfterSigma: 7.9,
  }
}

function ban(matchId: string) {
  return { matchId, civId: 'civ-russia', bannedBy: 'p1', phase: 1 }
}

function playerPage(generatedAt: number, nextCursor: string, playerRows: ReturnType<typeof player>[], ratings: ReturnType<typeof rating>[]) {
  return {
    version: 1,
    generatedAt,
    cutoffAt: generatedAt,
    phase: 'players',
    players: playerRows,
    ratings,
    nextCursor,
  }
}

function matchPage(
  generatedAt: number,
  nextCursor: string | null,
  matchRows: ReturnType<typeof match>[],
  participants: ReturnType<typeof participant>[],
  bans: ReturnType<typeof ban>[],
) {
  return {
    version: 1,
    generatedAt,
    cutoffAt: generatedAt,
    phase: 'matches',
    matches: matchRows,
    participants,
    bans,
    nextCursor,
  }
}

function excelDate(timestampMs: number): { type: 'date', value: number } {
  return {
    type: 'date',
    value: Math.round(((timestampMs / 86_400_000) + 25_569) * 86_400) / 86_400,
  }
}
