import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function browserEval(expression) {
  const target = process.env.SUPABASE_CDP_TARGET;
  if (!target) throw new Error("Set SUPABASE_CDP_TARGET to a dedicated Supabase dashboard tab.");
  const response = await fetch(`http://localhost:3456/eval?target=${encodeURIComponent(target)}`, {
    method: "POST", body: expression, signal: AbortSignal.timeout(300000)
  });
  const result = await response.json();
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export async function query(sql, readOnly = true) {
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!/^[a-z]{20}$/.test(ref ?? "")) throw new Error("Set SUPABASE_PROJECT_REF explicitly.");
  const result = await browserEval(`(async () => {
    if (location.origin !== 'https://supabase.com') throw new Error('Expected Supabase dashboard');
    const session = JSON.parse(localStorage.getItem('supabase.dashboard.auth.token') || '{}');
    if (!session.access_token) throw new Error('Sign in to Supabase dashboard');
    const response = await fetch(${JSON.stringify(`https://api.supabase.com/v1/projects/${ref}/database/query`)}, {
      method: 'POST', signal: AbortSignal.timeout(60000), headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token},
      body: JSON.stringify(${JSON.stringify({ query: sql, read_only: readOnly })})
    });
    return {status: response.status, body: await response.json()};
  })()`);
  if (result.status >= 400) throw new Error(JSON.stringify(result.body));
  return result.body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node scripts/supabase-query.mjs file.sql [--write]");
  console.log(JSON.stringify(await query(await readFile(path, "utf8"), !process.argv.includes("--write")), null, 2));
}
