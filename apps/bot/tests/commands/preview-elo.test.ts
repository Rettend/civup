import { describe, expect, test } from 'bun:test'
import { calculateDuelEloPreview, command_preview_elo, duelEloPreviewEmbed, previewEloComponents } from '../../src/commands/preview-elo.ts'
import { SHOW_EPHEMERAL_RESPONSE_BUTTON_ID } from '../../src/services/response/ephemeral.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { factory } from '../../src/setup.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

const STATS_CONTEXT = createStatsContext('111111111111111111', '111111111111111111')

describe('preview elo command', () => {
  test('registers as a user context command', () => {
    const [commandBuilder] = factory.getCommands([command_preview_elo])
    const command = commandBuilder?.toJSON() as { name?: string, type?: number, description?: string, options?: unknown[] } | undefined

    expect(command?.name).toBe('Preview Elo')
    expect(command?.type).toBe(2)
    expect(command?.description).toBe('')
    expect(command?.options).toBeUndefined()
  })

  test('uses the shared show button component', () => {
    const components = previewEloComponents().toJSON()

    expect(components[0]?.components?.[0]).toEqual(expect.objectContaining({
      custom_id: `${SHOW_EPHEMERAL_RESPONSE_BUTTON_ID};`,
      label: 'Show',
      style: 2,
      type: 2,
    }))
  })

  test('calculates both duel outcomes from the viewer perspective', () => {
    const preview = calculateDuelEloPreview(
      { playerId: 'viewer', mu: 25, sigma: 8.333, gamesPlayed: 0 },
      { playerId: 'target', mu: 25, sigma: 8.333, gamesPlayed: 0 },
    )

    expect(preview.viewerWinProbability).toBeCloseTo(0.5, 5)
    expect(preview.targetWinProbability).toBeCloseTo(0.5, 5)
    expect(preview.viewerWin.displayDelta).toBeGreaterThan(0)
    expect(preview.targetLoss.displayDelta).toBeLessThan(0)
    expect(preview.viewerLoss.displayDelta).toBeLessThan(0)
    expect(preview.targetWin.displayDelta).toBeGreaterThan(0)
  })

  test('renders an embed with fallback duel ratings', async () => {
    const { db, sqlite } = await createTestDatabase()

    const embed = (await duelEloPreviewEmbed(
      db,
      STATS_CONTEXT,
      { userId: 'viewer', displayName: 'Viewer', avatarUrl: null },
      { userId: 'target', displayName: 'Target', avatarUrl: null },
    )).toJSON()

    expect(embed.title).toBe('Preview Elo (1v1)')
    expect(embed.description).toBe('<@viewer> vs <@target>')
    expect(embed.fields?.find(field => field.name === 'Current Elo')?.value).toContain('`1000`')
    expect(embed.fields?.find(field => field.name === 'Win Chance')?.value).toContain('`50%`')
    expect(embed.fields?.find(field => field.name === 'If You Win')?.value).toContain('Viewer: `+')
    expect(embed.fields?.find(field => field.name === 'If You Lose')?.value).toContain('Viewer: `-')

    sqlite.close()
  })
})
