import type { JSX } from 'solid-js'
import { createSignal, onCleanup, Show, splitProps } from 'solid-js'
import { discordSdk } from '~/client/discord'
import { copyTextToClipboard } from '~/client/lib/clipboard'
import { cn } from '~/client/lib/css'
import { isMobileLayout } from '~/client/stores'

const COPY_ICON_TIMEOUT_MS = 1200

interface SteamLobbyButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  steamLobbyLink: string | null
}

export function SteamLobbyButton(props: SteamLobbyButtonProps) {
  const [local, rest] = splitProps(props, ['steamLobbyLink', 'class', 'onClick', 'onContextMenu', 'title', 'aria-label'])
  const [copied, setCopied] = createSignal(false)
  let copiedTimeout: ReturnType<typeof setTimeout> | null = null

  const callHandler = (handler: unknown, event: Event) => {
    if (typeof handler !== 'function') return
    void (handler as (event: Event) => void)(event)
  }

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

  const shouldCopyOnPrimaryAction = () => {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) {
      return true
    }
    return isMobileLayout()
  }

  const copyLink = async () => {
    const link = local.steamLobbyLink
    if (!link) return
    if (await copyTextToClipboard(link)) flashCopied()
  }

  const openLink = async () => {
    const link = local.steamLobbyLink
    if (!link) return

    try {
      const response = await discordSdk.commands.openExternalLink({ url: link })
      if (response?.opened === true) return
    }
    catch {}

    await copyLink()
  }

  const handleClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    callHandler(local.onClick, event)
    if (event.defaultPrevented) return
    if (shouldCopyOnPrimaryAction()) {
      void copyLink()
      return
    }
    void openLink()
  }

  const handleContextMenu: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    callHandler(local.onContextMenu, event)
    if (event.defaultPrevented) return
    event.preventDefault()
    void copyLink()
  }

  onCleanup(() => {
    clearCopiedTimeout()
  })

  return (
    <Show when={local.steamLobbyLink}>
      <button
        type="button"
        class={cn(
          'rounded-md flex shrink-0 cursor-pointer items-center justify-center transition-[filter,background-color,color,opacity] duration-200',
          'bg-accent text-bg hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed',
          local.class,
        )}
        title={local.title ?? (shouldCopyOnPrimaryAction() ? 'Copy Steam link' : 'Open Steam link, or right-click to copy')}
        aria-label={local['aria-label'] ?? (shouldCopyOnPrimaryAction() ? 'Copy Steam link' : 'Open Steam link')}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        {...rest}
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
    </Show>
  )
}
