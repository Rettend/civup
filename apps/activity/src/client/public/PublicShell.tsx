import type { JSX } from 'solid-js'
import { A } from '@solidjs/router'
import { onCleanup, onMount } from 'solid-js'

const NAV_ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/leaderboards', label: 'Leaderboards' },
  { href: '/rules', label: 'Rules' },
  { href: '/creators', label: 'Creators' },
] as const

export default function PublicShell(props: { children?: JSX.Element }) {
  onMount(() => {
    document.title = 'PPL Community'
    setDescription('Competitive Civilization VI multiplayer leaderboards, rules, and community resources.')
    document.body.classList.add('public-surface')
    document.body.classList.remove('activity-surface', 'civup-ui-scaled')
    document.body.style.removeProperty('zoom')
  })

  onCleanup(() => {
    document.body.classList.remove('public-surface')
  })

  return (
    <div class="bg-bg text-fg font-sans min-h-screen">
      <a class="focus-ring bg-accent text-bg fixed left-3 top-3 z-50 -translate-y-20 rounded-md px-4 py-2 font-bold focus:translate-y-0" href="#main-content">
        Skip to content
      </a>
      <header class="border-border-subtle bg-bg/95 sticky top-0 z-40 border-b backdrop-blur">
        <div class="mx-auto max-w-6xl flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <A class="focus-ring text-accent rounded-sm text-xl font-black tracking-[0.18em]" href="/" end>PPL</A>
          <nav aria-label="Primary navigation">
            <ul class="flex flex-wrap items-center gap-1 sm:gap-2">
              {NAV_ITEMS.map(item => (
                <li>
                  <A
                    class="focus-ring text-fg-muted hover:text-fg rounded-md px-2.5 py-2 text-sm font-semibold transition-colors sm:px-3"
                    activeClass="!text-accent bg-accent-subtle"
                    href={item.href}
                    end={item.href === '/'}
                  >
                    {item.label}
                  </A>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main id="main-content" class="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        {props.children}
      </main>
      <footer class="border-border-subtle text-fg-subtle border-t">
        <div class="mx-auto max-w-6xl px-4 py-8 text-sm sm:px-6">PPL Community</div>
      </footer>
    </div>
  )
}

function setDescription(content: string): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'description'
    document.head.appendChild(meta)
  }
  meta.content = content
}
