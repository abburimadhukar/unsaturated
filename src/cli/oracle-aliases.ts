/**
 * Finds Oracle career sites that are an exact copy of another site of the same
 * tenant, and writes the statements that retire them.
 *
 *   npm run oracle:aliases -- --sql out.sql --backup out.json
 *
 * Nothing is applied. The write key is an Actions secret, so on a laptop this
 * can only propose; the statements get read and then applied deliberately.
 *
 * Every posting id of every site is fetched and compared — see aliases.ts for
 * why nothing short of that is enough to retire a board. A site that cannot be
 * read is left alone, whatever its siblings look like.
 */
import { writeFileSync } from 'node:fs';

import { getAdapter } from '../ats/adapters/index.js';
import { config } from '../config.js';
import { db } from '../db/supabase.js';
import { aliasReason, aliasesOf, type SiteIds } from '../discovery/aliases.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface Row {
  id: string;
  token: string;
  company: string | null;
  extra: Record<string, string> | null;
  job_count: number | null;
}

async function main(): Promise<void> {
  const sqlOut = arg('sql');
  const backupOut = arg('backup');

  const { data, error } = await db()
    .from('boards')
    .select('id,token,company,extra,job_count')
    .eq('provider', 'oracle')
    .eq('active', true)
    .order('token', { ascending: true })
    .limit(10_000);
  if (error) throw new Error(`could not read the registry: ${error.message}`);

  const byTenant = new Map<string, Row[]>();
  for (const r of (data ?? []) as Row[]) {
    const t = r.token.toLowerCase();
    byTenant.set(t, [...(byTenant.get(t) ?? []), r]);
  }
  const tenants = [...byTenant].filter(([, rows]) => rows.length > 1);
  console.log(`${tenants.length} tenants with more than one site\n`);

  const adapter = getAdapter('oracle');
  const ctx = { userAgent: config.userAgent, timeoutMs: 60_000 };
  const retire: { row: Row; keptSite: string; postings: number }[] = [];
  let unreadable = 0;

  for (const [tenant, rows] of tenants) {
    const sites: SiteIds[] = [];
    for (const r of rows) {
      const site = r.extra?.site ?? '';
      let ids = new Set<string>();
      try {
        const jobs = await adapter.fetchJobs({ provider: 'oracle', token: r.token, extra: r.extra ?? {} }, ctx);
        ids = new Set(jobs.map((j) => j.externalId));
      } catch (err) {
        // An empty set matches nothing, so an unreadable site is never retired.
        unreadable++;
        console.log(`  ${tenant}/${site}: could not read (${String(err).slice(0, 80)}) — left alone`);
      }
      sites.push({ site, ids });
      await sleep(400);
    }

    for (const a of aliasesOf(sites)) {
      const row = rows.find((r) => (r.extra?.site ?? '') === a.site)!;
      const postings = sites.find((s) => s.site === a.site)!.ids.size;
      retire.push({ row, keptSite: a.keptSite, postings });
      console.log(`  ${tenant}: ${a.site} is ${a.keptSite} (${postings} postings, every id equal)`);
    }
  }

  const saved = retire.reduce((n, r) => n + r.postings, 0);
  console.log(
    `\n${retire.length} site rows are exact copies · ${saved.toLocaleString()} postings a sweep no longer read twice` +
      ` · ${unreadable} sites unreadable and left alone`,
  );

  if (backupOut) {
    writeFileSync(
      backupOut,
      JSON.stringify(
        {
          taken_at: new Date().toISOString(),
          note: 'Oracle alias sites before retirement. To undo: set active=true, last_error=null on these ids.',
          rows: retire.map((r) => ({
            id: r.row.id,
            token: r.row.token,
            site: r.row.extra?.site,
            kept_site: r.keptSite,
            company: r.row.company,
            postings: r.postings,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`backup: ${backupOut}`);
  }

  if (sqlOut) {
    // Guarded on still being active, so applying twice is a no-op and a row
    // someone changed in the meantime is not touched.
    const values = retire
      .map((r) => `(${quote(r.row.id)},${quote(aliasReason(r.keptSite))})`)
      .join(',');
    writeFileSync(
      sqlOut,
      retire.length === 0
        ? '-- nothing to retire\n'
        : `update public.boards b set active = false, last_error = v.reason from (values ${values}) as v(id, reason) ` +
            `where b.id = v.id::uuid and b.provider = 'oracle' and b.active;\n`,
    );
    console.log(`statements: ${sqlOut}. Nothing applied.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
