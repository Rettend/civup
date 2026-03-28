import type { JSX } from 'solid-js'
import { createSignal, onCleanup, Show } from 'solid-js'
import { discordSdk } from '~/client/discord'
import { copyTextToClipboard } from '~/client/lib/clipboard'
import { cn } from '~/client/lib/css'
import { isMobileLayout } from '~/client/stores'

const COPY_ICON_TIMEOUT_MS = 1200
const BLUR_CLOSE_DELAY_MS = 150

interface SteamLobbyButtonProps {
  /** Current steam lobby link, or null if not set. */
  steamLobbyLink: string | null
  /** Whether the current user is the lobby host. */
  isHost?: boolean
  /** Callback to save a new steam link. When provided, the host can edit the link via dropdown. */
  onSaveSteamLink?: (link: string | null) => void
  /** Whether a save is currently in progress. */
  savePending?: boolean
  class?: string
}

export function SteamLobbyButton(props: SteamLobbyButtonProps) {
  const [copied, setCopied] = createSignal(false)
  const [dropdownOpen, setDropdownOpen] = createSignal(false)
  const [inputValue, setInputValue] = createSignal('')
  const [missingLinkHintVisible, setMissingLinkHintVisible] = createSignal(false)
  let copiedTimeout: ReturnType<typeof setTimeout> | null = null
  let blurCloseTimeout: ReturnType<typeof setTimeout> | null = null
  let missingLinkHintTimeout: ReturnType<typeof setTimeout> | null = null
  let inputRef: HTMLInputElement | undefined

  const isHost = () => props.isHost === true
  const canSave = () => Boolean(props.onSaveSteamLink)
  const isEditableHost = () => isHost() && canSave()
  const isGhost = () => !props.steamLobbyLink

  // ── Copy / flash logic (non-host) ────────────

  const clearCopiedTimeout = () => {
    if (!copiedTimeout) return
    clearTimeout(copiedTimeout)
    copiedTimeout = null
  }

  const flashCopied = () => {
    clearCopiedTimeout()
    setCopied(true)
    copiedTimeout = setTimeout(() => {
      setCopied(false)
      copiedTimeout = null
    }, COPY_ICON_TIMEOUT_MS)
  }

  const clearMissingLinkHintTimeout = () => {
    if (!missingLinkHintTimeout) return
    clearTimeout(missingLinkHintTimeout)
    missingLinkHintTimeout = null
  }

  const flashMissingLinkHint = () => {
    clearMissingLinkHintTimeout()
    setMissingLinkHintVisible(true)
    missingLinkHintTimeout = setTimeout(() => {
      setMissingLinkHintVisible(false)
      missingLinkHintTimeout = null
    }, 4000)
  }

  const shouldCopyOnPrimaryAction = () => {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true
    return isMobileLayout()
  }

  const copyLink = async () => {
    const link = props.steamLobbyLink
    if (!link) return
    if (await copyTextToClipboard(link)) flashCopied()
  }

  const openLink = async () => {
    const link = props.steamLobbyLink
    if (!link) return

    try {
      const response = await discordSdk.commands.openExternalLink({ url: link })
      if (response?.opened === true) return
    }
    catch {}

    await copyLink()
  }

  // ── Dropdown logic (host) ────────────────────

  const clearBlurTimeout = () => {
    if (!blurCloseTimeout) return
    clearTimeout(blurCloseTimeout)
    blurCloseTimeout = null
  }

  const openDropdown = () => {
    setInputValue(props.steamLobbyLink ?? '')
    setDropdownOpen(true)
    queueMicrotask(() => inputRef?.focus())
  }

  const saveAndClose = () => {
    clearBlurTimeout()
    if (!dropdownOpen()) return
    if (canSave()) {
      const trimmed = inputValue().trim()
      const link = trimmed.length > 0 ? trimmed : null
      props.onSaveSteamLink?.(link)
    }
    setDropdownOpen(false)
  }

  const discardAndClose = () => {
    clearBlurTimeout()
    setDropdownOpen(false)
  }

  // ── Event handlers ───────────────────────────

  const handleButtonClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = () => {
    if (!isEditableHost()) {
      if (!props.steamLobbyLink) {
        flashMissingLinkHint()
        return
      }
      if (shouldCopyOnPrimaryAction()) void copyLink()
      else void openLink()
      return
    }

    // Host: toggle dropdown
    if (blurCloseTimeout) {
      // Blur just fired from clicking the button → save and close
      clearBlurTimeout()
      saveAndClose()
      return
    }

    if (dropdownOpen()) saveAndClose()
    else openDropdown()
  }

  const handleContextMenu: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    if (isEditableHost()) return
    event.preventDefault()
    if (!props.steamLobbyLink) {
      flashMissingLinkHint()
      return
    }
    void copyLink()
  }

  const handleInputBlur = () => {
    if (!dropdownOpen()) return
    blurCloseTimeout = setTimeout(() => {
      blurCloseTimeout = null
      saveAndClose()
    }, BLUR_CLOSE_DELAY_MS)
  }

  const handleInputKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      saveAndClose()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      discardAndClose()
    }
  }

  const buttonTitle = () => {
    if (isEditableHost()) return props.steamLobbyLink ? 'Edit Steam lobby link' : 'Set Steam lobby link'
    if (!props.steamLobbyLink) return 'No Steam link set'
    return shouldCopyOnPrimaryAction() ? 'Copy Steam link' : 'Open Steam link, or right-click to copy'
  }

  const buttonAriaLabel = () => {
    if (isEditableHost()) return props.steamLobbyLink ? 'Edit Steam lobby link' : 'Set Steam lobby link'
    if (!props.steamLobbyLink) return 'No Steam link set'
    return shouldCopyOnPrimaryAction() ? 'Copy Steam link' : 'Open Steam link'
  }

  onCleanup(() => {
    clearCopiedTimeout()
    clearBlurTimeout()
    clearMissingLinkHintTimeout()
  })

  return (
    <div class={cn('relative', props.class)}>
      <button
        type="button"
        class={cn(
          'h-full w-full rounded-md flex shrink-0 cursor-pointer items-center justify-center transition-[filter,background-color,color,opacity] duration-200',
          isGhost()
            ? 'bg-transparent text-fg-muted border border-border hover:bg-bg-muted hover:text-fg'
            : 'bg-accent text-bg hover:brightness-110',
          props.savePending && 'opacity-60 cursor-default',
        )}
        title={buttonTitle()}
        aria-label={buttonAriaLabel()}
        disabled={props.savePending}
        onClick={handleButtonClick}
        onContextMenu={handleContextMenu}
      >
        <div class="h-[18px] w-[18px] relative">
          <span
            class={cn(
              'i-ph:steam-logo-fill text-[18px] inset-0 absolute flex items-center justify-center transform-gpu transition-[transform,opacity] duration-150',
              copied() ? 'scale-0 opacity-0' : 'scale-100 opacity-100',
            )}
          />
          <span
            class={cn(
              'i-ph-check-bold text-[18px] inset-0 absolute flex items-center justify-center transform-gpu transition-[transform,opacity] duration-150',
              copied() ? 'scale-100 opacity-100' : 'scale-0 opacity-0',
            )}
          />
        </div>
      </button>

      <Show when={missingLinkHintVisible()}>
        <div class="pointer-events-none absolute left-0 top-full z-[100] mt-2 whitespace-nowrap rounded-full border border-border bg-bg-subtle/80 px-3 py-1 text-xs text-fg-muted shadow-lg backdrop-blur-sm">
          No Steam link set
        </div>
      </Show>

      {/* Host dropdown with steam link input */}
      <Show when={dropdownOpen()}>
        <div class="mt-1.5 left-0 top-full absolute z-[100]">
          <div class="p-2 border border-border rounded-lg bg-bg-subtle shadow-black/25 shadow-xl">
            <input
              ref={inputRef}
              type="text"
              value={inputValue()}
              placeholder="steam://joinlobby/289070/..."
              readOnly={!canSave()}
              disabled={props.savePending}
              class={cn(
                'w-64 text-sm text-fg px-3 py-2 rounded-md',
                'bg-bg/60 border border-border-subtle',
                'outline-none transition-colors duration-150',
                'placeholder:text-fg-subtle/60',
                'focus:border-accent/50 focus:bg-bg/80',
                'disabled:opacity-50 disabled:cursor-default',
              )}
              onInput={e => setInputValue(e.currentTarget.value)}
              onBlur={handleInputBlur}
              onKeyDown={handleInputKeyDown}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}
