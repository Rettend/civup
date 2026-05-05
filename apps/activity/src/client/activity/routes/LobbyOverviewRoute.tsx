import { Match, Switch } from 'solid-js'
import { LobbyOverviewPage } from '../../pages/lobby-overview'
import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'

export default function LobbyOverviewRoute() {
  const activity = useActivityController()

  return (
    <Switch fallback={<ActivityRedirectingPage />}>
      <Match when={activity.state().status === 'loading'}>
        <ActivityLoadingPage />
      </Match>
      <Match when={activity.state().status === 'error'}>
        <ActivityErrorPage message={(activity.state() as Extract<ReturnType<typeof activity.state>, { status: 'error' }>).message} />
      </Match>
      <Match when={activity.state().status === 'overview'}>
        <LobbyOverviewPage
          options={activity.availableTargets()}
          busy={activity.pickerBusy()}
          selectedKey={activity.currentTargetKey()}
          error={activity.pickerError()}
          onSelect={activity.handleTargetSelection}
          onResume={activity.lastResolvedSelection() ? activity.restoreLastSelection : undefined}
          onPractice={activity.openPractice}
        />
      </Match>
    </Switch>
  )
}
