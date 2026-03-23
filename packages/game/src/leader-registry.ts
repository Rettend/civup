import type { Leader, LeaderDataVersion } from './types.ts'
import { allLeaderIds as liveLeaderIds, getLeader as getLiveLeader, leaderMap as liveLeaderMap, leaders as liveLeaders, searchLeaders as searchLiveLeaders } from './leaders.ts'
import { getLeader as getBetaLeader, leaderMap as betaLeaderMap, leaders as betaLeaders, searchLeaders as searchBetaLeaders } from './leaders-beta.ts'

export const leaders = liveLeaders
export const leaderMap = liveLeaderMap
export const allLeaderIds = liveLeaderIds
export const leadersBeta = betaLeaders
export const leaderBetaMap = betaLeaderMap

export function getLeaders(version: LeaderDataVersion = 'live'): Leader[] {
  return version === 'beta' ? betaLeaders : liveLeaders
}

export function getLeaderMap(version: LeaderDataVersion = 'live'): Map<string, Leader> {
  return version === 'beta' ? betaLeaderMap : liveLeaderMap
}

export function getLeader(id: string, version: LeaderDataVersion = 'live'): Leader {
  return version === 'beta' ? getBetaLeader(id) : getLiveLeader(id)
}

export function searchLeaders(query: string, version: LeaderDataVersion = 'live'): Leader[] {
  return version === 'beta' ? searchBetaLeaders(query) : searchLiveLeaders(query)
}
