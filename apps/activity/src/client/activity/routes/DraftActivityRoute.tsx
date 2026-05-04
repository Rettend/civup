import { useParams } from '@solidjs/router'
import { Match, onMount, Switch } from 'solid-js'
import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'
import { preloadLobbyOverviewRoute } from '../route-preloads'
import { DraftPage } from '../../pages/draft'

export default function DraftActivityRoute() {
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
      <Match when={activity.state().status === 'authenticated' && (activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'authenticated' }>).matchId === params.matchId}>
        <DraftPage
          matchId={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'authenticated' }>).matchId}
          autoStart={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'authenticated' }>).autoStart}
          steamLobbyLink={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'authenticated' }>).steamLobbyLink}
          lobbyId={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'authenticated' }>).lobbyId}
          lobbyMode={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'authenticated' }>).lobbyMode}
          reported={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'authenticated' }>).reported}
          onSwitchTarget={activity.openOverview}
        />
      </Match>
    </Switch>
  )
}
