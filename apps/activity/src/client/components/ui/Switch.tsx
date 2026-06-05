import type { Accessor } from 'solid-js'
import { createMemo, splitProps } from 'solid-js'
import { cn } from '~/client/lib/css'

type MaybeAccessor<T> = T | Accessor<T>

interface SwitchProps {
  label?: string
  description?: string
  ariaLabel?: MaybeAccessor<string | undefined>
  checked?: MaybeAccessor<boolean | undefined>
  disabled?: MaybeAccessor<boolean | undefined>
  tone?: 'accent' | 'danger' | 'orange' | 'cyan' | 'note'
  inactiveTone?: 'purple'
  onChange?: (checked: boolean) => void
  class?: string
}

export function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, ['label', 'description', 'ariaLabel', 'checked', 'disabled', 'tone', 'inactiveTone', 'onChange', 'class'])
  const resolve = <T,>(value: MaybeAccessor<T> | undefined) => typeof value === 'function' ? (value as Accessor<T>)() : value
  const checked = createMemo(() => resolve(local.checked) ?? false)
  const disabled = createMemo(() => resolve(local.disabled) ?? false)
  const ariaLabel = createMemo(() => resolve(local.ariaLabel))

  const activeTrackClass = () => {
    if (local.tone === 'danger') {
      return 'bg-danger/20 border-danger/55 shadow-[0_0_8px_var(--danger-subtle),inset_0_1px_0_var(--danger-muted)]'
    }
    if (local.tone === 'orange') {
      return 'border-[#f97316]/60 bg-[#f97316]/18 shadow-[0_0_8px_rgba(249,115,22,0.24),inset_0_1px_0_rgba(251,146,60,0.28)]'
    }
    if (local.tone === 'cyan') {
      return 'border-cyan-300/60 bg-cyan-300/18 shadow-[0_0_8px_rgba(103,232,249,0.24),inset_0_1px_0_rgba(165,243,252,0.28)]'
    }
    if (local.tone === 'note') {
      return 'bg-note-muted border-note/60 shadow-[0_0_8px_var(--note-muted),inset_0_1px_0_var(--note-muted)]'
    }
    return 'bg-accent/25 border-accent/50 shadow-[0_0_8px_var(--accent-subtle),inset_0_1px_0_var(--accent-muted)]'
  }

  const inactiveTrackClass = () => {
    if (local.inactiveTone === 'purple') return 'bg-[#a78bfa]/18 border-[#a78bfa]/60 shadow-[0_0_8px_rgba(167,139,250,0.22),inset_0_1px_0_rgba(196,181,253,0.22)] group-hover:border-[#a78bfa]/75'
    return 'bg-bg-muted border-border-subtle group-hover:border-border'
  }

  const activeThumbClass = () => {
    if (local.tone === 'danger') return 'left-[calc(100%-18px)] bg-danger shadow-[0_0_6px_var(--danger-muted)]'
    if (local.tone === 'orange') return 'left-[calc(100%-18px)] bg-[#f97316] shadow-[0_0_6px_rgba(249,115,22,0.35)]'
    if (local.tone === 'cyan') return 'left-[calc(100%-18px)] bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,0.35)]'
    if (local.tone === 'note') return 'left-[calc(100%-18px)] bg-note shadow-[0_0_6px_var(--note-muted)]'
    return 'left-[calc(100%-18px)] bg-accent shadow-[0_0_6px_var(--accent-muted)]'
  }

  const inactiveThumbClass = () => {
    if (local.inactiveTone === 'purple') return 'left-1 bg-[#a78bfa] shadow-[0_0_6px_rgba(167,139,250,0.35)]'
    return 'left-1 bg-fg-subtle group-hover:bg-fg-muted'
  }

  return (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel()}
      aria-checked={checked()}
      disabled={disabled()}
      onClick={() => { if (!disabled()) local.onChange?.(!checked()) }}
      class={cn(
        'group flex items-center gap-3 w-full text-left',
        disabled() ? 'opacity-50 cursor-default' : 'cursor-pointer opacity-100',
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
          checked()
            ? activeTrackClass()
            : inactiveTrackClass(),
        )}
      >
        {/* Thumb */}
        <div
          class={cn(
            'absolute top-1/2 -translate-y-1/2 size-3.5 rounded-full',
            'transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
            checked()
              ? activeThumbClass()
              : inactiveThumbClass(),
          )}
        />
      </div>
    </button>
  )
}
