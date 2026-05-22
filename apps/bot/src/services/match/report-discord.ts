import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import type { LobbyState } from '../lobby/index.ts'
import type { SystemChannelType } from '../system/channels.ts'
import type { MatchReporterIdentity, ParticipantRow } from './types.ts'
import { lobbyResultEmbed } from '../../embeds/match.ts'
import { createChannelMessage, createChannelMessageWithFile, editChannelMessage, editChannelMessageWithFile, isDiscordApiError } from '../discord/index.ts'
import { setLobbyMessage, upsertLobbyMessage } from '../lobby/index.ts'
import { getSystemChannel } from '../system/channels.ts'
import { renderTournamentResultPng } from '../tournament/image.ts'
import { buildTournamentResultImageData, isMatchTournamentLinked } from '../tournament/index.ts'
import { getLeaderDataVersionFromDraftData, getMapVoteResultFromDraftData, getReporterIdentityFromDraftData } from './draft-data.ts'
import { listMatchMessageIds, storeMatchMessageMapping } from './message.ts'

type ArchivePolicy = 'always' | 'if-missing'
type ReportArchiveChannelType = Extract<SystemChannelType, 'archive' | 'tournament-archive'>

interface SyncReportedMatchDiscordMessagesInput {
  db: Database
  kv: KVNamespace
  token: string
  matchId: string
  reportedMode: GameMode
  reportedRedDeath: boolean
  participants: ParticipantRow[]
  lobby?: LobbyState | null
  sessionNamespace?: DurableObjectNamespace | null
  rankedRoleLines?: string[]
  matchDraftData?: string | null
  reporter?: MatchReporterIdentity | null
  archivePolicy?: ArchivePolicy
  archiveChannelType?: ReportArchiveChannelType
}

export interface ReportedMatchDiscordSyncResult {
  draftMessageUpdated: boolean
  archiveMessageCreated: boolean
  errors: string[]
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
  sessionNamespace = null,
  rankedRoleLines = [],
  matchDraftData = null,
  reporter = null,
  archivePolicy = 'always',
  archiveChannelType,
}: SyncReportedMatchDiscordMessagesInput): Promise<ReportedMatchDiscordSyncResult> {
  const errors: string[] = []
  let messageIds: string[] = []
  try {
    messageIds = await listMatchMessageIds(db, matchId)
  }
  catch (error) {
    console.error(`Failed to list Discord message mappings for reported match ${matchId}:`, error)
    errors.push(`message mapping lookup failed: ${formatError(error)}`)
  }
  const draftMessageId = messageIds[0] ?? null
  const resolvedReporter = resolveMatchReporterIdentity(matchDraftData, reporter)
  const mapVoteResult = getMapVoteResultFromDraftData(matchDraftData)
  const leaderDataVersion = getLeaderDataVersionFromDraftData(matchDraftData, lobby?.draftConfig.leaderDataVersion ?? 'live')
  const tournamentLinked = await isMatchTournamentLinked(db, matchId)
  let tournamentResultPng: Uint8Array | null = null
  let tournamentImageFailed = false
  if (tournamentLinked) {
    try {
      const tournamentResultData = await buildTournamentResultImageData(db, matchId, participants)
      if (!tournamentResultData) throw new Error('Tournament result data was not available')
      tournamentResultPng = await renderTournamentResultPng(tournamentResultData)
    }
    catch (error) {
      tournamentImageFailed = true
      console.error(`Failed to render tournament result image for match ${matchId}:`, error)
      errors.push(`tournament result image failed: ${formatError(error)}`)
    }
  }
  let draftMessageUpdated = false
  let archiveMessageCreated = false
  let draftUpdateError: unknown = null

  if (lobby) {
    try {
      if (tournamentLinked && tournamentResultPng) {
        await editChannelMessageWithFile({
          token,
          channelId: lobby.channelId,
          messageId: lobby.messageId,
          filename: 'tournament-result.png',
          contentType: 'image/png',
          data: tournamentResultPng,
          components: [],
        })
        await storeMatchMessageMapping(db, lobby.messageId, matchId)
        draftMessageUpdated = true
      }
      else if (!tournamentLinked) {
        const updatedLobby = await upsertLobbyMessage(kv, token, lobby, {
          embeds: [lobbyResultEmbed(lobby.mode, participants, undefined, {
            mapVoteResult,
            rankedRoleLines,
            reporter: resolvedReporter,
            leaderDataVersion,
          }, lobby.draftConfig.redDeath)],
          components: [],
        }, { db, sessionNamespace })
        await storeMatchMessageMapping(db, updatedLobby.messageId, matchId)
        draftMessageUpdated = true
      }
    }
    catch (error) {
      if (tournamentLinked && tournamentResultPng && isDiscordApiError(error, 404)) {
        try {
          const created = await createChannelMessageWithFile({
            token,
            channelId: lobby.channelId,
            filename: 'tournament-result.png',
            contentType: 'image/png',
            data: tournamentResultPng,
            components: [],
          })
          await setLobbyMessage(kv, lobby.id, lobby.channelId, created.id, { db, sessionNamespace })
          await storeMatchMessageMapping(db, created.id, matchId)
          draftMessageUpdated = true
        }
        catch (recreateError) {
          console.error(`Failed to recreate tournament result message for match ${matchId}:`, recreateError)
          draftUpdateError = recreateError
        }
      }
      else {
        console.error(`Failed to update lobby result ${tournamentLinked ? 'image' : 'embed'} for match ${matchId}:`, error)
        draftUpdateError = error
      }
    }
  }

  if (!draftMessageUpdated && draftMessageId && !tournamentImageFailed) {
    const draftChannelType = tournamentLinked ? 'tournament-draft' : 'draft'
    const draftChannelId = await getSystemChannel(kv, draftChannelType).catch((error) => {
      console.error(`Failed to read ${draftChannelType} channel for reported match ${matchId}:`, error)
      draftUpdateError = error
      return null
    })
    if (draftChannelId) {
      let draftRepairError: unknown = null
      for (const messageId of messageIds) {
        try {
          if (tournamentLinked && tournamentResultPng) {
            await editChannelMessageWithFile({
              token,
              channelId: draftChannelId,
              messageId,
              filename: 'tournament-result.png',
              contentType: 'image/png',
              data: tournamentResultPng,
              components: [],
            })
          }
          else if (!tournamentLinked) {
            await editChannelMessage(token, draftChannelId, messageId, {
              content: null,
              embeds: [lobbyResultEmbed(reportedMode, participants, undefined, {
                mapVoteResult,
                rankedRoleLines,
                reporter: resolvedReporter,
                leaderDataVersion,
              }, reportedRedDeath)],
              components: [],
              allowed_mentions: { parse: [] },
            })
          }
          else {
            throw new Error(`Tournament result image was not available for match ${matchId}`)
          }
          draftMessageUpdated = true
          draftRepairError = null
          break
        }
        catch (error) {
          draftRepairError = error
          if (!isDiscordApiError(error, 404)) break
        }
      }

      if (draftRepairError) {
        console.error(`Failed to repair draft result message for match ${matchId}:`, draftRepairError)
        draftUpdateError = draftRepairError
      }
    }
  }

  if (!draftMessageUpdated && draftUpdateError) {
    errors.push(`draft result update failed: ${formatError(draftUpdateError)}`)
  }

  if (tournamentImageFailed) return { draftMessageUpdated, archiveMessageCreated, errors }

  const resolvedArchiveChannelType = archiveChannelType ?? await resolveReportedArchiveChannelType(db, matchId)
  const archiveChannelId = await getSystemChannel(kv, resolvedArchiveChannelType).catch((error) => {
    console.error(`Failed to read ${resolvedArchiveChannelType} channel for reported match ${matchId}:`, error)
    errors.push(`archive channel lookup failed: ${formatError(error)}`)
    return null
  })
  if (!archiveChannelId) return { draftMessageUpdated, archiveMessageCreated, errors }

  const shouldCreateArchive = archivePolicy === 'always' || messageIds.length < 2
  if (!shouldCreateArchive) return { draftMessageUpdated, archiveMessageCreated, errors }

  try {
    if (tournamentLinked && !tournamentResultPng) throw new Error(`Tournament result image was not available for match ${matchId}`)
    const archiveMessage = tournamentLinked
      ? await createChannelMessageWithFile({
          token,
          channelId: archiveChannelId,
          filename: 'tournament-result.png',
          contentType: 'image/png',
          data: tournamentResultPng!,
        })
      : await createChannelMessage(token, archiveChannelId, {
          embeds: [lobbyResultEmbed(reportedMode, participants, undefined, {
            mapVoteResult,
            rankedRoleLines,
            reporter: resolvedReporter,
            leaderDataVersion,
          }, reportedRedDeath)],
          allowed_mentions: { parse: [] },
        })
    await storeMatchMessageMapping(db, archiveMessage.id, matchId)
    archiveMessageCreated = true
  }
  catch (error) {
    console.error(`Failed to post archive result for match ${matchId}:`, error)
    errors.push(`archive result post failed: ${formatError(error)}`)
  }

  return { draftMessageUpdated, archiveMessageCreated, errors }
}

async function resolveReportedArchiveChannelType(db: Database, matchId: string): Promise<ReportArchiveChannelType> {
  return await isMatchTournamentLinked(db, matchId) ? 'tournament-archive' : 'archive'
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

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  }
  catch {
    return String(error)
  }
}
