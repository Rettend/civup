import { useParams } from '@solidjs/router'
import type { Accessor } from 'solid-js'
import type { ActivityState } from '../activity-context'
import { Match, Show, Switch, onMount } from 'solid-js'
import { DraftSetupPage } from '../../pages/draft-setup'
import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'
import { preloadLobbyOverviewRoute } from '../route-preloads'

export default function LobbyWaitingRoute() {
  const activity = useActivityController()
  const params = useParams<{ lobbyId: string }>()

  onMount(() => { void preloadLobbyOverviewRoute() })

  const waitingState = () => {
    const state = activity.state()
    return state.status === 'lobby-waiting' && state.lobby.id === params.lobbyId ? state : null
  }

  return (
    <Show when={waitingState()} fallback={<LobbyWaitingFallback state={activity.state} />}>
      {state => (
        <DraftSetupPage
          lobby={state().lobby}
          showJoinPending={state().joinPending}
          joinEligibility={state().joinEligibility}
          onSwitchTarget={activity.openOverview}
          onLobbyStarted={(matchId, steamLobbyLink, sessionAccessToken) => {
            activity.transitionToDraft(matchId, true, steamLobbyLink, sessionAccessToken)
          }}
        />
      )}
    </Show>
  )
}

function LobbyWaitingFallback(props: { state: Accessor<ActivityState> }) {
  const errorMessage = () => {
    const state = props.state()
    return state.status === 'error' ? state.message : ''
  }

  return (
    <Switch fallback={<ActivityRedirectingPage />}>
      <Match when={props.state().status === 'loading'}>
        <ActivityLoadingPage />
      </Match>
      <Match when={props.state().status === 'error'}>
        <ActivityErrorPage message={errorMessage()} />
      </Match>
    </Switch>
  )
}
