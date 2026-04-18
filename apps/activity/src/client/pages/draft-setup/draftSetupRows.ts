import type { MiniSeatItem } from '~/client/components/draft/MiniLayout'
import type { DraftState } from '@civup/game'
import type { LobbySnapshot } from '~/client/stores'
import type { PlayerRow } from './helpers'
import { inferGameMode, slotToTeamIndex } from '@civup/game'

interface BuildRowsInput {
  lobby: LobbySnapshot | null
  draftState: DraftState | null
  hostId: string | null
  currentUserId: string | null
  currentUserDisplayName: string | null
  currentUserAvatarUrl: string | null
  pendingSelfJoinSlot: number | null
}

function buildLobbyRow(input: BuildRowsInput, slot: number, entry: LobbySnapshot['entries'][number] | null, key: string): PlayerRow {
  const pendingSelf = input.pendingSelfJoinSlot === slot
  if (pendingSelf && input.currentUserId) {
    return {
      key,
      slot,
      name: input.currentUserDisplayName || 'You',
      playerId: input.currentUserId,
      avatarUrl: input.currentUserAvatarUrl,
      isHost: false,
      empty: false,
      pendingSelf: true,
    }
  }

  return {
    key,
    slot,
    name: entry?.displayName ?? '[empty]',
    playerId: entry?.playerId ?? null,
    avatarUrl: entry?.avatarUrl ?? null,
    isHost: entry?.playerId === input.hostId,
    empty: entry == null,
    pendingSelf: false,
  }
}

export function buildTeamRows(input: BuildRowsInput, team: number): PlayerRow[] {
  if (input.lobby) {
    const mode = inferGameMode(input.lobby.mode)
    const rows: PlayerRow[] = []
    for (let slot = 0; slot < input.lobby.entries.length; slot++) {
      if (slotToTeamIndex(mode, slot, input.lobby.targetSize) !== team) continue
      rows.push(buildLobbyRow(input, slot, input.lobby.entries[slot] ?? null, `lobby-${slot}`))
    }
    return rows
  }

  return (input.draftState?.seats ?? []).flatMap((seat, seatIndex) => seat.team !== team ? [] : [{
    key: `room-${team}-${seat.playerId}`,
    slot: seatIndex,
    name: seat.displayName,
    playerId: seat.playerId,
    avatarUrl: seat.avatarUrl ?? null,
    isHost: seat.playerId === input.hostId,
    empty: false,
    pendingSelf: false,
  }])
}

export function buildFfaRows(input: BuildRowsInput): PlayerRow[] {
  if (input.lobby) {
    return Array.from({ length: input.lobby.targetSize }, (_, index) => buildLobbyRow(input, index, input.lobby?.entries[index] ?? null, `lobby-ffa-${index}`))
  }

  return (input.draftState?.seats ?? []).map((seat, index) => ({
    key: `room-ffa-${seat.playerId}`,
    slot: index,
    name: seat.displayName,
    playerId: seat.playerId,
    avatarUrl: seat.avatarUrl ?? null,
    isHost: seat.playerId === input.hostId,
    empty: false,
    pendingSelf: false,
  }))
}

export function splitFfaRows(rows: PlayerRow[]): [PlayerRow[], PlayerRow[]] {
  const midpoint = Math.ceil(rows.length / 2)
  return [rows.slice(0, midpoint), rows.slice(midpoint)]
}

export function buildMiniColumns(input: {
  isTeamMode: boolean
  teamIndices: number[]
  teamRows: (team: number) => PlayerRow[]
  ffaColumns: [PlayerRow[], PlayerRow[]]
  draftState: DraftState | null
  previewPicks: Record<number, string[] | undefined>
}): MiniSeatItem[][] {
  const toMiniSeatItem = (row: PlayerRow, team: number | null): MiniSeatItem => ({
    key: row.key,
    name: row.empty ? '[empty]' : row.name,
    avatarUrl: row.avatarUrl ?? null,
    leaderId: input.draftState?.picks.find(pick => pick.seatIndex === row.slot)?.civId ?? null,
    previewLeaderId: input.previewPicks[row.slot]?.[0] ?? null,
    team,
    empty: row.empty,
  })

  if (input.isTeamMode) {
    const teamColumns = input.teamIndices.map(team => input.teamRows(team).map(row => toMiniSeatItem(row, team)))
    if (teamColumns.length > 2) {
      const midpoint = Math.ceil(teamColumns.length / 2)
      return [teamColumns.slice(0, midpoint).flat(), teamColumns.slice(midpoint).flat()]
    }
    return teamColumns
  }

  return input.ffaColumns.map(column => column.map(row => toMiniSeatItem(row, null)))
}
