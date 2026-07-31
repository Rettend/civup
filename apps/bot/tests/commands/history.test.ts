import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { buildPlayerHistoryCommandPayload } from '../../src/commands/history.ts'
import { PLAYER_HISTORY_PAGE_SIZE } from '../../src/embeds/player-history.ts'
import { parsePaginationCustomId } from '../../src/services/response/pagination.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

describe('history command payload', () => {
  test('formats player history with opponents and ffa leader only', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await seedPlayers()
      await seedMatch({
        id: 'team-match',
        gameMode: '2v2',
        completedAt: Date.UTC(2026, 0, 3),
        participants: [
          participant('p1', 1, 'rome-trajan', 2),
          participant('p4', 1, 'japan-hojo-tokimune', 2),
          participant('p2', 2, 'russia-peter', 1),
          participant('p3', 2, 'america-abraham-lincoln', 1),
        ],
      })
      await seedMatch({
        id: 'duel-match',
        gameMode: '1v1',
        completedAt: Date.UTC(2026, 0, 2),
        participants: [
          participant('p1', 1, 'japan-hojo-tokimune', 1),
          participant('p2', 2, 'russia-peter', 2),
        ],
      })
      await seedMatch({
        id: 'ffa-match',
        gameMode: 'ffa',
        completedAt: Date.UTC(2026, 0, 1),
        participants: [
          participant('p1', null, 'babylon-hammurabi', 4),
          participant('p5', null, 'russia-peter', 1),
        ],
      })

      const payload = await buildPlayerHistoryCommandPayload(db, 'p1', 'all')
      const embed = firstEmbedJson(payload)

      expect(embed.title).toBe('Match History')
      expect(embed.footer?.text).toBe('Target - Page 1/1 - 1-3 of 3')
      expect(embed.footer?.icon_url).toBe('https://avatar.test/target.png')
      expect(embed.fields).toHaveLength(3)
      expect(embed.fields?.[0]?.name).toContain('2v2 - `2026-01-03`')
      expect(embed.fields?.[0]?.value).not.toContain('Team 0')
      expect(embed.fields?.[0]?.value).not.toContain('Team 1')
      expect(embed.fields?.[0]?.value).not.toContain('Team 2')
      expect(fieldLine(embed.fields?.[0]?.value, 0)).toStartWith(`${LEADING_INDENT_GUARD}${INDENT}`)
      expect(fieldLine(embed.fields?.[0]?.value, 0)).toContain('<:leader:1470104020193382522> **Target**')
      expect(fieldLine(embed.fields?.[0]?.value, 0)).toContain('<:leader:1470104043702583531> Opponent One')
      expect(fieldLine(embed.fields?.[0]?.value, 1)).toStartWith(`${LEADING_INDENT_GUARD}${INDENT}`)
      expect(fieldLine(embed.fields?.[0]?.value, 1)).toContain('<:leader:1470102755308863632> Team Mate')
      expect(fieldLine(embed.fields?.[0]?.value, 1)).toContain('<:leader:1470101227898540193> Opponent Two')
      expect(embed.fields?.[1]?.name).toContain('1v1 - `2026-01-02`')
      expect(embed.fields?.[1]?.value).not.toContain('Team')
      expect(fieldLine(embed.fields?.[1]?.value, 0)).toStartWith(`${LEADING_INDENT_GUARD}${INDENT}`)
      expect(fieldLine(embed.fields?.[1]?.value, 0)).toContain('<:leader:1470102755308863632> **Target**')
      expect(fieldLine(embed.fields?.[1]?.value, 0)).toContain('<:leader:1470104043702583531> Opponent One')
      expect(embed.fields?.[2]?.name).toContain('FFA - `2026-01-01`')
      expect(fieldLine(embed.fields?.[2]?.value, 0)).toStartWith(`${LEADING_INDENT_GUARD}${INDENT}`)
      expect(embed.fields?.[2]?.value).toContain(`${LEADING_INDENT_GUARD}${INDENT}\`#1 \` <:leader:1470104043702583531> Ffa Opponent`)
      expect(embed.fields?.[2]?.value).toContain(`${INDENT}\`#4 \` <:leader:1470101497164337318> **Target**`)
      expect(JSON.stringify(embed.fields)).not.toContain('You')
      expect(JSON.stringify(embed.fields)).not.toContain('<@p2>')
      expect(JSON.stringify(embed.fields)).not.toContain('Trajan')
      expect(JSON.stringify(embed.fields)).not.toContain('Hammurabi')
      expect(JSON.stringify(embed.fields)).toContain('**Target**')
      expect(JSON.stringify(embed.fields)).not.toContain('**Opponent')
    }
    finally {
      sqlite.close()
    }

    async function seedPlayers(): Promise<void> {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Target', avatarUrl: 'https://avatar.test/target.png', createdAt: 1 },
        { id: 'p2', displayName: 'Opponent One', avatarUrl: null, createdAt: 1 },
        { id: 'p3', displayName: 'Opponent Two', avatarUrl: null, createdAt: 1 },
        { id: 'p4', displayName: 'Team Mate', avatarUrl: null, createdAt: 1 },
        { id: 'p5', displayName: 'Ffa Opponent', avatarUrl: null, createdAt: 1 },
      ])
    }

    async function seedMatch(input: {
      id: string
      gameMode: string
      completedAt: number
      participants: Array<typeof matchParticipants.$inferInsert>
    }): Promise<void> {
      await db.insert(matches).values({
        id: input.id,
        gameMode: input.gameMode,
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: JSON.stringify({ state: { bans: [] } }),
        createdAt: input.completedAt - 1,
        completedAt: input.completedAt,
      })
      await db.insert(matchParticipants).values(input.participants.map(row => ({ ...row, matchId: input.id })))
    }
  })

  test('formats CivBlitz history with unranked result markers', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Target', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Opponent', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values([
        {
          id: 'civblitz-history-win',
          gameMode: '1v1',
          status: 'completed',
          isOld: false,
          seasonId: null,
          draftData: JSON.stringify({ civBlitz: true }),
          createdAt: Date.UTC(2026, 0, 1) - 1,
          completedAt: Date.UTC(2026, 0, 1),
        },
        {
          id: 'civblitz-history-loss',
          gameMode: '1v1',
          status: 'completed',
          isOld: false,
          seasonId: null,
          draftData: JSON.stringify({ civBlitz: true }),
          createdAt: Date.UTC(2026, 0, 2) - 1,
          completedAt: Date.UTC(2026, 0, 2),
        },
      ])
      await db.insert(matchParticipants).values([
        participant('p1', 0, 'japan-hojo-tokimune', 1, 'civblitz-history-win'),
        participant('p2', 1, 'russia-peter', 2, 'civblitz-history-win'),
        participant('p1', 0, 'russia-peter', 2, 'civblitz-history-loss'),
        participant('p2', 1, 'japan-hojo-tokimune', 1, 'civblitz-history-loss'),
      ])

      const payload = await buildPlayerHistoryCommandPayload(db, 'p1', 'all')
      const embed = firstEmbedJson(payload)

      expect(embed.fields?.[0]?.name).toContain('`  -` 📉')
      expect(embed.fields?.[1]?.name).toContain('`  +` 📈')
      expect(JSON.stringify(embed.fields)).not.toContain('❔ `(   ?)`')
    }
    finally {
      sqlite.close()
    }
  })

  test('paginates history at ten matches per page', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Target', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Opponent', avatarUrl: null, createdAt: 1 },
      ])
      for (let index = 0; index < 11; index += 1) {
        await seedDuel(`match-${index}`, Date.UTC(2026, 0, index + 1))
      }

      const firstPage = await buildPlayerHistoryCommandPayload(db, 'p1', 'all')
      const firstEmbed = firstEmbedJson(firstPage)
      const controls = firstPage.components as Array<{ components: Array<{ label: string, custom_id: string, disabled?: boolean }> }>

      expect(firstEmbed.fields).toHaveLength(PLAYER_HISTORY_PAGE_SIZE)
      expect(firstEmbed.footer?.text).toBe('Target - Page 1/2 - 1-10 of 11')
      expect(controls[0]?.components[2]?.custom_id).toBe('pagination;history:1:next:p1:all')
      expect(parsePaginationCustomId(controls[0]?.components[2]?.custom_id)).toEqual({ namespace: 'history', pageIndex: 1, args: ['p1', 'all'] })

      const lastPage = await buildPlayerHistoryCommandPayload(db, 'p1', 'all', { pageIndex: 99 })
      const lastEmbed = firstEmbedJson(lastPage)

      expect(lastEmbed.fields).toHaveLength(1)
      expect(lastEmbed.footer?.text).toBe('Target - Page 2/2 - 11-11 of 11')
    }
    finally {
      sqlite.close()
    }

    async function seedDuel(matchId: string, completedAt: number): Promise<void> {
      await db.insert(matches).values({
        id: matchId,
        gameMode: '1v1',
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: JSON.stringify({ state: { bans: [] } }),
        createdAt: completedAt - 1,
        completedAt,
      })
      await db.insert(matchParticipants).values([
        participant('p1', 1, 'rome-trajan', 1, matchId),
        participant('p2', 2, 'russia-peter', 2, matchId),
      ])
    }
  })

  test('uses rendered row cost for team pagination', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values(Array.from({ length: 13 }, (_, index) => ({
        id: `p${index + 1}`,
        displayName: index === 0 ? 'Target' : `Player ${index + 1}`,
        avatarUrl: null,
        createdAt: 1,
      })))
      for (let index = 0; index < 8; index += 1) {
        await seedTeamMatch(`three-${index}`, '3v3', 6, Date.UTC(2026, 0, index + 1))
      }

      const firstPage = await buildPlayerHistoryCommandPayload(db, 'p1', '3v3')
      const firstEmbed = firstEmbedJson(firstPage)
      const secondPage = await buildPlayerHistoryCommandPayload(db, 'p1', '3v3', { pageIndex: 1 })
      const secondEmbed = firstEmbedJson(secondPage)

      expect(firstEmbed.fields).toHaveLength(7)
      expect(firstEmbed.footer?.text).toBe('Target - Page 1/2 - 1-7 of 8')
      expect(secondEmbed.fields).toHaveLength(1)
      expect(secondEmbed.footer?.text).toBe('Target - Page 2/2 - 8-8 of 8')
    }
    finally {
      sqlite.close()
    }

    async function seedTeamMatch(matchId: string, gameMode: string, playerCount: number, completedAt: number): Promise<void> {
      await db.insert(matches).values({
        id: matchId,
        gameMode,
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: JSON.stringify({ state: { bans: [] } }),
        createdAt: completedAt - 1,
        completedAt,
      })
      const teamSize = playerCount / 2
      await db.insert(matchParticipants).values(Array.from({ length: playerCount }, (_, index) => participant(
        `p${index + 1}`,
        index < teamSize ? 1 : 2,
        index % 2 === 0 ? 'rome-trajan' : 'russia-peter',
        index < teamSize ? 1 : 2,
        matchId,
      )))
    }
  })
})

const INDENT = '\u00A0\u00A0\u00A0'
const LEADING_INDENT_GUARD = '\u200B'

function participant(
  playerId: string,
  team: number | null,
  civId: string,
  placement: number,
  matchId = '',
): typeof matchParticipants.$inferInsert {
  return {
    matchId,
    playerId,
    team,
    civId,
    placement,
    ratingBeforeMu: null,
    ratingBeforeSigma: null,
    ratingAfterMu: null,
    ratingAfterSigma: null,
  }
}

function firstEmbedJson(payload: { embeds?: unknown[] }): { title?: string, description?: string, footer?: { text?: string, icon_url?: string }, fields?: Array<{ name: string, value: string, inline?: boolean }> } {
  const embed = payload.embeds?.[0] as { toJSON?: () => { title?: string, description?: string, footer?: { text?: string, icon_url?: string }, fields?: Array<{ name: string, value: string, inline?: boolean }> } } | undefined
  return embed?.toJSON?.() ?? {}
}

function fieldLine(value: string | undefined, index: number): string {
  return value?.split('\n')[index] ?? ''
}
