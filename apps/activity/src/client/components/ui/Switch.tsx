import { splitProps } from 'solid-js'
import { cn } from '~/client/lib/css'

interface SwitchProps {
  label?: string
  description?: string
  ariaLabel?: string
  checked?: boolean
  disabled?: boolean
  tone?: 'accent' | 'danger' | 'orange'
  onChange?: (checked: boolean) => void
  class?: string
}

export function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, ['label', 'description', 'ariaLabel', 'checked', 'disabled', 'tone', 'onChange', 'class'])

  const activeTrackClass = () => {
    if (local.tone === 'danger') {
      return 'bg-danger/20 border-danger/55 shadow-[0_0_8px_var(--danger-subtle),inset_0_1px_0_var(--danger-muted)]'
    }
    if (local.tone === 'orange') {
      return 'border-[#f97316]/60 bg-[#f97316]/18 shadow-[0_0_8px_rgba(249,115,22,0.24),inset_0_1px_0_rgba(251,146,60,0.28)]'
    }
    return 'bg-accent/25 border-accent/50 shadow-[0_0_8px_var(--accent-subtle),inset_0_1px_0_var(--accent-muted)]'
  }

  const activeThumbClass = () => {
    if (local.tone === 'danger') return 'left-[calc(100%-18px)] bg-danger shadow-[0_0_6px_var(--danger-muted)]'
    if (local.tone === 'orange') return 'left-[calc(100%-18px)] bg-[#f97316] shadow-[0_0_6px_rgba(249,115,22,0.35)]'
    return 'left-[calc(100%-18px)] bg-accent shadow-[0_0_6px_var(--accent-muted)]'
  }

  return (
    <button
      type="button"
      role="switch"
      aria-label={local.ariaLabel}
      aria-checked={local.checked ?? false}
      disabled={local.disabled}
      onClick={() => { if (!local.disabled) local.onChange?.(!local.checked) }}
      class={cn(
        'group flex items-center gap-3 w-full text-left cursor-pointer',
        'disabled:opacity-50',
        local.class,
      )}
      {...rest}
    >
      {(local.label || local.description) && (
        <div class="flex flex-1 flex-col gap-0.5 min-w-0">
          {local.label && (
            <span class="text-[11px] text-fg-subtle tracking-wider font-semibold uppercase">
              {local.label}
            </span>
          )}
          {local.description && (
            <span class="text-xs text-fg-subtle/80 leading-snug">
              {local.description}
            </span>
          )}
        </div>
      )}

      {/* Track */}
      <div
        class={cn(
          'relative flex-shrink-0 w-10 h-5.5 rounded-full',
          'transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]',
          'border',
          local.checked
            ? activeTrackClass()
            : 'bg-bg-muted border-border-subtle group-hover:border-border',
        )}
      >
        {/* Thumb */}
        <div
          class={cn(
            'absolute top-1/2 -translate-y-1/2 size-3.5 rounded-full',
            'transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
            local.checked
              ? activeThumbClass()
              : 'left-1 bg-fg-subtle group-hover:bg-fg-muted',
          )}
        />
      </div>
    </button>
  )
}
