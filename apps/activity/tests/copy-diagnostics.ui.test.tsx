import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'
import { ActivityErrorPage, ActivityLoadingPage } from '../src/client/activity/activity-context'

afterEach(() => cleanup())

test('keeps diagnostics available while loading and confirms a successful copy', async () => {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
  render(() => <ActivityLoadingPage />)
  expect(screen.getByText('Connecting to CivUp...')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
})

test('offers selectable text if both clipboard methods fail, without hiding Retry', async () => {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } })
  const retry = vi.fn()
  render(() => <ActivityErrorPage message="Could not open the activity." onRetry={retry} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
  const field = (await screen.findByRole('textbox', { name: 'Connection diagnostics' })) as HTMLTextAreaElement
  expect(field.readOnly).toBe(true)
  expect(field.value).toContain('CivUp connection diagnostics')
  field.focus()
  expect(field.selectionEnd).toBe(field.value.length)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalledOnce()
})
