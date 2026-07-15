import { LobbyOverviewPage } from '../../pages/lobby-overview'
import { ActivityErrorPage, ActivityLoadingPage, ActivityRedirectingPage, useActivityController } from '../activity-context'

export default function LobbyOverviewRoute() {
  const activity = useActivityController()
  const renderRoute = () => {
    const state = activity.state()
    if (state.status === 'loading') return <ActivityLoadingPage />
    if (state.status === 'error') return <ActivityErrorPage message={state.message} />
    if (state.status !== 'overview') return <ActivityRedirectingPage />
    return (
      <LobbyOverviewPage
        options={activity.availableTargets()}
        busy={activity.pickerBusy()}
        selectedKey={activity.currentTargetKey()}
        error={activity.pickerError()}
        onSelect={activity.handleTargetSelection}
        onResume={activity.canResumeSelection() ? activity.restoreLastSelection : undefined}
        onPractice={activity.openPractice}
        onUpload={activity.openAutosaveUpload}
        onFolderUpload={activity.openAutosaveFolderUpload}
        onCatalog={activity.canViewAutosaveCatalog() ? activity.openAutosaveCatalog : undefined}
        onExportData={activity.canExportPlayerData() ? activity.exportPlayerData : undefined}
        playerDataExportState={activity.playerDataExportState()}
      />
    )
  }

  return <>{renderRoute()}</>
}
