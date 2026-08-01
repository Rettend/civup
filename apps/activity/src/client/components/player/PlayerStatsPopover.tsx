import type { JSX } from 'solid-js'
import { DISPLAY_RATING_BASE } from '@civup/rating'
import { Show } from 'solid-js'

export interface PublicPlayerStats {
  publicRating?: number | null
  rank?: number | null
  gamesPlayed?: number
  wins?: number
}

export function PlayerStatsPopover(props: {
  name: string
  avatarUrl?: string | null
  stats?: PublicPlayerStats | null
  statsLabel: string
  unranked?: boolean
  role?: { label: string, style?: JSX.CSSProperties } | null
  style?: JSX.CSSProperties
  setRef?: (element: HTMLDivElement) => void
}) {
  const ratingValue = () => formatRating(props.stats, props.unranked)
  const recordValue = () => formatRecord(props.stats)
  const winRateValue = () => formatWinRate(props.stats)
  const rankValue = () => props.stats?.rank ? `#${props.stats.rank}` : 'Unranked'

  return (
    <div
      ref={props.setRef}
      role="dialog"
      aria-label={`${props.name} stats`}
      class="pointer-events-none fixed z-50 w-fit min-w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-white/12 bg-bg-subtle/98 p-3 shadow-2xl shadow-black/35 backdrop-blur-md"
      style={props.style}
    >
      <div class="flex items-start gap-3">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/8 ring-1 ring-white/12 overflow-hidden">
          <Show when={props.avatarUrl} fallback={<span class="i-ph:user-bold text-lg text-fg-subtle" />}>
            {avatar => <img src={avatar()} alt="" class="h-full w-full object-cover" draggable={false} />}
          </Show>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-semibold text-fg">{props.name}</div>
              <Show when={props.role}>
                {role => (
                  <span
                    class="mt-1 text-[11px] leading-none font-semibold px-2 py-1 border rounded-full bg-bg-muted/40 inline-flex whitespace-nowrap items-center justify-center max-w-full"
                    style={role().style}
                  >
                    {role().label}
                  </span>
                )}
              </Show>
            </div>
            <div class="shrink-0 text-right text-[10px] text-fg-subtle font-semibold tracking-wide whitespace-nowrap" title={props.statsLabel}>
              {props.statsLabel}
            </div>
          </div>
        </div>
      </div>

      <div class="mt-3 grid min-w-full grid-cols-[minmax(max-content,1fr)_minmax(max-content,1fr)_minmax(max-content,1fr)] rounded-lg bg-white/5 divide-x divide-white/8">
        <Stat value={ratingValue()} label="Elo" />
        <Stat value={rankValue()} label="Rank" />
        <div class="px-3 py-2 text-center">
          <div class="text-sm font-semibold text-fg whitespace-nowrap">
            {recordValue()}
            <span class="text-fg-subtle font-normal text-xs ml-1">({winRateValue()})</span>
          </div>
          <div class="text-[10px] text-fg-muted uppercase tracking-wider mt-0.5">W-L (WR)</div>
        </div>
      </div>
    </div>
  )
}

function Stat(props: { value: string, label: string }) {
  return (
    <div class="px-3 py-2 text-center">
      <div class="text-sm font-semibold text-fg whitespace-nowrap">{props.value}</div>
      <div class="text-[10px] text-fg-muted uppercase tracking-wider mt-0.5">{props.label}</div>
    </div>
  )
}

export function formatRating(rating: PublicPlayerStats | null | undefined, unranked = false): string {
  if (unranked) return 'Unranked'
  return String(Math.round(rating?.publicRating ?? DISPLAY_RATING_BASE))
}

export function formatRecord(rating: PublicPlayerStats | null | undefined): string {
  const gamesPlayed = Math.max(0, rating?.gamesPlayed ?? 0)
  const wins = Math.max(0, Math.min(gamesPlayed, rating?.wins ?? 0))
  return `${wins}-${gamesPlayed - wins}`
}

export function formatWinRate(rating: PublicPlayerStats | null | undefined): string {
  const gamesPlayed = Math.max(0, rating?.gamesPlayed ?? 0)
  if (gamesPlayed === 0) return '0%'
  return `${Math.round(((rating?.wins ?? 0) / gamesPlayed) * 100)}%`
}
