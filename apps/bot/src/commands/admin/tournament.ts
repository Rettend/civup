import type { AdminCommandContext } from './types.ts'
import { createDb } from '@civup/db'
import { Modal, TextInput } from 'discord-hono'
import { ephemeralResponseEmbed } from '../../embeds/response.ts'
import { getKvStore } from '../../services/kv/batch.ts'
import { buildTournamentStandings, createTournament, createTournamentCut, DEFAULT_TOURNAMENT_MIN_GAMES, DEFAULT_TOURNAMENT_REMATCH_POLICY, DEFAULT_TOURNAMENT_TOP_CUT, getCurrentTournament, importTournamentPlayersCsv, isSupportedTournamentTopCut, normalizeTournamentPositiveInteger, normalizeTournamentRematchPolicy, refreshTournamentLeaderboard, startTournament, SUPPORTED_TOURNAMENT_TOP_CUTS, updateTournament } from '../../services/tournament/index.ts'
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
      .row(new TextInput('rematch_policy', 'Rematch policy').value(DEFAULT_TOURNAMENT_REMATCH_POLICY).required()),
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

    const csv = await response.text()
    const result = await importTournamentPlayersCsv(db, tournament.id, csv)
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

export function handleTournamentStatus(c: AdminCommandContext) {
  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const db = createDb(c.env.DB)
    const tournament = await getCurrentTournament(db)
    if (!tournament) {
      await sendTransientEphemeralResponse(c, 'No current tournament.', 'info')
      return
    }

    const standings = await buildTournamentStandings(db, tournament.id)
    const linked = standings.filter(row => row.playerId).length
    const pending = standings.length - linked
    await sendEphemeralResponse(
      c,
      `**${tournament.name}**\nStatus: **${tournament.status}**\nPlayers: **${standings.length}** (${linked} linked, ${pending} pending)\nMinimum games: **${tournament.minGames}**\nTop cut: **${tournament.topCut}**\nRematch policy: **${tournament.rematchPolicy}**`,
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
    }>
    const name = vars.name?.trim() ?? ''
    if (!name) return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed('Tournament name is required.', 'error')] })

    const rematchPolicy = normalizeTournamentRematchPolicy(vars.rematch_policy) ?? DEFAULT_TOURNAMENT_REMATCH_POLICY
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
      minGames: normalizeTournamentPositiveInteger(vars.min_games, DEFAULT_TOURNAMENT_MIN_GAMES),
      topCut,
      rematchPolicy,
    })

    return c.flags('EPHEMERAL').res({
      embeds: [ephemeralResponseEmbed(`Created tournament **${tournament.name}** in setup. Import players with \`/admin tournament import\`, then start it with \`/admin tournament start\`.`, 'success')],
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
