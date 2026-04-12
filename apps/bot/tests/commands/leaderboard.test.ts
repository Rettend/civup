import { matchParticipants, matches, playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { buildLeaderboardCommandPayload } from '../../src/commands/leaderboard.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('leaderboard command payload', () => {
  test('shows all leaderboard modes that currently have ranked players', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
        { id: 'p3', displayName: 'P3', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(playerRatings).values([
        { playerId: 'p1', mode: 'ffa', mu: 30, sigma: 5, gamesPlayed: 10, wins: 3, lastPlayedAt: 1 },
        { playerId: 'p2', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 7, wins: 4, lastPlayedAt: 1 },
        { playerId: 'p3', mode: 'duel', mu: 29, sigma: 5, gamesPlayed: 2, wins: 2, lastPlayedAt: 1 },
      ])

      const payload = await buildLeaderboardCommandPayload(db, kv, null)
      const titles = payload.embeds?.map(embed => embed.toJSON().title) ?? []

      expect(titles).toEqual(['Duo Leaderboard', 'FFA Leaderboard'])
      expect(payload.content).toBeUndefined()
    }
    finally {
      sqlite.close()
    }
  })

  test('returns plain text when no leaderboard mode has enough games yet', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await db.insert(playerRatings).values({
        playerId: 'p1',
        mode: 'ffa',
        mu: 30,
        sigma: 5,
        gamesPlayed: 2,
        wins: 1,
        lastPlayedAt: 1,
      })

      const payload = await buildLeaderboardCommandPayload(db, kv, null)

      expect(payload.embeds).toBeUndefined()
      expect(payload.content).toBe('No players with enough games to rank yet.')
    }
    finally {
      sqlite.close()
    }
  })

  test('still shows the requested mode when filtered explicitly', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await db.insert(playerRatings).values({
        playerId: 'p1',
        mode: 'ffa',
        mu: 30,
        sigma: 5,
        gamesPlayed: 2,
        wins: 1,
        lastPlayedAt: 1,
      })

      const payload = await buildLeaderboardCommandPayload(db, kv, 'ffa')
      const embed = payload.embeds?.[0]?.toJSON()

      expect(payload.content).toBeUndefined()
      expect(payload.embeds).toHaveLength(1)
      expect(embed?.title).toBe('FFA Leaderboard')
      expect(embed?.description).toBe('No players with enough games to rank yet.')
    }
    finally {
      sqlite.close()
    }
  })

  test('shows duo, 3v3, and 4v4 team leaderboards in team view', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedPlayers(db, [
        'd1', 'd2', 'd3', 'd4',
        's31', 's32', 's33', 's34', 's35', 's36',
        's41', 's42', 's43', 's44', 's45', 's46', 's47', 's48',
      ])
      await seedRatings(db, [
        { playerId: 'd1', mode: 'duo', mu: 30, sigma: 6, gamesPlayed: 6, wins: 4 },
        { playerId: 'd2', mode: 'duo', mu: 29, sigma: 6, gamesPlayed: 6, wins: 4 },
        { playerId: 's31', mode: 'squad', mu: 31, sigma: 6, gamesPlayed: 7, wins: 5 },
        { playerId: 's32', mode: 'squad', mu: 30, sigma: 6, gamesPlayed: 7, wins: 5 },
        { playerId: 's33', mode: 'squad', mu: 29, sigma: 6, gamesPlayed: 7, wins: 5 },
        { playerId: 's41', mode: 'squad', mu: 32, sigma: 6, gamesPlayed: 8, wins: 6 },
        { playerId: 's42', mode: 'squad', mu: 31, sigma: 6, gamesPlayed: 8, wins: 6 },
        { playerId: 's43', mode: 'squad', mu: 30, sigma: 6, gamesPlayed: 8, wins: 6 },
        { playerId: 's44', mode: 'squad', mu: 29, sigma: 6, gamesPlayed: 8, wins: 6 },
      ])

      await seedCompletedTeamMatch(db, {
        matchId: 'duo-1',
        gameMode: '2v2',
        completedAt: 1_000,
        participants: [
          { playerId: 'd1', team: 0, placement: 1 },
          { playerId: 'd2', team: 0, placement: 1 },
          { playerId: 'd3', team: 1, placement: 2 },
          { playerId: 'd4', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'duo-2',
        gameMode: '2v2',
        completedAt: 2_000,
        participants: [
          { playerId: 'd1', team: 0, placement: 1 },
          { playerId: 'd2', team: 0, placement: 1 },
          { playerId: 'd3', team: 1, placement: 2 },
          { playerId: 'd4', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'duo-3',
        gameMode: '2v2',
        completedAt: 3_000,
        participants: [
          { playerId: 'd1', team: 0, placement: 2 },
          { playerId: 'd2', team: 0, placement: 2 },
          { playerId: 'd3', team: 1, placement: 1 },
          { playerId: 'd4', team: 1, placement: 1 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'duo-4',
        gameMode: '2v2',
        completedAt: 3_500,
        participants: [
          { playerId: 'd1', team: 0, placement: 1 },
          { playerId: 'd2', team: 0, placement: 1 },
          { playerId: 'd3', team: 1, placement: 2 },
          { playerId: 'd4', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'duo-5',
        gameMode: '2v2',
        completedAt: 3_750,
        participants: [
          { playerId: 'd1', team: 0, placement: 2 },
          { playerId: 'd2', team: 0, placement: 2 },
          { playerId: 'd3', team: 1, placement: 1 },
          { playerId: 'd4', team: 1, placement: 1 },
        ],
      })

      await seedCompletedTeamMatch(db, {
        matchId: 'squad-3v3-1',
        gameMode: '3v3',
        completedAt: 4_000,
        participants: [
          { playerId: 's31', team: 0, placement: 1 },
          { playerId: 's32', team: 0, placement: 1 },
          { playerId: 's33', team: 0, placement: 1 },
          { playerId: 's34', team: 1, placement: 2 },
          { playerId: 's35', team: 1, placement: 2 },
          { playerId: 's36', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-3v3-2',
        gameMode: '3v3',
        completedAt: 5_000,
        participants: [
          { playerId: 's31', team: 0, placement: 1 },
          { playerId: 's32', team: 0, placement: 1 },
          { playerId: 's33', team: 0, placement: 1 },
          { playerId: 's34', team: 1, placement: 2 },
          { playerId: 's35', team: 1, placement: 2 },
          { playerId: 's36', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-3v3-3',
        gameMode: '3v3',
        completedAt: 6_000,
        participants: [
          { playerId: 's31', team: 0, placement: 2 },
          { playerId: 's32', team: 0, placement: 2 },
          { playerId: 's33', team: 0, placement: 2 },
          { playerId: 's34', team: 1, placement: 1 },
          { playerId: 's35', team: 1, placement: 1 },
          { playerId: 's36', team: 1, placement: 1 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-3v3-4',
        gameMode: '3v3',
        completedAt: 6_500,
        participants: [
          { playerId: 's31', team: 0, placement: 1 },
          { playerId: 's32', team: 0, placement: 1 },
          { playerId: 's33', team: 0, placement: 1 },
          { playerId: 's34', team: 1, placement: 2 },
          { playerId: 's35', team: 1, placement: 2 },
          { playerId: 's36', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-3v3-5',
        gameMode: '3v3',
        completedAt: 6_750,
        participants: [
          { playerId: 's31', team: 0, placement: 2 },
          { playerId: 's32', team: 0, placement: 2 },
          { playerId: 's33', team: 0, placement: 2 },
          { playerId: 's34', team: 1, placement: 1 },
          { playerId: 's35', team: 1, placement: 1 },
          { playerId: 's36', team: 1, placement: 1 },
        ],
      })

      await seedCompletedTeamMatch(db, {
        matchId: 'squad-4v4-1',
        gameMode: '4v4',
        completedAt: 7_000,
        participants: [
          { playerId: 's41', team: 0, placement: 1 },
          { playerId: 's42', team: 0, placement: 1 },
          { playerId: 's43', team: 0, placement: 1 },
          { playerId: 's44', team: 0, placement: 1 },
          { playerId: 's45', team: 1, placement: 2 },
          { playerId: 's46', team: 1, placement: 2 },
          { playerId: 's47', team: 1, placement: 2 },
          { playerId: 's48', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-4v4-2',
        gameMode: '4v4',
        completedAt: 8_000,
        participants: [
          { playerId: 's41', team: 0, placement: 1 },
          { playerId: 's42', team: 0, placement: 1 },
          { playerId: 's43', team: 0, placement: 1 },
          { playerId: 's44', team: 0, placement: 1 },
          { playerId: 's45', team: 1, placement: 2 },
          { playerId: 's46', team: 1, placement: 2 },
          { playerId: 's47', team: 1, placement: 2 },
          { playerId: 's48', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-4v4-3',
        gameMode: '4v4',
        completedAt: 9_000,
        participants: [
          { playerId: 's41', team: 0, placement: 2 },
          { playerId: 's42', team: 0, placement: 2 },
          { playerId: 's43', team: 0, placement: 2 },
          { playerId: 's44', team: 0, placement: 2 },
          { playerId: 's45', team: 1, placement: 1 },
          { playerId: 's46', team: 1, placement: 1 },
          { playerId: 's47', team: 1, placement: 1 },
          { playerId: 's48', team: 1, placement: 1 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-4v4-4',
        gameMode: '4v4',
        completedAt: 9_500,
        participants: [
          { playerId: 's41', team: 0, placement: 1 },
          { playerId: 's42', team: 0, placement: 1 },
          { playerId: 's43', team: 0, placement: 1 },
          { playerId: 's44', team: 0, placement: 1 },
          { playerId: 's45', team: 1, placement: 2 },
          { playerId: 's46', team: 1, placement: 2 },
          { playerId: 's47', team: 1, placement: 2 },
          { playerId: 's48', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-4v4-5',
        gameMode: '4v4',
        completedAt: 9_750,
        participants: [
          { playerId: 's41', team: 0, placement: 2 },
          { playerId: 's42', team: 0, placement: 2 },
          { playerId: 's43', team: 0, placement: 2 },
          { playerId: 's44', team: 0, placement: 2 },
          { playerId: 's45', team: 1, placement: 1 },
          { playerId: 's46', team: 1, placement: 1 },
          { playerId: 's47', team: 1, placement: 1 },
          { playerId: 's48', team: 1, placement: 1 },
        ],
      })

      const payload = await buildLeaderboardCommandPayload(db, kv, null, { view: 'teams' })
      const titles = payload.embeds?.map(embed => embed.toJSON().title) ?? []
      const descriptions = payload.embeds?.map(embed => embed.toJSON().description) ?? []

      expect(payload.content).toBeUndefined()
      expect(titles).toEqual([
        'Duo Team Leaderboard',
        'Squad 3v3 Team Leaderboard',
        'Squad 4v4 Team Leaderboard',
      ])
      expect(descriptions[0]).toContain('<@d1> + <@d2>')
      expect(descriptions[1]).toContain('<@s31> + <@s32> + <@s33>')
      expect(descriptions[2]).toContain('<@s41> + <@s42> + <@s43> + <@s44>')
    }
    finally {
      sqlite.close()
    }
  })

  test('shows an explicit empty team board when a lineup has fewer than five shared games', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedPlayers(db, ['s31', 's32', 's33', 's34', 's35', 's36'])
      await seedRatings(db, [
        { playerId: 's31', mode: 'squad', mu: 31, sigma: 6, gamesPlayed: 4, wins: 3 },
        { playerId: 's32', mode: 'squad', mu: 30, sigma: 6, gamesPlayed: 4, wins: 3 },
        { playerId: 's33', mode: 'squad', mu: 29, sigma: 6, gamesPlayed: 4, wins: 3 },
      ])

      await seedCompletedTeamMatch(db, {
        matchId: 'squad-3v3-a',
        gameMode: '3v3',
        completedAt: 1_000,
        participants: [
          { playerId: 's31', team: 0, placement: 1 },
          { playerId: 's32', team: 0, placement: 1 },
          { playerId: 's33', team: 0, placement: 1 },
          { playerId: 's34', team: 1, placement: 2 },
          { playerId: 's35', team: 1, placement: 2 },
          { playerId: 's36', team: 1, placement: 2 },
        ],
      })
      await seedCompletedTeamMatch(db, {
        matchId: 'squad-3v3-b',
        gameMode: '3v3',
        completedAt: 2_000,
        participants: [
          { playerId: 's31', team: 0, placement: 2 },
          { playerId: 's32', team: 0, placement: 2 },
          { playerId: 's33', team: 0, placement: 2 },
          { playerId: 's34', team: 1, placement: 1 },
          { playerId: 's35', team: 1, placement: 1 },
          { playerId: 's36', team: 1, placement: 1 },
        ],
      })

      const payload = await buildLeaderboardCommandPayload(db, kv, 'squad', {
        view: 'teams',
        teamSize: '3v3',
      })
      const embed = payload.embeds?.[0]?.toJSON()

      expect(payload.content).toBeUndefined()
      expect(payload.embeds).toHaveLength(1)
      expect(embed?.title).toBe('Squad 3v3 Team Leaderboard')
      expect(embed?.description).toBe('No teams with enough games to rank yet.')
    }
    finally {
      sqlite.close()
    }
  })

  test('shows empty team embeds instead of plain text in default team view', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const payload = await buildLeaderboardCommandPayload(db, kv, null, { view: 'teams' })
      const titles = payload.embeds?.map(embed => embed.toJSON().title) ?? []

      expect(payload.content).toBeUndefined()
      expect(titles).toEqual([
        'Duo Team Leaderboard',
        'Squad 3v3 Team Leaderboard',
        'Squad 4v4 Team Leaderboard',
      ])
      expect(payload.embeds?.every(embed => embed.toJSON().description === 'No teams with enough games to rank yet.')).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('filters team boards by requested squad size', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedPlayers(db, ['s31', 's32', 's33', 's34', 's35', 's36', 's41', 's42', 's43', 's44', 's45', 's46', 's47', 's48'])
      await seedRatings(db, [
        { playerId: 's31', mode: 'squad', mu: 30, sigma: 6, gamesPlayed: 6, wins: 4 },
        { playerId: 's32', mode: 'squad', mu: 30, sigma: 6, gamesPlayed: 6, wins: 4 },
        { playerId: 's33', mode: 'squad', mu: 30, sigma: 6, gamesPlayed: 6, wins: 4 },
        { playerId: 's41', mode: 'squad', mu: 31, sigma: 6, gamesPlayed: 6, wins: 4 },
        { playerId: 's42', mode: 'squad', mu: 31, sigma: 6, gamesPlayed: 6, wins: 4 },
        { playerId: 's43', mode: 'squad', mu: 31, sigma: 6, gamesPlayed: 6, wins: 4 },
        { playerId: 's44', mode: 'squad', mu: 31, sigma: 6, gamesPlayed: 6, wins: 4 },
      ])

      for (const [index, matchId] of ['squad-3-1', 'squad-3-2', 'squad-3-3', 'squad-3-4', 'squad-3-5'].entries()) {
        await seedCompletedTeamMatch(db, {
          matchId,
          gameMode: '3v3',
          completedAt: 1_000 + index,
          participants: [
            { playerId: 's31', team: 0, placement: 1 },
            { playerId: 's32', team: 0, placement: 1 },
            { playerId: 's33', team: 0, placement: 1 },
            { playerId: 's34', team: 1, placement: 2 },
            { playerId: 's35', team: 1, placement: 2 },
            { playerId: 's36', team: 1, placement: 2 },
          ],
        })
      }

      for (const [index, matchId] of ['squad-4-1', 'squad-4-2', 'squad-4-3', 'squad-4-4', 'squad-4-5'].entries()) {
        await seedCompletedTeamMatch(db, {
          matchId,
          gameMode: '4v4',
          completedAt: 2_000 + index,
          participants: [
            { playerId: 's41', team: 0, placement: 1 },
            { playerId: 's42', team: 0, placement: 1 },
            { playerId: 's43', team: 0, placement: 1 },
            { playerId: 's44', team: 0, placement: 1 },
            { playerId: 's45', team: 1, placement: 2 },
            { playerId: 's46', team: 1, placement: 2 },
            { playerId: 's47', team: 1, placement: 2 },
            { playerId: 's48', team: 1, placement: 2 },
          ],
        })
      }

      const payload = await buildLeaderboardCommandPayload(db, kv, 'squad', {
        view: 'teams',
        teamSize: '4v4',
      })
      const embed = payload.embeds?.[0]?.toJSON()

      expect(payload.content).toBeUndefined()
      expect(payload.embeds).toHaveLength(1)
      expect(embed?.title).toBe('Squad 4v4 Team Leaderboard')
      expect(embed?.description).toContain('<@s41> + <@s42> + <@s43> + <@s44>')
      expect(embed?.description).not.toContain('<@s31> + <@s32> + <@s33>')
    }
    finally {
      sqlite.close()
    }
  })

  test('rejects unsupported modes for team view', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const payload = await buildLeaderboardCommandPayload(db, kv, 'ffa', { view: 'teams' })

      expect(payload.embeds).toBeUndefined()
      expect(payload.content).toBe('Team leaderboards are only available for Duo and Squad.')
    }
    finally {
      sqlite.close()
    }
  })
})

async function seedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  playerIds: string[],
): Promise<void> {
  await db.insert(players).values(playerIds.map(playerId => ({
    id: playerId,
    displayName: playerId.toUpperCase(),
    avatarUrl: null,
    createdAt: 1,
  })))
}

async function seedRatings(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  rows: Array<{
    playerId: string
    mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death'
    mu: number
    sigma: number
    gamesPlayed: number
    wins: number
  }>,
): Promise<void> {
  await db.insert(playerRatings).values(rows.map(row => ({
    ...row,
    lastPlayedAt: 1,
  })))
}

async function seedCompletedTeamMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  input: {
    matchId: string
    gameMode: '2v2' | '3v3' | '4v4'
    completedAt: number
    participants: Array<{
      playerId: string
      team: number
      placement: number
    }>
  },
): Promise<void> {
  await db.insert(matches).values({
    id: input.matchId,
    gameMode: input.gameMode,
    status: 'completed',
    seasonId: null,
    draftData: null,
    createdAt: input.completedAt - 100,
    completedAt: input.completedAt,
  })

  await db.insert(matchParticipants).values(input.participants.map(participant => ({
    matchId: input.matchId,
    playerId: participant.playerId,
    team: participant.team,
    civId: null,
    placement: participant.placement,
    ratingBeforeMu: null,
    ratingBeforeSigma: null,
    ratingAfterMu: null,
    ratingAfterSigma: null,
  })))
}
