import type { ActivityTargetOption } from '../stores'

export const preloadActivityShell = () => import('./ActivityShell')
export const preloadActivityIndexRoute = () => import('./routes/ActivityIndexRoute')
export const preloadActivityRedirectRoute = () => import('./routes/ActivityRedirectRoute')
export const preloadDraftActivityRoute = () => import('./routes/DraftActivityRoute')
export const preloadLobbyOverviewRoute = () => import('./routes/LobbyOverviewRoute')
export const preloadLobbyWaitingRoute = () => import('./routes/LobbyWaitingRoute')
export const preloadPracticePage = () => import('../pages/practice/PracticePage')

export function preloadActivityOverviewEntry() {
  void preloadActivityShell()
  void preloadLobbyOverviewRoute()
}

export function preloadActivityTargetRoute(option: ActivityTargetOption) {
  if (option.kind === 'lobby') {
    void preloadLobbyWaitingRoute()
    return
  }

  void preloadDraftActivityRoute()
}
