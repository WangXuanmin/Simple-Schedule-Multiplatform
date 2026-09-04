# Implementation Status

Updated 2026-09-04. The additive database migration was deployed and tested. This main-branch change publishes Web through Pages after validation; see the commit's Actions run for deployment status. Windows binaries remain local. Prior-turn iOS source changes are retained locally and excluded from this publication at the user's request.

| Area | Implemented | Validation |
| --- | --- | --- |
| Windows native | SQLite atomic queue/ack/conflict resolution, additive old-store upgrade, versioned RPC | 11 SQLite/storage tests; typecheck/frontend and native release build passed; desktop interaction acceptance pending |
| Web/PWA | IndexedDB atomic queue/ack, versioned RPC, conflict choices, compatibility notice | Typecheck/build and 12 isolated Chromium checks passed |
| iOS native | Prior-turn local reliability source changes retained; legacy cloud writes | No new iOS work this round; Xcode/migration/device validation and versioned protocol integration deferred |
| Shared core | Account-aware merge, serial scheduler/retries, durable dependency-aware uploader | 13 tests passed |
| Supabase | Version trigger, write_task_v1, private receipts and capabilities deployed | Real SQL transactional suite and 9 real Auth/PostgREST scenarios passed; temporary test users cleaned up |
| Strict enforcement | Permission/soft-retention script prepared | Not activated; current capabilities strict=false; direct legacy writes remain permitted |
| CI | PR/main checks; Pages also requires tests/typechecks/builds | Local gate passed; GitHub results are attached to the published commit |

Native iOS and old deployed clients still use direct writes. The new RPC detects conflicts, but compatibility mode permits legacy bypass. The existing retention job still hard-deletes old completed rows; strict activation must preserve tombstones. No standalone API or incremental cursor is implemented.

See [optimization results](云程日历_优化实施结果.md), [sync design](sync-design.md) and [deployment](deployment.md) for evidence, rollout order and remaining work.
