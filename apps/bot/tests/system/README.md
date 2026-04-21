# System scenario tests

`createSystemWorld()` runs the bot routes in-process against the real sqlite-backed test DB, tracked KV, captured `waitUntil()` tasks, fake Discord HTTP, and a fake Party room boundary that still delivers signed webhook requests through the real bot webhook route.

Use it for end-to-end lobby/draft/match scenarios without booting Wrangler or a real Party server.

The suite intentionally focuses on shared cross-boundary lifecycle paths: open-lobby launch targeting, start handoff into live match selection, webhook-driven state changes, reporting idempotency, and cleanup/recovery behavior.

Recent coverage especially leans on projection-recovery scenarios where stale or missing KV indexes must be repaired from canonical lobby or match state, with channel-index recovery focused on suspicious empty-index cases rather than every read path.
