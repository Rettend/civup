import { Route, Router } from '@solidjs/router'
import { lazy, Suspense } from 'solid-js'
import {
  preloadActivityIndexRoute,
  preloadActivityRedirectRoute,
  preloadActivityShell,
  preloadAutosaveCatalogPage,
  preloadDraftActivityRoute,
  preloadLobbyOverviewRoute,
  preloadLobbyWaitingRoute,
  preloadPracticePage,
  preloadWebSessionRoute,
} from './activity/route-preloads'
import { UiScaleController } from './components/ui/UiScaleController'

const ActivityShell = lazy(preloadActivityShell)
const ActivityIndexRoute = lazy(preloadActivityIndexRoute)
const ActivityRedirectRoute = lazy(preloadActivityRedirectRoute)
const AutosaveCatalogPage = lazy(preloadAutosaveCatalogPage)
const DraftActivityRoute = lazy(preloadDraftActivityRoute)
const LobbyOverviewRoute = lazy(preloadLobbyOverviewRoute)
const LobbyWaitingRoute = lazy(preloadLobbyWaitingRoute)
const PracticePage = lazy(preloadPracticePage)
const WebSessionRoute = lazy(preloadWebSessionRoute)

export default function App() {
  return (
    <>
      <UiScaleController />
      <Suspense fallback={<AppRouteFallback />}>
        <Router>
          <Route path="/practice/:game?" component={PracticePage} />
          <Route path="/" component={ActivityShell}>
            <Route path="/" component={ActivityIndexRoute} />
            <Route path="/overview" component={LobbyOverviewRoute} />
            <Route path="/uploads" component={AutosaveCatalogPage} />
            <Route path="/lobby/:lobbyId" component={LobbyWaitingRoute} />
            <Route path="/draft/:matchId" component={DraftActivityRoute} />
          </Route>
          <Route path="/web" component={ActivityShell}>
            <Route path="/channel/:channelId" component={LobbyOverviewRoute} />
            <Route path="/session/:sessionId" component={WebSessionRoute} />
          </Route>
          <Route path="*all" component={ActivityRedirectRoute} />
        </Router>
      </Suspense>
    </>
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
