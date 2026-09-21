/**
 * Repairs the employer names on iCIMS boards already in the registry.
 *
 *   npm run icims:names -- --dry-run     report only
 *   npm run icims:names                  write the names
 *   npm run icims:names -- --limit 100   a slice, to try it out
 *   npm run icims:names -- --sql out.sql emit the statements, apply nothing
 *
 * WHY THIS EXISTS
 *
 * The same shape of defect as oracle-names.ts, and for the same reason: a
 * naming rule was corrected after the boards were already stored, and seeding
 * cannot go back for them.
 *
 * The first iCIMS seeding run stored 2,589 boards under title-cased tokens.
 * `icimsCompanyFrom` matched "Job Listings at {employer}" only at the START of
 * the page title, and most boards prefix it — "Fred Hutchinson Cancer Center
 * Job Listings at Fred Hutchinson Cancer Center", "Careers – Job Listings at
 * North American Construction Group". So almost nothing was named, and the
 * fallback title-cased the token: Fred Hutchinson Cancer Center became "Fhcrc"
 * and North American Construction Group became "Nacg".
 *
 * That rule now reads from the LAST occurrence and boards-seed.ts keeps the
 * name it recovers, which fixes every board found from here on. It does not
 * fix the ones already stored, because boards-seed skips anything already in
 * the registry — deliberately, since re-verifying 36,563 boards to correct
 * 2,589 names would take hours and hammer the vendors. Hence this.
 *
 * SAFE BY CONSTRUCTION
 *
 * It only ever writes `company`, only on `provider = 'icims'`, and only when it
 * has found a name that is not the one already there. A board it cannot reach,
 * or cannot name, is left exactly as it is — never blanked, never deactivated.
 * Nothing here can retire a board or touch a posting.
 */
import { writeFileSync } from 'node:fs';

import { icimsCompanyFrom } from '../ats/adapters/icims.js';
import { config } from '../config.js';
import { titleise } from '../discovery/commoncrawl.js';
import { db, dbWrite, readAllRows } from '../db/supabase.js';

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
}

/**
 * The employer's own spelling, from the listing page's title.
 *
 * The same URL verification uses, so a board that answers here is a board that
 * answered there. Only the head of the document is read: the title is in the
 * first few hundred bytes and the rest can be a megabyte of job cards.
 */
async function nameFor(token: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://careers-${encodeURIComponent(token)}.icims.com/jobs/search?ss=1&in_iframe=1`,
      {
        headers: { 'user-agent': config.userAgent, accept: 'text/html' },
        signal: AbortSignal.timeout(25_000),
      },
    );
    if (!res.ok) return undefined;
    return icimsCompanyFrom((await res.text()).slice(0, 20_000));
  } catch {
    return undefined;
  }
}

/**
 * Whether this row is one of the ones this script exists to fix.
 *
 * ONLY THE PLACEHOLDER IS REPLACED. oracle-names.ts learned this the hard way:
 * its first dry run was about to overwrite two boards carrying real names, read
 * from the vendor on the first discovery run, with an error page's title. A
 * repair that can overwrite a good value is not a repair.
 *
 * So the only row this will touch is one still carrying its own token, plain or
 * title-cased — which is the exact defect being fixed and is unmistakable.
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
  const delay = Number.parseInt(arg('delay') ?? '700', 10);

  /**
   * A page at a time, because PostgREST caps a response at 1,000 rows and says
   * nothing about it.
   *
   * The first run of this asked for 5,000 boards, was handed 1,000, announced
   * "1000 icims boards" as though that were the lot, renamed 744 and left 1,589
   * untouched — exiting 0 with nothing in the log to suggest otherwise.
   */
  const all = await readAllRows<Row>((from, to) =>
    db()
      .from('boards')
      .select('id,token,company')
      .eq('provider', 'icims')
      .order('id', { ascending: true })
      .range(from, to),
  );
  const rows = all.slice(0, limit);
  console.log(
    `${rows.length} icims boards${all.length > rows.length ? ` (of ${all.length}, --limit applied)` : ''}\n`,
  );

  // Rows already carrying a real name cost nothing: they are never fetched.
  const candidates = rows.filter((r) => isPlaceholder(r.company, r.token));
  console.log(`${candidates.length} still named after their token · ${rows.length - candidates.length} already named\n`);

  let named = 0;
  let unchanged = 0;
  let unreachable = 0;
  const writes: { id: string; company: string }[] = [];

  for (const row of candidates) {
    const found = await nameFor(row.token);
    if (!found) {
      unreachable++;
    } else if (isBetter(found, row.company, row.token)) {
      writes.push({ id: row.id, company: found });
      named++;
      if (named <= 25) console.log(`  ${row.token.padEnd(24)} ${String(row.company).padEnd(24)} -> ${found}`);
    } else {
      unchanged++;
    }
    // One request a second and a bit, the pace verification runs at.
    await sleep(delay);
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
