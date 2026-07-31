import type { GameMode, QueueEntry, SourceGuildIdentity } from '@civup/game'
import { isTeamMode, slotToTeamIndex, teamCount, teamSize } from '@civup/game'

export interface TeamGuildPolicy {
  primaryGuildId?: string | null
  allowLegacyPrimarySource?: boolean
}

export interface TeamGuildLock {
  team: number
  sourceGuild: SourceGuildIdentity | null
}

export interface TeamGuildValidation {
  locks: TeamGuildLock[]
  error: string | null
}

/** Resolves the first-occupant lock for each team and rejects mixed or unknown-source teams. */
export function validateTeamGuildSlots(
  mode: GameMode,
  slots: readonly (string | null)[],
  queueEntries: readonly QueueEntry[],
  policy: TeamGuildPolicy = {},
): TeamGuildValidation {
  if (!isTeamMode(mode)) return { locks: [], error: null }

  const entryByPlayerId = new Map(queueEntries.map(entry => [entry.playerId, entry]))
  const locks: TeamGuildLock[] = Array.from({ length: teamCount(mode, slots.length) }, (_, team) => ({ team, sourceGuild: null }))

  for (let slot = 0; slot < slots.length; slot++) {
    const playerId = slots[slot]
    if (!playerId) continue
    const team = slotToTeamIndex(mode, slot, slots.length)
    if (team == null) continue

    const source = resolveQueueEntrySourceGuild(entryByPlayerId.get(playerId), policy)
    if (!source) {
      return {
        locks,
        error: `Player ${formatPlayer(entryByPlayerId.get(playerId), playerId)} has no join server. Leave and rejoin before using a team slot.`,
      }
    }

    const lock = locks[team]
    if (!lock) continue
    if (!lock.sourceGuild) {
      lock.sourceGuild = source
      continue
    }
    if (lock.sourceGuild.id !== source.id) {
      return {
        locks,
        error: `Team ${formatTeam(team)} is locked to ${formatGuild(lock.sourceGuild)}, so ${formatPlayer(entryByPlayerId.get(playerId), playerId)} cannot join from ${formatGuild(source)}.`,
      }
    }
  }

  const selected = new Set(slots.filter((playerId): playerId is string => !!playerId))
  for (const party of buildLobbyPartyPlayerIds(queueEntries, selected)) {
    if (party.length < 2) continue
    const partyTeams = new Set<number>()
    for (let slot = 0; slot < slots.length; slot++) {
      if (!slots[slot] || !party.includes(slots[slot]!)) continue
      const team = slotToTeamIndex(mode, slot, slots.length)
      if (team != null) partyTeams.add(team)
    }
    if (partyTeams.size > 1) {
      return {
        locks,
        error: `Party ${party.map(playerId => formatPlayer(entryByPlayerId.get(playerId), playerId)).join(', ')} must stay together on one team.`,
      }
    }
  }

  return { locks, error: null }
}

export function validateLobbyParties(
  mode: GameMode,
  queueEntries: readonly QueueEntry[],
  slottedPlayerIds: readonly string[],
  slotCount: number,
  policy: TeamGuildPolicy = {},
): string | null {
  if (!isTeamMode(mode)) return null
  const maxTeamSize = teamSize(mode, slotCount)
  if (!maxTeamSize) return null

  const entryByPlayerId = new Map(queueEntries.map(entry => [entry.playerId, entry]))
  const selected = new Set(slottedPlayerIds)
  for (const party of buildLobbyPartyPlayerIds(queueEntries, selected)) {
    if (party.length > maxTeamSize) {
      return `Party ${party.map(playerId => formatPlayer(entryByPlayerId.get(playerId), playerId)).join(', ')} is too large for a team of ${maxTeamSize}.`
    }
    const sources = new Map<string, SourceGuildIdentity>()
    for (const playerId of party) {
      const source = resolveQueueEntrySourceGuild(entryByPlayerId.get(playerId), policy)
      if (!source) return `Player ${formatPlayer(entryByPlayerId.get(playerId), playerId)} has no join server.`
      sources.set(source.id, source)
    }
    if (sources.size > 1) {
      return `Party ${party.map(playerId => formatPlayer(entryByPlayerId.get(playerId), playerId)).join(', ')} cannot share a team because its players joined from ${[...sources.values()].map(formatGuild).join(' and ')}.`
    }
  }
  return null
}

export function buildLobbyPartyPlayerIds(queueEntries: readonly QueueEntry[], selected: ReadonlySet<string>): string[][] {
  const adjacency = new Map<string, Set<string>>()
  for (const playerId of selected) adjacency.set(playerId, new Set())
  for (const entry of queueEntries) {
    if (!selected.has(entry.playerId)) continue
    for (const partyId of entry.partyIds ?? []) {
      if (!selected.has(partyId) || partyId === entry.playerId) continue
      adjacency.get(entry.playerId)?.add(partyId)
      adjacency.get(partyId)?.add(entry.playerId)
    }
  }

  const parties: string[][] = []
  const visited = new Set<string>()
  for (const playerId of selected) {
    if (visited.has(playerId)) continue
    const pending = [playerId]
    const party: string[] = []
    visited.add(playerId)
    while (pending.length > 0) {
      const current = pending.shift()!
      party.push(current)
      for (const related of adjacency.get(current) ?? []) {
        if (visited.has(related)) continue
        visited.add(related)
        pending.push(related)
      }
    }
    parties.push(party)
  }
  return parties
}

export function resolveQueueEntrySourceGuild(entry: QueueEntry | undefined, policy: TeamGuildPolicy = {}): SourceGuildIdentity | null {
  if (entry?.sourceGuild?.id) return entry.sourceGuild
  if (policy.allowLegacyPrimarySource && policy.primaryGuildId) {
    return { id: policy.primaryGuildId, name: 'PPL', iconUrl: null }
  }
  return null
}

function formatPlayer(entry: QueueEntry | undefined, playerId: string): string {
  return `**${entry?.displayName || playerId}**`
}

function formatGuild(guild: SourceGuildIdentity): string {
  return `**${guild.name || guild.id}**`
}

function formatTeam(team: number): string {
  return String.fromCharCode(65 + team)
}
