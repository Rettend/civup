import type { JSX } from 'solid-js'
import { createSignal, onCleanup, Show } from 'solid-js'
import { copyTextToClipboard } from '~/client/lib/clipboard'
import { cn } from '~/client/lib/css'
import { openExternalLink } from '~/client/platform/external-links'

const COPY_ICON_TIMEOUT_MS = 1200
const BLUR_CLOSE_DELAY_MS = 150
const HOLD_EDIT_DELAY_MS = 500
const HOLD_MOVE_TOLERANCE_PX = 10
const POINTER_FOLLOWUP_TIMEOUT_MS = 1000

interface HoldPointer {
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  element: HTMLButtonElement
  triggered: boolean
}

interface SteamLobbyButtonProps {
  /** Current steam lobby link, or null if not set. */
  steamLobbyLink: string | null
  /** Callback to save a new steam link. When provided, the user can edit the link via dropdown. */
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
  let holdEditTimeout: ReturnType<typeof setTimeout> | null = null
  let pointerFollowupTimeout: ReturnType<typeof setTimeout> | null = null
  let holdPointer: HoldPointer | null = null
  let suppressNextClick = false
  let suppressNextContextMenu = false
  let buttonRef: HTMLButtonElement | undefined
  let inputRef: HTMLInputElement | undefined

  const canSave = () => Boolean(props.onSaveSteamLink)
  const canEdit = canSave
  const isGhost = () => !props.steamLobbyLink

  // ── Copy / flash logic ────────────

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

  const copyLink = async () => {
    const link = props.steamLobbyLink
    if (!link) return
    if (await copyTextToClipboard(link)) flashCopied()
  }

  const openLink = async () => {
    const link = props.steamLobbyLink
    if (!link) return

    if (!await openExternalLink(link)) await copyLink()
  }

  // ── Dropdown logic ────────────────────

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

  const restoreButtonFocus = () => queueMicrotask(() => buttonRef?.focus())

  // ── Hold-to-edit logic ───────────────────────

  const clearHoldEditTimeout = () => {
    if (!holdEditTimeout) return
    clearTimeout(holdEditTimeout)
    holdEditTimeout = null
  }

  const clearPointerFollowupTimeout = () => {
    if (!pointerFollowupTimeout) return
    clearTimeout(pointerFollowupTimeout)
    pointerFollowupTimeout = null
  }

  const clearPointerFollowupSuppression = () => {
    clearPointerFollowupTimeout()
    suppressNextClick = false
    suppressNextContextMenu = false
  }

  const schedulePointerFollowupReset = () => {
    clearPointerFollowupTimeout()
    pointerFollowupTimeout = setTimeout(() => {
      pointerFollowupTimeout = null
      suppressNextClick = false
      suppressNextContextMenu = false
    }, POINTER_FOLLOWUP_TIMEOUT_MS)
  }

  const releaseHoldPointer = () => {
    const pointer = holdPointer
    holdPointer = null
    if (!pointer) return

    try {
      if (pointer.element.hasPointerCapture(pointer.pointerId)) pointer.element.releasePointerCapture(pointer.pointerId)
    }
    catch {
      // Capture may already be gone after cancellation or element removal.
    }
  }

  const stopHoldInteraction = () => {
    clearHoldEditTimeout()
    releaseHoldPointer()
  }

  const finishHoldInteraction = () => {
    const triggered = holdPointer?.triggered === true
    stopHoldInteraction()
    if (triggered) schedulePointerFollowupReset()
  }

  // ── Event handlers ───────────────────────────

  const handleButtonClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    if (suppressNextClick) {
      event.preventDefault()
      event.stopPropagation()
      suppressNextClick = false
      return
    }

    if (blurCloseTimeout) {
      // Blur just fired from clicking the button → save and close
      clearBlurTimeout()
      saveAndClose()
      return
    }

    if (dropdownOpen()) {
      saveAndClose()
      return
    }

    if (props.steamLobbyLink) {
      void openLink()
      return
    }

    if (canEdit()) openDropdown()
    else flashMissingLinkHint()
  }

  const handleContextMenu: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    event.preventDefault()

    if (suppressNextContextMenu || (holdPointer != null && holdPointer.pointerType !== 'mouse')) {
      event.stopPropagation()
      suppressNextContextMenu = false
      return
    }

    if (!props.steamLobbyLink) {
      if (!canEdit()) flashMissingLinkHint()
      return
    }
    void copyLink()
  }

  const handleButtonKeyDown: JSX.EventHandler<HTMLButtonElement, KeyboardEvent> = (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      suppressNextContextMenu = false
      return
    }
    if (event.key !== 'F2' || !canEdit()) return
    event.preventDefault()
    if (dropdownOpen()) inputRef?.focus()
    else openDropdown()
  }

  const handlePointerDown: JSX.EventHandler<HTMLButtonElement, PointerEvent> = (event) => {
    if (event.button === 2) {
      suppressNextContextMenu = false
      return
    }
    if (!event.isPrimary || event.button !== 0 || !canEdit() || !props.steamLobbyLink || dropdownOpen()) return

    stopHoldInteraction()
    holdPointer = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      element: event.currentTarget,
      triggered: false,
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    catch {
      holdPointer = null
      return
    }

    holdEditTimeout = setTimeout(() => {
      holdEditTimeout = null
      if (!holdPointer || !canEdit() || !props.steamLobbyLink || props.savePending) {
        releaseHoldPointer()
        return
      }

      holdPointer.triggered = true
      suppressNextClick = true
      suppressNextContextMenu = true
      openDropdown()
    }, HOLD_EDIT_DELAY_MS)
  }

  const handlePointerMove: JSX.EventHandler<HTMLButtonElement, PointerEvent> = (event) => {
    if (holdPointer?.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - holdPointer.startX, event.clientY - holdPointer.startY) <= HOLD_MOVE_TOLERANCE_PX) return
    finishHoldInteraction()
  }

  const handlePointerEnd: JSX.EventHandler<HTMLButtonElement, PointerEvent> = (event) => {
    if (holdPointer?.pointerId !== event.pointerId) return
    finishHoldInteraction()
  }

  const handleLostPointerCapture: JSX.EventHandler<HTMLButtonElement, PointerEvent> = (event) => {
    if (holdPointer?.pointerId !== event.pointerId) return
    const triggered = holdPointer.triggered
    holdPointer = null
    clearHoldEditTimeout()
    if (triggered) schedulePointerFollowupReset()
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
      restoreButtonFocus()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      discardAndClose()
      restoreButtonFocus()
    }
  }

  const buttonTitle = () => {
    if (props.steamLobbyLink && canEdit()) return 'Open Steam link; right-click to copy; hold or press F2 to edit'
    if (props.steamLobbyLink) return 'Open Steam link; right-click to copy'
    if (canEdit()) return 'Set Steam lobby link; click or press F2 to edit'
    return 'No Steam link set'
  }

  const buttonAriaLabel = () => {
    if (props.steamLobbyLink) return 'Open Steam link'
    if (canEdit()) return 'Set Steam lobby link'
    return 'No Steam link set'
  }

  const buttonAriaDescription = () => {
    if (props.steamLobbyLink && canEdit()) return 'Right-click to copy. Hold the primary pointer for half a second or press F2 to edit.'
    if (props.steamLobbyLink) return 'Right-click to copy.'
    if (canEdit()) return 'Click, press Enter or Space, or press F2 to set the link.'
    return undefined
  }

  onCleanup(() => {
    clearCopiedTimeout()
    clearBlurTimeout()
    clearMissingLinkHintTimeout()
    stopHoldInteraction()
    clearPointerFollowupSuppression()
  })

  return (
    <div class={cn('relative', props.class)}>
      <button
        ref={element => buttonRef = element}
        type="button"
        class={cn(
          'h-full w-full rounded-md flex shrink-0 cursor-pointer touch-manipulation select-none items-center justify-center transition-[filter,background-color,color,opacity] duration-200',
          isGhost()
            ? 'bg-transparent text-fg-muted border border-border hover:bg-bg-muted hover:text-fg'
            : 'bg-accent text-bg hover:brightness-110',
          props.savePending && 'opacity-60 cursor-default',
        )}
        title={buttonTitle()}
        aria-label={buttonAriaLabel()}
        aria-description={buttonAriaDescription()}
        aria-keyshortcuts={canEdit() ? 'F2' : undefined}
        aria-expanded={canEdit() ? dropdownOpen() : undefined}
        aria-haspopup={canEdit() ? 'dialog' : undefined}
        disabled={props.savePending}
        onClick={handleButtonClick}
        onContextMenu={handleContextMenu}
        onKeyDown={handleButtonKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handleLostPointerCapture}
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
        <div class="text-xs text-fg-muted mt-2 px-3 py-1 border border-border rounded-full bg-bg-subtle/80 pointer-events-none whitespace-nowrap shadow-lg left-0 top-full absolute z-[100] backdrop-blur-sm">
          No Steam link set
        </div>
      </Show>

      {/* Steam link editor */}
      <Show when={dropdownOpen()}>
        <div role="dialog" aria-label="Edit Steam lobby link" class="mt-1.5 left-0 top-full absolute z-[100]">
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
