export interface Env {
  Bindings: {
    DB: D1Database
    KV: KVNamespace
    DISCORD_APPLICATION_ID: string
    DISCORD_PUBLIC_KEY: string
    DISCORD_TOKEN: string
    PARTY_HOST?: string
    BOT_HOST?: string
    ENABLE_DEBUG_LOBBY_FILL?: string
    ENABLED_GAME_MODES?: string
    CIVUP_SECRET?: string
  }
}
