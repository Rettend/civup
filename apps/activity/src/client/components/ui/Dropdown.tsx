import type { JSX } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'

interface DropdownOption {
  value: string
  label: string
}

interface DropdownProps {
  label?: string
  value?: string
  options: DropdownOption[]
  disabled?: boolean
  onChange?: (value: string) => void
  class?: string
}

export function Dropdown(props: DropdownProps) {
  const [open, setOpen] = createSignal(false)
  let containerRef: HTMLDivElement | undefined

  const selectedLabel = () => {
    const option = props.options.find(o => o.value === props.value)
    return option?.label ?? props.value ?? ''
  }

  const handleSelect = (value: string) => {
    if (props.disabled) return
    setOpen(false)
    props.onChange?.(value)
  }

  const handleBlur = (event: FocusEvent) => {
    if (containerRef?.contains(event.relatedTarget as Node)) return
    setOpen(false)
  }

  const handleKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (props.disabled) return

    if (event.key === 'Escape') {
      setOpen(false)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(prev => !prev)
      return
    }

    if (!open()) return

    const currentIndex = props.options.findIndex(o => o.value === props.value)

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = Math.min(currentIndex + 1, props.options.length - 1)
      const option = props.options[next]
      if (option) handleSelect(option.value)
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(currentIndex - 1, 0)
      const option = props.options[next]
      if (option) handleSelect(option.value)
    }
  }

  return (
    <div class="flex flex-col gap-1.5">
      {props.label && (
        <label class="text-[11px] text-text-muted tracking-wider font-semibold pl-0.5 uppercase">
          {props.label}
        </label>
      )}
      <div
        ref={containerRef}
        class={cn('relative', props.class)}
        onFocusOut={handleBlur}
        onKeyDown={handleKeyDown}
      >
        {/* Trigger */}
        <button
          type="button"
          tabIndex={0}
          disabled={props.disabled}
          onClick={() => { if (!props.disabled) setOpen(prev => !prev) }}
          class={cn(
            'w-full flex items-center justify-between gap-2',
            'text-sm text-text-primary px-3.5 py-2.5 rounded-lg',
            'bg-bg-primary/60 border border-white/8',
            'outline-none transition-all duration-150 cursor-pointer',
            'hover:border-white/15 hover:bg-bg-primary/75',
            'focus:border-accent-gold/50 focus:bg-bg-primary/80 focus:shadow-[0_0_0_3px_rgba(200,170,110,0.08)]',
            'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-white/8',
            open() && 'border-accent-gold/50 bg-bg-primary/80',
          )}
        >
          <span class="truncate">{selectedLabel()}</span>
          <span
            class={cn(
              'i-ph-caret-down text-xs text-text-muted transition-transform duration-150',
              open() && 'rotate-180',
            )}
          />
        </button>

        {/* Dropdown menu */}
        <Show when={open()}>
          <div
            class={cn(
              'absolute z-50 mt-1.5 w-full rounded-lg overflow-hidden',
              'bg-bg-secondary border border-white/10',
              'shadow-lg shadow-black/40',
              'anim-fade-in',
            )}
          >
            <For each={props.options}>
              {option => (
                <button
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  class={cn(
                    'w-full text-left text-sm px-3.5 py-2.5 cursor-pointer',
                    'transition-colors duration-100',
                    option.value === props.value
                      ? 'bg-accent-gold/12 text-accent-gold font-medium'
                      : 'text-text-secondary hover:bg-white/6 hover:text-text-primary',
                  )}
                >
                  {option.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
