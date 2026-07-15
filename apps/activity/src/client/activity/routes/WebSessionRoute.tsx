import type { Accessor } from 'solid-js'
import { DraftPage } from '../../pages/draft'
import { DraftSetupPage } from '../../pages/draft-setup'
import { Match, Show, Switch } from 'solid-js'
import type { ActivityState } from '../activity-context'
import { ActivityErrorPage, ActivityLoadingPage, useActivityController } from '../activity-context'

export default function WebSessionRoute() {
  const activity = useActivityController()
  const waitingState = () => {
    const state = activity.state()
    return state.status === 'lobby-waiting' ? state : null
  }

  return (
    <Show
      when={activity.state().status === 'lobby-waiting'}
      fallback={<WebSessionFallback state={activity.state} onSwitchTarget={activity.canSwitchTargets ? activity.openOverview : undefined} />}
    >
      <DraftSetupPage
        lobby={waitingState()?.lobby}
        showJoinPending={waitingState()?.joinPending}
        joinEligibility={waitingState()?.joinEligibility}
        onSwitchTarget={activity.canSwitchTargets ? activity.openOverview : undefined}
        onLobbyStarted={(matchId, steamLobbyLink, sessionAccessToken) => {
          activity.transitionToDraft(matchId, true, steamLobbyLink, sessionAccessToken)
        }}
      />
    </Show>
  )
}

function WebSessionFallback(props: { state: Accessor<ActivityState>, onSwitchTarget?: () => void }) {
  const authenticatedState = () => {
    const state = props.state()
    return state.status === 'authenticated' ? state : null
  }

  return (
    <Show when={props.state().status === 'authenticated'} fallback={<WebSessionStatus state={props.state} />}>
      <DraftPage
        matchId={authenticatedState()?.matchId ?? ''}
        autoStart={authenticatedState()?.autoStart ?? false}
        steamLobbyLink={authenticatedState()?.steamLobbyLink ?? null}
        lobbyId={authenticatedState()?.lobbyId ?? null}
        lobbyMode={authenticatedState()?.lobbyMode ?? null}
        reported={authenticatedState()?.reported ?? false}
        onSwitchTarget={props.onSwitchTarget}
      />
    </Show>
  )
}

function WebSessionStatus(props: { state: Accessor<ActivityState> }) {
  const errorMessage = () => {
    const state = props.state()
    return state.status === 'error' ? state.message : ''
  }

  return (
    <Switch fallback={<ActivityErrorPage message="This session is unavailable." />}>
      <Match when={props.state().status === 'loading'}>
        <ActivityLoadingPage />
      </Match>
      <Match when={props.state().status === 'error'}>
        <ActivityErrorPage message={errorMessage()} />
      </Match>
    </Switch>
  )
}
