import type { ActivityTargetOption } from '~/client/stores'
import type { PlayerDataExportState } from '~/client/lib/player-data-export'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { isMiniView, isMobileLayout } from '~/client/stores'
import { LobbyOverviewTargetPicker } from './LobbyOverviewTargetPicker'

export interface LobbyOverviewPageProps {
  options: ActivityTargetOption[]
  busy?: boolean
  selectedKey?: string | null
  error?: string | null
  onSelect: (option: ActivityTargetOption) => void
  onResume?: () => void
  onPractice?: () => void
  onUpload?: () => void
  onFolderUpload?: () => void
  onCatalog?: () => void
  onExportData?: () => void
  playerDataExportState?: PlayerDataExportState
}

export function LobbyOverviewPage(props: LobbyOverviewPageProps) {
  const exportButtonLabel = () => {
    const state = props.playerDataExportState
    if (state?.status === 'ready') return 'Download Again'
    if (state?.status === 'estimating') return 'Estimating...'
    if (state?.status === 'estimate') return 'Confirm Export'
    if (state?.status === 'loading') return 'Exporting Data'
    if (state?.status === 'error') return state.retry === 'estimate' ? 'Retry Estimate' : 'Retry Export'
    return 'Export Data'
  }

  const exportButtonAriaLabel = () => {
    const state = props.playerDataExportState
    if (state?.status === 'ready') return 'Download data again'
    if (state?.status === 'estimate') return 'Confirm data export'
    if (state?.status === 'error') return state.retry === 'estimate' ? 'Retry data export estimate' : 'Retry data export'
    return 'Export data'
  }

  return (
    <Show
      when={isMiniView()}
      fallback={(
        <main class="text-text-primary bg-bg-primary font-sans min-h-screen relative overflow-y-auto">
          <Show when={props.onResume}>
            <button
              type="button"
              class={cn(
                'text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center z-20 absolute hover:text-fg hover:bg-bg-muted',
                isMobileLayout() ? 'top-12 right-4' : 'top-4 right-6',
              )}
              title="Return"
              aria-label="Return"
              onClick={() => props.onResume?.()}
            >
              <span class="i-ph-arrow-right-bold text-base" />
            </button>
          </Show>
          <div class="mx-auto px-4 py-4 pb-44 w-full max-w-[1600px] sm:px-6 sm:pb-32">
            <TargetPickerPanel {...props} />
          </div>
          <Show when={props.onPractice || props.onCatalog || props.onExportData}>
            <div class="px-4 flex flex-wrap justify-center gap-3 bottom-4 left-0 right-0 absolute z-20" data-overview-actions>
              <Show when={props.onCatalog}>
                <button
                  type="button"
                  class="text-sm text-sky-200 font-bold px-4 py-2 border border-sky-400/35 rounded-full bg-sky-500/14 inline-flex gap-2 whitespace-nowrap shadow-[0_0_28px_rgba(56,189,248,0.16)] transition items-center hover:text-sky-200 hover:border-sky-400/60 hover:bg-sky-500/20"
                  onClick={() => props.onCatalog?.()}
                >
                  <span class="i-ph-folder-open-bold text-lg" />
                  Saved Games
                </button>
              </Show>
              <Show when={props.onPractice}>
                <button
                  type="button"
                  class="text-sm text-accent font-bold px-4 py-2 border border-accent/30 rounded-full bg-accent/12 inline-flex gap-2 whitespace-nowrap shadow-[0_0_28px_rgba(250,204,21,0.16)] transition items-center hover:text-accent hover:border-accent/60 hover:bg-accent/18"
                  onClick={() => props.onPractice?.()}
                >
                  <span class="i-ph-game-controller-bold text-lg" />
                  Practice
                </button>
              </Show>
              <Show when={props.onExportData}>
                <button
                  type="button"
                  class="text-sm text-emerald-200 font-bold px-4 py-2 border border-emerald-400/35 rounded-full bg-emerald-500/14 inline-flex gap-2 whitespace-nowrap shadow-[0_0_28px_rgba(52,211,153,0.16)] transition items-center hover:text-emerald-100 hover:border-emerald-400/60 hover:bg-emerald-500/20 disabled:cursor-wait disabled:opacity-70"
                  disabled={props.playerDataExportState?.status === 'loading' || props.playerDataExportState?.status === 'estimating'}
                  aria-label={exportButtonAriaLabel()}
                  onClick={() => props.onExportData?.()}
                >
                  <span class={props.playerDataExportState?.status === 'loading' || props.playerDataExportState?.status === 'estimating' ? 'i-gg:spinner text-lg' : 'i-ph-file-xls-bold text-lg'} />
                  {exportButtonLabel()}
                </button>
              </Show>
              <PlayerDataExportStatus state={props.playerDataExportState} />
            </div>
          </Show>
        </main>
      )}
    >
      <TargetPickerPanel {...props} mini />
    </Show>
  )
}

function PlayerDataExportStatus(props: { state?: PlayerDataExportState }) {
  const message = () => {
    const state = props.state
    if (!state || state.status === 'idle' || state.status === 'ready') return null
    if (state.status === 'error') return state.message
    if (state.status === 'estimating') return 'Estimating export size and capacity...'
    if (state.status === 'estimate') return exportEstimateMessage(state.estimate)
    if (state.phase === 'players') return `Loading players: ${state.players.toLocaleString()}`
    if (state.phase === 'matches') return `Loading matches: ${state.matches.toLocaleString()}`
    return `Building workbook from ${state.players.toLocaleString()} players and ${state.matches.toLocaleString()} matches...`
  }

  return (
    <Show when={props.state?.status === 'ready' || message()}>
      <div class="text-xs text-fg-muted basis-full text-center break-words" role="status">
        <Show when={props.state?.status === 'ready'} fallback={message()}>
          <span>{props.state?.status === 'ready' ? `${props.state.filename} is ready.` : ''}</span>
        </Show>
      </div>
    </Show>
  )
}

function exportEstimateMessage(estimate: Extract<PlayerDataExportState, { status: 'estimate' }>['estimate']): string {
  const d1Share = formatAllowanceRange(
    estimate.d1RowsRead.lowEstimate,
    estimate.d1RowsRead.highEstimate,
    estimate.dailyFreeAllowance.d1RowsRead,
  )
  return `Estimate: ${estimate.rows.players.toLocaleString()} players, ${estimate.rows.matches.toLocaleString()} matches, ${estimate.rows.participants.toLocaleString()} participants; ${estimate.d1RowsRead.lowEstimate.toLocaleString()}-${estimate.d1RowsRead.highEstimate.toLocaleString()} database reads (${d1Share} of the daily allowance).`
}

function formatAllowanceRange(low: number, high: number, allowance: number): string {
  const lowPercentage = low / allowance * 100
  const highPercentage = high / allowance * 100
  if (highPercentage > 0 && highPercentage < 0.1) return 'under 0.1%'
  const roundedLow = Math.round(lowPercentage * 10) / 10
  const roundedHigh = Math.round(highPercentage * 10) / 10
  return roundedLow === roundedHigh ? `${roundedHigh}%` : `${roundedLow}-${roundedHigh}%`
}

function TargetPickerPanel(props: LobbyOverviewPageProps & { mini?: boolean }) {
  return (
    <div class="flex flex-col gap-4">
      <LobbyOverviewTargetPicker
        mini={props.mini}
        error={props.error}
        options={props.options}
        busy={props.busy}
        selectedKey={props.selectedKey ?? null}
        onSelect={props.onSelect}
      />

      <Show when={!props.mini && props.error}>
        <div class="text-sm text-danger px-4 py-3 border border-danger/25 rounded-xl bg-danger/10">
          {props.error}
        </div>
      </Show>
    </div>
  )
}
