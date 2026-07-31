import type { CivBlitzKit, LeaderDataVersion } from '@civup/game'

export interface CivBlitzModSeatInput {
  /** Zero-based seat index. Seats must be supplied contiguously in this order. */
  seatIndex: number
  /** Validated for caller diagnostics, but deliberately excluded from generated archive contents. */
  displayName: string
  kit: CivBlitzKit
}

export interface CivBlitzModInput {
  /** Stable match identifier. It, the data version, and the canonical kit set determine all generated IDs. */
  matchId: string
  leaderDataVersion: LeaderDataVersion
  /** BBG Expanded is intentionally unsupported and this must currently be true. */
  excludeBbgExpanded: boolean
  seats: readonly CivBlitzModSeatInput[]
}

export interface CivBlitzModFile {
  path: string
  /** UTF-8 text unless a future payload explicitly uses bytes. */
  content: string | Uint8Array
}

export interface GeneratedCivBlitzModFiles {
  archiveFilename: string
  modId: string
  files: readonly CivBlitzModFile[]
}

export type CivBlitzModErrorCode
  = | 'INVALID_INPUT'
    | 'INVALID_KIT'
    | 'DUPLICATE_COMPONENT'
    | 'COMPONENT_NOT_FOUND'
    | 'COMPONENT_UNSUPPORTED'
    | 'BBG_EXPANDED_UNSUPPORTED'
    | 'GENERATION_LIMIT'

export class CivBlitzModError extends Error {
  readonly code: CivBlitzModErrorCode
  readonly safeMessage: string
  readonly status: 400 | 413 | 422

  constructor(code: CivBlitzModErrorCode, safeMessage: string, status: 400 | 413 | 422 = 422) {
    super(safeMessage)
    this.name = 'CivBlitzModError'
    this.code = code
    this.safeMessage = safeMessage
    this.status = status
  }
}

export function isCivBlitzModError(error: unknown): error is CivBlitzModError {
  return error instanceof CivBlitzModError
}

export type { CivBlitzKit, LeaderDataVersion }
