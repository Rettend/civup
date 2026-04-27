type KvOperationType = 'get' | 'put' | 'delete' | 'list'

interface KvOperation {
  type: KvOperationType
  key: string
}

interface CreateTrackedKvOptions {
  trackReads?: boolean
}

interface TrackedKv {
  kv: KVNamespace
  operations: KvOperation[]
  resetOperations: () => void
  runWithoutTracking: <T>(callback: () => Promise<T> | T) => Promise<T>
}

export function createTrackedKv(options: CreateTrackedKvOptions = {}): TrackedKv {
  const { trackReads = false } = options
  const store = new Map<string, string>()
  const operations: KvOperation[] = []
  let trackingEnabled = true

  function track(type: KvOperationType, key: string): void {
    if (!trackingEnabled) return
    if (!trackReads && (type === 'get' || type === 'list')) return
    operations.push({ type, key })
  }

  const kv = {
    async get(key: string, type?: string) {
      track('get', key)
      const value = store.get(key)
      if (value == null) return null
      if (type === 'json') {
        try {
          return JSON.parse(value)
        }
        catch {
          return null
        }
      }
      return value
    },
    async put(key: string, value: string) {
      store.set(key, value)
      track('put', key)
    },
    async delete(key: string) {
      store.delete(key)
      track('delete', key)
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? ''
      track('list', prefix)
      const keys = [...store.keys()]
        .filter(key => key.startsWith(prefix))
        .map(name => ({ name }))

      return {
        keys,
        list_complete: true,
        cursor: '',
      }
    },
  }

  return {
    kv: kv as unknown as KVNamespace,
    operations,
    resetOperations() {
      operations.length = 0
    },
    async runWithoutTracking<T>(callback: () => Promise<T> | T): Promise<T> {
      const previous = trackingEnabled
      trackingEnabled = false
      try {
        return await callback()
      }
      finally {
        trackingEnabled = previous
      }
    },
  }
}
