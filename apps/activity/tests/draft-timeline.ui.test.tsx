/** @jsxImportSource solid-js */

import { render, screen } from '@solidjs/testing-library'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createActiveDraftState } from './ui-fixtures'
import { resetUiMocks, uiMockState } from './ui-mocks'

const { DraftTimeline } = await import('../src/client/components/draft/DraftTimeline')

describe('DraftTimeline UI', () => {
  beforeEach(() => {
    resetUiMocks()
  })

  test('labels the initial blind pick as a normal pick phase', () => {
    uiMockState.draftState = createActiveDraftState({
      formatId: 'default-ffa-blind-pick',
      steps: [{ action: 'pick', seats: 'all', count: 1, timer: 60, blind: true, blindPickRound: 0, fallbackPickOrder: [0, 1, 2, 3] }],
    })

    render(() => <DraftTimeline />)

    expect(screen.getByText('PICK')).toBeTruthy()
    expect(screen.queryByText('BLIND PICK')).toBeNull()
  })
})
