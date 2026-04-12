import type { Leader, LeaderDataVersion } from './types.ts'
import { factionMap, factions, getFaction, searchFactions } from './factions.ts'
import { normalizeAvailableLeaderDataVersion } from './leader-data-meta.ts'
import { leaderMap as betaLeaderMap, leaders as betaLeaders, getLeader as getBetaLeader, searchLeaders as searchBetaLeaders } from './leaders-beta.ts'
import { getLeader as getLiveLeader, allLeaderIds as liveLeaderIds, leaderMap as liveLeaderMap, leaders as liveLeaders, searchLeaders as searchLiveLeaders } from './leaders.ts'

export const leaders = liveLeaders
export const leaderMap = liveLeaderMap
export const allLeaderIds = liveLeaderIds
export const leadersBeta = normalizeAvailableLeaderDataVersion('beta') === 'beta' ? betaLeaders : liveLeaders
export const leaderBetaMap = normalizeAvailableLeaderDataVersion('beta') === 'beta' ? betaLeaderMap : liveLeaderMap
export const redDeathLeaders = factions
export const redDeathLeaderMap = factionMap

export function getLeaders(version: LeaderDataVersion = 'live'): Leader[] {
  return normalizeAvailableLeaderDataVersion(version) === 'beta' ? betaLeaders : liveLeaders
}

export function getLeaderMap(version: LeaderDataVersion = 'live'): Map<string, Leader> {
  return normalizeAvailableLeaderDataVersion(version) === 'beta' ? betaLeaderMap : liveLeaderMap
}

export function getLeader(id: string, version: LeaderDataVersion = 'live'): Leader {
  if (factionMap.has(id)) return getFaction(id)
  return normalizeAvailableLeaderDataVersion(version) === 'beta' ? getBetaLeader(id) : getLiveLeader(id)
}

export function searchLeaders(query: string, version: LeaderDataVersion = 'live'): Leader[] {
  if (query.trim().toLowerCase().startsWith('rd ')) {
    return searchFactions(query.replace(/^rd\s+/i, ''))
  }
  return normalizeAvailableLeaderDataVersion(version) === 'beta' ? searchBetaLeaders(query) : searchLiveLeaders(query)
}
