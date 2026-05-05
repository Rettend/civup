import { useParams } from '@solidjs/router'
import { Match, onMount, Switch } from 'solid-js'
import { DraftSetupPage } from '../../pages/draft-setup'
import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'
import { preloadLobbyOverviewRoute } from '../route-preloads'

export default function LobbyWaitingRoute() {
  const activity = useActivityController()
  const params = useParams<{ lobbyId: string }>()
  onMount(() => { void preloadLobbyOverviewRoute() })

  return (
    <Switch fallback={<ActivityRedirectingPage />}>
      <Match when={activity.state().status === 'loading'}>
        <ActivityLoadingPage />
      </Match>
      <Match when={activity.state().status === 'error'}>
        <ActivityErrorPage message={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'error' }>).message} />
      </Match>
      <Match when={activity.state().status === 'lobby-waiting' && (activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'lobby-waiting' }>).lobby.id === params.lobbyId}>
        <DraftSetupPage
          lobby={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'lobby-waiting' }>).lobby}
          showJoinPending={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'lobby-waiting' }>).joinPending}
          joinEligibility={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'lobby-waiting' }>).joinEligibility}
          onSwitchTarget={activity.openOverview}
          onLobbyStarted={(matchId, steamLobbyLink, sessionAccessToken) => {
            activity.transitionToDraft(matchId, true, steamLobbyLink, sessionAccessToken)
          }}
        />
      </Match>
    </Switch>
  )
}
