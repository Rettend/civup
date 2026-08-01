import { describe, expect, test } from 'bun:test'
import {
  DRAFT_SETUP_HINTS,
  getApplicableDraftSetupHints,
  getNextDraftSetupHint,
  resolveDraftSetupHint,
} from '../src/client/pages/draft-setup/draftSetupHintCatalog'

const ffaContext = { mode: 'ffa' as const }
const teamContext = { mode: '2v2' as const }
const oneVsOneContext = { mode: '1v1' as const }

describe('draft setup hint catalog', () => {
  test('keeps unique stable IDs and concise copy for the complete catalog', () => {
    const ids = DRAFT_SETUP_HINTS.map(hint => hint.id)

    expect(ids).toEqual([
      'steam-lobby-link-controls',
      'team-leader-preview-visibility',
      'expand-leader-grid',
      'leader-grid-views',
      'match-bump-open-lobby',
    ])
    expect(new Set(ids).size).toBe(ids.length)
    expect(DRAFT_SETUP_HINTS.every(hint => hint.copy.length > 0 && hint.copy.length <= 120)).toBe(true)
  })

  test('only includes teammate preview guidance in team modes', () => {
    expect(getApplicableDraftSetupHints(teamContext).map(hint => hint.id)).toContain('team-leader-preview-visibility')
    expect(getApplicableDraftSetupHints(ffaContext).map(hint => hint.id)).not.toContain('team-leader-preview-visibility')
    expect(getApplicableDraftSetupHints(oneVsOneContext).map(hint => hint.id)).not.toContain('team-leader-preview-visibility')
  })

  test('resolves missing and inapplicable persisted IDs deterministically', () => {
    expect(resolveDraftSetupHint('removed-hint', ffaContext)?.id).toBe('steam-lobby-link-controls')
    expect(resolveDraftSetupHint('team-leader-preview-visibility', ffaContext)?.id).toBe('expand-leader-grid')
    expect(resolveDraftSetupHint('team-leader-preview-visibility', teamContext)?.id).toBe('team-leader-preview-visibility')
  })

  test('moves through applicable hints and wraps', () => {
    expect(getNextDraftSetupHint('steam-lobby-link-controls', ffaContext)?.id).toBe('expand-leader-grid')
    expect(getNextDraftSetupHint('match-bump-open-lobby', ffaContext)?.id).toBe('steam-lobby-link-controls')
    expect(getNextDraftSetupHint('steam-lobby-link-controls', teamContext)?.id).toBe('team-leader-preview-visibility')
  })
})
