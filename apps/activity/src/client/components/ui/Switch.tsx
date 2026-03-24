import { splitProps } from 'solid-js'
import { cn } from '~/client/lib/css'

interface SwitchProps {
  label?: string
  description?: string
  checked?: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
  class?: string
}

export function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, ['label', 'description', 'checked', 'disabled', 'onChange', 'class'])

  return (
    <button
      type="button"
      role="switch"
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
            ? 'bg-accent/25 border-accent/50 shadow-[0_0_8px_var(--accent-subtle),inset_0_1px_0_var(--accent-muted)]'
            : 'bg-bg-muted border-border-subtle group-hover:border-border',
        )}
      >
        {/* Thumb */}
        <div
          class={cn(
            'absolute top-1/2 -translate-y-1/2 size-3.5 rounded-full',
            'transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
            local.checked
              ? 'left-[calc(100%-18px)] bg-accent shadow-[0_0_6px_var(--accent-muted)]'
              : 'left-1 bg-fg-subtle group-hover:bg-fg-muted',
          )}
        />
      </div>
    </button>
  )
}
