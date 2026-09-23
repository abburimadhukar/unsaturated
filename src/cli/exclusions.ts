/**
 * Reads back what the crawl has been throwing away.
 *
 *   npm run exclusions                    the shape: totals per rule
 *   npm run exclusions -- --reason sales  the titles one rule is rejecting
 *   npm run exclusions -- --suspect       titles that look technical but were dropped
 *   npm run exclusions -- --top 100       how many titles to list
 *
 * The point of the table is a question that used to take an afternoon of
 * hand-crawling: "are we rejecting anything we should be keeping?" `--suspect`
 * is that question asked directly — every rejected title carrying an engineering
 * word, most frequent first. A clean run is a short list of things that genuinely
 * are not tech roles.
 */
import { db } from '../db/supabase.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

/**
 * Words that make a rejected title worth a second look.
 *
 * Deliberately the same vocabulary the classifier uses to rescue a soft
 * exclusion, plus the specific titles that were found misfiled by hand. A title
 * matching one of these was dropped by SOMETHING, and that something is either
 * right for a reason worth knowing or wrong.
 */
const SUSPECT =
  /\b(engineer|engineering|developer|architect|administrator|programmer|sre|devops|scientist|analyst|technical|systems?|cloud|data|software|platform|infrastructure|security|network|database|integration|automation)\b/i;

async function main(): Promise<void> {
  const client = db();
  const top = Number.parseInt(arg('top') ?? '40', 10);
  const reason = arg('reason');

  // Paged. PostgREST caps a single select at 1000 rows whatever `limit` says,
  // so asking for 20,000 quietly returned 1,000 and every total printed below
  // was a fraction of the truth — it reported 57,891 discards against an actual
  // 232,366. The same cap is already handled in db-feed.ts; this forgot it.
  //
  // Paged BY KEY, not by offset, and in primary-key order rather than by count.
  //
  // The obvious version — `order by n desc` with `.range(from, from + 999)` —
  // is quadratic in disguise. Each page re-sorts all 304,000 rows to throw away
  // everything before the offset, so reading the table costs 304 sorts of it.
  // Measured on the live table: 2.2s per page by count, 3.8s per page by key
  // with an offset, and 36ms per page by key with a WHERE. That is the whole
  // difference between a five-minute report and a ten-second one.
  //
  // (reason, title) is exactly the primary key, so each page is a short walk
  // along an index we already keep. The eq/gt pair expresses the row-value
  // comparison `(reason, title) > (last_reason, last_title)` in the two steps
  // PostgREST can actually send, and the values go in their own query
  // parameters rather than inside an `or=(...)` list — so a title containing a
  // comma or a bracket cannot break the filter.
  type Row = {
    reason: string; title: string; n: number; sample_company: string | null; last_seen_at: string;
  };
  const PAGE = 1000;
  const COLUMNS = 'reason,title,n,sample_company,last_seen_at';
  const rows: Row[] = [];

  const fail = (message: string): void => {
    console.error(`could not read exclusions: ${message}`);
    console.error('If the table does not exist, apply src/db/migrations/2026-09-04-exclusions.sql.');
    process.exitCode = 1;
  };

  // The rules themselves, walked the same way. There are ~22 of them, so this
  // is 22 single-row index lookups rather than a distinct over the whole table.
  const reasons: string[] = [];
  for (let last: string | null = null; ; ) {
    let q = client.from('exclusions').select('reason');
    if (last !== null) q = q.gt('reason', last);
    const { data, error } = await q.order('reason', { ascending: true }).limit(1);
    if (error) return fail(error.message);
    const next = (data as { reason: string }[] | null)?.[0]?.reason;
    if (next === undefined) break;
    reasons.push(next);
    last = next;
  }

  for (const reason of reasons) {
    for (let lastTitle: string | null = null; ; ) {
      let q = client.from('exclusions').select(COLUMNS).eq('reason', reason);
      if (lastTitle !== null) q = q.gt('title', lastTitle);
      const { data, error } = await q.order('title', { ascending: true }).limit(PAGE);
      if (error) return fail(error.message);
      const batch = (data ?? []) as Row[];
      rows.push(...batch);
      if (batch.length < PAGE) break;
      lastTitle = batch[batch.length - 1]!.title;
    }
  }

  // Biggest first, which is the order every report below reads in. One sort of
  // an array already in memory, in place of one sort per page on the server.
  rows.sort(
    (a, b) =>
      Number(b.n) - Number(a.n) ||
      a.reason.localeCompare(b.reason) ||
      a.title.localeCompare(b.title),
  );

  if (rows.length === 0) {
    console.log('Nothing recorded yet. The tally is written at the end of each crawl.');
    return;
  }

  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);

  if (has('suspect')) {
    const hits = rows.filter((r) => SUSPECT.test(r.title));
    const hitTotal = hits.reduce((s, r) => s + Number(r.n), 0);
    console.log(
      `Rejected titles containing an engineering word: ${hits.length} distinct, ` +
        `${hitTotal.toLocaleString()} postings (${((hitTotal / total) * 100).toFixed(1)}% of all discards)\n`,
    );
    for (const r of hits.slice(0, top)) {
      console.log(
        `  ${String(r.n).padStart(6)}  ${r.reason.padEnd(26)} ${r.title.slice(0, 58).padEnd(58)} ${r.sample_company ?? ''}`,
      );
    }
    console.log('\nEach line is a rule and a title. A line that reads like a real');
    console.log('engineering role is a rule to go and look at.');
    return;
  }

  if (reason) {
    const hits = rows.filter((r) => r.reason === reason);
    if (hits.length === 0) {
      console.log(`Nothing recorded under "${reason}". Rules seen: ${[...new Set(rows.map((r) => r.reason))].join(', ')}`);
      return;
    }
    const n = hits.reduce((s, r) => s + Number(r.n), 0);
    console.log(`${reason}: ${n.toLocaleString()} postings across ${hits.length} distinct titles\n`);
    for (const r of hits.slice(0, top)) {
      console.log(`  ${String(r.n).padStart(6)}  ${r.title.slice(0, 70).padEnd(70)} ${r.sample_company ?? ''}`);
    }
    return;
  }

  // Default: the shape. Which rules are doing the work, and how concentrated
  // each one is — a rule with one title behind it is a different thing from a
  // rule with four thousand.
  const byReason = new Map<string, { n: number; titles: number }>();
  for (const r of rows) {
    const e = byReason.get(r.reason) ?? { n: 0, titles: 0 };
    e.n += Number(r.n);
    e.titles++;
    byReason.set(r.reason, e);
  }
  console.log(`${total.toLocaleString()} discarded postings, ${rows.length} distinct titles\n`);
  console.log(`  ${'postings'.padStart(9)}  ${'share'.padStart(6)}  ${'titles'.padStart(6)}  rule`);
  for (const [name, e] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `  ${e.n.toLocaleString().padStart(9)}  ${((e.n / total) * 100).toFixed(1).padStart(5)}%  ${String(e.titles).padStart(6)}  ${name}`,
    );
  }
  console.log('\n  npm run exclusions -- --suspect            what looks wrongly rejected');
  console.log('  npm run exclusions -- --reason <rule>      the titles behind one rule');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
