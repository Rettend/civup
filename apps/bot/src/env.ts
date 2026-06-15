export interface Env {
  Bindings: {
    DB: D1Database
    KV: KVNamespace
    AUTOSAVE_UPLOADS?: R2Bucket
    Activity?: DurableObjectNamespace
    SessionDO?: DurableObjectNamespace
    DISCORD_APPLICATION_ID: string
    DISCORD_PUBLIC_KEY: string
    DISCORD_TOKEN: string
    ALLOWED_DISCORD_GUILD_ID?: string
    BOT_HOST?: string
    ENABLE_DEBUG_LOBBY_FILL?: string
    CIVUP_SECRET?: string
    AUTOSAVE_ADMIN_USER_IDS?: string
    AUTOSAVE_UPLOAD_BUCKET?: string
    R2_ACCOUNT_ID?: string
    R2_UPLOAD_ACCESS_KEY_ID?: string
    R2_UPLOAD_SECRET_ACCESS_KEY?: string
  }
}
