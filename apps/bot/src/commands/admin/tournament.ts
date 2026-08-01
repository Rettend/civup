import type { AdminCommandContext } from './types.ts'
import { createDb } from '@civup/db'
import { buildDiscordAvatarUrl } from '@civup/utils'
import { Modal, TextInput } from 'discord-hono'
import { ephemeralResponseEmbed } from '../../embeds/response.ts'
import { fetchGuildMember, isDiscordApiError } from '../../services/discord/index.ts'
import { getKvStore } from '../../services/kv/batch.ts'
import { buildTournamentStandings, createTournament, createTournamentCut, DEFAULT_TOURNAMENT_MIN_GAMES, DEFAULT_TOURNAMENT_REMATCH_POLICY, DEFAULT_TOURNAMENT_TOP_CUT, getCurrentTournament, importTournamentPlayers, isSupportedTournamentTopCut, listTournamentEntrySnapshots, normalizeTournamentMode, normalizeTournamentPositiveInteger, normalizeTournamentRematchPolicy, parseTournamentPlayersCsv, refreshTournamentLeaderboard, startTournament, SUPPORTED_TOURNAMENT_MODES, SUPPORTED_TOURNAMENT_TOP_CUTS, updateTournament, type TournamentPlayerImportRow } from '../../services/tournament/index.ts'
import { factory } from '../../setup.ts'
import { getInteractionUserId, sendEphemeralResponse, sendTransientEphemeralResponse } from './shared.ts'

const ADMIN_TOURNAMENT_CREATE_MODAL_ID = 'admin-tournament-create'
const ADMIN_TOURNAMENT_EDIT_MODAL_ID = 'admin-tournament-edit'

interface ResolvedAttachment {
  id?: string
  filename?: string
  content_type?: string
  size?: number
  url?: string
}

interface AttachmentInteractionData {
  resolved?: {
    attachments?: Record<string, ResolvedAttachment>
  }
}

export function handleTournamentCreate(c: AdminCommandContext) {
  return c.resModal(
    new Modal(ADMIN_TOURNAMENT_CREATE_MODAL_ID, 'Create Tournament')
      .row(new TextInput('name', 'Name').required().max_length(80).placeholder('1v1 Tournament'))
      .row(new TextInput('min_games', 'Minimum games').value(String(DEFAULT_TOURNAMENT_MIN_GAMES)).required())
      .row(new TextInput('top_cut', 'Top cut').value(String(DEFAULT_TOURNAMENT_TOP_CUT)).required())
      .row(new TextInput('rematch_policy', 'Rematch policy').value(DEFAULT_TOURNAMENT_REMATCH_POLICY).required())
      .row(new TextInput('mode', 'Mode (1v1 through 6v6)').value('1v1').required()),
  )
}

export function handleTournamentImport(c: AdminCommandContext) {
  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const db = createDb(c.env.DB)
    const tournament = await getCurrentTournament(db)
    if (!tournament) {
      await sendTransientEphemeralResponse(c, 'No current tournament. Create one first with `/admin tournament create`.', 'error')
      return
    }
    if (tournament.mode !== '1v1') {
      await sendTransientEphemeralResponse(c, 'CSV import is only available for 1v1 tournaments.', 'error')
      return
    }

    const attachment = resolveAttachment(c, c.var.csv)
    if (!attachment?.url) {
      await sendTransientEphemeralResponse(c, 'Could not read the CSV attachment.', 'error')
      return
    }

    if (attachment.size != null && attachment.size > 256_000) {
      await sendTransientEphemeralResponse(c, 'CSV attachment is too large. Keep it under 256 KB.', 'error')
      return
    }

    const response = await fetch(attachment.url)
    if (!response.ok) {
      await sendTransientEphemeralResponse(c, `Failed to download CSV attachment (${response.status}).`, 'error')
      return
    }

    const parsedRows = await parseTournamentPlayersCsv(await response.text())
    if ('error' in parsedRows) {
      await sendTransientEphemeralResponse(c, parsedRows.error, 'error')
      return
    }

    const resolvedRows = await resolveTournamentImportRows(c.env.DISCORD_TOKEN, c.interaction.guild_id ?? null, parsedRows)
    if ('error' in resolvedRows) {
      await sendTransientEphemeralResponse(c, resolvedRows.error, 'error')
      return
    }

    const result = await importTournamentPlayers(db, tournament.id, resolvedRows).catch((error) => {
      console.error('[admin:tournament:import] failed to import tournament players', error)
      return { error: 'Failed to import players. Check the CSV for duplicate seeds, duplicate display names, or duplicate Discord user IDs.' }
    })
    if ('error' in result) {
      await sendTransientEphemeralResponse(c, result.error, 'error')
      return
    }

    if (tournament.status !== 'setup') {
      await refreshTournamentLeaderboard(db, getKvStore(c.env), c.env.DISCORD_TOKEN).catch((error) => {
        console.error('[admin:tournament:import] failed to refresh tournament leaderboard', error)
      })
    }

    await sendEphemeralResponse(
      c,
      `Imported **${result.imported}** players into **${tournament.name}**. Linked: **${result.linked}**. Pending: **${result.pending}**.${tournament.status === 'setup' ? ' Start it later with `/admin tournament start`.' : ''}`,
      'success',
    )
  })
}

async function resolveTournamentImportRows(
  token: string,
  guildId: string | null,
  rows: TournamentPlayerImportRow[],
): Promise<TournamentPlayerImportRow[] | { error: string }> {
  const linkedRows = rows.filter(row => row.playerId)
  if (linkedRows.length === 0) return rows
  if (!guildId) return { error: 'Tournament import with Discord IDs must be run from a server so nicknames can be resolved.' }

  const resolvedByPlayerId = new Map<string, { displayName: string, avatarUrl: string | null }>()
  const failures: string[] = []
  for (const row of linkedRows) {
    const playerId = row.playerId!
    if (resolvedByPlayerId.has(playerId)) continue
    try {
      const member = await fetchGuildMember(token, guildId, playerId)
      const displayName = member.nick?.trim()
        || member.user?.global_name?.trim()
        || member.user?.username?.trim()
      if (!displayName) {
        failures.push(playerId)
        continue
      }

      resolvedByPlayerId.set(playerId, {
        displayName,
        avatarUrl: buildGuildMemberAvatarUrl(guildId, playerId, member.avatar) ?? buildDiscordAvatarUrl(playerId, member.user?.avatar ?? null),
      })
    }
    catch (error) {
      failures.push(isDiscordApiError(error) ? `${playerId} (${error.status})` : playerId)
    }
  }

  if (failures.length > 0) return { error: `Could not resolve Discord member names for: ${failures.join(', ')}` }

  return rows.map((row) => {
    if (!row.playerId) return row
    const resolved = resolvedByPlayerId.get(row.playerId)
    return resolved ? { ...row, displayName: resolved.displayName, avatarUrl: resolved.avatarUrl } : row
  })
}

function buildGuildMemberAvatarUrl(guildId: string, userId: string, avatarHash: string | null | undefined): string | null {
  if (!avatarHash) return null
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${avatarHash}.${ext}?size=128`
}

export function handleTournamentStatus(c: AdminCommandContext) {
  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const db = createDb(c.env.DB)
    const tournament = await getCurrentTournament(db)
    if (!tournament) {
      await sendTransientEphemeralResponse(c, 'No current tournament.', 'info')
      return
    }

    const entries = await listTournamentEntrySnapshots(db, tournament.id, { activeOnly: true })
    const playerCount = entries.reduce((sum, entry) => sum + entry.members.length, 0)
    const linked = entries.reduce((sum, entry) => sum + entry.members.filter(member => member.playerId).length, 0)
    const pending = playerCount - linked
    await sendEphemeralResponse(
      c,
      `**${tournament.name}**\nMode: **${tournament.mode}**\nStatus: **${tournament.status}**\nEntries: **${entries.length}**\nPlayers: **${playerCount}** (${linked} linked, ${pending} pending)\nMinimum games: **${tournament.minGames}**\nTop cut: **${tournament.topCut}**\nRematch policy: **${tournament.rematchPolicy}**`,
      'info',
    )
  })
}

export async function handleTournamentEdit(c: AdminCommandContext) {
  const db = createDb(c.env.DB)
  const tournament = await getCurrentTournament(db)
  if (!tournament) {
    return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed('No current tournament.', 'info')] })
  }

  return c.resModal(
    new Modal(ADMIN_TOURNAMENT_EDIT_MODAL_ID, 'Edit Tournament')
      .row(new TextInput('name', 'Name').required().max_length(80).value(tournament.name))
      .row(new TextInput('min_games', 'Minimum games').value(String(tournament.minGames)).required())
      .row(new TextInput('top_cut', 'Playoffs size').value(String(tournament.topCut)).required())
      .row(new TextInput('rematch_policy', 'Rematch policy').value(tournament.rematchPolicy).required()),
  )
}

export function handleTournamentCut(c: AdminCommandContext) {
  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const db = createDb(c.env.DB)
    const tournament = await getCurrentTournament(db)
    if (!tournament) {
      await sendTransientEphemeralResponse(c, 'No current tournament.', 'info')
      return
    }

    const result = await createTournamentCut(db, tournament.id)
    if ('error' in result) {
      await sendTransientEphemeralResponse(c, result.error, 'error')
      return
    }

    await refreshTournamentLeaderboard(db, getKvStore(c.env), c.env.DISCORD_TOKEN).catch((error) => {
      console.error('[admin:tournament:cut] failed to refresh tournament leaderboard', error)
    })

    const cutSizeNote = result.actualTopCut === result.requestedTopCut
      ? `Playoffs: **${result.actualTopCut}**`
      : `Playoffs: **${result.actualTopCut}** eligible players (configured for ${result.requestedTopCut})`
    const pairingLines = result.pairings.map(pairing => `#${pairing.seedOne} ${pairing.playerOneDisplayName} vs #${pairing.seedTwo} ${pairing.playerTwoDisplayName}`)
    await sendEphemeralResponse(
      c,
      `Created **${result.round}** pairings for **${result.tournamentName}**.\n${cutSizeNote}\n${pairingLines.join('\n')}`,
      'success',
    )
  })
}

export function handleTournamentStart(c: AdminCommandContext) {
  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const db = createDb(c.env.DB)
    const tournament = await getCurrentTournament(db)
    if (!tournament) {
      await sendTransientEphemeralResponse(c, 'No current tournament. Create one first with `/admin tournament create`.', 'error')
      return
    }

    const result = await startTournament(db, tournament.id)
    if ('error' in result) {
      await sendTransientEphemeralResponse(c, result.error, 'error')
      return
    }

    await refreshTournamentLeaderboard(db, getKvStore(c.env), c.env.DISCORD_TOKEN).catch((error) => {
      console.error('[admin:tournament:start] failed to refresh tournament leaderboard', error)
    })

    await sendEphemeralResponse(c, `Started tournament **${tournament.name}**. Players can now use \`/tournament create\`.`, 'success')
  })
}

export const modal_admin_tournament_create = factory.modal(
  new Modal(ADMIN_TOURNAMENT_CREATE_MODAL_ID, 'Create Tournament'),
  async (c) => {
    const actorId = getInteractionUserId(c)
    if (!actorId) return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed('Could not identify you.', 'error')] })

    const vars = c.var as Readonly<{
      name?: string
      min_games?: string
      top_cut?: string
      rematch_policy?: string
      mode?: string
    }>
    const name = vars.name?.trim() ?? ''
    if (!name) return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed('Tournament name is required.', 'error')] })

    const rematchPolicy = normalizeTournamentRematchPolicy(vars.rematch_policy) ?? DEFAULT_TOURNAMENT_REMATCH_POLICY
    const mode = vars.mode == null || vars.mode.trim() === '' ? '1v1' : normalizeTournamentMode(vars.mode)
    if (!mode) return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed(`Mode must be one of: ${SUPPORTED_TOURNAMENT_MODES.join(', ')}.`, 'error')] })
    const topCut = normalizeTournamentPositiveInteger(vars.top_cut, 0)
    if (!isSupportedTournamentTopCut(topCut)) {
      return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed(`Top cut must be one of: ${SUPPORTED_TOURNAMENT_TOP_CUTS.join(', ')}.`, 'error')] })
    }
    const db = createDb(c.env.DB)
    const existing = await getCurrentTournament(db)
    if (existing) {
      return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed(`Tournament **${existing.name}** already exists with status **${existing.status}**.`, 'error')] })
    }

    const tournament = await createTournament(db, {
      name,
      createdById: actorId,
      mode,
      minGames: normalizeTournamentPositiveInteger(vars.min_games, DEFAULT_TOURNAMENT_MIN_GAMES),
      topCut,
      rematchPolicy,
    })

    return c.flags('EPHEMERAL').res({
      embeds: [ephemeralResponseEmbed(`Created **${tournament.mode}** tournament **${tournament.name}** in setup. Players can register with \`/tournament register\`${tournament.mode === '1v1' ? ' or be imported by an admin' : ''}.`, 'success')],
    })
  },
)

export const modal_admin_tournament_edit = factory.modal(
  new Modal(ADMIN_TOURNAMENT_EDIT_MODAL_ID, 'Edit Tournament'),
  async (c) => {
    const actorId = getInteractionUserId(c)
    if (!actorId) return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed('Could not identify you.', 'error')] })

    const vars = c.var as Readonly<{
      name?: string
      min_games?: string
      top_cut?: string
      rematch_policy?: string
    }>
    const name = vars.name?.trim() ?? ''
    if (!name) return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed('Tournament name is required.', 'error')] })

    const rematchPolicy = normalizeTournamentRematchPolicy(vars.rematch_policy) ?? DEFAULT_TOURNAMENT_REMATCH_POLICY
    const topCut = normalizeTournamentPositiveInteger(vars.top_cut, 0)
    if (!isSupportedTournamentTopCut(topCut)) {
      return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed(`Top cut must be one of: ${SUPPORTED_TOURNAMENT_TOP_CUTS.join(', ')}.`, 'error')] })
    }
    const db = createDb(c.env.DB)
    const tournament = await getCurrentTournament(db)
    if (!tournament) {
      return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed('No current tournament to edit.', 'error')] })
    }

    await updateTournament(db, tournament.id, {
      name,
      minGames: normalizeTournamentPositiveInteger(vars.min_games, tournament.minGames),
      topCut,
      rematchPolicy,
    })

    if (tournament.status !== 'setup') {
      await refreshTournamentLeaderboard(db, getKvStore(c.env), c.env.DISCORD_TOKEN).catch((error) => {
        console.error('[admin:tournament:edit] failed to refresh tournament leaderboard', error)
      })
    }

    return c.flags('EPHEMERAL').res({
      embeds: [ephemeralResponseEmbed(`Updated tournament **${name}**.`, 'success')],
    })
  },
)

function resolveAttachment(c: AdminCommandContext, attachmentId: string | undefined): ResolvedAttachment | null {
  if (!attachmentId) return null
  const attachments = (c.interaction.data as AttachmentInteractionData | undefined)?.resolved?.attachments
  return attachments?.[attachmentId] ?? null
}
