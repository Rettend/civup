import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'

export default function ActivityIndexRoute() {
  const activity = useActivityController()
  const renderRoute = () => {
    const state = activity.state()
    if (state.status === 'loading') return <ActivityLoadingPage />
    if (state.status === 'error') return <ActivityErrorPage message={state.message} />
    return <ActivityRedirectingPage />
  }

  return <>{renderRoute()}</>
}
