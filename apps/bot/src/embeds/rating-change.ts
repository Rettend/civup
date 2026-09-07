import type { PublicRatingSnapshot } from '@civup/rating'
import { publicRatingPresentation } from '@civup/rating'

export function formatPublicRatingSnapshotChange(snapshot: PublicRatingSnapshot): string | null {
  if (snapshot.ratingSystem !== 'rp') return null
  if (!snapshot.publicRatingReady || snapshot.publicRatingBefore == null || snapshot.publicRatingAfter == null) return '`Rating pending`'
  return `\`${publicRatingPresentation(snapshot.publicRatingBefore, snapshot.publicRatingAfter).text}\``
}

export function formatDisplayRatingChange(before: number, after: number): string {
  const rawDelta = after - before
  const roundedDelta = Math.round(rawDelta)
  const deltaValue = Object.is(roundedDelta, -0) ? '-0' : String(roundedDelta)
  const deltaText = `${rawDelta < 0 ? '' : '+'}${deltaValue}`.padStart(3, ' ')
  const trendEmoji = rawDelta < 0 ? '📉' : '📈'
  const updatedElo = `(${String(Math.round(after)).padStart(4, ' ')})`

  return `\`${deltaText}\` ${trendEmoji} \`${updatedElo}\``
}

export function formatUnrankedResultMarker(placement: number | null | undefined): string {
  return placement === 1 ? '`  +` 📈' : '`  -` 📉'
}
