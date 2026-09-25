import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { JOB_COLUMNS, loadJob } from '../src/after-apply/job-lookup.js';

/**
 * The columns a query names have to exist, and a broken database must not be
 * reported as a missing job.
 *
 * WHAT HAPPENED
 *
 * The rewrite route was written from scratch beside an existing one, and asked
 * `jobs` for `extra` — a column that lives on `boards`. Postgres returned an
 * error, the caller turned it into `null`, and every job on the site answered
 * "that job is not in the feed any more" while its title and company sat on the
 * screen directly above the message.
 *
 * Two faults, and the second is the worse one. The query was wrong, which is
 * ordinary. But a DATABASE ERROR WAS REPORTED AS A MISSING ROW, and those are
 * different things: one is a fact about the world, the other is a fact about us.
 * Reporting the second as the first sent somebody looking for a job that was
 * right there, and left nothing anywhere saying the query had failed.
 *
 * It also shipped. The deploy was checked by loading the page (200) and by
 * calling the API without a session (401) — which proved the gate and not the
 * feature. A 401 is not a test of anything past the gate.
 */

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SCHEMA = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');

/** The column list of one `create table`, as the live database has it. */
function columnsOf(table: string): Set<string> {
  const at = SCHEMA.indexOf(`create table if not exists public.${table} (`);
  assert.notEqual(at, -1, `no create table for ${table}`);
  const body = SCHEMA.slice(at, SCHEMA.indexOf('\n);', at));
  const names = new Set<string>();
  for (const line of body.split('\n').slice(1)) {
    const m = /^\s{2}([a-z_][a-z0-9_]*)\s/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

test('EVERY COLUMN THE JOB LOOKUP ASKS FOR EXISTS ON `jobs`', () => {
  // The test that would have caught it. `extra` is on boards; `company` is on
  // both, which is exactly how a wrong column looks plausible.
  const jobs = columnsOf('jobs');
  for (const col of JOB_COLUMNS.split(',')) {
    assert.ok(jobs.has(col), `jobs has no column "${col}"`);
  }
  assert.ok(!jobs.has('extra'), 'jobs grew an `extra` column — this test is now wrong');
});

test('NO ROUTE SELECTS A COLUMN ITS TABLE DOES NOT HAVE', () => {
  // Generalised, because the specific bug is less interesting than the class. A
  // select() naming a table and a column list is checked against schema.sql.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.next') walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(join(root, 'app'));
  walk(join(root, 'src'));

  const known = new Map<string, Set<string>>();
  const columns = (table: string): Set<string> | null => {
    if (!known.has(table)) {
      try {
        known.set(table, columnsOf(table));
      } catch {
        // A view rather than a table — feed_page and friends are defined by a
        // create view and have no column list to read. Not checkable here.
        known.set(table, new Set());
      }
    }
    const got = known.get(table)!;
    return got.size > 0 ? got : null;
  };

  const problems: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const re = /\.from\('([a-z_]+)'\)\s*\n?\s*\.select\('([^']+)'/g;
    for (const m of src.matchAll(re)) {
      const table = m[1]!;
      const cols = columns(table);
      if (!cols) continue;
      for (const raw of m[2]!.split(',')) {
        // "count" and aggregate/embedded forms are not plain columns.
        const col = raw.trim().split(/[:(]/)[0]!.trim();
        if (!col || col === '*' || col.includes('!')) continue;
        if (!cols.has(col)) {
          problems.push(`${file.slice(root.length)}: ${table} has no column "${col}"`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

// ---------------------------------------------------------------------------
// The two outcomes, which must never share a message
// ---------------------------------------------------------------------------

/** A stand-in for the Supabase client, shaped only as far as this code uses it. */
function fakeClient(jobs: {
  error?: { message: string } | null;
  data?: unknown;
  throws?: boolean;
}) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => {
                  if (jobs.throws) throw new Error('connection reset');
                  return { data: jobs.data ?? null, error: jobs.error ?? null };
                },
                // The boards read, which is only reached for Workday.
                then: undefined,
              };
            },
          };
        },
      };
    },
  } as never;
}

test('A MISSING ROW AND A BROKEN DATABASE DO NOT SHARE A MESSAGE', async () => {
  const missing = await loadJob('nope', { client: fakeClient({ data: null }) });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.found, false);
  assert.match(missing.reason, /not in the feed any more/);

  const broken = await loadJob('x', {
    client: fakeClient({ error: { message: 'column jobs.extra does not exist' } }),
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.ok === false && broken.found, true, 'a query error reads as a missing job');
  assert.match(broken.reason, /could not read that job/);
  // The database's own words, so the cause is not lost.
  assert.match(broken.reason, /column jobs\.extra does not exist/);
  assert.ok(!/not in the feed/.test(broken.reason), 'it still says the job is gone');
});

test('an unreachable database is reported as our fault, not as a missing job', async () => {
  const out = await loadJob('x', { client: fakeClient({ throws: true }) });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.found, true);
  assert.match(out.reason, /could not reach the database/);
});

test('a found job comes back whole', async () => {
  const row = {
    key: 'greenhouse:acme:1',
    title: 'Platform Engineer',
    company: 'Acme',
    provider: 'greenhouse',
    board_token: 'acme',
    apply_url: null,
    closed_at: null,
  };
  const out = await loadJob('greenhouse:acme:1', { client: fakeClient({ data: row }) });
  assert.equal(out.ok, true);
  assert.equal(out.ok === true && out.job.title, 'Platform Engineer');
  // Only Workday needs the second read, so nothing else pays for it.
  assert.equal(out.ok === true && out.extra, undefined);
});

test('THE ROUTE REPORTS THE TWO CASES WITH DIFFERENT STATUS CODES', () => {
  // 404 means the posting has gone. 503 means we could not ask. A person seeing
  // the first goes and finds another job; a person seeing the second tries again.
  const src = readFileSync(
    // After applying's research route. This read the tailor rewrite route until
    // tailoring was removed on 25 Sep 2026; After applying is now the caller
    // that has to keep "posting gone" and "we are broken" apart.
    new URL('../app/api/after-apply/research/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(src, /loadJob\(jobKey\)/);
  assert.match(src, /found\.found \? 503 : 404/);
  // It may DESCRIBE the old message in a comment — the header does, because the
  // reason this code looks like this is worth keeping. What it may not do is
  // construct it, which is what `bad(` would mean.
  assert.ok(
    !/bad\(\s*['"`]that job is not in the feed/.test(src),
    'the route still builds its own copy of the message',
  );
});
