import type { GameMode } from '@civup/game'
import type { CapacityModel, DailyUsage, MetricBreakpoint } from './model.ts'

export type UsageSample = DailyUsage

export interface SimulationResult {
  usage: UsageSample
  draftRoomIncomingMessages: number
  draftRoomIncomingMessagesWithSelectionPreviews: number
  draftRoomIncomingMessagesWithTeamPickPreviews: number
  openLobbyMutationRequests: number
  selectedLobbyPushUpdates: number
}

export interface CapacityScenario {
  id: string
  label: string
  mode: GameMode
  joinGroups: string[][]
  spectatorIds?: string[]
}

export interface ScenarioReport {
  mode: CapacityScenario
  model: CapacityModel
  corePerDraft: UsageSample
  openLobbyChurnPerDraft: UsageSample
  draftRoomIncomingMessages: number
  draftRoomIncomingMessagesWithSelectionPreviews: number
  draftRoomIncomingMessagesWithTeamPickPreviews: number
  openLobbyMutationRequests: number
  selectedLobbyPushUpdates: number
  freeCapacityPlaysPerDay: number
  paidIncludedCapacityPlaysPerDay: number
  paidSixDollarCapacityPlaysPerDay: number
  paidSixDollarOverageUsd: number
  paidTenDollarCapacityPlaysPerDay: number
  paidTenDollarOverageUsd: number
  freeBreakpoints: MetricBreakpoint[]
  paidBreakpoints: MetricBreakpoint[]
}

export interface CapacitySnapshot {
  version: 6
  globals: {
    stabilitySamples: number
    leaderboardCronRunsPerDay: number
    inactiveLobbyCleanupCronRunsPerDay: number
    rankedRoleCronRunsPerDay: number
    architectureModel: string
    currentArchitectureModel: string
    targetArchitectureModel: string
    modeledProductionRatedPlayers: number
    modeledProductionCompletedMatches: number
    modeledProductionMatchParticipants: number
    estimatedSelectedSessionConnectedSeconds: number
    lobbyWatchMsgsPerConnection: number
    doWebsocketBillingRatio: number
    estimatedDoGbSecondsPerRequest: number
    sessionSocketConnectionsPerViewer: number
    sessionDoSqlReadsPerCommand: number
    sessionDoSqlWritesPerCommand: number
    sessionDoSqlReadsPerSocketConnect: number
    sessionDoSqlWritesPerSocketConnect: number
    sessionDoSqlReadsPerDraftMessage: number
    sessionDoSqlWritesPerDraftMessage: number
    directoryReadsPerViewerLaunch: number
    directoryReadsPerJoinGroup: number
    directoryWritesPerSessionCreate: number
    directoryWritesPerParticipantJoin: number
    directoryWritesPerOpenLobbyMutation: number
    directoryWritesPerDraftStart: number
    directoryWritesPerReport: number
    directoryWritesPerParticipantReportCleanup: number
    averageAcceptedSwapsPerTeamDraft: number
    rankedFinishModel: string
    rankedFinishExtraRatingReadsPerPlayer: number
    rankedFinishExtraRatingWritesPerPlayer: number
    rankedFinishEventWritesPerPlayer: number
    rankedFinishEvidenceReadsPerPlayer: number
    rankedFinishEvidenceWritesPerPlayer: number
    rankedFinishOpponentQualityReadsPerPlayer: number
    rankedFinishSeasonReadsPerPlayer: number
    rankedFinishContextReadsPerMatch: number
    rankedRoleSyncReadsPerRatedPlayer: number
  }
  backgroundDailyUsage: DailyUsage | null
  scenarios: CapacitySnapshotScenario[]
}

export interface CapacitySnapshotScenario {
  id: string
  label: string
  players: number
  viewers: number
  lobbyMutations: number
  selectedLobbyPushUpdates: number
  draftMessages: number
  previewMessages: number
  teamPreviewMessages: number
  rankedFinishExtraD1RowsRead: number
  rankedFinishExtraD1RowsWritten: number
  selectedSessionObjectSeconds: number
  selectedSessionObjectHours: number
  sessionDoDurationGbSeconds: number
  corePerDraft: UsageSample
  openLobbyChurnPerDraft: UsageSample
  perDraft: CapacityModel['perDraft']
  capacity: {
    free: CapacitySnapshotPlan
    paidIncluded: CapacitySnapshotPlan
    paid6: CapacitySnapshotPlanWithOverage
    paid10: CapacitySnapshotPlanWithOverage
  }
  breakpoints: {
    free: CapacitySnapshotBreakpoint[]
    paidIncluded: CapacitySnapshotBreakpoint[]
  }
}

export interface CapacitySnapshotPlan {
  playsPerDay: number
  draftsPerDay: number
  bottleneck: string
}

export interface CapacitySnapshotPlanWithOverage {
  playsPerDay: number
  draftsPerDay: number
  overageUsd: number
}

export interface CapacitySnapshotBreakpoint {
  metric: MetricBreakpoint['metric']
  playsPerDay: number
  draftsPerDay: number
}
