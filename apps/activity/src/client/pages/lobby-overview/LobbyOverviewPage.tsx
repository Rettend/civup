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
  onPractice?: () => void
  onUpload?: () => void
  onFolderUpload?: () => void
  onCatalog?: () => void
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
          <div class="mx-auto px-4 py-4 pb-24 w-full max-w-[1600px] sm:px-6">
            <TargetPickerPanel {...props} />
          </div>
          <Show when={props.onPractice || props.onCatalog}>
            <div class="flex gap-3 bottom-6 left-1/2 absolute z-20 -translate-x-1/2">
              <Show when={props.onCatalog}>
                <button
                  type="button"
                  class="text-sm text-sky-200 font-bold px-4 py-2 border border-sky-400/35 rounded-full bg-sky-500/14 inline-flex gap-2 whitespace-nowrap shadow-[0_0_28px_rgba(56,189,248,0.16)] transition items-center hover:text-white hover:border-sky-300/70 hover:bg-sky-500/22"
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
            </div>
          </Show>
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
