export interface Env {
  Bindings: {
    DB: D1Database
    KV: KVNamespace
    AUTOSAVE_UPLOADS?: R2Bucket
    Activity?: DurableObjectNamespace
    MaintenanceDO?: DurableObjectNamespace
    SessionDO?: DurableObjectNamespace
    DISCORD_APPLICATION_ID: string
    DISCORD_PUBLIC_KEY: string
    DISCORD_TOKEN: string
    ALLOWED_DISCORD_GUILD_ID?: string
    ALLOWED_DISCORD_GUILD_IDS?: string
    ACTIVITY_PUBLIC_ORIGIN?: string
    ENABLE_DEBUG_LOBBY_FILL?: string
    CIVUP_SECRET?: string
    CIVUP_INTERACTION_ENDPOINT_URL?: string
  }
}
