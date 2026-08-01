import { describe, expect, test } from 'bun:test'
import { lobbyDraftingEmbed } from '../../src/embeds/match.ts'

describe('drafting lobby embed', () => {
  test('lists the Captain Pick pool instead of hiding unassigned players', () => {
    const embed = lobbyDraftingEmbed('3v3', [
      { playerId: 'a', displayName: 'A', team: 0 },
      { playerId: 'b', displayName: 'B', team: 1 },
      { playerId: 'c', displayName: 'C' },
      { playerId: 'd', displayName: 'D' },
      { playerId: 'e', displayName: 'E' },
      { playerId: 'f', displayName: 'F' },
    ])
    const fields = embed.toJSON().fields ?? []

    expect(fields.find(field => field.name === 'Team A')?.value).toContain('<@a>')
    expect(fields.find(field => field.name === 'Team B')?.value).toContain('<@b>')
    expect(fields.find(field => field.name === 'Unassigned')?.value).toBe('1. <@c>\n2. <@d>\n3. <@e>\n4. <@f>')
  })
})
