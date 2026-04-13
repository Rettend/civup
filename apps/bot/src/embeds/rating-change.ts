export function formatDisplayRatingChange(before: number, after: number): string {
  const rawDelta = after - before
  const roundedDelta = Math.round(rawDelta)
  const deltaValue = Object.is(roundedDelta, -0) ? '-0' : String(roundedDelta)
  const deltaText = `${rawDelta < 0 ? '' : '+'}${deltaValue}`.padStart(3, ' ')
  const trendEmoji = rawDelta < 0 ? '📉' : '📈'
  const updatedElo = `(${String(Math.round(after)).padStart(4, ' ')})`

  return `\`${deltaText}\` ${trendEmoji} \`${updatedElo}\``
}
