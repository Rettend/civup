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
<<<<<<< New base: feat: auto shuffle
<<<<<<< New base: feat: save file analyzer
||||||| Common ancestor
=======
    ALLOWED_DISCORD_GUILD_IDS?: string
>>>>>>> Current commit: feat: add multi-server foundations
    ACTIVITY_PUBLIC_ORIGIN?: string
<<<<<<< New base: fix: mod resolve
||||||| Common ancestor
    BOT_HOST?: string
=======
    ACTIVITY_PUBLIC_ORIGIN?: string
    BOT_HOST?: string
>>>>>>> Current commit: feat: external browser draft WIP
||||||| Common ancestor
    BOT_HOST?: string
=======
>>>>>>> Current commit: chore: cleanup and simplify setup
    ENABLE_DEBUG_LOBBY_FILL?: string
    CIVUP_SECRET?: string
<<<<<<< New base: fix: mod resolve
<<<<<<< New base: chore: update leader desc
    CIVUP_INTERACTION_ENDPOINT_URL?: string
||||||| Common ancestor
=======
||||||| Common ancestor
=======
    CIVUP_INTERACTION_ENDPOINT_URL?: string
<<<<<<< New base: chore: cleanup and simplify setup
>>>>>>> Current commit: chore: cleanup and simplify setup
    AUTOSAVE_ADMIN_USER_IDS?: string
<<<<<<< New base: fix: mod resolve
<<<<<<< New base: fix: sonner design
>>>>>>> Current commit: feat: catalog
||||||| Common ancestor
=======
    AUTOSAVE_UPLOAD_BUCKET?: string
    R2_ACCOUNT_ID?: string
    R2_UPLOAD_ACCESS_KEY_ID?: string
    R2_UPLOAD_SECRET_ACCESS_KEY?: string
>>>>>>> Current commit: fix: multiple r2
||||||| Common ancestor
    AUTOSAVE_UPLOAD_BUCKET?: string
    R2_ACCOUNT_ID?: string
    R2_UPLOAD_ACCESS_KEY_ID?: string
    R2_UPLOAD_SECRET_ACCESS_KEY?: string
=======
>>>>>>> Current commit: chore: cleanup and simplify setup
||||||| Common ancestor
    AUTOSAVE_ADMIN_USER_IDS?: string
=======
>>>>>>> Current commit: fix: refresh ranked role colors
  }
}
