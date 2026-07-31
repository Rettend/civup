import type { Database } from '@civup/db'
import type { CompetitiveTier } from '@civup/game'
import type { StatsContext } from '../stats/context.ts'
import type { RankedRoleConfig } from './roles.ts'
import { competitiveTierMeetsMaximum, competitiveTierMeetsMinimum } from '@civup/game'
import { previewRankedRoles } from './role-sync.ts'
import { buildRankedRoleVisuals, getRankedRoleCalculationConfig, hasConfiguredRankedRoleTier } from './roles.ts'

export interface CalculatedRank {
  qualified: boolean
  rank: number | null
  tier: CompetitiveTier | null
}

export async function calculateRanksForPlayers(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  playerIds: readonly string[],
): Promise<{ ranks: Map<string, CalculatedRank>, config: RankedRoleConfig, configValid: boolean, visuals: ReturnType<typeof buildRankedRoleVisuals> }> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const style = await getRankedRoleCalculationConfig(kv, statsContext.guildId, statsContext.primaryGuildId)
  const visuals = buildRankedRoleVisuals(style.config)
  if (!style.valid || uniquePlayerIds.length === 0) {
    return { ranks: new Map(), config: style.config, configValid: style.valid, visuals }
  }

  const preview = await previewRankedRoles({
    db,
    kv,
    guildId: statsContext.guildId,
    statsContext,
    playerIds: uniquePlayerIds,
    includePlayerIdentities: false,
    fullRosterGraceCaps: false,
    configOverride: style.config,
  })
  const byPlayerId = new Map(preview.playerPreviews.map(player => [player.playerId, player]))
  return {
    configValid: true,
    config: style.config,
    visuals,
    ranks: new Map(uniquePlayerIds.map((playerId) => {
      const player = byPlayerId.get(playerId)
      const qualified = player?.qualified === true
      return [playerId, {
        qualified,
        rank: null,
        tier: qualified ? player.liveAssignment.tier : null,
      }]
    })),
  }
}

export async function getCalculatedRankGateError(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  lobby: {
    minRole: CompetitiveTier | null
    maxRole: CompetitiveTier | null
  },
  playerIds: readonly string[],
): Promise<string | null> {
  if (!lobby.minRole && !lobby.maxRole) return null

  const calculation = await calculateRanksForPlayers(db, kv, statsContext, playerIds)
  if (!calculation.configValid) return 'This server has an incomplete rank setup, so rank-gated lobbies are unavailable.'
  if ((lobby.minRole && !hasConfiguredRankedRoleTier(calculation.config, lobby.minRole)) || (lobby.maxRole && !hasConfiguredRankedRoleTier(calculation.config, lobby.maxRole))) {
    return 'This lobby uses a rank that is not configured for its server.'
  }

  for (const playerId of playerIds) {
    const rank = calculation.ranks.get(playerId) ?? { qualified: false, rank: null, tier: null }
    if (!rank.qualified) return `<@${playerId}> is unranked in this server and cannot join a rank-gated lobby.`
    if (!competitiveTierMeetsMinimum(rank.tier, lobby.minRole)) {
      return `This lobby requires at least ${rankGateLabel(calculation.visuals, lobby.minRole)}.`
    }
    if (!competitiveTierMeetsMaximum(rank.tier, lobby.maxRole)) {
      return `This lobby allows up to ${rankGateLabel(calculation.visuals, lobby.maxRole)}.`
    }
  }
  return null
}

function rankGateLabel(
  visuals: ReturnType<typeof buildRankedRoleVisuals>,
  tier: CompetitiveTier | null,
): string {
  return visuals.find(option => option.tier === tier)?.label ?? 'that ranked role'
}
