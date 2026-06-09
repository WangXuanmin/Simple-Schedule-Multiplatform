# Architecture

The current architecture uses a Windows PWA plus a native iOS client. Both
clients sync through the same Supabase Auth user and `public.tasks` table.

For the detailed product design, read:

- `docs/pwa-product-design.md`

For the technical architecture, read:

- `docs/pwa-architecture.md`

The short version:

```text
iOS SwiftUI app ----------\
                           -> Supabase Auth + Postgres public.tasks
Windows installed PWA -----/

apps/ios uses SwiftUI + SwiftData + Supabase REST.
apps/web uses React + IndexedDB + Supabase JS.
```

`apps/api` remains a reserved future sync service. The active implementations
sync directly to Supabase and use local-first writes with retry queues.
