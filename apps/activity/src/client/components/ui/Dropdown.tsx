import type { JSX } from 'solid-js'
import { createSignal, For } from 'solid-js'
import { cn } from '~/client/lib/css'

interface DropdownOption {
  value: string
  label: string
  disabled?: boolean
  render?: () => JSX.Element
}

interface DropdownProps {
  label?: string
  ariaLabel?: string
  value?: string
  options: DropdownOption[]
  disabled?: boolean
  onChange?: (value: string) => void
  class?: string
}

export function Dropdown(props: DropdownProps) {
  const [open, setOpen] = createSignal(false)
  let containerRef: HTMLDivElement | undefined

  const selectedOption = () => props.options.find(o => o.value === props.value)

  const fallbackValue = () => props.value ?? ''

  const renderSelected = () => {
    const option = selectedOption()
    if (option?.render) return option.render()
    return option?.label ?? fallbackValue()
  }

  const handleSelect = (value: string) => {
    const option = props.options.find(candidate => candidate.value === value)
    if (props.disabled || option?.disabled) return
    setOpen(false)
    props.onChange?.(value)
  }

  const findEnabledIndex = (startIndex: number, step: -1 | 1) => {
    for (let index = startIndex; index >= 0 && index < props.options.length; index += step) {
      if (!props.options[index]?.disabled) return index
    }
    return -1
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
      const next = findEnabledIndex(Math.max(0, currentIndex + 1), 1)
      if (next < 0) return
      const option = props.options[next]
      if (option) handleSelect(option.value)
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = findEnabledIndex(currentIndex < 0 ? props.options.length - 1 : currentIndex - 1, -1)
      if (next < 0) return
      const option = props.options[next]
      if (option) handleSelect(option.value)
    }
  }

  return (
    <div class="flex flex-col gap-1.5">
      {props.label && (
        <label class="text-[11px] text-fg-subtle tracking-wider font-semibold pl-0.5 uppercase">
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
          aria-label={props.ariaLabel ?? props.label}
          disabled={props.disabled}
          onClick={() => { if (!props.disabled) setOpen(prev => !prev) }}
          class={cn(
            'w-full flex items-center justify-between gap-2',
            'text-sm text-fg px-3.5 py-2.5 rounded-lg',
            'bg-bg/60 border border-border-subtle',
            'outline-none transition-all duration-150 cursor-pointer',
            'hover:border-border hover:bg-bg/75',
            'focus:border-accent/50 focus:bg-bg/80 focus:shadow-[0_0_0_3px_var(--accent-subtle)]',
            'disabled:opacity-50 disabled:hover:border-border-subtle',
            open() && 'border-accent/50 bg-bg/80',
          )}
        >
          <span class="min-w-0 truncate">{renderSelected()}</span>
          <span
            class={cn(
              'i-ph-caret-down text-xs text-fg-subtle transition-transform duration-150',
              open() && 'rotate-180',
            )}
          />
        </button>

        {/* Dropdown menu */}
        <div
          hidden={!open()}
          class={cn(
            'absolute z-50 mt-1.5 w-full rounded-lg overflow-hidden',
            'bg-bg-subtle border border-border-subtle',
            'shadow-lg shadow-black/40',
            open() && 'anim-fade-in',
          )}
        >
          <For each={props.options}>
            {option => (
              <button
                type="button"
                aria-disabled={option.disabled ? 'true' : undefined}
                onClick={() => handleSelect(option.value)}
                class={cn(
                  'w-full text-left text-sm px-3.5 py-2.5 cursor-pointer',
                  'transition-colors duration-100',
                  option.disabled && 'cursor-default opacity-45',
                  option.value === props.value
                    ? 'bg-accent/12 text-accent font-medium'
                    : option.disabled
                      ? 'text-fg-subtle'
                      : 'text-fg-muted hover:bg-white/6 hover:text-fg',
                )}
              >
                {option.render ? option.render() : option.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
