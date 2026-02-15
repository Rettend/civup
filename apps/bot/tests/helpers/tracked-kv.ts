interface KvOperation {
  type: 'put' | 'delete'
  key: string
}

interface TrackedKv {
  kv: KVNamespace
  operations: KvOperation[]
  resetOperations: () => void
}

export function createTrackedKv(): TrackedKv {
  const store = new Map<string, string>()
  const operations: KvOperation[] = []

  const kv = {
    async get(key: string, type?: string) {
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
      operations.push({ type: 'put', key })
    },
    async delete(key: string) {
      store.delete(key)
      operations.push({ type: 'delete', key })
    },
  }

  return {
    kv: kv as unknown as KVNamespace,
    operations,
    resetOperations() {
      operations.length = 0
    },
  }
}
