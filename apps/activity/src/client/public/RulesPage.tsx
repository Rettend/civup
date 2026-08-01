import { For, Show } from 'solid-js'
import { PUBLIC_RULE_SECTIONS, PUBLIC_RULES_EMPTY_MESSAGE } from './content'

export default function RulesPage() {
  return (
    <section class="max-w-3xl" aria-labelledby="rules-heading">
      <p class="text-accent text-sm font-bold uppercase tracking-[0.2em]">Reference</p>
      <h1 id="rules-heading" class="mt-3 text-4xl font-black">Rules</h1>
      <p class="text-fg-muted mt-4 text-lg leading-8">Competitive play guidance for supported servers.</p>
      <div class="mt-8 space-y-4">
        <Show when={PUBLIC_RULE_SECTIONS.length > 0} fallback={<EmptyPanel message={PUBLIC_RULES_EMPTY_MESSAGE} />}>
          <For each={PUBLIC_RULE_SECTIONS}>
            {section => (
              <section class="border-border bg-bg-subtle rounded-xl border p-6">
                <h2 class="text-xl font-black">{section.heading}</h2>
                <p class="text-fg-muted mt-3 leading-7">{section.body}</p>
              </section>
            )}
          </For>
        </Show>
      </div>
    </section>
  )
}

function EmptyPanel(props: { message: string }) {
  return <p class="border-border bg-bg-subtle text-fg-muted rounded-xl border p-6 leading-7">{props.message}</p>
}
