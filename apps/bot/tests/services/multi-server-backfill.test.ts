import { matchParticipants, matchRepairs, matches, playerRatingEvents, playerRatings, players, scopedPlayerRatingEvents, scopedPlayerRatings, sessionDirectory } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { buildMultiServerBackfillSql, buildMultiServerValidationQueries } from '../../scripts/multi-server-backfill-shared.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

const PRIMARY = '111111111111111111'
const PARTNER = '222222222222222222'
const LEGACY_PARTNER = '333333333333333333'
const UNAPPROVED = '444444444444444444'
const CUTOFF = 1_000
const CONFIG = {
  primaryGuildId: PRIMARY,
  allowedGuildIds: [PRIMARY, PARTNER],
  cutoff: CUTOFF,
  guildMappings: new Map([[LEGACY_PARTNER, PARTNER]]),
}

describe('multi-server data backfill', () => {
  test('backfills proven ownership and lifecycle data idempotently while leaving conflicting claims unresolved', async () => {
    const { db, sqlite } = await createTestDatabase()
    await db.insert(players).values([
      { id: 'p1', displayName: 'P1', createdAt: 1 },
      { id: 'p2', displayName: 'P2', createdAt: 1 },
      { id: 'p3', displayName: 'P3', createdAt: 1 },
    ])
    await db.insert(matches).values([
      { id: 'directory-owned', gameMode: '1v1', status: 'active', draftData: JSON.stringify({ completedAt: 150 }), createdAt: 100 },
      { id: 'legacy-cancelled', gameMode: '1v1', status: 'cancelled', createdAt: 100 },
      { id: 'partner-current', guildId: PARTNER, gameMode: '1v1', status: 'completed', createdAt: 100, completedAt: 200 },
      { id: 'conflicting-owner', gameMode: '1v1', status: 'active', createdAt: 100 },
      { id: 'mapped-owner', gameMode: '1v1', status: 'active', createdAt: 100 },
      { id: 'unapproved-owner', gameMode: '1v1', status: 'active', createdAt: 100 },
    ])
    await db.insert(matchParticipants).values([
      { matchId: 'directory-owned', playerId: 'p1', placement: 1 },
      { matchId: 'legacy-cancelled', playerId: 'p2' },
      { matchId: 'partner-current', playerId: 'p3', sourceGuildId: PARTNER, sourceKind: 'joined', placement: 1 },
    ])
    await db.insert(sessionDirectory).values([
      directoryRow('session-owned', 'directory-owned', PRIMARY),
      directoryRow('session-conflict-a', 'conflicting-owner', PRIMARY),
      directoryRow('session-conflict-b', 'conflicting-owner', PARTNER),
      directoryRow('session-mapped', 'mapped-owner', LEGACY_PARTNER),
      directoryRow('session-unapproved', 'unapproved-owner', UNAPPROVED),
    ])
    await db.insert(playerRatings).values({ playerId: 'p1', mode: 'duel', mu: 31, sigma: 7, gamesPlayed: 4, wins: 3, updatedAt: 500 })
    await db.insert(playerRatingEvents).values({
      matchId: 'directory-owned',
      playerId: 'p1',
      mode: 'duel',
      gameMode: '1v1',
      ratingBeforeMu: 30,
      ratingBeforeSigma: 7.2,
      ratingAfterMu: 31,
      ratingAfterSigma: 7,
      matchCreatedAt: 100,
      matchCompletedAt: 200,
      updatedAt: 500,
    })

    const sql = buildMultiServerBackfillSql(CONFIG)
    sqlite.exec(sql)
    sqlite.exec(sql)

    const rows = await db.select().from(matches)
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('directory-owned')).toMatchObject({ guildId: PRIMARY, draftCompletedAt: 150, resultRevision: 1 })
    expect(byId.get('legacy-cancelled')).toMatchObject({ guildId: PRIMARY, completedAt: null, cancelledAt: CUTOFF, resultRevision: 1 })
    expect(byId.get('partner-current')).toMatchObject({ guildId: PARTNER, resultRevision: 1 })
    expect(byId.get('conflicting-owner')?.guildId).toBeNull()
    expect(byId.get('mapped-owner')?.guildId).toBe(PARTNER)
    expect(byId.get('unapproved-owner')?.guildId).toBeNull()
    expect((await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, 'session-mapped')))[0]?.guildId).toBe(PARTNER)

    expect(await db.select().from(scopedPlayerRatings)).toEqual([
      expect.objectContaining({ statsKey: `server:${PRIMARY}`, playerId: 'p1', mode: 'duel', mu: 31, gamesPlayed: 4 }),
    ])
    expect(await db.select().from(scopedPlayerRatingEvents)).toEqual([
      expect.objectContaining({ statsKey: `server:${PRIMARY}`, matchId: 'directory-owned', playerId: 'p1', mode: 'duel' }),
    ])

    const participants = await db.select().from(matchParticipants)
    expect(participants.find(row => row.matchId === 'directory-owned')).toMatchObject({ sourceGuildId: PRIMARY, sourceKind: 'legacy_primary' })
    expect(participants.find(row => row.matchId === 'partner-current')).toMatchObject({ sourceGuildId: PARTNER, sourceKind: 'joined' })
    expect(await db.select().from(matchRepairs).where(eq(matchRepairs.repairType, 'migration-cancelled-at-fallback'))).toHaveLength(1)

    const validation = Object.fromEntries(Object.entries(buildMultiServerValidationQueries(CONFIG)).map(([name, query]) => {
      const row = sqlite.query(query).get() as { count: number }
      return [name, row.count]
    }))
    expect(validation).toMatchObject({
      matchesMissingOwner: 2,
      matchesWithUnapprovedOwner: 0,
      directoryWithUnapprovedOwner: 1,
      participantsMissingSourceGuild: 0,
      participantsMissingSourceKind: 0,
      cancelledMatchesMissingTimestamp: 0,
      terminalMatchesMissingRevision: 0,
      conflictingDirectoryOwners: 1,
      primaryRatingsMissingScopedRows: 0,
      primaryRatingEventsMissingScopedRows: 0,
    })
    sqlite.close()
  })
})

function directoryRow(sessionId: string, matchId: string, guildId: string) {
  return {
    sessionId,
    phase: 'active',
    mode: '1v1',
    guildId,
    channelId: 'channel',
    hostId: 'host',
    messageId: 'message',
    matchId,
    version: 1,
    rosterJson: '{}',
    configJson: '{}',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
}
