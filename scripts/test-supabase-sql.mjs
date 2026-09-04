import { readFile } from "node:fs/promises";
import { query } from "./supabase-query.mjs";

const migration = await readFile(new URL("../supabase/migrations/20260904_sync_v1.sql", import.meta.url), "utf8");
const tests = await readFile(new URL("../supabase/tests/sync-v1.sql", import.meta.url), "utf8");
// Preview the exact migration and all tests in one rollback-only transaction.
const combined = migration.replace(/\ncommit;\s*$/, "\n") + tests.replace(/\nbegin;/, "");
console.log(JSON.stringify(await query(combined, false), null, 2));
