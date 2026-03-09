import type { CompetitiveTier, DraftState, GameMode } from '@civup/game'
import type { LobbyJoinEligibilitySnapshot, LobbySnapshot, RankedRoleOptionSnapshot } from '~/client/stores'

export const MAX_TIMER_MINUTES = 30

export type LobbyModeValue = GameMode

export interface PlayerRow {
  key: string
  slot: number
  name: string
  playerId: string | null
  avatarUrl: string | null
  partyIds: string[]
  isHost: boolean
  empty: boolean
  pendingSelf: boolean
}

export interface DraftTimerConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

export interface MinRoleMismatchDetail {
  playerName: string
  roleLabel: string
  roleColor: string | null
}

export interface MinRoleSetDetail {
  roleLabel: string
  roleColor: string | null
}

export type OptimisticLobbyAction
  = | {
    kind: 'place-self'
    targetSlot: number
    baseRevision: number
    expiresAt: number
  }
  | {
    kind: 'remove-self'
    baseRevision: number
    expiresAt: number
  }
  | {
    kind: 'move-player'
    playerId: string
    targetSlot: number
    baseRevision: number
    expiresAt: number
  }
  | {
    kind: 'remove-player'
    playerId: string
    baseRevision: number
    expiresAt: number
  }

export type PendingOptimisticLobbyAction
  = | {
    kind: 'place-self'
    targetSlot: number
  }
  | {
    kind: 'remove-self'
  }
  | {
    kind: 'move-player'
    playerId: string
    targetSlot: number
  }
  | {
    kind: 'remove-player'
    playerId: string
  }

export function getTimerConfigFromDraft(state: DraftState | null): DraftTimerConfig {
  if (!state) return { banTimerSeconds: null, pickTimerSeconds: null }

  const banTimer = state.steps.find(step => step.action === 'ban')?.timer ?? null
  const pickTimer = state.steps.find(step => step.action === 'pick')?.timer ?? null
  return { banTimerSeconds: banTimer, pickTimerSeconds: pickTimer }
}

export function timerSecondsToMinutesInput(timerSeconds: number | null): string {
  if (timerSeconds == null) return ''
  return String(Math.round(timerSeconds / 60))
}

export function timerSecondsToMinutesPlaceholder(timerSeconds: number | null): string {
  if (timerSeconds == null) return ''
  return String(Math.round(timerSeconds / 60))
}

export function parseTimerMinutesInput(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return undefined
  if (numeric < 0 || numeric > MAX_TIMER_MINUTES) return undefined
  return numeric
}

export function normalizeTimerMinutesInput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return value

  const bounded = Math.min(MAX_TIMER_MINUTES, Math.max(0, Math.round(numeric)))
  return String(bounded)
}

export function formatTimerValue(timerSeconds: number | null, defaultTimerSeconds: number | null = null): string {
  if (timerSeconds == null && defaultTimerSeconds != null) {
    if (defaultTimerSeconds === 0) return 'Unlimited'
    const defaultMinutes = Math.round(defaultTimerSeconds / 60)
    if (defaultMinutes === 1) return '1 minute'
    return `${defaultMinutes} minutes`
  }

  if (timerSeconds == null) return 'Server default'
  if (timerSeconds === 0) return 'Unlimited'
  const minutes = Math.round(timerSeconds / 60)
  if (minutes === 1) return '1 minute'
  return `${minutes} minutes`
}

export function normalizeLobbyMinRoleValue(value: string): CompetitiveTier | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function findRankedRoleOptionByTier(
  options: RankedRoleOptionSnapshot[],
  tier: CompetitiveTier,
): RankedRoleOptionSnapshot | null {
  return options.find(option => option.tier === tier) ?? null
}

export function formatLobbyMinRole(minRole: CompetitiveTier | null, options: RankedRoleOptionSnapshot[]): string {
  if (!minRole) return 'Anyone'
  return findRankedRoleOptionByTier(options, minRole)?.label ?? 'Unranked'
}

export function buildRankDotStyle(color: string | null): Record<string, string> {
  return color ? { 'background-color': color } : { 'background-color': 'rgba(255,255,255,0.25)' }
}

export function buildRolePillStyle(color: string | null): Record<string, string> {
  if (!color) {
    return {
      'color': 'rgb(229,229,229)',
      'background-color': 'rgba(255,255,255,0.06)',
      'border-color': 'rgba(255,255,255,0.22)',
    }
  }

  const normalized = normalizeHexColor(color)
  if (!normalized) {
    return {
      color,
      'background-color': 'rgba(255,255,255,0.06)',
      'border-color': 'rgba(255,255,255,0.22)',
    }
  }

  return {
    'color': normalized,
    'background-color': `${normalized}1F`,
    'border-color': `${normalized}66`,
  }
}

function normalizeHexColor(color: string): string | null {
  const trimmed = color.trim()
  if (!/^#[0-9A-F]{6}$/i.test(trimmed)) return null
  return trimmed.toUpperCase()
}

export function applyOptimisticLobbyAction(
  lobby: LobbySnapshot | null,
  action: OptimisticLobbyAction | null,
  currentUserId: string | null,
  currentUserDisplayName: string | null,
  currentUserAvatarUrl: string | null,
): LobbySnapshot | null {
  if (!lobby || !action || !currentUserId) return lobby
  if (Date.now() > action.expiresAt || lobby.status !== 'open') return lobby

  const entries = [...lobby.entries]

  const movePlayer = (playerId: string, targetSlot: number): boolean => {
    if (targetSlot < 0 || targetSlot >= entries.length) return false

    const sourceSlot = entries.findIndex(entry => entry?.playerId === playerId)
    if (sourceSlot === targetSlot) return false
    const targetEntry = entries[targetSlot]

    if (sourceSlot < 0) {
      if (targetEntry && targetEntry.playerId !== playerId) return false

      entries[targetSlot] = {
        playerId,
        displayName: typeof currentUserDisplayName === 'string' && currentUserDisplayName.trim().length > 0
          ? currentUserDisplayName
          : 'You',
        avatarUrl: currentUserAvatarUrl || null,
      }
      return true
    }

    const sourceEntry = entries[sourceSlot]
    if (!sourceEntry) return false

    entries[sourceSlot] = targetEntry ?? null
    entries[targetSlot] = sourceEntry
    return true
  }

  const removePlayer = (playerId: string): boolean => {
    const sourceSlot = entries.findIndex(entry => entry?.playerId === playerId)
    if (sourceSlot < 0) return false
    entries[sourceSlot] = null
    return true
  }

  const changed = (() => {
    switch (action.kind) {
      case 'place-self':
        return movePlayer(currentUserId, action.targetSlot)
      case 'remove-self':
        return removePlayer(currentUserId)
      case 'move-player':
        return movePlayer(action.playerId, action.targetSlot)
      case 'remove-player':
        return removePlayer(action.playerId)
      default:
        return false
    }
  })()

  if (!changed) return lobby

  let hasPlayerDiff = false
  for (let i = 0; i < entries.length; i++) {
    const before = lobby.entries[i]?.playerId ?? null
    const after = entries[i]?.playerId ?? null
    if (before !== after) {
      hasPlayerDiff = true
      break
    }
  }
  if (!hasPlayerDiff) return lobby

  return { ...lobby, entries }
}

export function resolvePendingJoinGhostSlot(
  lobby: LobbySnapshot | null,
  currentUserId: string | null,
  pendingJoinActive: boolean,
  joinEligibility: LobbyJoinEligibilitySnapshot | null | undefined,
  preferredSlot: number | null = null,
): number | null {
  if (!lobby || !currentUserId || !pendingJoinActive) return null
  if (!joinEligibility?.canJoin) return null
  if (lobby.entries.some(entry => entry?.playerId === currentUserId)) return null

  const pendingSlot = preferredSlot ?? joinEligibility.pendingSlot
  if (pendingSlot == null || !Number.isInteger(pendingSlot)) return null
  if (pendingSlot < 0 || pendingSlot >= lobby.entries.length) return null
  if (lobby.entries[pendingSlot] != null) return null
  return pendingSlot
}
