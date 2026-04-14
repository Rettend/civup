import type { Database } from '@civup/db'
import type { MatchReporterIdentity } from './types.ts'
import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/index.ts'
import type { ParticipantRow } from './types.ts'
import { lobbyResultEmbed } from '../../embeds/match.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from '../discord/index.ts'
import { upsertLobbyMessage } from '../lobby/index.ts'
import { getReporterIdentityFromDraftData } from './draft-data.ts'
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
  matchDraftData?: string | null
  reporter?: MatchReporterIdentity | null
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
  matchDraftData = null,
  reporter = null,
  archivePolicy = 'always',
}: SyncReportedMatchDiscordMessagesInput): Promise<void> {
  const messageIds = await listMatchMessageIds(db, matchId)
  const draftMessageId = messageIds[0] ?? null
  const resolvedReporter = resolveMatchReporterIdentity(matchDraftData, reporter)

  if (lobby) {
    try {
        const updatedLobby = await upsertLobbyMessage(kv, token, lobby, {
        embeds: [lobbyResultEmbed(lobby.mode, participants, undefined, {
          rankedRoleLines,
          reporter: resolvedReporter,
        }, lobby.draftConfig.redDeath)],
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
            content: null,
            embeds: [lobbyResultEmbed(reportedMode, participants, undefined, {
              rankedRoleLines,
              reporter: resolvedReporter,
            }, reportedRedDeath)],
            components: [],
            allowed_mentions: { parse: [] },
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
    const archiveMessage = await createChannelMessage(token, archiveChannelId, {
      embeds: [lobbyResultEmbed(reportedMode, participants, undefined, {
        rankedRoleLines,
        reporter: resolvedReporter,
      }, reportedRedDeath)],
      allowed_mentions: { parse: [] },
    })
    await storeMatchMessageMapping(db, archiveMessage.id, matchId)
  }
  catch (error) {
    console.error(`Failed to post archive result for match ${matchId}:`, error)
  }
}

function resolveMatchReporterIdentity(
  draftData: string | null,
  reporter?: MatchReporterIdentity | null,
): MatchReporterIdentity | null {
  const storedReporter = getReporterIdentityFromDraftData(draftData)
  if (!reporter?.userId) return storedReporter
  if (!storedReporter || storedReporter.userId !== reporter.userId) return reporter

  return {
    userId: reporter.userId,
    displayName: (reporter.displayName?.trim() || storedReporter.displayName) ?? null,
    avatarUrl: (reporter.avatarUrl?.trim() || storedReporter.avatarUrl) ?? null,
  }
}
