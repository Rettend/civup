interface ParsedDraftData {
  completedAt?: unknown
  hostId?: unknown
  state?: {
    seats?: Array<{ playerId?: unknown }>
  }
}

function parseDraftData(draftData: string | null): ParsedDraftData | null {
  if (!draftData) return null
  try {
    return JSON.parse(draftData) as ParsedDraftData
  }
  catch {
    return null
  }
}

export function getHostIdFromDraftData(draftData: string | null): string | null {
  const parsed = parseDraftData(draftData)
  if (!parsed) return null

  if (typeof parsed.hostId === 'string' && parsed.hostId.length > 0) {
    return parsed.hostId
  }

  const hostId = parsed.state?.seats?.[0]?.playerId
  return typeof hostId === 'string' && hostId.length > 0 ? hostId : null
}

export function getCompletedAtFromDraftData(draftData: string | null): number | null {
  const parsed = parseDraftData(draftData)
  if (!parsed) return null
  return typeof parsed.completedAt === 'number' && Number.isFinite(parsed.completedAt)
    ? Math.round(parsed.completedAt)
    : null
}
