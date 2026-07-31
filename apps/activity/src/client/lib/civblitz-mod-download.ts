import { CIVUP_CIVBLITZ_DOWNLOAD_TICKET_QUERY_PARAM } from '@civup/utils'
import { buildActivitySessionHeaders } from './activity-session'
import { openExternalLink } from '../platform/external-links'
import { getClientSurface } from '../platform/runtime'

export function buildCivBlitzModDownloadUrl(matchId: string, ticket: string, origin = window.location.origin): string {
  const url = new URL(`/api/match/${encodeURIComponent(matchId)}/civblitz/download`, origin)
  url.searchParams.set(CIVUP_CIVBLITZ_DOWNLOAD_TICKET_QUERY_PARAM, ticket)
  return url.toString()
}

export async function requestCivBlitzModDownloadUrl(
  matchId: string,
  fetchImpl: typeof fetch = fetch,
  origin = window.location.origin,
): Promise<string> {
  const response = await fetchImpl(`/api/match/${encodeURIComponent(matchId)}/civblitz/download-ticket`, {
    method: 'POST',
    headers: buildActivitySessionHeaders(),
  })
  const payload = await response.json<{ ticket?: unknown, error?: unknown }>().catch(() => null)
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Could not authorize the mod download.')
  if (typeof payload?.ticket !== 'string' || payload.ticket.length === 0) throw new Error('The mod download authorization was invalid.')
  return buildCivBlitzModDownloadUrl(matchId, payload.ticket, origin)
}

export async function openCivBlitzModDownload(matchId: string): Promise<void> {
  if (getClientSurface() === 'web') {
    await openExternalLink(buildDirectCivBlitzModDownloadUrl(matchId))
    return
  }

  const url = await requestCivBlitzModDownloadUrl(matchId)
  if (!await openExternalLink(url)) window.open(url, '_blank', 'noopener')
}

function buildDirectCivBlitzModDownloadUrl(matchId: string, origin = window.location.origin): string {
  return new URL(`/api/match/${encodeURIComponent(matchId)}/civblitz/download`, origin).toString()
}
