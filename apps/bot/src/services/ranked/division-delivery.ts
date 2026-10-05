import type { DbBatchItem } from '../db/batch.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

const delivery = new AsyncLocalStorage<{
  namespace: DurableObjectNamespace
  waitUntil: (task: Promise<unknown>) => void
}>()
const changedQueries = new WeakMap<object, string>()

export function withDivisionDelivery<T>(
  namespace: DurableObjectNamespace | undefined,
  ctx: { waitUntil(task: Promise<unknown>): void },
  task: () => T,
): T {
  if (!namespace) return task()
  return delivery.run({ namespace, waitUntil: task => ctx.waitUntil(task) }, task)
}
export function markDivisionDelivery(query: DbBatchItem, guildId: string): DbBatchItem {
  changedQueries.set(query, guildId)
  return query
}
export function notifyDivisionDelivery(queries: DbBatchItem[]): void {
  const context = delivery.getStore()
  if (!context) return
  const guilds = [...new Set(queries.flatMap(query => changedQueries.get(query) ?? []))]
  for (const guildId of guilds)
    context.waitUntil(
      wakeDivisionDelivery(context.namespace, guildId).catch(error => {
        console.error('Division delivery wake failed; durable pending work remains queued.', { guildId }, error)
      }),
    )
}
export async function wakeDivisionDelivery(namespace: DurableObjectNamespace, guildId: string): Promise<void> {
  const response = await namespace.get(namespace.idFromName('global')).fetch(
    new Request('https://maintenance.local/ranked-roles/wake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guildId }),
    }),
  )
  if (!response.ok) throw new Error(`Division delivery wake failed (${response.status}).`)
}
