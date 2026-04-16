import type { ActivityTargetOption } from '~/client/stores'
import { Show } from 'solid-js'
import { activityTargetOptionKey, ActivityTargetPicker } from '~/client/components/draft'
import { cn } from '~/client/lib/css'
import { isMiniView, isMobileLayout } from '~/client/stores'

export interface LobbyOverviewPageProps {
  options: ActivityTargetOption[]
  busy?: boolean
  selectedKey?: string | null
  error?: string | null
  onSelect: (option: ActivityTargetOption) => void
  onResume?: () => void
}

/** Lobby overview page wrapper used while ActivityTargetPicker remains the implementation. */
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
  if (props.mini) {
    return (
      <ActivityTargetPicker
        mini
        error={props.error}
        options={props.options}
        busy={props.busy}
        selectedKey={props.selectedKey}
        onSelect={props.onSelect}
        onClose={props.onResume}
      />
    )
  }

  return (
    <div class="flex flex-col gap-4">
      <ActivityTargetPicker
        options={props.options}
        busy={props.busy}
        selectedKey={props.selectedKey ?? null}
        onSelect={props.onSelect}
        onClose={props.onResume}
      />

      <Show when={props.error}>
        <div class="text-sm text-danger px-4 py-3 border border-danger/25 rounded-xl bg-danger/10">
          {props.error}
        </div>
      </Show>
    </div>
  )
}

export { activityTargetOptionKey }
