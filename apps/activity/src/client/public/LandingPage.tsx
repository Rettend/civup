import { A } from '@solidjs/router'

const HUB_CARDS = [
  { href: '/leaderboards', eyebrow: 'Competition', title: 'Leaderboards', body: 'Player ratings and Civilization VI leader statistics for each supported server.' },
  { href: '/rules', eyebrow: 'Play', title: 'Rules', body: 'The shared reference for competitive play and server expectations.' },
  { href: '/creators', eyebrow: 'Community', title: 'Creators', body: 'A home for verified community creators and their work.' },
] as const

export default function LandingPage() {
  return (
    <>
      <section class="relative overflow-hidden rounded-2xl border border-border bg-bg-subtle px-6 py-14 sm:px-10 sm:py-20">
        <div class="bg-accent-subtle pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl" aria-hidden="true" />
        <div class="relative max-w-3xl">
          <p class="text-accent text-sm font-bold uppercase tracking-[0.22em]">Competitive multiplayer</p>
          <h1 class="mt-4 text-4xl font-black tracking-tight sm:text-6xl">Civilization VI, played together.</h1>
          <p class="text-fg-muted mt-6 max-w-2xl text-lg leading-8">
            PPL is a competitive Civilization VI multiplayer community and a hub for supported servers, standings, rules, and community resources.
          </p>
          <div class="mt-8 flex flex-wrap gap-3">
            <A class="focus-ring bg-accent text-bg hover:bg-[#d8bd83] rounded-md px-5 py-3 font-bold transition-colors" href="/leaderboards">View leaderboards</A>
            <A class="focus-ring border-border hover:border-accent text-fg rounded-md border px-5 py-3 font-bold transition-colors" href="/rules">Read the rules</A>
          </div>
        </div>
      </section>

      <section class="mt-14" aria-labelledby="hub-heading">
        <div class="max-w-2xl">
          <p class="text-accent text-sm font-bold uppercase tracking-[0.2em]">Supported-server hub</p>
          <h2 id="hub-heading" class="mt-3 text-3xl font-black">Everything in one place</h2>
        </div>
        <div class="mt-7 grid gap-4 md:grid-cols-3">
          {HUB_CARDS.map(card => (
            <A class="focus-ring group border-border bg-bg-subtle hover:border-accent rounded-xl border p-6 transition-colors" href={card.href}>
              <span class="text-fg-subtle text-xs font-bold uppercase tracking-[0.18em]">{card.eyebrow}</span>
              <h3 class="group-hover:text-accent mt-3 text-xl font-black transition-colors">{card.title}</h3>
              <p class="text-fg-muted mt-3 leading-7">{card.body}</p>
            </A>
          ))}
        </div>
      </section>
    </>
  )
}
