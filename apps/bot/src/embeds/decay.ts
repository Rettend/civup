import type { PublicRatingDecayPolicy, PublicRatingDecayState } from '@civup/rating'
import { Embed } from 'discord-hono'
import { PUBLIC_RATING_DECAY, PUBLIC_RATING_START, settlePublicRatingDecay, visiblePublicRating } from '@civup/rating'

interface DecayRating {
  mode: string
  publicRating: number | null
  publicDecay: PublicRatingDecayState | null
}

export function playerDecayEmbed(input: {
  displayName: string
  avatarUrl?: string | null
  ratings: readonly DecayRating[]
  policy: PublicRatingDecayPolicy | null
  season: { ratingSystem: string; startsAt: number; endsAt: number | null } | null
  now: number
  modeOnly?: boolean
}) {
  const at = Math.min(input.now, input.season?.endsAt ?? input.now)
  const publicEra = input.season?.ratingSystem === 'rp'
  const fields = (
    [
      ['global', 'Overall'],
      ['duel', 'Duel'],
      ['duo', 'Duo'],
      ['squad', 'Squad'],
      ['ffa', 'FFA'],
    ] as const
  )
    .filter(([mode]) => !input.modeOnly || mode !== 'global')
    .map(([mode, label]) => {
      const row = input.ratings.find(row => row.mode === mode)
      const rating = row?.publicRating ?? PUBLIC_RATING_START
      const decay =
        publicEra && input.policy
          ? settlePublicRatingDecay(rating, row?.publicDecay, at, input.policy, input.season!.startsAt)
          : { rating, state: null }
      const bank = decay.state
      const days = bank
        ? Math.max(0, Math.min(PUBLIC_RATING_DECAY.reserveDays, Math.ceil((bank.bankUntil - at) / 86_400_000)))
        : 0
      const hasDecay = bank && (bank.active || decay.rating >= PUBLIC_RATING_DECAY.floor)
      return {
        name: publicEra ? `${label} · ${visiblePublicRating(decay.rating).toLocaleString('en-US')} RP` : label,
        value: hasDecay
          ? `Bank: ${days}/60 days${days === 0 ? ` ⚠️${bank.active ? ' `−2 RP/day`' : ''}` : ''}`
          : 'No decay',
        inline: false,
      }
    })
  return new Embed()
    .title('Decay')
    .color(0xc8aa6e)
    .fields(...fields, {
      name: '\u200B',
      value: 'Starts at 1,550 RP, Stops at 1,500 RP\n+14 days/game, -2 RP/day when empty',
    })
    .footer({ text: input.displayName, icon_url: input.avatarUrl ?? undefined })
    .toJSON()
}
