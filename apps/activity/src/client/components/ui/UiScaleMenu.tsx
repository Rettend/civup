import { createSignal, onCleanup, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { cn } from '~/client/lib/css'
import {
  decreaseUiScale,
  increaseUiScale,
  resetUiScale,
  setUiScale,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
  uiScale,
} from '~/client/stores/ui-store'
import { Slider } from './Slider'

interface UiScaleMenuProps {
  buttonClass?: string
  iconClass?: string
  disabled?: boolean
}

const PANEL_WIDTH = 240
const PANEL_HEIGHT = 112
const PANEL_GAP = 8
const VIEWPORT_PADDING = 8

export function FloatingUiScaleMenu(props: { class?: string, disabled?: boolean }) {
  return (
    <div class={cn('fixed bottom-4 right-4 sm:bottom-5 sm:right-5', props.class ?? 'z-40')}>
      <UiScaleMenu
        buttonClass="border-border-subtle h-9 w-9 rounded-full"
        iconClass="h-4 w-4"
        disabled={props.disabled}
      />
    </div>
  )
}

export function UiScaleMenu(props: UiScaleMenuProps) {
  let buttonRef: HTMLButtonElement | undefined
  let panelRef: HTMLDivElement | undefined
  const [open, setOpen] = createSignal(false)
  const [panelPosition, setPanelPosition] = createSignal<{ left: number, top: number } | null>(null)
  const scaleLabel = () => `${uiScale()}%`
  const canDecrease = () => uiScale() > UI_SCALE_MIN
  const canIncrease = () => uiScale() < UI_SCALE_MAX
  const panelStyle = () => {
    const position = panelPosition()
    if (!position) return undefined
    return {
      left: `calc(${position.left}px / var(--civup-ui-scale))`,
      top: `calc(${position.top}px / var(--civup-ui-scale))`,
    }
  }

  const closeMenu = () => {
    setOpen(false)
    setPanelPosition(null)
  }

  const updatePanelPosition = () => {
    if (typeof window === 'undefined') return
    const rect = buttonRef?.getBoundingClientRect()
    if (!rect) return

    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - PANEL_WIDTH - VIEWPORT_PADDING)
    const left = Math.min(Math.max(VIEWPORT_PADDING, rect.right - PANEL_WIDTH), maxLeft)
    const belowTop = rect.bottom + PANEL_GAP
    const aboveTop = rect.top - PANEL_HEIGHT - PANEL_GAP
    const top = belowTop + PANEL_HEIGHT <= window.innerHeight - VIEWPORT_PADDING
      ? belowTop
      : Math.max(VIEWPORT_PADDING, aboveTop)
    setPanelPosition({ left, top })
  }

  const toggleMenu = () => {
    if (props.disabled) return
    if (open()) {
      closeMenu()
      return
    }

    updatePanelPosition()
    setOpen(true)
  }

  const handleButtonClick = (event: MouseEvent) => {
    event.preventDefault()
    toggleMenu()
  }

  if (typeof document !== 'undefined') {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!open() || !target) return
      const node = target as Node
      if (buttonRef?.contains(node) || panelRef?.contains(node)) return
      closeMenu()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !open()) return
      closeMenu()
    }

    const handleViewportChange = () => {
      if (open()) updatePanelPosition()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    onCleanup(() => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    })
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        class={cn(
          'text-fg-muted border border-border rounded-full flex shrink-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted',
          open() && 'text-fg bg-bg-muted border-border-hover',
          props.disabled && 'cursor-default opacity-55 hover:text-fg-muted hover:bg-transparent',
          props.buttonClass,
        )}
        title={`UI Scale: ${scaleLabel()}`}
        aria-label="UI Scale"
        aria-haspopup="dialog"
        aria-expanded={open()}
        disabled={props.disabled}
        on:click={handleButtonClick}
      >
        <span class={cn('i-ph-gear-six-bold', props.iconClass ?? 'h-4 w-4')} />
      </button>

      <Show when={open()}>
        <Portal>
          <div
            ref={panelRef}
            class="civup-ui-scale-panel is-position-locked anim-fade-in text-fg p-3 border border-border-subtle rounded-lg bg-bg-subtle shadow-2xl shadow-black/40 w-60 fixed z-[1000] backdrop-blur-sm"
            style={panelStyle()}
            role="dialog"
            aria-label="UI scale settings"
          >
            <div class="flex gap-3 items-center justify-between">
              <span class="text-[11px] text-fg-subtle tracking-widest font-bold uppercase">UI Scale</span>
              <div class="flex gap-2 items-center">
                <span class="font-mono text-sm text-accent font-bold tabular-nums">{scaleLabel()}</span>
                <IconButton
                  title={`Reset UI scale to ${UI_SCALE_DEFAULT}%`}
                  disabled={uiScale() === UI_SCALE_DEFAULT}
                  iconClass="i-ph-arrow-counter-clockwise-bold"
                  onClick={resetUiScale}
                />
              </div>
            </div>

            <div class="mt-3 flex gap-2 items-center">
              <IconButton
                title="Decrease UI scale"
                disabled={!canDecrease()}
                variant="ghost"
                iconClass="i-ph-minus-bold"
                onClick={decreaseUiScale}
              />
              <Slider
                ariaLabel="UI scale"
                min={UI_SCALE_MIN}
                max={UI_SCALE_MAX}
                step={UI_SCALE_STEP}
                value={uiScale()}
                onInput={value => setUiScale(value)}
              />
              <IconButton
                title="Increase UI scale"
                disabled={!canIncrease()}
                variant="ghost"
                iconClass="i-ph-plus-bold"
                onClick={increaseUiScale}
              />
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}

function IconButton(props: {
  title: string
  disabled?: boolean
  variant?: 'default' | 'ghost'
  iconClass: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class={cn(
        'text-fg-muted rounded-md flex h-8 w-8 shrink-0 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted disabled:opacity-45 disabled:pointer-events-none',
        props.variant !== 'ghost' && 'border border-border-subtle hover:border-border',
      )}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={() => { if (!props.disabled) props.onClick() }}
    >
      <span class={cn(props.iconClass, 'text-sm')} />
    </button>
  )
}
