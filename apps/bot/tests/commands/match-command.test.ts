import { describe, expect, test } from 'bun:test'
import { shouldAutoOpenMatchCreateActivity } from '../../src/commands/match/command.ts'

describe('match create activity launch', () => {
  test('auto-opens only for lobbies created in the draft channel from the draft channel', () => {
    expect(shouldAutoOpenMatchCreateActivity('draft-channel', 'draft-channel', { channelId: 'draft-channel' })).toBe(true)
    expect(shouldAutoOpenMatchCreateActivity('other-channel', 'draft-channel', { channelId: 'draft-channel' })).toBe(false)
    expect(shouldAutoOpenMatchCreateActivity(null, 'draft-channel', { channelId: 'draft-channel' })).toBe(false)
    expect(shouldAutoOpenMatchCreateActivity('draft-channel', 'draft-channel', { channelId: 'old-draft-channel' })).toBe(false)
  })
})
