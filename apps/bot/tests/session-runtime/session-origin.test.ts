import type { DraftSessionRecord } from '../../src/session-runtime/session-record.ts'
import { cloneOfficialAppliedSettings } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { buildOpenSessionRecordFromLobby, syncSessionRecordFromLobby } from '../../src/session-runtime/session-record.ts'
import { createLobby } from '../helpers/lobby-runtime.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('session origin identity', () => {
  test('keeps origin guild, channel, and message immutable across open-session syncs', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: '111111111111111111',
      hostId: 'host-1',
      channelId: 'origin-channel',
      messageId: 'origin-message',
    })
    const original = buildOpenSessionRecordFromLobby(lobby)
    const synced = syncSessionRecordFromLobby(original, {
      ...lobby,
      guildId: '222222222222222222',
      channelId: 'other-channel',
      messageId: 'other-message',
      revision: lobby.revision + 1,
      updatedAt: lobby.updatedAt + 1,
    })

    expect(synced.guildId).toBe('111111111111111111')
    expect(synced.channelId).toBe('origin-channel')
    expect(synced.projectionState).toMatchObject({ channelId: 'origin-channel', messageId: 'origin-message' })
  })

  test('defaults legacy lobbies to Official settings and freezes copied settings after draft start', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const legacyRecord = buildOpenSessionRecordFromLobby({ ...lobby, gameSettings: undefined })
    expect(legacyRecord.gameSettings.preset.kind).toBe('official')

    const customSettings = cloneOfficialAppliedSettings()
    customSettings.profile.base.hutFrequencyMultiplier = 2
    customSettings.preset = { kind: 'custom', id: null, name: 'Copied settings', revision: null }
    const openRecord = buildOpenSessionRecordFromLobby({ ...lobby, gameSettings: customSettings })
    customSettings.profile.base.hutFrequencyMultiplier = 3
    expect(openRecord.gameSettings.profile.base.hutFrequencyMultiplier).toBe(2)

    const frozenRecord: DraftSessionRecord = {
      ...openRecord,
      phase: 'draft',
      matchId: lobby.id,
      frozenAt: lobby.updatedAt,
    }
    const replacementSettings = cloneOfficialAppliedSettings()
    replacementSettings.profile.base.hutFrequencyMultiplier = 4
    const synced = syncSessionRecordFromLobby(frozenRecord, {
      ...lobby,
      status: 'active',
      matchId: lobby.id,
      gameSettings: replacementSettings,
      revision: lobby.revision + 1,
      updatedAt: lobby.updatedAt + 1,
    })

    expect(synced.gameSettings).toEqual(openRecord.gameSettings)
  })
})
