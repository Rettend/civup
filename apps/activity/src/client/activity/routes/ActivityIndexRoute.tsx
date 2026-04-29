import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'
import { Match, Switch } from 'solid-js'

export default function ActivityIndexRoute() {
  const activity = useActivityController()

  return (
    <Switch fallback={<ActivityRedirectingPage />}>
      <Match when={activity.state().status === 'loading'}>
        <ActivityLoadingPage />
      </Match>
      <Match when={activity.state().status === 'error'}>
        <ActivityErrorPage message={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'error' }>).message} />
      </Match>
    </Switch>
  )
}
