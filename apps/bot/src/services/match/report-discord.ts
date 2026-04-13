import type { Database } from '@civup/db'
import type { MatchReporterIdentity } from './types.ts'
import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/index.ts'
import type { ParticipantRow } from './types.ts'
import { players } from '@civup/db'
import { eq } from 'drizzle-orm'
import { lobbyResultEmbed } from '../../embeds/match.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from '../discord/index.ts'
import { upsertLobbyMessage } from '../lobby/index.ts'
import { listMatchMessageIds, storeMatchMessageMapping } from './message.ts'
import { loadMatchReporterIdentity } from './reporter.ts'
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
  reporter = null,
  archivePolicy = 'always',
}: SyncReportedMatchDiscordMessagesInput): Promise<void> {
  const messageIds = await listMatchMessageIds(db, matchId)
  const draftMessageId = messageIds[0] ?? null
  const storedReporter = await resolveMatchReporterIdentity(db, kv, matchId, reporter)

  if (lobby) {
    try {
      const updatedLobby = await upsertLobbyMessage(kv, token, lobby, {
        embeds: [lobbyResultEmbed(lobby.mode, participants, undefined, {
          rankedRoleLines,
          reporter: storedReporter,
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
              reporter: storedReporter,
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
        reporter: storedReporter,
      }, reportedRedDeath)],
      allowed_mentions: { parse: [] },
    })
    await storeMatchMessageMapping(db, archiveMessage.id, matchId)
  }
  catch (error) {
    console.error(`Failed to post archive result for match ${matchId}:`, error)
  }
}

async function resolveMatchReporterIdentity(
  db: Database,
  kv: KVNamespace,
  matchId: string,
  reporter?: MatchReporterIdentity | null,
): Promise<MatchReporterIdentity | null> {
  const current = reporter ?? await loadMatchReporterIdentity(kv, matchId)
  if (!current?.userId) return null
  if (current.displayName?.trim() && current.avatarUrl?.trim()) return current

  try {
    const [player] = await db
      .select({
        displayName: players.displayName,
        avatarUrl: players.avatarUrl,
      })
      .from(players)
      .where(eq(players.id, current.userId))
      .limit(1)

    return {
      userId: current.userId,
      displayName: (current.displayName?.trim() || player?.displayName) ?? null,
      avatarUrl: (current.avatarUrl?.trim() || player?.avatarUrl) ?? null,
    }
  }
  catch (error) {
    console.error(`Failed to resolve reporter identity for match ${matchId}:`, error)
    return current
  }
}
