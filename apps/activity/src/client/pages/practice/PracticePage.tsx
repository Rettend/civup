import { A, useParams } from '@solidjs/router'
import { preloadActivityOverviewEntry } from '~/client/activity/route-preloads'

const GAME_LABELS: Record<string, string> = {
  'era-score': 'Era Score',
  'great-people': 'Great People',
}

export default function PracticePage() {
  const params = useParams<{ game?: string }>()
  const gameLabel = () => GAME_LABELS[params.game ?? 'great-people'] ?? 'Practice'

  return (
    <main class="text-text-primary bg-bg-primary font-sans min-h-screen overflow-y-auto px-6 py-8">
      <div class="mx-auto flex min-h-[calc(100vh-4rem)] max-w-4xl flex-col items-center justify-center text-center">
        <div class="mb-5 grid size-18 place-items-center rounded-3xl border border-accent/30 bg-accent/10 text-accent shadow-[0_0_40px_rgba(250,204,21,0.15)]">
          <div class="i-ph-game-controller-bold text-4xl" />
        </div>
        <p class="mb-2 text-xs font-bold uppercase tracking-[0.35em] text-accent/80">Practice</p>
        <h1 class="mb-3 text-4xl font-black tracking-tight sm:text-5xl">{gameLabel()}</h1>
        <p class="max-w-xl text-sm leading-6 text-text-secondary">
          Flashcards will live here. This route is outside the live activity shell, so opening it does not keep lobby or draft websockets alive.
        </p>
        <A
          href="/overview"
          class="mt-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-4 py-2 text-sm font-bold text-text-primary transition hover:border-accent/40 hover:bg-accent/10 hover:text-accent"
          onPointerEnter={preloadActivityOverviewEntry}
          onPointerDown={preloadActivityOverviewEntry}
          onFocus={preloadActivityOverviewEntry}
        >
          <span class="i-ph-arrow-left-bold text-base" />
          Back to activity
        </A>
      </div>
    </main>
  )
}
