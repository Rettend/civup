import type { Database } from '@civup/db'
import type { PlayerRating, RatingUpdate } from '@civup/rating'
import type { StatsContext } from '../services/stats/context.ts'
import { createDb, scopedPlayerRatings as playerRatings } from '@civup/db'
import { calculatePublicRatingUpdate, calculateRatings, createRating, predictWinProbabilities, PUBLIC_RATING_START, resolvePublicRating } from '@civup/rating'
import { Button, Command, Components, Embed } from 'discord-hono'
import { and, eq, inArray } from 'drizzle-orm'
import { getIdentity, getIdentityByUserId } from './identity.ts'
import { upsertPlayerProfiles } from '../services/player/profile.ts'
import { SHOW_EPHEMERAL_RESPONSE_BUTTON_ID } from '../services/response/ephemeral.ts'
import { formatPublicRatingValue, formatSignedPublicRatingDelta } from '../embeds/rating-change.ts'
import { factory } from '../setup.ts'
import { resolveStatsContext } from '../services/stats/context.ts'

const USER_COMMAND_TYPE = 2
const DUEL_MODE = 'duel'

interface PreviewEloIdentity {
  userId: string
  displayName: string
  avatarUrl: string | null
}

export interface DuelEloPreviewInput extends PlayerRating {
  gamesPlayed: number
  publicRating: number
}

export interface DuelEloPreviewUpdate {
  hidden: RatingUpdate
  publicRatingBefore: number
  publicRatingAfter: number
  publicRatingDelta: number
}

export interface DuelEloPreview {
  viewerWinProbability: number
  targetWinProbability: number
  viewerWin: DuelEloPreviewUpdate
  targetLoss: DuelEloPreviewUpdate
  viewerLoss: DuelEloPreviewUpdate
  targetWin: DuelEloPreviewUpdate
}

export const command_preview_elo = factory.command(
  new Command('Preview Rating').type(USER_COMMAND_TYPE),
  (c) => {
    const targetId = getInteractionTargetId(c.interaction.data)
    const viewer = getIdentity(c)

    if (!c.interaction.guild_id) return c.flags('EPHEMERAL').res('This command can only be used in a server.')
    if (!viewer) return c.flags('EPHEMERAL').res('Could not identify you.')
    if (!targetId) return c.flags('EPHEMERAL').res('Could not identify the target player.')
    if (targetId === viewer.userId) return c.flags('EPHEMERAL').res('Pick another player to preview duel rating.')

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      try {
        const db = createDb(c.env.DB)
        const target = getIdentityByUserId(c, targetId) ?? {
          userId: targetId,
          displayName: targetId,
          avatarUrl: null,
        }

        await upsertPlayerProfiles(db, [viewer, target].map(identity => ({
          playerId: identity.userId,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        })))
        const embed = await duelEloPreviewEmbed(db, resolveStatsContext(c.interaction.guild_id, c.env), viewer, target)
        await c.followup({ embeds: [embed], components: previewEloComponents(), allowed_mentions: { parse: [] } })
      }
      catch (error) {
        console.error('Failed to build duel rating preview:', error)
        await c.followup({ content: 'Failed to build this rating preview.', allowed_mentions: { parse: [] } })
      }
    })
  },
)

export function previewEloComponents(): Components {
  return new Components().row(
    new Button(SHOW_EPHEMERAL_RESPONSE_BUTTON_ID, 'Show', 'Secondary'),
  )
}

function getInteractionTargetId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const targetId = (data as { target_id?: unknown }).target_id
  return typeof targetId === 'string' && targetId.length > 0 ? targetId : null
}

export async function duelEloPreviewEmbed(db: Database, statsContext: StatsContext, viewer: PreviewEloIdentity, target: PreviewEloIdentity): Promise<Embed> {
  const ratings = await loadDuelPreviewRatings(db, statsContext, [viewer.userId, target.userId])
  const viewerRating = ratings.get(viewer.userId) ?? defaultPreviewRating(viewer.userId)
  const targetRating = ratings.get(target.userId) ?? defaultPreviewRating(target.userId)
  const preview = calculateDuelEloPreview(viewerRating, targetRating)

  return new Embed()
    .title('Preview Rating (1v1)')
    .description(`${formatUserMention(viewer.userId)} vs ${formatUserMention(target.userId)}`)
    .color(0xC8AA6E)
    .fields(
      {
        name: 'Current RP',
        value: `${viewer.displayName}: \`${formatPublicRating(preview.viewerWin.publicRatingBefore)}\`\n${target.displayName}: \`${formatPublicRating(preview.targetWin.publicRatingBefore)}\``,
        inline: true,
      },
      {
        name: 'Win Chance',
        value: `${viewer.displayName}: \`${formatPercent(preview.viewerWinProbability)}%\`\n${target.displayName}: \`${formatPercent(preview.targetWinProbability)}%\``,
        inline: true,
      },
      {
        name: 'If You Win',
        value: [
          formatOutcomeLine(viewer.displayName, preview.viewerWin),
          formatOutcomeLine(target.displayName, preview.targetLoss),
        ].join('\n'),
        inline: false,
      },
      {
        name: 'If You Lose',
        value: [
          formatOutcomeLine(viewer.displayName, preview.viewerLoss),
          formatOutcomeLine(target.displayName, preview.targetWin),
        ].join('\n'),
        inline: false,
      },
    )
    .footer({ text: target.displayName, icon_url: target.avatarUrl ?? undefined })
}

export function calculateDuelEloPreview(viewer: DuelEloPreviewInput, target: DuelEloPreviewInput): DuelEloPreview {
  const probabilities = predictWinProbabilities([[viewer], [target]])
  const viewerWins = calculateRatings({
    type: 'team',
    teams: [{ players: [viewer] }, { players: [target] }],
  })
  const targetWins = calculateRatings({
    type: 'team',
    teams: [{ players: [target] }, { players: [viewer] }],
  })

  return {
    viewerWinProbability: clampProbability(probabilities[0] ?? 0.5),
    targetWinProbability: clampProbability(probabilities[1] ?? 0.5),
    viewerWin: projectPublicUpdate(requireUpdate(viewerWins, viewer.playerId), viewer.publicRating),
    targetLoss: projectPublicUpdate(requireUpdate(viewerWins, target.playerId), target.publicRating),
    viewerLoss: projectPublicUpdate(requireUpdate(targetWins, viewer.playerId), viewer.publicRating),
    targetWin: projectPublicUpdate(requireUpdate(targetWins, target.playerId), target.publicRating),
  }
}

async function loadDuelPreviewRatings(db: Database, statsContext: StatsContext, playerIds: readonly string[]): Promise<Map<string, DuelEloPreviewInput>> {
  const uniquePlayerIds = [...new Set(playerIds)]
  if (uniquePlayerIds.length === 0) return new Map()

  const rows = await db
    .select({
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      gamesPlayed: playerRatings.gamesPlayed,
      publicRating: playerRatings.publicRating,
    })
    .from(playerRatings)
    .where(and(
      eq(playerRatings.statsKey, statsContext.statsKey),
      eq(playerRatings.mode, DUEL_MODE),
      inArray(playerRatings.playerId, uniquePlayerIds),
    ))

  return new Map(rows.map(row => [row.playerId, {
    playerId: row.playerId,
    mu: row.mu,
    sigma: row.sigma,
    gamesPlayed: row.gamesPlayed,
    publicRating: resolvePublicRating(row.publicRating, row.mu),
  }]))
}

function defaultPreviewRating(playerId: string): DuelEloPreviewInput {
  const rating = createRating(playerId)
  return { ...rating, gamesPlayed: 0, publicRating: PUBLIC_RATING_START }
}

function requireUpdate(updates: readonly RatingUpdate[], playerId: string): RatingUpdate {
  const update = updates.find(update => update.playerId === playerId)
  if (!update) throw new Error(`Missing rating update for ${playerId}`)
  return update
}

function projectPublicUpdate(hidden: RatingUpdate, priorPublicRating: number): DuelEloPreviewUpdate {
  const update = calculatePublicRatingUpdate({
    priorPublicRating,
    hiddenMuBefore: hidden.before.mu,
    hiddenMuAfterRaw: hidden.after.mu,
    sourceWeight: 1,
  })
  return {
    hidden,
    publicRatingBefore: update.before,
    publicRatingAfter: update.after,
    publicRatingDelta: update.delta,
  }
}

function formatOutcomeLine(name: string, update: DuelEloPreviewUpdate): string {
  return `${name}: \`${formatSignedPublicRatingDelta(update.publicRatingDelta)} RP\` -> \`${formatPublicRatingValue(update.publicRatingAfter, update.publicRatingDelta)} RP\``
}

function formatUserMention(userId: string): string {
  return `<@${userId}>`
}

function formatPublicRating(value: number): number {
  return Math.round(value)
}

function formatPercent(probability: number): number {
  return Math.round(clampProbability(probability) * 100)
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, value))
}
