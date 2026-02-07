export interface Env {
  Bindings: {
    DB: D1Database
    KV: KVNamespace
    DISCORD_APPLICATION_ID: string
    DISCORD_PUBLIC_KEY: string
    DISCORD_TOKEN: string
  }
}
