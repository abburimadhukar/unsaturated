import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { normaliseTitle, tallyExclusions } from '../src/corpus/exclusions.js';
import type { FeedJob } from '../src/corpus/types.js';

/**
 * The tally is the only record that 93% of every crawl was discarded for
 * defensible reasons. If it silently counts nothing — because it was handed an
 * already-filtered list, or because normalisation collapsed every title to the
 * same string — the instrument reads clean while measuring nothing, which is
 * worse than having no instrument.
 */

function job(over: Partial<FeedJob>): FeedJob {
  return {
    key: 'greenhouse:acme:1', title: 'Engineer', company: 'Acme', provider: 'greenhouse',
    location: null, country: null, remoteType: null, seniority: null, employmentType: null,
    department: null, salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
    ageDays: null, applyUrl: null, saturation: 0, components: {}, reasons: [],
    inScope: false, family: null, ai: false, matchedSkills: [], skillScore: 0,
    ...over,
  } as FeedJob;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('titles differing only in employer noise collapse to one row', () => {
  const same = [
    'Senior Backend Engineer (Remote)',
    'Senior Backend Engineer [REQ-1029]',
    'Senior Backend Engineer - Chicago, IL',
    '  Senior   Backend   Engineer  ',
    'SENIOR BACKEND ENGINEER',
  ].map(normaliseTitle);
  assert.equal(new Set(same).size, 1, `collapsed to ${JSON.stringify([...new Set(same)])}`);
  assert.equal(same[0], 'senior backend engineer');
});

test('normalisation never removes a word that carries meaning', () => {
  // The whole point is reading the words back, so anything that changes which
  // words are present defeats the table.
  assert.equal(normaliseTitle('Cloud Operations Engineer'), 'cloud operations engineer');
  assert.equal(normaliseTitle('C# / .NET Developer'), 'c# / .net developer');
  assert.equal(normaliseTitle('Data Engineer II'), 'data engineer ii');
  assert.equal(normaliseTitle('Site Reliability Engineer, Platform'), 'site reliability engineer platform');
});

test('distinct roles stay distinct', () => {
  const titles = ['Backend Engineer', 'Frontend Engineer', 'Warehouse Associate', 'Delivery Driver'];
  assert.equal(new Set(titles.map(normaliseTitle)).size, 4);
});

test('a title that normalises to nothing is dropped, not counted as empty', () => {
  assert.equal(normaliseTitle('(remote)'), '');
  assert.equal(normaliseTitle('!!!'), '');
  const rows = tallyExclusions([job({ title: '!!!', excludedReason: 'sales' })]);
  assert.equal(rows.length, 0);
});

test('an absurdly long title is truncated rather than stored whole', () => {
  assert.ok(normaliseTitle('Engineer '.repeat(100)).length <= 120);
});

// ---------------------------------------------------------------------------
// Tallying
// ---------------------------------------------------------------------------

test('counts are grouped by rule AND title, not one or the other', () => {
  const rows = tallyExclusions([
    job({ title: 'Delivery Driver', excludedReason: 'manual' }),
    job({ title: 'Delivery Driver', excludedReason: 'manual' }),
    job({ title: 'Delivery Driver', excludedReason: 'sales' }),
    job({ title: 'Warehouse Associate', excludedReason: 'manual' }),
  ]);
  const find = (reason: string, title: string) =>
    rows.find((r) => r.reason === reason && r.title === title)?.n;
  assert.equal(find('manual', 'delivery driver'), 2);
  // Same title, different rule: a separate row, or you cannot tell which rule
  // is responsible for what.
  assert.equal(find('sales', 'delivery driver'), 1);
  assert.equal(find('manual', 'warehouse associate'), 1);
});

test('in-scope jobs are never counted as discards', () => {
  const rows = tallyExclusions([
    job({ title: 'Backend Engineer', inScope: true, family: 'software' }),
    job({ title: 'Delivery Driver', excludedReason: 'manual' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, 'delivery driver');
});

test('an already-filtered list yields nothing rather than looking healthy', () => {
  // The failure mode this guards: calling the tally AFTER `.filter(j => j.inScope)`
  // would report zero discards from a crawl that discarded 224,000 postings.
  const kept = [job({ title: 'Backend Engineer', inScope: true, family: 'software' })];
  assert.deepEqual(tallyExclusions(kept), []);
});

test('a job no rule excluded and no family claimed gets its own reason', () => {
  // The interesting case. Previously indistinguishable from a deliberate
  // exclusion, because both left nothing behind.
  const rows = tallyExclusions([job({ title: 'Forward Deployed Engineer' })]);
  assert.equal(rows[0]?.reason, 'no family matched');
  assert.equal(rows[0]?.n, 1);
});

test('results are ordered by count, because only the top of the list gets read', () => {
  const rows = tallyExclusions([
    ...Array.from({ length: 3 }, () => job({ title: 'Rare Role', excludedReason: 'sales' })),
    ...Array.from({ length: 40 }, () => job({ title: 'Common Role', excludedReason: 'manual' })),
    ...Array.from({ length: 12 }, () => job({ title: 'Middling Role', excludedReason: 'legal' })),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [40, 12, 3]);
});

test('the write is capped, and the cap keeps the largest counts', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    Array.from({ length: i + 1 }, () => job({ title: `Role ${i}`, excludedReason: 'sales' })),
  ).flat();
  const rows = tallyExclusions(many, 5);
  assert.equal(rows.length, 5);
  // Largest kept, not an arbitrary five: a cap that dropped the common titles
  // would hide exactly what the table exists to show.
  assert.deepEqual(rows.map((r) => r.n), [50, 49, 48, 47, 46]);
});

test('a sample company is carried so a title can be traced back', () => {
  const rows = tallyExclusions([job({ title: 'Cloud Operations Engineer', company: 'Globex' })]);
  assert.equal(rows[0]?.sampleCompany, 'Globex');
});

test('an empty crawl tallies nothing without throwing', () => {
  assert.deepEqual(tallyExclusions([]), []);
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

/**
 * The report must page by key, never by offset.
 *
 * `order by n desc` with `.range(from, from + 999)` makes Postgres re-sort all
 * 304,000 rows for every page and discard everything before the offset, so
 * reading the table once costs 304 sorts of it. Measured on the live table:
 * 2.2s a page that way, 36ms a page with a WHERE on the primary key. The report
 * went from 5m09s to 1m11s on the same data and printed identical totals.
 *
 * `n` must NOT be ordered on in the query. It is the column every crawl
 * increments, and indexing it to make this sort cheap is what forced 11,721,136
 * updates down the slow path at 0% HOT — see the 2026-09-23 migration. The sort
 * belongs in memory, after the read, where it costs nothing.
 */
const cliSource = readFileSync(new URL('../src/cli/exclusions.ts', import.meta.url), 'utf8');

/**
 * Comments stripped before matching.
 *
 * A "this must not appear" assertion read against the raw file fails on the
 * comment explaining why the thing is absent — the absence is documented right
 * where it happened, so the prose names what the code must not contain. Match
 * on the code alone.
 */
const cli = cliSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/.*$/gm, ' ');

test('the report pages by primary key, not by offset', () => {
  assert.match(cli, /\.eq\('reason', reason\)/);
  assert.match(cli, /\.gt\('title', lastTitle\)/);
  assert.match(cli, /\.order\('title', \{ ascending: true \}\)/);
  // .range() is the offset paging this replaced.
  assert.doesNotMatch(cli, /\.range\(/);
});

test('the report never asks the database to sort by the counter', () => {
  assert.doesNotMatch(cli, /\.order\('n'/);
  // It sorts in memory instead, which is what keeps the output biggest-first.
  assert.match(cli, /rows\.sort\(/);
});

test('keyset values travel as their own parameters, not inside an or() list', () => {
  // Titles contain commas and brackets. Inside `or=(...)` those are syntax and
  // would break the filter; as separate eq/gt parameters they are just values.
  assert.doesNotMatch(cli, /\.or\(/);
});

// ---------------------------------------------------------------------------
// Two speeds: never miss a title, stop rewriting the ones we have
// ---------------------------------------------------------------------------

/**
 * `record_exclusions` was 16% of ALL database time — more write traffic than
 * the corpus it diagnoses (16,841,852 updates against jobs' 15,557,011 over 34
 * days) — for a table nothing under app/ reads.
 *
 * The obvious fix, writing the whole tally once a day, was WRONG and these
 * tests exist mostly to stop it coming back. 98% of the cost is re-writing
 * rows that already exist (16.8M updates against 394k inserts), but the value
 * is in the rare ones: 5,251 of 232,505 pairs have been seen exactly once, and
 * a rule with a bug in it usually drops an uncommon title. Writing one crawl in
 * five would have missed about four in five of those — weakening the only
 * instrument that catches a broken rule, right when a new family is added.
 *
 * So: new titles on EVERY crawl, the expensive counter pass once a day.
 */
const costSql = readFileSync(
  new URL('../src/db/migrations/2026-10-02-exclusions-cost-and-grant.sql', import.meta.url),
  'utf8',
);
const costBody = costSql.replace(/^\s*--.*$/gm, ' ');

test('A TITLE NEVER SEEN BEFORE IS RECORDED ON EVERY CRAWL', () => {
  // The cheap branch must still INSERT. If this becomes a no-op the rare
  // titles — the whole point of the table — are lost.
  assert.match(costBody, /on conflict \(reason, title\) do nothing/);
  assert.match(costBody, /inserted as \(/);
  // And it must be reached when the window is shut, not skipped entirely.
  assert.doesNotMatch(costBody, /elsif[^\n]*then\s*\n\s*return 0;/);
});

test('the expensive counter pass runs once a day, not once a crawl', () => {
  assert.match(costBody, /create table if not exists public\.exclusions_run/);
  assert.match(costBody, /v_now - v_started >= interval '20 hours'/);
  assert.match(costBody, /v_now - v_started <= interval '30 minutes'/);
  // Both branches exist and are chosen by one flag.
  assert.match(costBody, /v_full\s+boolean := false/);
  assert.match(costBody, /if v_full then/);
  assert.match(costBody, /on conflict \(reason, title\) do update/);
});

test('an empty call cannot burn the window the full pass needs', () => {
  const guard = costBody.indexOf('jsonb_array_length(p_rows) = 0');
  const marker = costBody.indexOf('select window_started_at into v_started');
  assert.ok(guard > -1 && marker > -1, 'both the guard and the marker read exist');
  assert.ok(guard < marker, 'the empty-input guard runs before the window is touched');
});

test('THE WRITE RPC IS TAKEN BACK OFF THE PUBLIC INTERNET', () => {
  // anon could still execute this on 2 Oct 2026 — SECURITY DEFINER, reachable
  // with the publishable key that ships in the site's JavaScript, writing
  // unbounded rows into 21% of a 500 MB database.
  assert.match(
    costBody,
    /revoke execute on function public\.record_exclusions\(jsonb\) from public, anon, authenticated;/,
  );
  // The crawler must keep working.
  assert.match(costBody, /grant execute on function public\.record_exclusions\(jsonb\) to service_role;/);
});

test('the migration replaces the function rather than dropping it', () => {
  // DROP + CREATE resets the ACL to PUBLIC, which is the most likely way the
  // 2026-09-24 revoke was lost. CREATE OR REPLACE keeps the grants.
  assert.match(costBody, /create or replace function public\.record_exclusions/);
  assert.doesNotMatch(costBody, /drop function[^\n]*record_exclusions/i);
});

test('NOTHING IS DELETED AND NOTHING IS DROPPED', () => {
  assert.doesNotMatch(costBody, /drop table/i);
  assert.doesNotMatch(costBody, /delete from/i);
  assert.doesNotMatch(costBody, /truncate/i);
});

test('the new marker table is not reachable over PostgREST', () => {
  assert.match(costBody, /alter table public\.exclusions_run enable row level security/);
  assert.doesNotMatch(costBody, /create policy[^\n]*exclusions_run/i);
});

test('every column the report reads is still written', () => {
  // src/cli/exclusions.ts selects reason,title,n,sample_company,last_seen_at.
  // The cheap branch relies on column defaults for the timestamps, so it must
  // still supply the other four.
  for (const cond of [
    /insert into public\.exclusions as e \(reason, title, n, sample_company\)[\s\S]{0,200}do update/,
    /insert into public\.exclusions as e \(reason, title, n, sample_company\)[\s\S]{0,200}do nothing/,
    /n\s*=\s*e\.n \+ excluded\.n/,
    /last_seen_at = now\(\)/,
    /sample_company = coalesce\(e\.sample_company, excluded\.sample_company\)/,
  ]) assert.match(costBody, cond);
  assert.match(cliSource, /const COLUMNS = 'reason,title,n,sample_company,last_seen_at'/);
});
