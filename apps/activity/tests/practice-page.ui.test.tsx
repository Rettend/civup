/** @jsxImportSource solid-js */

import { Route, Router } from '@solidjs/router'
import { render, screen } from '@solidjs/testing-library'
import { beforeEach, describe, expect, test } from 'bun:test'

const { default: PracticePage } = await import('../src/client/pages/practice/PracticePage')

describe('PracticePage UI', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/practice/era-score')
  })

  test('renders outside the live activity shell for the selected practice game', () => {
    render(() => (
      <Router>
        <Route path="/practice/:game?" component={PracticePage} />
      </Router>
    ))

    expect(screen.getByRole('heading', { name: 'Era Score' })).toBeTruthy()
    expect(screen.getByText(/does not keep lobby or draft websockets alive/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to activity' }).getAttribute('href')).toBe('/overview')
  })
})
