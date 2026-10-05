import type { Accessor } from 'solid-js'
import { createEffect, createSignal, latest, onCleanup } from 'solid-js'

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
  let disposed = false
  let syncTimeout: ReturnType<typeof setTimeout> | null = null

  const clearSyncTimeout = () => {
    if (syncTimeout == null) return
    clearTimeout(syncTimeout)
    syncTimeout = null
  }

  // Primitive-owned cleanup also invalidates persist promises still in flight.
  onCleanup(() => {
    disposed = true
    commitVersion++
    clearSyncTimeout()
  })

  const value = () => pending() ?? source()

  createEffect(
    () => {
      const pendingValue = pending()
      return pendingValue != null && equals(source(), pendingValue)
    },
    synced => {
      if (!synced) return
      clearSyncTimeout()
      setPending(null)
      setStatus('idle')
      setError(null)
    },
  )

  const clearError = () => {
    setStatus(prev => prev === 'error' ? 'idle' : prev)
    setError(null)
  }

  const commit = async (
    nextValue: T,
    persist: () => Promise<void>,
    commitOptions: OptimisticCommitOptions = {},
  ): Promise<boolean> => {
    if (disposed) return false
    const thisCommit = ++commitVersion
    const timeoutMs = commitOptions.syncTimeoutMs ?? 9000
    clearSyncTimeout()

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
    if (latest(() => equals(source(), nextValue))) {
      setPending(null)
      setStatus('idle')
      setError(null)
      return true
    }

    syncTimeout = setTimeout(() => {
      syncTimeout = null
      if (thisCommit !== commitVersion) return

      const pendingValue = latest(pending)
      if (pendingValue == null) return
      if (!equals(pendingValue, nextValue)) return
      if (latest(() => equals(source(), nextValue))) return

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
