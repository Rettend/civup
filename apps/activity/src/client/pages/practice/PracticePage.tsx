import { A, useLocation } from '@solidjs/router'
import { parseBrowserReturnPath } from '~/client/activity/route-policy'

export default function PracticePage() {
  const location = useLocation()
  const returnPath = () => parseBrowserReturnPath(location.search, 'channel') ?? '/overview'

  return (
    <main class="text-fg font-sans bg-bg min-h-screen overflow-y-auto">
      <div class="mx-auto px-4 py-10 flex flex-col gap-4 max-w-3xl items-start md:px-8">
        <h1 class="text-3xl text-fg font-semibold">Practice</h1>
        <A
          href={returnPath()}
          class="text-sm text-fg-muted px-4 py-2 border border-border rounded-md bg-transparent inline-flex transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted"
        >
          Back
        </A>
      </div>
    </main>
  )
}
