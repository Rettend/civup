import { useParams } from '@solidjs/router'
import { onMount } from 'solid-js'
import { DraftSetupPage } from '../../pages/draft-setup'
import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'
import { preloadLobbyOverviewRoute } from '../route-preloads'

export default function LobbyWaitingRoute() {
  const activity = useActivityController()
  const params = useParams<{ lobbyId: string }>()

  onMount(() => { void preloadLobbyOverviewRoute() })

  const renderRoute = () => {
    const state = activity.state()
    if (state.status === 'loading') return <ActivityLoadingPage />
    if (state.status === 'error') return <ActivityErrorPage message={state.message} />
    if (state.status !== 'lobby-waiting' || state.lobby.id !== params.lobbyId) return <ActivityRedirectingPage />
    return (
      <DraftSetupPage
        lobby={state.lobby}
        showJoinPending={state.joinPending}
        joinEligibility={state.joinEligibility}
        onSwitchTarget={activity.openOverview}
        onLobbyStarted={(matchId, steamLobbyLink, sessionAccessToken) => {
          activity.transitionToDraft(matchId, true, steamLobbyLink, sessionAccessToken)
        }}
      />
    )
  }

  return <>{renderRoute()}</>
}
