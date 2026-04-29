import { useParams } from '@solidjs/router'
import { Match, onMount, Switch } from 'solid-js'
import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'
import { preloadLobbyOverviewRoute } from '../route-preloads'
import { ReportedMatchPage } from '../../pages/reported-match'

export default function ReportedActivityRoute() {
  const activity = useActivityController()
  const params = useParams<{ matchId: string }>()
  onMount(() => { void preloadLobbyOverviewRoute() })

  return (
    <Switch fallback={<ActivityRedirectingPage />}>
      <Match when={activity.state().status === 'loading'}>
        <ActivityLoadingPage />
      </Match>
      <Match when={activity.state().status === 'error'}>
        <ActivityErrorPage message={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'error' }>).message} />
      </Match>
      <Match when={activity.state().status === 'reported' && (activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'reported' }>).matchId === params.matchId}>
        <ReportedMatchPage
          matchId={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'reported' }>).matchId}
          mode={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'reported' }>).lobbyMode}
          onSwitchTarget={activity.openOverview}
        />
      </Match>
    </Switch>
  )
}
