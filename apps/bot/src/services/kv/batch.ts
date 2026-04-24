export interface KvBatchGetEntry {
  key: string
  type?: 'json'
}

export interface KvBatchPutEntry {
  key: string
  value: string
  expirationTtl?: number
}

export interface KvStoreEnv {
  KV: KVNamespace
}

export function getKvStore(env: KvStoreEnv): KVNamespace {
  return env.KV
}

export async function kvMget(kv: KVNamespace, entries: KvBatchGetEntry[]): Promise<unknown[]> {
  if (entries.length === 0) return []
  return Promise.all(entries.map(entry => kv.get(entry.key, entry.type as any)))
}

export async function kvMput(kv: KVNamespace, entries: KvBatchPutEntry[]): Promise<void> {
  if (entries.length === 0) return
  await Promise.all(entries.map(entry => kv.put(entry.key, entry.value, { expirationTtl: entry.expirationTtl } as any)))
}

export async function kvMdelete(kv: KVNamespace, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  await Promise.all(keys.map(key => kv.delete(key)))
}

export async function kvPutIfAbsent(
  kv: KVNamespace,
  key: string,
  value: string,
  options?: { expirationTtl?: number },
): Promise<boolean> {
  const existing = await kv.get(key)
  if (existing != null) return false
  await kv.put(key, value, options as any)
  return true
}
