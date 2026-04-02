export interface Env {
  Bindings: {
    DB: D1Database
    KV: KVNamespace
    DISCORD_APPLICATION_ID: string
    DISCORD_PUBLIC_KEY: string
    DISCORD_TOKEN: string
    ALLOWED_DISCORD_GUILD_ID?: string
    PARTY_HOST?: string
    BOT_HOST?: string
    ENABLE_DEBUG_LOBBY_FILL?: string
    CIVUP_SECRET?: string
  }
}
