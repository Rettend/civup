import type { ActivityTargetOption } from '~/client/stores'
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
}

export function LobbyOverviewPage(props: LobbyOverviewPageProps) {
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
          <div class="mx-auto px-6 py-4 max-w-5xl">
            <TargetPickerPanel {...props} />
          </div>
        </main>
      )}
    >
      <TargetPickerPanel {...props} mini />
    </Show>
  )
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
