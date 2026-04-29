import { Show } from 'solid-js'
import { preloadLobbyOverviewRoute } from '~/client/activity/route-preloads'
import { cn } from '~/client/lib/css'
import { isMobileLayout } from '~/client/stores'

interface ReportedMatchPageProps {
  matchId: string
  mode: string | null
  onSwitchTarget?: () => void
}

export function ReportedMatchPage(props: ReportedMatchPageProps) {
  return (
    <main class="text-fg font-sans bg-bg h-screen relative overflow-y-auto">
      <Show when={props.onSwitchTarget}>
        <button
          type="button"
          class={cn(
            'text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center z-20 absolute hover:text-fg hover:bg-bg-muted',
            isMobileLayout() ? 'top-12 right-4' : 'top-4 right-6',
          )}
          title="Lobby Overview"
          aria-label="Lobby Overview"
          onPointerEnter={() => { void preloadLobbyOverviewRoute() }}
          onFocus={() => { void preloadLobbyOverviewRoute() }}
          onClick={() => props.onSwitchTarget?.()}
        >
          <span class="i-ph-squares-four-bold text-base" />
        </button>
      </Show>

      <div class="mx-auto px-4 py-10 flex flex-col gap-4 max-w-3xl md:px-8">
        <section class="p-7 text-center border border-border rounded-lg bg-bg-subtle/70">
          <div class="text-[11px] text-fg-subtle tracking-[0.14em] font-semibold mb-2 uppercase">Session Closed</div>
          <h1 class="text-3xl text-fg font-semibold mb-3">Result Already Reported</h1>
          <p class="text-sm text-fg-muted leading-relaxed">
            This match has already been reported. The Discord result message is being refreshed if the button you clicked was stale.
          </p>
          <div class="mt-5 flex flex-wrap gap-2 justify-center text-[11px] text-fg-subtle tracking-widest uppercase">
            <span class="px-2.5 py-1 border border-border-subtle rounded-full bg-bg-muted/60">{props.mode ?? 'Match'}</span>
            <span class="px-2.5 py-1 border border-border-subtle rounded-full bg-bg-muted/60">{props.matchId}</span>
          </div>
        </section>
      </div>
    </main>
  )
}
