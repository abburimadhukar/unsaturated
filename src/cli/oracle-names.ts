/**
 * Repairs the employer names on Oracle boards already in the registry.
 *
 *   npm run oracle:names -- --dry-run     report only
 *   npm run oracle:names                  write the names
 *   npm run oracle:names -- --limit 100   a slice, to try it out
 *
 * WHY THIS EXISTS
 *
 * The first Oracle discovery run stored 764 boards under title-cased tenant
 * codes, because the name resolution at the time trusted `organizationsFacet`
 * only when it named exactly one organisation — and the large tenants are
 * precisely the ones listing their subsidiaries. So Tata Capital was recorded as
 * "Eofh", Lifepoint Health as "Ibnjjb", WSP as "Emit" and Kotak Mahindra Bank as
 * "Hcbt".
 *
 * verify.ts now reads the career site's own page title and falls back to the
 * facet's first entry, which is the parent. That fixes every board discovered
 * from here on and none of the ones already stored, hence this.
 *
 * SAFE BY CONSTRUCTION
 *
 * It only ever writes `company`, only on `provider = 'oracle'`, and only when
 * it has found a name that is not the one already there. A board it cannot
 * reach, or cannot name, is left exactly as it is — never blanked, never
 * deactivated. Nothing here can retire a board or touch a posting.
 */
import { oracleCompanyFrom, oracleCompanyFromPage, oracleSearchUrl, oracleSitePageUrl } from '../ats/adapters/oracle.js';
import { writeFileSync } from 'node:fs';

import { config } from '../config.js';
import { titleise } from '../discovery/commoncrawl.js';
import { db, dbWrite } from '../db/supabase.js';

const has = (name: string) => process.argv.includes(`--${name}`);
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Postgres string literal. Doubling the quote is the whole escape it needs. */
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface Row {
  id: string;
  token: string;
  company: string | null;
  extra: Record<string, string> | null;
}

/** The title first, the facet second — the same order verification uses. */
async function nameFor(host: string, site: string, token: string): Promise<string | undefined> {
  try {
    const page = await fetch(oracleSitePageUrl(host, site), {
      headers: { 'user-agent': config.userAgent, accept: 'text/html' },
      signal: AbortSignal.timeout(25_000),
    });
    if (page.ok) {
      const found = oracleCompanyFromPage((await page.text()).slice(0, 20_000));
      if (found) return found;
    }
  } catch {
    /* fall through to the facet */
  }
  try {
    const res = await fetch(oracleSearchUrl(host, site, 1, 0), {
      headers: { 'user-agent': config.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return undefined;
    return oracleCompanyFrom(await res.json());
  } catch {
    return undefined;
  }
}

/**
 * Whether this row is one of the ones this script exists to fix.
 *
 * ONLY THE PLACEHOLDER IS REPLACED, and that is a deliberate narrowing after
 * the first dry run tried to do more. Two boards already named "Americas Region"
 * and "Al Moosa Specialist Hospital" — real values, read from the vendor's own
 * facet on the first discovery run — were about to be overwritten with "Page
 * not found", because their career sites serve an error page with HTTP 200.
 *
 * The error page is refused separately, in oracleCompanyFromPage. But the
 * lesson is the broader one: a repair that can overwrite a good value is not a
 * repair. So the only row this will touch is one still carrying the title-cased
 * tenant code, which is the exact defect being fixed and is unmistakable.
 * Anything else is left alone, whatever we think of it.
 */
function isPlaceholder(current: string | null, token: string): boolean {
  if (!current) return true;
  const c = current.trim().toLowerCase();
  return c === titleise(token).toLowerCase() || c === token.toLowerCase();
}

function isBetter(found: string, current: string | null, token: string): boolean {
  if (found.trim().length === 0) return false;
  if (found === current) return false;
  if (found.toLowerCase() === token.toLowerCase()) return false;
  return isPlaceholder(current, token);
}

async function main(): Promise<void> {
  const dryRun = has('dry-run');
  const limit = Number.parseInt(arg('limit') ?? '5000', 10);

  const { data, error } = await db()
    .from('boards')
    .select('id,token,company,extra')
    .eq('provider', 'oracle')
    .order('id', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`could not read the registry: ${error.message}`);
  const rows = (data ?? []) as Row[];
  console.log(`${rows.length} oracle boards\n`);

  let named = 0;
  let unchanged = 0;
  let unreachable = 0;
  const writes: { id: string; company: string }[] = [];

  for (const row of rows) {
    const host = row.extra?.host;
    const site = row.extra?.site;
    if (!host || !site) {
      unreachable++;
      continue;
    }
    const found = await nameFor(host, site, row.token);
    if (!found) {
      unreachable++;
    } else if (isBetter(found, row.company, row.token)) {
      writes.push({ id: row.id, company: found });
      named++;
      if (named <= 25) console.log(`  ${row.token.padEnd(24)} ${String(row.company).padEnd(24)} -> ${found}`);
    } else {
      unchanged++;
    }
    // One request a second, the same pace verification runs at.
    await sleep(700);
  }

  console.log(`\nrenamed ${named} · already right ${unchanged} · could not name ${unreachable}`);

  // The write key is a GitHub Actions secret and cannot be read back, so
  // dbWrite() falls back to the publishable key on a laptop and every update
  // would be refused by row-level security. `--sql` is the way to run this from
  // here: it emits the statements, they get read, and they get applied
  // deliberately rather than by a script nobody watched.
  const out = arg('sql');
  if (out) {
    const lines = writes.map(
      (w) => `update public.boards set company = ${quote(w.company)} where id = ${quote(w.id)};`,
    );
    writeFileSync(out, `begin;\n${lines.join('\n')}\ncommit;\n`, 'utf8');
    console.log(`\nwrote ${lines.length} statements to ${out}. Nothing applied.`);
    return;
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  if (writes.length === 0) return;

  // One row at a time by primary key. An upsert would need every NOT NULL
  // column and could insert where it meant to update; this cannot touch
  // anything but the name.
  const client = dbWrite();
  let done = 0;
  for (const w of writes) {
    const { error: err } = await client.from('boards').update({ company: w.company }).eq('id', w.id);
    if (err) throw new Error(`rename failed for ${w.id}: ${err.message}`);
    done++;
    if (done % 50 === 0) process.stdout.write(`  ${done}/${writes.length}\r`);
  }
  console.log(`\nwrote ${done} names.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
