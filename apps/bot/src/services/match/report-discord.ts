import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/index.ts'
import type { ParticipantRow } from './types.ts'
import { buildLobbyImageMessage } from '../discord/lobby-card.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from '../discord/index.ts'
import { upsertLobbyMessage } from '../lobby/index.ts'
import { listMatchMessageIds, storeMatchMessageMapping } from './message.ts'
import { getSystemChannel } from '../system/channels.ts'

type ArchivePolicy = 'always' | 'if-missing'

interface SyncReportedMatchDiscordMessagesInput {
  db: Database
  kv: KVNamespace
  token: string
  matchId: string
  reportedMode: GameMode
  reportedRedDeath: boolean
  participants: ParticipantRow[]
  lobby?: LobbyState | null
  rankedRoleLines?: string[]
  archivePolicy?: ArchivePolicy
}

export async function syncReportedMatchDiscordMessages({
  db,
  kv,
  token,
  matchId,
  reportedMode,
  reportedRedDeath,
  participants,
  lobby = null,
  rankedRoleLines = [],
  archivePolicy = 'always',
}: SyncReportedMatchDiscordMessagesInput): Promise<void> {
  const messageIds = await listMatchMessageIds(db, matchId)
  const draftMessageId = messageIds[0] ?? null
  const resultPayload = await buildLobbyImageMessage({
    db,
    mode: reportedMode,
    stage: 'reported',
    participants,
    rankedRoleLines,
    redDeath: reportedRedDeath,
  })

  if (lobby) {
    try {
      const updatedLobby = await upsertLobbyMessage(kv, token, lobby, {
        ...resultPayload,
        components: [],
      })
      await storeMatchMessageMapping(db, updatedLobby.messageId, matchId)
    }
    catch (error) {
      console.error(`Failed to update lobby result embed for match ${matchId}:`, error)
    }
  }
  else if (draftMessageId) {
    const draftChannelId = await getSystemChannel(kv, 'draft')
    if (draftChannelId) {
      let draftRepairError: unknown = null
      for (const messageId of messageIds) {
        try {
          await editChannelMessage(token, draftChannelId, messageId, {
            ...resultPayload,
            components: [],
          })
          draftRepairError = null
          break
        }
        catch (error) {
          draftRepairError = error
          if (!isDiscordApiError(error, 404)) break
        }
      }

      if (draftRepairError) {
        console.error(`Failed to repair draft result embed for match ${matchId}:`, draftRepairError)
      }
    }
  }

  const archiveChannelId = await getSystemChannel(kv, 'archive')
  if (!archiveChannelId) return

  const shouldCreateArchive = archivePolicy === 'always' || messageIds.length < 2
  if (!shouldCreateArchive) return

  try {
    const archiveMessage = await createChannelMessage(token, archiveChannelId, resultPayload)
    await storeMatchMessageMapping(db, archiveMessage.id, matchId)
  }
  catch (error) {
    console.error(`Failed to post archive result for match ${matchId}:`, error)
  }
}
