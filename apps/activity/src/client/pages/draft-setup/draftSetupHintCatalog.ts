import type { GameMode } from '@civup/game'
import { isTeamMode } from '@civup/game'

export interface DraftSetupHintContext {
  mode: GameMode
}

export interface DraftSetupHint {
  id: string
  copy: string
  applies?: (context: DraftSetupHintContext) => boolean
}

export const DRAFT_SETUP_HINTS = [
  {
    id: 'steam-lobby-link-controls',
    copy: 'With a Steam link set, click or tap to open and right-click to copy. Lobby players can hold or press F2 to edit.',
  },
  {
    id: 'team-leader-preview-visibility',
    copy: 'Selecting a leader only shows the preview to your teammates.',
    applies: (context: DraftSetupHintContext) => isTeamMode(context.mode),
  },
  {
    id: 'expand-leader-grid',
    copy: 'Use the button in the top-left to expand the leader grid.',
  },
  {
    id: 'leader-grid-views',
    copy: 'The leader grid has three views.',
  },
  {
    id: 'match-bump-open-lobby',
    copy: 'While the lobby is open, you can use /match bump to repost it.',
  },
] as const satisfies readonly DraftSetupHint[]

export type DraftSetupHintId = (typeof DRAFT_SETUP_HINTS)[number]['id']

export function getApplicableDraftSetupHints(
  context: DraftSetupHintContext,
  catalog: readonly DraftSetupHint[] = DRAFT_SETUP_HINTS,
): DraftSetupHint[] {
  return catalog.filter(hint => hint.applies?.(context) !== false)
}

export function resolveDraftSetupHint(
  currentId: string | null,
  context: DraftSetupHintContext,
  catalog: readonly DraftSetupHint[] = DRAFT_SETUP_HINTS,
): DraftSetupHint | null {
  const current = catalog.find(hint => hint.id === currentId)
  if (current && current.applies?.(context) !== false) return current
  return findNextApplicableHint(currentId, context, catalog)
}

export function getNextDraftSetupHint(
  currentId: string | null,
  context: DraftSetupHintContext,
  catalog: readonly DraftSetupHint[] = DRAFT_SETUP_HINTS,
): DraftSetupHint | null {
  return findNextApplicableHint(currentId, context, catalog)
}

function findNextApplicableHint(
  currentId: string | null,
  context: DraftSetupHintContext,
  catalog: readonly DraftSetupHint[],
): DraftSetupHint | null {
  if (catalog.length === 0) return null

  const currentIndex = catalog.findIndex(hint => hint.id === currentId)
  const startIndex = currentIndex < 0 ? -1 : currentIndex
  for (let offset = 1; offset <= catalog.length; offset++) {
    const hint = catalog[(startIndex + offset) % catalog.length]!
    if (hint.applies?.(context) !== false) return hint
  }
  return null
}
