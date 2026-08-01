import { A } from '@solidjs/router'

export default function NotFoundPage() {
  return (
    <section class="py-16 text-center" aria-labelledby="not-found-heading">
      <p class="text-accent text-sm font-bold uppercase tracking-[0.2em]">404</p>
      <h1 id="not-found-heading" class="mt-3 text-4xl font-black">Page not found</h1>
      <p class="text-fg-muted mt-4">That page is not part of the public site.</p>
      <A class="focus-ring text-accent mt-7 inline-block rounded-sm font-bold underline-offset-4 hover:underline" href="/">Return home</A>
    </section>
  )
}
