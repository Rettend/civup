import { matchBans, matches, matchParticipants, playerRatingSeeds, playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { buildPlayerDataExport, buildPlayerDataExportSheets } from '../../src/services/export/player-data.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

describe('player data export', () => {
  test('builds the player and match workbook sheets', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Alice & Bob', avatarUrl: 'https://example.com/avatar.png', createdAt: Date.UTC(2026, 0, 1) },
        { id: 'p2', displayName: 'Charlie', avatarUrl: null, createdAt: Date.UTC(2026, 0, 2) },
      ])
      await db.insert(playerRatings).values({
        playerId: 'p1',
        mode: 'ffa',
        mu: 30,
        sigma: 5,
        gamesPlayed: 12,
        wins: 4,
        lastPlayedAt: Date.UTC(2026, 0, 3),
      })
      await db.insert(playerRatingSeeds).values({
        playerId: 'p1',
        mode: 'ffa',
        mu: 28,
        sigma: 6,
        eligibleForRanked: true,
        fadeGamesRemaining: 3,
        source: 'legacy',
        note: 'seed note',
        createdAt: Date.UTC(2026, 0, 4),
        updatedAt: Date.UTC(2026, 0, 5),
      })
      await db.insert(matches).values([
        {
          id: 'm1',
          gameMode: 'ffa',
          status: 'completed',
          isOld: false,
          seasonId: null,
          draftData: '{"omitted":true}',
          createdAt: Date.UTC(2026, 0, 6),
          completedAt: Date.UTC(2026, 0, 7),
        },
        {
          id: 'm2',
          gameMode: 'ffa',
          status: 'completed',
          isOld: true,
          seasonId: null,
          draftData: JSON.stringify({
            state: {
              seats: [{ playerId: 'p1' }, { playerId: 'p2' }],
              bans: [{ civId: 'civ-arabia', seatIndex: 0, stepIndex: 1 }],
            },
          }),
          createdAt: Date.UTC(2026, 0, 8),
          completedAt: Date.UTC(2026, 0, 9),
        },
      ])
      await db.insert(matchParticipants).values({
        matchId: 'm1',
        playerId: 'p1',
        team: null,
        civId: 'civ-rome',
        placement: 1,
        ratingBeforeMu: 29,
        ratingBeforeSigma: 5,
        ratingAfterMu: 30,
        ratingAfterSigma: 5,
      })
      await db.insert(matchBans).values({
        matchId: 'm1',
        civId: 'civ-russia',
        bannedBy: 'p2',
        phase: 0,
      })

      const sheets = await buildPlayerDataExportSheets(db, { now: new Date('2026-01-10T00:00:00.000Z') })
      const sheetByName = new Map(sheets.map(sheet => [sheet.name, sheet]))

      expect(sheets.map(sheet => sheet.name)).toEqual([
        'overview',
        'players',
        'ratings',
        'rating_seeds',
        'matches',
        'match_participants',
        'match_bans',
      ])
      expect(sheetByName.get('overview')?.columns).toEqual(['Overview'])
      expect(sheetByName.get('overview')?.rows).toContainEqual(['Summary'])
      expect(sheetByName.get('overview')?.rows).toContainEqual(['Metric', 'Value'])
      expect(sheetByName.get('overview')?.rows).toContainEqual(['Completed matches', 2])
      expect(sheetByName.get('overview')?.rows).toContainEqual(['Recorded bans in completed matches', 2])
      expect(sheetByName.get('overview')?.rows).toContainEqual(['Mode', 'Completed matches'])
      expect(sheetByName.get('overview')?.rows).toContainEqual(['ffa', 2])
      expect(sheetByName.get('overview')?.rows).toContainEqual(['Leader', 'Civilization', 'Bans', 'Picks', 'Wins', 'Win rate'])
      expect(sheetByName.get('overview')?.rows).toContainEqual(['civ-russia', null, 1, 0, 0, ''])
      expect(sheetByName.get('players')?.columns).toEqual(['player_id', 'display_name', 'created_at_utc', 'last_match_at_utc'])
      expect(sheetByName.get('players')?.rows[0]).toEqual(['p1', 'Alice & Bob', excelDate(46023), excelDate(46029)])
      expect(sheetByName.get('players')?.rows[1]).toEqual(['p2', 'Charlie', excelDate(46024), null])
      expect(sheetByName.get('rating_seeds')?.rows[0]).toContain('legacy')
      expect(sheetByName.get('matches')?.columns).toContain('old_bot')
      expect(sheetByName.get('matches')?.columns).not.toContain('draft_data')
      expect(sheetByName.get('matches')?.rows[0]).toEqual(['m1', 'ffa', 'completed', false, null, excelDate(46028), excelDate(46029)])
      expect(sheetByName.get('match_participants')?.rows[0]?.slice(0, 6)).toEqual(['m1', 'p1', 'Alice & Bob', null, 'civ-rome', 1])
      expect(sheetByName.get('match_bans')?.rows[0]).toEqual(['m1', 0, 'civ-russia', 'p2', 'Charlie'])
      expect(sheetByName.get('match_bans')?.rows[1]).toEqual(['m2', 1, 'civ-arabia', 'p1', 'Alice & Bob'])
    }
    finally {
      sqlite.close()
    }
  })

  test('creates an xlsx zip with workbook and worksheet XML', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'Alice & Bob', avatarUrl: null, createdAt: 1 })

      const exportFile = await buildPlayerDataExport(db, { now: new Date('2026-04-26T12:00:00.000Z') })
      const files = await unzipXlsxFiles(exportFile.data)

      expect(exportFile.filename).toBe('export-2026-04-26.xlsx')
      expect(exportFile.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      expect(files.has('[Content_Types].xml')).toBe(true)
      expect(files.has('xl/workbook.xml')).toBe(true)
      expect(files.has('xl/styles.xml')).toBe(true)
      expect(files.has('xl/worksheets/sheet1.xml')).toBe(true)
      expect(files.has('xl/worksheets/sheet2.xml')).toBe(true)
      expect(decode(files.get('xl/workbook.xml')!)).toContain('rating_seeds')
      expect(decode(files.get('xl/worksheets/sheet1.xml')!)).toContain('Summary')
      const playersXml = decode(files.get('xl/worksheets/sheet2.xml')!)
      expect(playersXml).toContain('Alice &amp; Bob')
      expect(playersXml).toContain('s="1"><v>25569</v>')
      expect(exportFile.counts).toMatchObject({ players: 1, ratings: 0, rating_seeds: 0, matches: 0 })
      expect(exportFile.counts.overview).toBeGreaterThan(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('compresses workbook XML so larger exports fit Discord attachment limits', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const playerRows = Array.from({ length: 200 }, (_value, index) => ({
        id: `player-${String(index).padStart(3, '0')}`,
        displayName: `Very Long Repeated Export Player Name ${String(index).padStart(3, '0')} `.repeat(8),
        avatarUrl: null,
        createdAt: Date.UTC(2026, 0, 1) + index,
      }))
      await db.insert(players).values(playerRows)

      const exportFile = await buildPlayerDataExport(db, { now: new Date('2026-04-26T12:00:00.000Z') })
      const files = await unzipXlsxFiles(exportFile.data)
      const uncompressedSize = [...files.values()].reduce((total, file) => total + file.byteLength, 0)

      expect(files.has('xl/worksheets/sheet2.xml')).toBe(true)
      expect(decode(files.get('xl/worksheets/sheet2.xml')!)).toContain('Very Long Repeated Export Player Name 000')
      expect(exportFile.data.byteLength).toBeLessThan(uncompressedSize)
    }
    finally {
      sqlite.close()
    }
  })
})

async function unzipXlsxFiles(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const decoder = new TextDecoder()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const files = new Map<string, Uint8Array>()
  let offset = 0

  while (offset + 4 <= data.byteLength && view.getUint32(offset, true) === 0x04034B50) {
    const method = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const filenameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const filenameStart = offset + 30
    const filenameEnd = filenameStart + filenameLength
    const fileStart = filenameEnd + extraLength
    const fileEnd = fileStart + compressedSize

    expect([0, 8]).toContain(method)
    const compressed = data.slice(fileStart, fileEnd)
    const file = method === 8 ? await inflateRaw(compressed) : compressed
    files.set(decoder.decode(data.slice(filenameStart, filenameEnd)), file)
    offset = fileEnd
  }

  return files
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const decompressed = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(decompressed).arrayBuffer())
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

function excelDate(value: number): { type: 'date', value: number } {
  return { type: 'date', value }
}
