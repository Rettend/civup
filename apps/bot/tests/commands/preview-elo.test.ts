import { describe, expect, test } from 'bun:test'
import { calculateDuelEloPreview, command_preview_elo, duelEloPreviewEmbed } from '../../src/commands/preview-elo.ts'
import { factory } from '../../src/setup.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

describe('preview elo command', () => {
  test('registers as a user context command', () => {
    const [commandBuilder] = factory.getCommands([command_preview_elo])
    const command = commandBuilder?.toJSON() as { name?: string, type?: number, description?: string, options?: unknown[] } | undefined

    expect(command?.name).toBe('Preview Elo')
    expect(command?.type).toBe(2)
    expect(command?.description).toBe('')
    expect(command?.options).toBeUndefined()
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

  test('renders a preview-only embed with fallback duel ratings', async () => {
    const { db, sqlite } = await createTestDatabase()

    const embed = (await duelEloPreviewEmbed(
      db,
      { userId: 'viewer', displayName: 'Viewer', avatarUrl: null },
      { userId: 'target', displayName: 'Target', avatarUrl: null },
    )).toJSON()

    expect(embed.title).toBe('Preview Elo')
    expect(embed.description).toContain('Viewer vs Target in Duel')
    expect(embed.description).toContain('Ratings are not changed')
    expect(embed.fields?.find(field => field.name === 'Current Elo')?.value).toContain('`1000`')
    expect(embed.fields?.find(field => field.name === 'Win Chance')?.value).toContain('`50%`')
    expect(embed.fields?.find(field => field.name === 'If You Win')?.value).toContain('Viewer: `+')
    expect(embed.fields?.find(field => field.name === 'If You Lose')?.value).toContain('Viewer: `-')

    sqlite.close()
  })
})
