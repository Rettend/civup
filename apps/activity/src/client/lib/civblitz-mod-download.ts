import { CIVUP_ACTIVITY_SESSION_QUERY_PARAM } from '@civup/utils'
import { getActivitySessionToken } from './activity-session'
import { openExternalLink } from '../platform/external-links'

export function buildCivBlitzModDownloadUrl(matchId: string, origin = window.location.origin): string {
  const url = new URL(`/api/match/${encodeURIComponent(matchId)}/civblitz/download`, origin)
  const token = getActivitySessionToken()
  if (token) url.searchParams.set(CIVUP_ACTIVITY_SESSION_QUERY_PARAM, token)
  return url.toString()
}

export async function openCivBlitzModDownload(matchId: string): Promise<void> {
  const url = buildCivBlitzModDownloadUrl(matchId)
  if (!await openExternalLink(url)) window.open(url, '_blank', 'noopener')
}
