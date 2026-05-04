import { Route, Router } from '@solidjs/router'
import { lazy, Suspense } from 'solid-js'
import {
  preloadActivityIndexRoute,
  preloadActivityRedirectRoute,
  preloadActivityShell,
  preloadDraftActivityRoute,
  preloadLobbyOverviewRoute,
  preloadLobbyWaitingRoute,
  preloadPracticePage,
} from './activity/route-preloads'

const ActivityShell = lazy(preloadActivityShell)
const ActivityIndexRoute = lazy(preloadActivityIndexRoute)
const ActivityRedirectRoute = lazy(preloadActivityRedirectRoute)
const DraftActivityRoute = lazy(preloadDraftActivityRoute)
const LobbyOverviewRoute = lazy(preloadLobbyOverviewRoute)
const LobbyWaitingRoute = lazy(preloadLobbyWaitingRoute)
const PracticePage = lazy(preloadPracticePage)

export default function App() {
  return (
    <Suspense fallback={<AppRouteFallback />}>
      <Router>
        <Route path="/practice/:game?" component={PracticePage} />
        <Route path="/" component={ActivityShell}>
          <Route path="/" component={ActivityIndexRoute} />
          <Route path="/overview" component={LobbyOverviewRoute} />
          <Route path="/lobby/:lobbyId" component={LobbyWaitingRoute} />
          <Route path="/draft/:matchId" component={DraftActivityRoute} />
        </Route>
        <Route path="*all" component={ActivityRedirectRoute} />
      </Router>
    </Suspense>
  )
}

function AppRouteFallback() {
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="text-center">
        <div class="text-2xl text-accent font-bold mb-2">CivUp</div>
        <div class="text-sm text-fg-muted">Loading...</div>
      </div>
    </main>
  )
}
