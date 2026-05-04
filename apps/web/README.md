# Web PWA

This app will be the main Simple Schedule client for both iPhone and Windows.

Target behavior:

- Installable from Safari on iPhone
- Installable from Edge/Chrome on Windows
- Offline-capable
- IndexedDB local cache
- Cloud sync through `apps/api`
- Shared task rules from `packages/core`

## Local Setup

1. Copy `.env.example` to `.env.local`.
2. Confirm the Supabase URL and anon key.
3. Run the SQL in `../../supabase/schema.sql` in Supabase.
4. Install dependencies from the repository root.
5. Run `npm run dev:web`.
