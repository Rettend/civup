import type { RankedPreviewBandSummary, RankedPreviewModeSummary, RankedPreviewSummary } from '../services/ranked/role-sync.ts'
import { formatLeaderboardModeLabel } from '@civup/game'
import { Embed } from 'discord-hono'
import { formatRankedRoleSlotLabel } from '../services/ranked/roles.ts'

const RANKED_PREVIEW_COLOR = 0xC8AA6E

export function rankedPreviewEmbed(summary: RankedPreviewSummary): Embed {
  const embed = new Embed()
    .title('Ranked Roles')
    .color(RANKED_PREVIEW_COLOR)
    .footer({ text: summary.dirty ? 'Pending ranked sync' : 'Up to date' })

  const fields: Array<{ name: string, value: string, inline?: boolean }> = []

  fields.push(...buildConfiguredBandFields(summary))

  if (summary.modes.length > 0) {
    for (const mode of summary.modes) {
      fields.push(...buildModeCutoffFields(mode))
    }
  }

  embed.fields(...fields)
  return embed
}

function buildConfiguredBandFields(summary: RankedPreviewSummary): Array<{ name: string, value: string, inline?: boolean }> {
  return [
    {
      name: 'Role',
      value: summary.bands.map(band => formatRoleReference(band.roleId, band.tier)).join('\n'),
      inline: true,
    },
    {
      name: 'Earn',
      value: summary.bands.map(formatBandEarnValue).join('\n'),
      inline: true,
    },
    {
      name: 'Keep',
      value: summary.bands.map(formatBandKeepValue).join('\n'),
      inline: true,
    },
    {
      name: 'Unranked',
      value: String(summary.unrankedCount),
      inline: true,
    },
  ]
}

function buildModeCutoffFields(mode: RankedPreviewModeSummary): Array<{ name: string, value: string, inline?: boolean }> {
  if (mode.rankedCount <= 0 || mode.tiers.length === 0) {
    return [{
      name: `${formatLeaderboardModeLabel(mode.mode, mode.mode)} (${mode.rankedCount} ranked)`,
      value: 'No ranked players yet.',
      inline: false,
    }]
  }

  return [
    {
      name: `${formatLeaderboardModeLabel(mode.mode, mode.mode)} (${mode.rankedCount} ranked)`,
      value: '\u200B',
      inline: false,
    },
    {
      name: 'Role',
      value: mode.tiers.map(tier => formatRoleReference(tier.roleId, tier.tier)).join('\n'),
      inline: true,
    },
    {
      name: 'Cutoff',
      value: mode.tiers.map(formatTierCutoffValue).join('\n'),
      inline: true,
    },
    {
      name: 'Score',
      value: mode.tiers.map(formatTierScoreValue).join('\n'),
      inline: true,
    },
  ]
}

function formatRoleReference(roleId: string | null, tier: RankedPreviewBandSummary['tier']): string {
  return roleId ? `<@&${roleId}>` : formatRankedRoleSlotLabel(tier)
}

function formatBandEarnValue(band: RankedPreviewBandSummary): string {
  if (band.isFallback) {
    return `The rest (Top ${formatPercent(band.cumulativeEarnPercent)}%)`
  }
  return `${formatPercent(band.earnPercent)}% (Top ${formatPercent(band.cumulativeEarnPercent)}%)`
}

function formatBandKeepValue(band: RankedPreviewBandSummary): string {
  if (band.isFallback || band.keepOverallPercent == null) return '-'
  return `${formatPercent(band.keepOverallPercent)}% (Top ${formatPercent(band.keepOverallPercent)}%)`
}

function formatTierCutoffValue(tier: RankedPreviewModeSummary['tiers'][number]): string {
  if (tier.isFallback) return 'The rest'
  if (tier.locked) return 'Locked'
  if (tier.cutoffRank == null) return 'No cutoff'
  return `#${tier.cutoffRank}`
}

function formatTierScoreValue(tier: RankedPreviewModeSummary['tiers'][number]): string {
  if (tier.isFallback) return '-'
  if (tier.locked) return `${tier.unlockMinPlayers} players (${tier.playersNeededToUnlock} more)`
  if (tier.cutoffScore == null) return '-'
  return String(Math.round(tier.cutoffScore))
}

function formatPercent(value: number | null): string {
  return ((value ?? 0) * 100).toFixed(1)
}
