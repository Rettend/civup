import type { JSX } from 'solid-js'
import { Route, Router, useLocation } from '@solidjs/router'
import { lazy, Suspense } from 'solid-js'
import {
  preloadActivityIndexRoute,
  preloadActivityShell,
  preloadAutosaveCatalogPage,
  preloadDraftActivityRoute,
  preloadLobbyOverviewRoute,
  preloadLobbyWaitingRoute,
  preloadPracticePage,
  preloadWebSessionRoute,
} from './activity/route-preloads'
import CreatorsPage from './public/CreatorsPage'
import LandingPage from './public/LandingPage'
import LeaderboardsPage from './public/LeaderboardsPage'
import NotFoundPage from './public/NotFoundPage'
import PublicShell from './public/PublicShell'
import RulesPage from './public/RulesPage'
import { resolveRouteSurface } from './route-surface'

const ActivitySurface = lazy(() => import('./activity/ActivitySurface'))
const ActivityShell = lazy(preloadActivityShell)
const ActivityIndexRoute = lazy(preloadActivityIndexRoute)
const AutosaveCatalogPage = lazy(preloadAutosaveCatalogPage)
const DraftActivityRoute = lazy(preloadDraftActivityRoute)
const LobbyOverviewRoute = lazy(preloadLobbyOverviewRoute)
const LobbyWaitingRoute = lazy(preloadLobbyWaitingRoute)
const PracticePage = lazy(preloadPracticePage)
const WebSessionRoute = lazy(preloadWebSessionRoute)

export default function App() {
  return (
    <Suspense fallback={<AppRouteFallback />}>
      <Router>
        <Route path="/" component={RootRoute} />
        <Route path="/leaderboards" component={PublicLeaderboardsRoute} />
        <Route path="/rules" component={PublicRulesRoute} />
        <Route path="/creators" component={PublicCreatorsRoute} />

        <Route path="/overview" component={OverviewActivityRoute} />
        <Route path="/uploads" component={UploadsActivityRoute} />
        <Route path="/lobby/:lobbyId" component={LobbyActivityRoute} />
        <Route path="/draft/:matchId" component={DraftActivityRouteSurface} />
        <Route path="/web/channel/:channelId" component={WebChannelActivityRoute} />
        <Route path="/web/session/:sessionId" component={WebSessionActivityRoute} />
        <Route path="/practice/:game?" component={PracticeActivityRoute} />

        <Route path="*all" component={PublicNotFoundRoute} />
      </Router>
    </Suspense>
  )
}

function RootRoute() {
  const location = useLocation()
  const surface = () => resolveRouteSurface({
    pathname: location.pathname,
    search: location.search,
    framed: isWindowFramed(),
    development: import.meta.env.DEV,
  })
  return surface() === 'activity'
    ? <ActivityFrame><ActivityIndexRoute /></ActivityFrame>
    : <PublicFrame><LandingPage /></PublicFrame>
}

function OverviewActivityRoute() {
  return <ActivityFrame><LobbyOverviewRoute /></ActivityFrame>
}

function UploadsActivityRoute() {
  return <ActivityFrame><AutosaveCatalogPage /></ActivityFrame>
}

function LobbyActivityRoute() {
  return <ActivityFrame><LobbyWaitingRoute /></ActivityFrame>
}

function DraftActivityRouteSurface() {
  return <ActivityFrame><DraftActivityRoute /></ActivityFrame>
}

function WebChannelActivityRoute() {
  return <ActivityFrame><LobbyOverviewRoute /></ActivityFrame>
}

function WebSessionActivityRoute() {
  return <ActivityFrame><WebSessionRoute /></ActivityFrame>
}

function PracticeActivityRoute() {
  return <ActivitySurface><PracticePage /></ActivitySurface>
}

function PublicLeaderboardsRoute() {
  return <PublicFrame><LeaderboardsPage /></PublicFrame>
}

function PublicRulesRoute() {
  return <PublicFrame><RulesPage /></PublicFrame>
}

function PublicCreatorsRoute() {
  return <PublicFrame><CreatorsPage /></PublicFrame>
}

function PublicNotFoundRoute() {
  return <PublicFrame><NotFoundPage /></PublicFrame>
}

function ActivityFrame(props: { children: JSX.Element }) {
  return (
    <ActivitySurface>
      <ActivityShell>{props.children}</ActivityShell>
    </ActivitySurface>
  )
}

function PublicFrame(props: { children: JSX.Element }) {
  return <PublicShell>{props.children}</PublicShell>
}

function AppRouteFallback() {
  const surface = resolveRouteSurface({
    pathname: window.location.pathname,
    search: window.location.search,
    framed: isWindowFramed(),
    development: import.meta.env.DEV,
  })
  return (
    <main class="text-fg font-sans bg-bg flex min-h-screen items-center justify-center">
      <div class="text-center">
        <div class="text-accent mb-2 text-2xl font-bold">{surface === 'activity' ? 'Draft' : 'PPL'}</div>
        <div class="text-fg-muted text-sm">Loading...</div>
      </div>
    </main>
  )
}

function isWindowFramed(): boolean {
  try {
    return window.self !== window.top
  }
  catch {
    return true
  }
}
