import type { Accessor } from 'solid-js'
import { createEffect, createMemo, createSignal } from 'solid-js'

type OptimisticStatus = 'idle' | 'pending' | 'error'

interface OptimisticCreateOptions<T> {
  equals?: (a: T, b: T) => boolean
}

interface OptimisticCommitOptions {
  syncTimeoutMs?: number
  syncTimeoutMessage?: string
}

export interface OptimisticState<T> {
  value: Accessor<T>
  pending: Accessor<T | null>
  status: Accessor<OptimisticStatus>
  error: Accessor<string | null>
  commit: (
    nextValue: T,
    persist: () => Promise<void>,
    options?: OptimisticCommitOptions,
  ) => Promise<boolean>
  clearError: () => void
}

/** Generic optimistic state synced against an authoritative source accessor. */
export function createOptimisticState<T>(
  source: Accessor<T>,
  options: OptimisticCreateOptions<T> = {},
): OptimisticState<T> {
  const equals = options.equals ?? Object.is

  const [pending, setPending] = createSignal<T | null>(null)
  const [status, setStatus] = createSignal<OptimisticStatus>('idle')
  const [error, setError] = createSignal<string | null>(null)
  let commitVersion = 0

  const value = createMemo(() => pending() ?? source())

  createEffect(() => {
    const pendingValue = pending()
    if (pendingValue == null) return
    if (!equals(source(), pendingValue)) return

    setPending(null)
    setStatus('idle')
    setError(null)
  })

  const clearError = () => {
    if (status() === 'error') setStatus('idle')
    setError(null)
  }

  const commit = async (
    nextValue: T,
    persist: () => Promise<void>,
    commitOptions: OptimisticCommitOptions = {},
  ): Promise<boolean> => {
    const thisCommit = ++commitVersion
    const timeoutMs = commitOptions.syncTimeoutMs ?? 9000

    setPending(() => nextValue)
    setStatus('pending')
    setError(null)

    try {
      await persist()
    }
    catch (persistError) {
      if (thisCommit !== commitVersion) return false
      setPending(null)
      setStatus('error')
      setError(formatCommitError(persistError))
      return false
    }

    if (thisCommit !== commitVersion) return false
    if (equals(source(), nextValue)) {
      setPending(null)
      setStatus('idle')
      setError(null)
      return true
    }

    setTimeout(() => {
      if (thisCommit !== commitVersion) return

      const pendingValue = pending()
      if (pendingValue == null) return
      if (!equals(pendingValue, nextValue)) return
      if (equals(source(), nextValue)) return

      setPending(null)
      setStatus('error')
      setError(commitOptions.syncTimeoutMessage ?? 'Save not confirmed. Please try again.')
    }, timeoutMs)

    return true
  }

  return {
    value,
    pending,
    status,
    error,
    commit,
    clearError,
  }
}

function formatCommitError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return 'Failed to save changes.'
}
