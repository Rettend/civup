import type { LeaderDataVersion } from './types.ts'

/** Installed live BBG version label used by the UI. */
export const liveLeaderDataVersionLabel = "7.4.2"

/** Installed beta BBG version label, or null when no beta is active. */
export const betaLeaderDataVersionLabel = null

/** Whether a distinct beta BBG leader data set is currently available. */
export const hasBetaLeaderData = false

/** Collapse beta requests to live when no active beta is installed. */
export function normalizeAvailableLeaderDataVersion(version: LeaderDataVersion = 'live'): LeaderDataVersion {
  return hasBetaLeaderData && version === 'beta' ? 'beta' : 'live'
}
