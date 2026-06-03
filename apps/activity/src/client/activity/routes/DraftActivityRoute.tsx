import { useParams } from '@solidjs/router'
import { DraftPage } from '../../pages/draft'
import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'

export default function DraftActivityRoute() {
  const activity = useActivityController()
  const params = useParams<{ matchId: string }>()

  const renderRoute = () => {
    const state = activity.state()
    if (state.status === 'loading') return <ActivityLoadingPage />
    if (state.status === 'error') return <ActivityErrorPage message={state.message} />
    if (state.status !== 'authenticated' || state.matchId !== params.matchId) return <ActivityRedirectingPage />
    return (
      <DraftPage
        matchId={state.matchId}
        autoStart={state.autoStart}
        steamLobbyLink={state.steamLobbyLink}
        lobbyId={state.lobbyId}
        lobbyMode={state.lobbyMode}
        reported={state.reported}
        onSwitchTarget={activity.openOverview}
      />
    )
  }

  return <>{renderRoute()}</>
}
