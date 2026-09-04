/**
 * Blocks a board from ever being crawled, and cleans up what it left behind.
 *
 *   npm run block -- --list
 *   npm run block -- lever:jobgether --reason "aggregator"
 *   npm run block -- --unblock lever:jobgether
 *
 * Blocking does three things, and all three matter: it records the board so
 * discovery cannot re-add it, deactivates it in the registry so the next crawl
 * skips it, and closes the jobs it already contributed. Doing only the first two
 * leaves its postings in the feed for the full 21-day retention window.
 */
import { dbWrite } from '../db/supabase.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const valueOf = (f: string) => {
  const i = args.indexOf(`--${f}`);
  return i === -1 ? undefined : args[i + 1];
};

function parseTarget(raw: string): { provider: string; token: string } | null {
  const [provider, token] = raw.split(':');
  if (!provider || !token) return null;
  return { provider, token };
}

async function main(): Promise<void> {
  const client = dbWrite();

  if (has('list')) {
    const { data, error } = await client
      .from('blocked_boards')
      .select('provider,token,reason,blocked_at')
      .order('blocked_at', { ascending: false });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { provider: string; token: string; reason: string }[];
    if (rows.length === 0) {
      console.log('Nothing blocked.');
      return;
    }
    console.log(`${rows.length} blocked:\n`);
    for (const r of rows) console.log(`  ${`${r.provider}:${r.token}`.padEnd(32)} ${r.reason}`);
    return;
  }

  const unblock = valueOf('unblock');
  if (unblock) {
    const t = parseTarget(unblock);
    if (!t) throw new Error('expected provider:token, e.g. lever:jobgether');
    const { error } = await client
      .from('blocked_boards')
      .delete()
      .eq('provider', t.provider)
      .eq('token', t.token);
    if (error) throw new Error(error.message);
    // Deliberately not reactivated: unblocking says "this may be crawled again",
    // not "start crawling it now". Discovery will re-verify it on its own.
    console.log(`Unblocked ${unblock}. It is not reactivated — discovery will re-verify it.`);
    return;
  }

  const target = args.find((a) => !a.startsWith('--') && a.includes(':'));
  if (!target) {
    console.log('Usage: npm run block -- <provider:token> --reason "why"');
    console.log('       npm run block -- --list');
    console.log('       npm run block -- --unblock <provider:token>');
    process.exitCode = 1;
    return;
  }
  const t = parseTarget(target);
  if (!t) throw new Error('expected provider:token, e.g. lever:jobgether');
  const reason = valueOf('reason') ?? 'blocked manually';

  const { error: blockError } = await client
    .from('blocked_boards')
    .upsert({ ...t, reason }, { onConflict: 'provider,token' });
  if (blockError) throw new Error(`could not block: ${blockError.message}`);

  const { error: deactivateError } = await client
    .from('boards')
    .update({ active: false })
    .eq('provider', t.provider)
    .eq('token', t.token);
  if (deactivateError) console.error(`could not deactivate: ${deactivateError.message}`);

  const { error: closeError, count } = await client
    .from('jobs')
    .update({ closed_at: new Date().toISOString() }, { count: 'exact' })
    .is('closed_at', null)
    .eq('provider', t.provider)
    .eq('board_token', t.token);
  if (closeError) console.error(`could not close its jobs: ${closeError.message}`);

  console.log(`Blocked ${target} — ${reason}`);
  console.log(`  deactivated in the registry, ${count ?? 0} job(s) closed`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
