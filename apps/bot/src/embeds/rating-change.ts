export function formatPublicRatingChange(before: number, after: number): string {
  const rawDelta = after - before
  const deltaText = formatSignedPublicRatingDelta(rawDelta).padStart(4, ' ')
  const trendEmoji = rawDelta < 0 ? '📉' : '📈'
  const updatedRating = formatPublicRatingValue(after, rawDelta)
  const updatedRp = `(${updatedRating.padStart(6, ' ')} RP)`

  return `\`${deltaText} RP\` ${trendEmoji} \`${updatedRp}\``
}

export function formatPublicRatingValue(value: number, delta?: number): string {
  return delta !== 0 && delta != null && Math.abs(delta) < 1 ? value.toFixed(1) : String(Math.round(value))
}

export function formatSignedPublicRatingDelta(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0'
  if (Math.abs(value) < 1) {
    const visible = Math.max(0.1, Math.round(Math.abs(value) * 10) / 10)
    return `${value > 0 ? '+' : '-'}${visible.toFixed(1)}`
  }
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}`
}

export function formatUnrankedResultMarker(placement: number | null | undefined): string {
  return placement === 1 ? '`  +` 📈' : '`  -` 📉'
}
