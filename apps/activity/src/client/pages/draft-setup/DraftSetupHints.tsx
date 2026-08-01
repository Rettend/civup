import type { GameMode } from '@civup/game'
import { createEffect, createMemo, Show } from 'solid-js'
import {
  draftSetupHintId,
  draftSetupHintsCollapsed,
  setDraftSetupHintId,
  setDraftSetupHintsCollapsed,
} from '~/client/stores'
import {
  getApplicableDraftSetupHints,
  getNextDraftSetupHint,
  resolveDraftSetupHint,
} from './draftSetupHintCatalog'

export function DraftSetupHints(props: { mode: () => GameMode }) {
  let hideButton: HTMLButtonElement | undefined
  let showButton: HTMLButtonElement | undefined
  const initialContext = { mode: props.mode() }
  const initialHint = resolveDraftSetupHint(draftSetupHintId(), initialContext)
  if (initialHint && initialHint.id !== draftSetupHintId()) setDraftSetupHintId(initialHint.id)

  const context = createMemo(() => ({ mode: props.mode() }))
  const applicableHints = createMemo(() => getApplicableDraftSetupHints(context()))
  const currentHint = createMemo(() => resolveDraftSetupHint(draftSetupHintId(), context()))
  const position = () => Math.max(0, applicableHints().findIndex(hint => hint.id === currentHint()?.id)) + 1

  createEffect(() => {
    const hint = currentHint()
    if (hint && hint.id !== draftSetupHintId()) setDraftSetupHintId(hint.id)
  })

  const showNextHint = () => {
    const next = getNextDraftSetupHint(currentHint()?.id ?? null, context())
    if (next) setDraftSetupHintId(next.id)
  }
  const hideHints = () => {
    setDraftSetupHintsCollapsed(true)
    queueMicrotask(() => showButton?.focus())
  }
  const showHints = () => {
    setDraftSetupHintsCollapsed(false)
    queueMicrotask(() => hideButton?.focus())
  }

  return (
    <Show
      when={!draftSetupHintsCollapsed()}
      fallback={(
        <button
          ref={showButton}
          type="button"
          class="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-fg-subtle transition-colors hover:bg-white/5 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-controls="draft-setup-hint-card"
          aria-expanded="false"
          onClick={showHints}
        >
          <span class="i-ph:lightbulb-filament-bold text-xs text-accent/80" aria-hidden />
          Show hint
        </button>
      )}
    >
      <Show when={currentHint()}>
        {hint => (
          <aside
            id="draft-setup-hint-card"
            aria-label="Draft setup hint"
            class="mt-2 rounded-lg border border-border-subtle bg-white/3 px-3 py-2.5"
          >
            <div class="flex items-center gap-2">
              <span class="i-ph:lightbulb-filament-bold text-sm text-accent/80" aria-hidden />
              <span class="text-[10px] font-bold uppercase tracking-widest text-fg-subtle">Hint</span>
              <span class="ml-auto text-[10px] tabular-nums text-fg-subtle" aria-label={`Hint ${position()} of ${applicableHints().length}`}>
                {position()} / {applicableHints().length}
              </span>
              <button
                ref={hideButton}
                type="button"
                class="rounded px-1.5 py-0.5 text-[10px] text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                aria-controls="draft-setup-hint-card"
                aria-expanded="true"
                onClick={hideHints}
              >
                Hide
              </button>
            </div>
            <p class="mt-1.5 text-[11px] leading-relaxed text-fg-muted" aria-live="polite">{hint().copy}</p>
            <div class="mt-1.5 flex justify-end">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={showNextHint}
              >
                Next
                <span class="i-ph:arrow-right-bold text-xs" aria-hidden />
              </button>
            </div>
          </aside>
        )}
      </Show>
    </Show>
  )
}
