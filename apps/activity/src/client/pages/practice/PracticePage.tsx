import { A } from '@solidjs/router'
import { preloadActivityOverviewEntry } from '~/client/activity/route-preloads'

export default function PracticePage() {
  return (
    <main class="text-fg font-sans bg-bg min-h-screen overflow-y-auto">
      <div class="mx-auto px-4 py-10 flex max-w-3xl flex-col items-start gap-4 md:px-8">
        <h1 class="text-3xl text-fg font-semibold">Practice</h1>
        <A
          href="/overview"
          class="inline-flex items-center justify-center rounded-md border border-border bg-transparent px-4 py-2 text-sm text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg"
          onPointerEnter={preloadActivityOverviewEntry}
          onPointerDown={preloadActivityOverviewEntry}
          onFocus={preloadActivityOverviewEntry}
        >
          Back
        </A>
      </div>
    </main>
  )
}
