/** @jsxImportSource solid-js */

import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { clipboardSpies, discordSpies, resetUiMocks, uiMockState } from './ui-mocks'

const onSaveSteamLink = mock(() => {})
const STEAM_LINK = 'steam://joinlobby/289070/example'
const HOLD_WAIT_MS = 525

const { SteamLobbyButton } = await import('../src/client/components/draft/SteamLobbyButton')

function dispatchPrimaryPointer(button: HTMLElement, type: 'pointerDown' | 'pointerUp' | 'pointerCancel', pointerType: string, pointerId = 7) {
  fireEvent[type](button, {
    pointerId,
    pointerType,
    button: 0,
    buttons: type === 'pointerDown' ? 1 : 0,
    isPrimary: true,
    clientX: 10,
    clientY: 10,
  })
}

function installPointerCapture(button: HTMLElement) {
  const capturedPointers = new Set<number>()
  const releasePointerCapture = mock((pointerId: number) => {
    capturedPointers.delete(pointerId)
  })
  button.setPointerCapture = pointerId => capturedPointers.add(pointerId)
  button.hasPointerCapture = pointerId => capturedPointers.has(pointerId)
  button.releasePointerCapture = releasePointerCapture
  return releasePointerCapture
}

describe('SteamLobbyButton UI', () => {
  beforeEach(() => {
    resetUiMocks()
    onSaveSteamLink.mockClear()
  })

  test('opens an editable set link on a quick click and advertises every interaction', async () => {
    const user = userEvent.setup()
    render(() => (
      <SteamLobbyButton
        steamLobbyLink={STEAM_LINK}
        onSaveSteamLink={onSaveSteamLink}
      />
    ))

    const button = screen.getByRole('button', { name: 'Open Steam link' })
    expect(button.getAttribute('title')).toBe('Open Steam link; right-click to copy; hold or press F2 to edit')
    expect(button.getAttribute('aria-description')).toContain('half a second')
    expect(button.getAttribute('aria-keyshortcuts')).toBe('F2')

    await user.click(button)

    await waitFor(() => expect(discordSpies.openExternalLink).toHaveBeenCalledWith({ url: STEAM_LINK }))
    expect(onSaveSteamLink).not.toHaveBeenCalled()
  })

  test('opens the editor on a normal click when an editable link is unset', () => {
    render(() => <SteamLobbyButton steamLobbyLink={null} onSaveSteamLink={onSaveSteamLink} />)

    const button = screen.getByRole('button', { name: 'Set Steam lobby link' })
    expect(button.getAttribute('title')).toBe('Set Steam lobby link; click or press F2 to edit')
    fireEvent.click(button)

    expect(screen.queryByText('No Steam link set')).toBeNull()
    expect(discordSpies.openExternalLink).not.toHaveBeenCalled()
    expect(clipboardSpies.copyTextToClipboard).not.toHaveBeenCalled()

    fireEvent.click(button)
    expect(onSaveSteamLink).toHaveBeenCalledWith(null)
  })

  test('does not try to open or copy when the steam link is missing', () => {
    render(() => <SteamLobbyButton steamLobbyLink={null} />)

    const button = screen.getByRole('button', { name: 'No Steam link set' })
    fireEvent.click(button)
    fireEvent.contextMenu(button)

    expect(discordSpies.openExternalLink).not.toHaveBeenCalled()
    expect(clipboardSpies.copyTextToClipboard).not.toHaveBeenCalled()
  })

  test('opens a read-only set link on primary click and copies it on context menu', async () => {
    const user = userEvent.setup()

    render(() => <SteamLobbyButton steamLobbyLink={STEAM_LINK} />)

    const button = screen.getByRole('button', { name: 'Open Steam link' })
    await user.click(button)
    fireEvent.contextMenu(button)

    await waitFor(() => expect(discordSpies.openExternalLink).toHaveBeenCalledWith({ url: STEAM_LINK }))
    await waitFor(() => expect(clipboardSpies.copyTextToClipboard).toHaveBeenCalledWith(STEAM_LINK))
  })

  test('opens instead of copying on a quick touch tap', async () => {
    uiMockState.isMobileLayout = true

    render(() => <SteamLobbyButton steamLobbyLink={STEAM_LINK} onSaveSteamLink={onSaveSteamLink} />)

    const button = screen.getByRole('button', { name: 'Open Steam link' })
    const releasePointerCapture = installPointerCapture(button)
    dispatchPrimaryPointer(button, 'pointerDown', 'touch')
    dispatchPrimaryPointer(button, 'pointerUp', 'touch')
    fireEvent.click(button)

    await waitFor(() => expect(discordSpies.openExternalLink).toHaveBeenCalledWith({ url: STEAM_LINK }))
    expect(clipboardSpies.copyTextToClipboard).not.toHaveBeenCalled()
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
  })

  test('always copies an editable set link on context menu', async () => {
    render(() => <SteamLobbyButton steamLobbyLink={STEAM_LINK} onSaveSteamLink={onSaveSteamLink} />)

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Steam link' }))

    await waitFor(() => expect(clipboardSpies.copyTextToClipboard).toHaveBeenCalledWith(STEAM_LINK))
    expect(discordSpies.openExternalLink).not.toHaveBeenCalled()
  })

  test.each(['mouse', 'touch'])('opens the editor on a %s hold and suppresses its click and context menu', async (pointerType) => {
    render(() => <SteamLobbyButton steamLobbyLink={STEAM_LINK} onSaveSteamLink={onSaveSteamLink} />)

    const button = screen.getByRole('button', { name: 'Open Steam link' })
    installPointerCapture(button)
    dispatchPrimaryPointer(button, 'pointerDown', pointerType)
    await Bun.sleep(HOLD_WAIT_MS)

    dispatchPrimaryPointer(button, 'pointerUp', pointerType)
    fireEvent.click(button)
    fireEvent.contextMenu(button)

    expect(discordSpies.openExternalLink).not.toHaveBeenCalled()
    expect(clipboardSpies.copyTextToClipboard).not.toHaveBeenCalled()

    if (pointerType === 'mouse') {
      fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'mouse', button: 2, buttons: 2, isPrimary: true })
      fireEvent.contextMenu(button)
      await waitFor(() => expect(clipboardSpies.copyTextToClipboard).toHaveBeenCalledWith(STEAM_LINK))
    }

    fireEvent.click(button)
    expect(onSaveSteamLink).toHaveBeenCalledWith(STEAM_LINK)
  })

  test('opens the existing editor with F2 while the button is focused', () => {
    render(() => <SteamLobbyButton steamLobbyLink={STEAM_LINK} onSaveSteamLink={onSaveSteamLink} />)

    const button = screen.getByRole('button', { name: 'Open Steam link' })
    button.focus()
    fireEvent.keyDown(button, { key: 'F2' })
    fireEvent.click(button)

    expect(onSaveSteamLink).toHaveBeenCalledWith(STEAM_LINK)
    expect(discordSpies.openExternalLink).not.toHaveBeenCalled()
  })

  test('keeps Enter and Space as normal open actions', async () => {
    const user = userEvent.setup()
    render(() => <SteamLobbyButton steamLobbyLink={STEAM_LINK} onSaveSteamLink={onSaveSteamLink} />)

    const button = screen.getByRole('button', { name: 'Open Steam link' })
    button.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')

    await waitFor(() => expect(discordSpies.openExternalLink).toHaveBeenCalledTimes(2))
    expect(onSaveSteamLink).not.toHaveBeenCalled()
  })

  test('cancels a pending hold safely on pointer cancellation', async () => {
    render(() => <SteamLobbyButton steamLobbyLink={STEAM_LINK} onSaveSteamLink={onSaveSteamLink} />)

    const button = screen.getByRole('button', { name: 'Open Steam link' })
    const releasePointerCapture = installPointerCapture(button)
    dispatchPrimaryPointer(button, 'pointerDown', 'pen')
    dispatchPrimaryPointer(button, 'pointerCancel', 'pen')
    await Bun.sleep(HOLD_WAIT_MS)
    fireEvent.click(button)

    await waitFor(() => expect(discordSpies.openExternalLink).toHaveBeenCalledWith({ url: STEAM_LINK }))
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
  })

  test('falls back to copying when link opening does not open', async () => {
    const user = userEvent.setup()
    discordSpies.openExternalLink.mockResolvedValueOnce({ opened: false })

    render(() => <SteamLobbyButton steamLobbyLink={STEAM_LINK} onSaveSteamLink={onSaveSteamLink} />)

    await user.click(screen.getByRole('button', { name: 'Open Steam link' }))

    await waitFor(() => expect(discordSpies.openExternalLink).toHaveBeenCalledWith({ url: STEAM_LINK }))
    await waitFor(() => expect(clipboardSpies.copyTextToClipboard).toHaveBeenCalledWith(STEAM_LINK))
  })
})
