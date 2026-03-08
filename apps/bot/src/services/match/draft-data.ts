export function getHostIdFromDraftData(draftData: string | null): string | null {
  if (!draftData) return null
  try {
    const parsed = JSON.parse(draftData) as {
      hostId?: string
      state?: {
        seats?: Array<{ playerId?: string }>
      }
    }
    if (typeof parsed.hostId === 'string' && parsed.hostId.length > 0) {
      return parsed.hostId
    }
    const hostId = parsed.state?.seats?.[0]?.playerId
    return typeof hostId === 'string' && hostId.length > 0 ? hostId : null
  }
  catch {
    return null
  }
}
