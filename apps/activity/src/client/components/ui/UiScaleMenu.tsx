import { createSignal, onCleanup } from 'solid-js'
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
}

export function UiScaleMenu(props: UiScaleMenuProps) {
  let detailsRef: HTMLDetailsElement | undefined
  let panelRef: HTMLDivElement | undefined
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

  if (typeof document !== 'undefined') {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!detailsRef?.open || !target || detailsRef.contains(target as Node)) return
      detailsRef.open = false
      setPanelPosition(null)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    onCleanup(() => document.removeEventListener('pointerdown', handlePointerDown, true))
  }

  const handleToggle = () => {
    if (!detailsRef?.open) {
      setPanelPosition(null)
      return
    }

    const rect = panelRef?.getBoundingClientRect()
    if (!rect) return
    setPanelPosition({ left: rect.left, top: rect.top })
  }

  return (
    <details ref={detailsRef} class="relative group" onToggle={handleToggle}>
      <summary
        class={cn(
          'civup-icon-summary text-fg-muted border border-border rounded-md flex shrink-0 h-8 w-8 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted list-none group-open:text-fg group-open:bg-bg-muted group-open:border-border-hover',
          props.buttonClass,
        )}
        title={`UI Scale: ${scaleLabel()}`}
        aria-label="UI Scale"
      >
        <span class="i-ph-gear-six-bold text-sm" />
      </summary>

      <div
        ref={panelRef}
        class={cn(
          'civup-ui-scale-panel anim-fade-in text-fg p-3 border border-border-subtle rounded-lg bg-bg-subtle shadow-2xl shadow-black/40 w-60 z-50 backdrop-blur-sm',
          panelPosition() ? 'is-position-locked fixed' : 'right-0 top-full mt-2 absolute',
        )}
        style={panelStyle()}
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
    </details>
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
