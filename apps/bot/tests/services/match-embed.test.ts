import { describe, expect, test } from 'bun:test'
import { lobbyResultEmbed } from '../../src/embeds/match.ts'

describe('match result embed', () => {
  test('limits leaderboard movement lines to tracked top ranks while always keeping new entrants', () => {
    const embed = lobbyResultEmbed('ffa', [
      {
        playerId: '100010000000000001',
        team: null,
        civId: null,
        placement: 1,
        ratingBeforeMu: 25,
        ratingBeforeSigma: 8,
        ratingAfterMu: 28,
        ratingAfterSigma: 7,
        leaderboardBeforeRank: 9,
        leaderboardAfterRank: 6,
        leaderboardEligibleCount: 100,
      },
      {
        playerId: '100010000000000002',
        team: null,
        civId: null,
        placement: 2,
        ratingBeforeMu: 24,
        ratingBeforeSigma: 8,
        ratingAfterMu: 26,
        ratingAfterSigma: 7,
        leaderboardBeforeRank: 50,
        leaderboardAfterRank: 40,
        leaderboardEligibleCount: 100,
      },
      {
        playerId: '100010000000000003',
        team: null,
        civId: null,
        placement: 3,
        ratingBeforeMu: 23,
        ratingBeforeSigma: 8,
        ratingAfterMu: 25,
        ratingAfterSigma: 7,
        leaderboardBeforeRank: null,
        leaderboardAfterRank: 12,
        leaderboardEligibleCount: 100,
      },
    ], undefined, {
      rankedRoleLines: ['⬆️ <@100010000000000001> <@&1> -> <@&2> (FFA)'],
    }).toJSON()

    const fields = JSON.stringify(embed.fields)
    expect(fields).toContain('⬆️ <@100010000000000001> `#9 ` -> `#6 `')
    expect(fields).not.toContain('100010000000000002')
    expect(fields).toContain('🆕 <@100010000000000003> entered at `#12`')
    expect(fields).toContain('Rank Roles')
    expect(fields).toContain('<@&1> -> <@&2>')
  })
})
