import type { RankedPreviewBandSummary, RankedPreviewModeSummary, RankedPreviewSummary } from '../services/ranked/role-sync.ts'
import { formatLeaderboardModeLabel } from '@civup/game'
import { PUBLIC_RATING_BANDS, rankDivisionSuffix } from '@civup/rating'
import { Embed } from 'discord-hono'
import { formatRankedRoleSlotLabel, getConfiguredDivisionLabel, getConfiguredRankedRoleLabel } from '../services/ranked/roles.ts'

const RANKED_PREVIEW_COLOR = 0xC8AA6E

export function rankedPreviewEmbeds(summary: RankedPreviewSummary): Embed[] {
  if (summary.ratingSystem === 'rp') return publicRankedPreviewEmbeds(summary)
  const embeds: Embed[] = [
    new Embed()
      .title('Ranked Roles')
      .color(RANKED_PREVIEW_COLOR)
      .fields(...buildConfiguredBandFields(summary)),
  ]

  const modeEmbeds = summary.modes
    .filter(hasModeCutoffData)
    .map((mode) => {
      const embed = new Embed()
        .title(`${formatLeaderboardModeLabel(mode.mode, mode.mode)} - ${mode.rankedCount} ranked`)
        .color(RANKED_PREVIEW_COLOR)

      embed.fields(...buildModeCutoffFields(mode))
      return embed
    })

  const lastEmbed = modeEmbeds[modeEmbeds.length - 1] ?? embeds[0]
  lastEmbed?.footer({ text: summary.dirty ? 'Pending ranked sync' : 'Up to date' })

  embeds.push(...modeEmbeds)
  return embeds
}

function publicRankedPreviewEmbeds(summary: RankedPreviewSummary): Embed[] {
  const fields = [...new Set(PUBLIC_RATING_BANDS.map(band => band.tier))].map((tier) => {
    const bands = PUBLIC_RATING_BANDS.filter(band => band.tier === tier)
    const roleId = summary.bands.find(band => band.tier === tier)?.roleId
    return {
      name: getConfiguredRankedRoleLabel(summary.config, bands[0]!.tier)!,
      value: bands.map((band) => {
        const next = PUBLIC_RATING_BANDS[PUBLIC_RATING_BANDS.indexOf(band) + 1]
        const range = next ? `${band.minimum}–${next.minimum - 1} RP` : `${band.minimum}+ RP`
        const division = rankDivisionSuffix(band.division)
        const divisionRoleId = summary.config.divisionPolicy?.roleIdsByMinimum[band.minimum]
        const label = divisionRoleId ? `<@&${divisionRoleId}>` : roleId ? `<@&${roleId}>${division}` : getConfiguredDivisionLabel(summary.config, band.minimum)
        const padding = division ? '\u2009\u200A'.repeat(3 - division.trim().length) : ''
        return `${label}${padding} ${range}`
      }).join('\n'),
      inline: true,
    }
  })
  return [new Embed().title('Rank Ladder').color(RANKED_PREVIEW_COLOR).fields(...fields)]
}

function hasModeCutoffData(mode: RankedPreviewModeSummary): boolean {
  return mode.rankedCount > 0 && mode.tiers.length > 0
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
  return [
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
  if (band.isFallback || band.keepPercent == null || band.cumulativeKeepPercent == null) return '-'
  return `${formatPercent(band.keepPercent)}% (Top ${formatPercent(band.cumulativeKeepPercent)}%)`
}

function formatTierCutoffValue(tier: RankedPreviewModeSummary['tiers'][number]): string {
  if (tier.isFallback) return 'The rest'
  if (tier.cutoffRank == null) return 'No cutoff'
  return `#${tier.cutoffRank}`
}

function formatTierScoreValue(tier: RankedPreviewModeSummary['tiers'][number]): string {
  if (tier.isFallback) return '-'
  if (tier.cutoffScore == null) return '-'
  return String(Math.round(tier.cutoffScore))
}

function formatPercent(value: number | null): string {
  return ((value ?? 0) * 100).toFixed(1)
}
