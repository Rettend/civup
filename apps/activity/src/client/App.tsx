import type { ParentProps } from 'solid-js'
import { createRouter } from '@solidjs/router'
import { lazy, Loading } from 'solid-js'
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

function EmbeddedActivityShell(props: ParentProps) {
  return <ActivityShell surface="discord-embedded">{props.children}</ActivityShell>
}

function BrowserActivityShell(props: ParentProps) {
  return <ActivityShell surface="web">{props.children}</ActivityShell>
}

export const ActivityRouter = createRouter({
  routes: [
    { path: '/practice/:game?', component: PracticePage },
    {
      path: '/',
      component: EmbeddedActivityShell,
      children: [
        { path: '/', component: ActivityIndexRoute },
        { path: '/overview', component: LobbyOverviewRoute },
        { path: '/uploads', component: AutosaveCatalogPage },
        { path: '/lobby/:lobbyId', component: LobbyWaitingRoute },
        { path: '/draft/:matchId', component: DraftActivityRoute },
      ],
    },
    {
      path: '/web',
      component: BrowserActivityShell,
      children: [
        { path: '/channel/:channelId', component: LobbyOverviewRoute },
        { path: '/session/:sessionId', component: WebSessionRoute },
      ],
    },
    { path: '*all', component: ActivityRedirectRoute },
  ],
})

export default function App() {
  return (
    <>
      <UiScaleController />
      <Loading fallback={<AppRouteFallback />}>
        <ActivityRouter />
      </Loading>
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
