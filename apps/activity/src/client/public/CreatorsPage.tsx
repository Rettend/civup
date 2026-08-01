import { For, Show } from 'solid-js'
import { PUBLIC_CREATORS, PUBLIC_CREATORS_EMPTY_MESSAGE } from './content'

export default function CreatorsPage() {
  return (
    <section aria-labelledby="creators-heading">
      <p class="text-accent text-sm font-bold uppercase tracking-[0.2em]">Community</p>
      <h1 id="creators-heading" class="mt-3 text-4xl font-black">Creators</h1>
      <p class="text-fg-muted mt-4 max-w-2xl text-lg leading-8">Verified creators from across the community.</p>
      <div class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Show
          when={PUBLIC_CREATORS.length > 0}
          fallback={<p class="border-border bg-bg-subtle text-fg-muted rounded-xl border p-6 leading-7 sm:col-span-2 lg:col-span-3">{PUBLIC_CREATORS_EMPTY_MESSAGE}</p>}
        >
          <For each={PUBLIC_CREATORS}>
            {creator => (
              <article class="border-border bg-bg-subtle rounded-xl border p-6">
                <h2 class="text-xl font-black">{creator.name}</h2>
                <p class="text-fg-muted mt-3 leading-7">{creator.description}</p>
                <Show when={creator.url}>
                  {url => <a class="focus-ring text-accent mt-5 inline-block rounded-sm font-bold underline-offset-4 hover:underline" href={url()} rel="noreferrer">Visit profile</a>}
                </Show>
              </article>
            )}
          </For>
        </Show>
      </div>
    </section>
  )
}
