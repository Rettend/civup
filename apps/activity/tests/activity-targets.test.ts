import type { ActivityTargetOption } from '../src/client/stores'
import { describe, expect, test } from 'bun:test'
import { didClearResolvedActivityTarget, resolveAutoSelectedActivityTarget } from '../src/client/lib/activity-targets'

const joinedMatch: ActivityTargetOption = {
  kind: 'match',
  id: 'match-1',
  lobbyId: 'lobby-1',
  matchId: 'match-1',
  channelId: 'channel-1',
  mode: '2v2',
  status: 'drafting',
  participantCount: 4,
  targetSize: 4,
  isMember: true,
  isHost: false,
  updatedAt: 20,
}

const staleLobby: ActivityTargetOption = {
  kind: 'lobby',
  id: 'lobby-2',
  lobbyId: 'lobby-2',
  matchId: null,
  channelId: 'channel-1',
  mode: '2v2',
  status: 'open',
  participantCount: 1,
  targetSize: 4,
  isMember: false,
  isHost: false,
  updatedAt: 10,
}

describe('activity target helpers', () => {
  test('does not treat the initial missing target replay as a cleared selection', () => {
    expect(didClearResolvedActivityTarget(undefined, null)).toBe(false)
  })

  test('keeps the initial default-target auto-selection behavior', () => {
    const selected = resolveAutoSelectedActivityTarget({
      options: [staleLobby, joinedMatch],
      target: null,
      overviewPinned: false,
      suppressAutoSelection: false,
    })

    expect(selected).toEqual(joinedMatch)
  })

  test('suppresses auto-selection after an existing target is cleared', () => {
    const suppressAutoSelection = didClearResolvedActivityTarget({ kind: 'lobby', id: 'lobby-1' }, null)

    const selected = resolveAutoSelectedActivityTarget({
      options: [staleLobby],
      target: null,
      overviewPinned: false,
      suppressAutoSelection,
    })

    expect(suppressAutoSelection).toBe(true)
    expect(selected).toBeNull()
  })

  test('does not auto-select while the overview is pinned open', () => {
    const selected = resolveAutoSelectedActivityTarget({
      options: [joinedMatch],
      target: null,
      overviewPinned: true,
      suppressAutoSelection: false,
    })

    expect(selected).toBeNull()
  })
})
