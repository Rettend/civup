import { describe, expect, test } from 'bun:test'
import { lobbyCancelledEmbed, lobbyOpenEmbed, lobbyResultEmbed } from '../../src/embeds/match.ts'

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

  test('shows the BBG data version in the footer when provided', () => {
    const openEmbed = lobbyOpenEmbed('2v2', [null, null, null, null], 4, null, null, 'beta').toJSON()
    const resultEmbed = lobbyResultEmbed('ffa', []).toJSON()
    const cancelledEmbed = lobbyCancelledEmbed('2v2', [], 'scrub', undefined, 'live').toJSON()

    expect(openEmbed.footer?.text).toBe('BBG Beta')
    expect(resultEmbed.footer).toBeUndefined()
    expect(cancelledEmbed.footer).toBeUndefined()
  })

  test('pads four-team open lobbies into a 2x2 inline field layout', () => {
    const embed = lobbyOpenEmbed('rd-2p', Array.from({ length: 8 }, () => null), 8).toJSON()

    expect(embed.fields?.map(field => field.name)).toEqual([
      'Team A',
      'Team B',
      '\u200B',
      'Team C',
      'Team D',
      '\u200B',
    ])
  })

  test('pads four-team cancelled lobbies into a 2x2 inline field layout', () => {
    const participants = Array.from({ length: 8 }, (_, index) => ({
      playerId: `1000100000000000${String(index + 1).padStart(2, '0')}`,
      team: Math.floor(index / 2),
      civId: null,
    }))
    const embed = lobbyCancelledEmbed('rd-2p', participants, 'cancel').toJSON()

    expect(embed.fields?.map(field => field.name)).toEqual([
      'Team A',
      'Team B',
      '\u200B',
      'Team C',
      'Team D',
      '\u200B',
    ])
  })
})
