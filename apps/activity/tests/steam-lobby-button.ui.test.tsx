/** @jsxImportSource solid-js */

import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { clipboardSpies, discordSpies, resetUiMocks, uiMockState } from './ui-mocks'

const onSaveSteamLink = mock(() => {})

const { SteamLobbyButton } = await import('../src/client/components/draft/SteamLobbyButton')

describe('SteamLobbyButton UI', () => {
  beforeEach(() => {
    resetUiMocks()
    onSaveSteamLink.mockClear()
  })

  test('shows the editable affordance when a steam link can be managed', () => {
    render(() => (
      <SteamLobbyButton
        steamLobbyLink="steam://joinlobby/289070/example"
        onSaveSteamLink={onSaveSteamLink}
      />
    ))

    const button = screen.getByRole('button', { name: 'Edit Steam lobby link' })
    expect(button.getAttribute('title')).toBe('Edit Steam lobby link')
  })

  test('shows copy-first ghost affordances when no steam link exists on mobile', () => {
    uiMockState.isMobileLayout = true
    render(() => <SteamLobbyButton steamLobbyLink={null} />)

    const button = screen.getByRole('button', { name: 'No Steam link set' })
    expect(button.getAttribute('title')).toBe('No Steam link set')
  })

  test('uses the setter affordance instead of missing-link copy affordances when no steam link is set but save is allowed', () => {
    render(() => <SteamLobbyButton steamLobbyLink={null} onSaveSteamLink={onSaveSteamLink} />)

    const button = screen.getByRole('button', { name: 'Set Steam lobby link' })
    expect(button.getAttribute('title')).toBe('Set Steam lobby link')
    fireEvent.click(button)

    expect(screen.queryByText('No Steam link set')).toBeNull()
    expect(discordSpies.openExternalLink).not.toHaveBeenCalled()
    expect(clipboardSpies.copyTextToClipboard).not.toHaveBeenCalled()
  })

  test('does not try to open or copy when the steam link is missing', () => {
    render(() => <SteamLobbyButton steamLobbyLink={null} />)

    const button = screen.getByRole('button', { name: 'No Steam link set' })
    fireEvent.click(button)
    fireEvent.contextMenu(button)

    expect(discordSpies.openExternalLink).not.toHaveBeenCalled()
    expect(clipboardSpies.copyTextToClipboard).not.toHaveBeenCalled()
  })

  test('opens the steam link on primary click and copies it on context menu', async () => {
    const user = userEvent.setup()
    const link = 'steam://joinlobby/289070/example'

    render(() => <SteamLobbyButton steamLobbyLink={link} />)

    const button = screen.getByRole('button', { name: 'Open Steam link' })
    await user.click(button)
    fireEvent.contextMenu(button)

    await waitFor(() => expect(discordSpies.openExternalLink).toHaveBeenCalledWith({ url: link }))
    await waitFor(() => expect(clipboardSpies.copyTextToClipboard).toHaveBeenCalledWith(link))
  })

  test('copies first on mobile when a steam link exists', async () => {
    const user = userEvent.setup()
    const link = 'steam://joinlobby/289070/example'
    uiMockState.isMobileLayout = true

    render(() => <SteamLobbyButton steamLobbyLink={link} />)

    const button = screen.getByRole('button', { name: 'Copy Steam link' })
    expect(button.getAttribute('title')).toBe('Copy Steam link')

    await user.click(button)

    await waitFor(() => expect(clipboardSpies.copyTextToClipboard).toHaveBeenCalledWith(link))
    expect(discordSpies.openExternalLink).not.toHaveBeenCalled()
  })

  test('falls back to copying when desktop link opening does not open', async () => {
    const user = userEvent.setup()
    const link = 'steam://joinlobby/289070/example'
    discordSpies.openExternalLink.mockResolvedValueOnce({ opened: false })

    render(() => <SteamLobbyButton steamLobbyLink={link} />)

    await user.click(screen.getByRole('button', { name: 'Open Steam link' }))

    await waitFor(() => expect(discordSpies.openExternalLink).toHaveBeenCalledWith({ url: link }))
    await waitFor(() => expect(clipboardSpies.copyTextToClipboard).toHaveBeenCalledWith(link))
  })
})
