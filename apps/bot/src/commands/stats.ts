import type { StatsModeFilter } from '../embeds/player-card.ts'
import { createDb } from '@civup/db'
import { GAME_MODE_CHOICES, getLeaders, LEADERBOARD_MODES, parseGameMode, searchLeaders, toLeaderboardMode } from '@civup/game'
import { Autocomplete, Command, Option } from 'discord-hono'
import { leaderStatsEmbed } from '../embeds/leader-card.ts'
import { playerCardEmbed } from '../embeds/player-card.ts'
import { teamCardEmbed } from '../embeds/team-card.ts'
import { getIdentityByUserId } from './identity.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { upsertPlayerProfiles } from '../services/player/profile.ts'
import { getPlayerStatsRankProfile } from '../services/player/rank.ts'
import { rankedRoleMembershipNeedsRepair, repairCurrentRankedRoleMembership } from '../services/ranked/role-sync.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { factory } from '../setup.ts'

interface Var {
  player?: string
  leader?: string
  mode?: string
  teammate1?: string
  teammate2?: string
  teammate3?: string
  teammate4?: string
  teammate5?: string
}

const LIVE_LEADER_ID_SET = new Set(getLeaders('live').map(leader => leader.id))
const BETA_LEADER_ID_SET = new Set(getLeaders('beta').map(leader => leader.id))

export const command_stats = factory.autocomplete<Var>(
  new Command('stats', 'View player or leader stats').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
    new Option('leader', 'Leader to look up').autocomplete(),
    new Option('mode', 'Filter by game mode').choices(...GAME_MODE_CHOICES),
    new Option('teammate1', 'First teammate for lineup stats', 'User'),
    new Option('teammate2', 'Second teammate for lineup stats', 'User'),
    new Option('teammate3', 'Third teammate for lineup stats', 'User'),
    new Option('teammate4', 'Fourth teammate for lineup stats', 'User'),
    new Option('teammate5', 'Fifth teammate for lineup stats', 'User'),
  ),
  c => c.resAutocomplete(
    new Autocomplete(typeof c.focused?.value === 'string' ? c.focused.value : '').choices(
      ...buildLeaderAutocompleteChoices(typeof c.focused?.value === 'string' ? c.focused.value : ''),
    ),
  ),
  (c) => {
    const guildId = c.interaction.guild_id
    const leaderId = c.var.leader ? resolveLeaderInput(c.var.leader) : null
    const targetId = c.var.player
      ?? c.interaction.member?.user?.id
      ?? c.interaction.user?.id
    const invokingPlayerId = c.interaction.member?.user?.id ?? c.interaction.user?.id
    const invokingRoleIds = targetId === invokingPlayerId && Array.isArray(c.interaction.member?.roles)
      ? c.interaction.member.roles.filter((roleId): roleId is string => typeof roleId === 'string')
      : null
    const teammateIds = [c.var.teammate1, c.var.teammate2, c.var.teammate3, c.var.teammate4, c.var.teammate5]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    const mode = (parseGameMode(c.var.mode) ?? 'all') as StatsModeFilter
    const isDefaultSelfLookup = !c.var.player && !c.var.leader && !c.var.mode && teammateIds.length === 0

    if (c.var.leader && !leaderId) return c.res('Choose a leader from the autocomplete suggestions.')
    if (leaderId && (c.var.player || teammateIds.length > 0)) return c.res('Use either leader stats or player/team stats.')

    if (leaderId) {
      return resDeferGeneralCommandResponse(c, async (c) => {
        const db = createDb(c.env.DB)
        const embed = await leaderStatsEmbed(db, leaderId, mode)
        return { embeds: [embed] }
      })
    }

    if (!targetId) return c.res('Could not identify the player.')
    const playerIds = [targetId, ...teammateIds]
    if (new Set(playerIds).size !== playerIds.length) {
      return c.res('Pick unique players for lineup stats.')
    }

    return resDeferGeneralCommandResponse(c, async (c) => {
      const db = createDb(c.env.DB)
      const kv = getKvStore(c.env)
      const identities = new Map(playerIds.flatMap((playerId) => {
        const identity = getIdentityByUserId(c, playerId)
        return identity ? [[identity.userId, identity] as const] : []
      }))
      await upsertPlayerProfiles(db, [...identities.values()].map(identity => ({
        playerId: identity.userId,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
      })))

      if (teammateIds.length > 0) {
        const embed = await teamCardEmbed(db, kv, guildId ?? null, playerIds, mode)
        return { embeds: [embed] }
      }

      const rankProfile = guildId
        ? await getPlayerStatsRankProfile(db, kv, guildId, targetId)
        : null

      if (
        guildId
        && invokingRoleIds
        && rankProfile?.rankedRoleRepair
        && rankedRoleMembershipNeedsRepair({
          currentRoleIds: invokingRoleIds,
          ...rankProfile.rankedRoleRepair,
        })
      ) {
        c.executionCtx.waitUntil(repairCurrentRankedRoleMembership({
          kv,
          token: c.env.DISCORD_TOKEN,
          guildId,
          playerId: targetId,
          currentRoleIds: invokingRoleIds,
        }).catch((error) => {
          console.error(`Failed to repair ranked role from /stats for ${targetId}:`, error)
        }))
      }

      const visibleModes = mode === 'all'
        ? LEADERBOARD_MODES
        : (() => {
            const leaderboardMode = toLeaderboardMode(mode)
            return leaderboardMode ? [leaderboardMode] as const : LEADERBOARD_MODES
          })()

      const embed = await playerCardEmbed(db, targetId, mode, {
        rankProfile: rankProfile?.rankProfile ?? null,
        ratingRows: rankProfile?.ratingRows,
        visibleModes,
      })
      return { embeds: [embed] }
    }, {
      ephemeral: isDefaultSelfLookup,
    })
  },
)

function buildLeaderAutocompleteChoices(query: string): Array<{ name: string, value: string }> {
  const trimmed = query.trim()
  const leaders = trimmed.length > 0
    ? [...searchLeaders(trimmed, 'live'), ...searchLeaders(trimmed, 'beta')]
    : [...getLeaders('live'), ...getLeaders('beta')]
  const seen = new Set<string>()
  const choices: Array<{ name: string, value: string }> = []

  for (const leader of leaders) {
    if ((!LIVE_LEADER_ID_SET.has(leader.id) && !BETA_LEADER_ID_SET.has(leader.id)) || seen.has(leader.id)) continue
    seen.add(leader.id)
    choices.push({
      name: truncateAutocompleteName(`${leader.name} - ${leader.civilization}`),
      value: leader.id,
    })
    if (choices.length >= 25) break
  }

  return choices
}

function resolveLeaderInput(input: string): string | null {
  const normalized = input.trim()
  if (LIVE_LEADER_ID_SET.has(normalized) || BETA_LEADER_ID_SET.has(normalized)) return normalized

  const lower = normalized.toLowerCase()
  const exact = getLeaders('live').find(leader => leader.name.toLowerCase() === lower || `${leader.name} ${leader.civilization}`.toLowerCase() === lower)
  if (exact) return exact.id
  const betaExact = getLeaders('beta').find(leader => leader.name.toLowerCase() === lower || `${leader.name} ${leader.civilization}`.toLowerCase() === lower)
  if (betaExact) return betaExact.id

  const matches = searchLeaders(normalized, 'live').filter(leader => LIVE_LEADER_ID_SET.has(leader.id))
  if (matches.length === 1) return matches[0]!.id
  const betaMatches = searchLeaders(normalized, 'beta').filter(leader => BETA_LEADER_ID_SET.has(leader.id))
  return betaMatches.length === 1 ? betaMatches[0]!.id : null
}

function truncateAutocompleteName(name: string): string {
  return name.length <= 100 ? name : `${name.slice(0, 97)}...`
}
