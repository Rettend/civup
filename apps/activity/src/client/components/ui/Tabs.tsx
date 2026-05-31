import type { Accessor } from 'solid-js'
import { createMemo, For, splitProps } from 'solid-js'
import { cn } from '~/client/lib/css'

type MaybeAccessor<T> = T | Accessor<T>

interface TabOption<T extends string = string> {
  value: T
  label: string
  ariaLabel?: string
}

interface TabsProps<T extends string = string> {
  options: TabOption<T>[]
  value?: MaybeAccessor<T>
  disabled?: MaybeAccessor<boolean>
  onChange?: (value: T) => void
  class?: string
}

export function Tabs<T extends string = string>(props: TabsProps<T>) {
  const [local] = splitProps(props, ['options', 'value', 'disabled', 'onChange', 'class'])
  const resolve = <V,>(v: MaybeAccessor<V> | undefined) => typeof v === 'function' ? (v as Accessor<V>)() : v
  const value = createMemo(() => resolve(local.value))
  const disabled = createMemo(() => resolve(local.disabled) ?? false)

  return (
    <div
      class={cn(
        'rounded-md border border-border-subtle bg-bg/50 p-0.5 flex items-center',
        local.class,
      )}
    >
      <For each={local.options}>
        {option => {
          const active = () => value() === option.value
          return (
            <button
              type="button"
              class={cn(
                'flex-1 px-2.5 py-1 rounded-[5px] text-[10px] font-bold tracking-wide transition-all duration-200 cursor-pointer',
                'disabled:cursor-not-allowed disabled:opacity-60',
                active()
                  ? 'bg-accent/20 text-accent border border-accent/30 shadow-[0_0_8px_var(--accent-subtle)]'
                  : 'text-fg-muted border border-transparent hover:text-fg hover:bg-white/4',
              )}
              disabled={disabled()}
              aria-pressed={active()}
              aria-label={option.ariaLabel ?? option.label}
              onClick={() => local.onChange?.(option.value)}
            >
              {option.label}
            </button>
          )
        }}
      </For>
    </div>
  )
}
