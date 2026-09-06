/**
 * Regenerates the Quiet Roles migration from the magnet list.
 *
 *   npm run quiet:sql            write the migration
 *   npm run quiet:sql -- --check exit non-zero if the file is out of date
 *
 * The magnet list lives in TypeScript because that is where it is tested and
 * where the page reads it. But the FILTER has to run in the database — a regex
 * over 61,000 rows sent through PostgREST as a query filter was measured at a
 * statement timeout, and pulling the rows into a Worker to filter them there is
 * the exact thing the rest of this codebase refuses to do.
 *
 * So the pattern exists twice, and this is what keeps the two honest. Editing
 * MAGNET_TITLES and forgetting the migration would leave the site filtering on
 * yesterday's list with nothing to say so; `--check` runs in the test suite and
 * fails loudly instead.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { MAGNET_PATTERN, MAGNET_TITLES, MAGNET_ACRONYMS } from '../taxonomy/quiet.js';

export const MIGRATION_PATH = new URL(
  '../db/migrations/2026-09-06-quiet.sql',
  import.meta.url,
);

export function renderMigration(): string {
  // A single quote would end the SQL string literal early and a backslash would
  // be read as an escape. Neither can occur in a list of job titles, but the
  // generator asserts it rather than trusting it — this string is pasted into a
  // production database by hand.
  if (MAGNET_PATTERN.includes("'") || MAGNET_PATTERN.includes('\\')) {
    throw new Error('magnet pattern must contain no quotes or backslashes');
  }

  return `-- Quiet roles: the same work under a title nobody searches for.
--
-- People find jobs by typing a title into a box. A posting not called what they
-- typed is never seen, and collects a fraction of the applications an identical
-- job collects under the popular name. The published figures put the average
-- opening at 200-250 applications and entry-level at 400+, while remote roles
-- draw 2.5-3.4x the applicants of the same job on-site.
--
-- The corpus says the crowd funnels into very few names. Each family holds
-- thousands of distinct titles and the top twenty cover a fifth to a quarter:
--
--   cloud     9,140 jobs · 4,856 distinct titles · top 20 = 19%
--   software 14,167 jobs · 6,906 distinct titles · top 20 = 22%
--   data      7,273 jobs · 3,928 distinct titles · top 20 = 26%
--   hris      2,481 jobs · 1,308 distinct titles · top 20 = 29%
--
-- A GENERATED column, and deliberately not a function change.
--
-- The obvious implementation was another parameter on feed_page and
-- feed_facets. That means dropping and recreating both — Postgres treats an
-- added default parameter as an overload, so calls with the old argument count
-- become ambiguous and the site goes down until the new definition lands. That
-- has already nearly happened here once: a migration dropped both functions and
-- then failed to parse, and only the editor's transaction saved it.
--
-- Nothing below touches a function. The existing page cannot change behaviour,
-- because none of the code it runs is modified. Worst case, this column fails
-- to be created and the Quiet Roles page finds nothing.
--
-- STORED rather than computed per query for the same reason the parameter was
-- rejected: matching a 1,100-character regex against every candidate row timed
-- out when tried live. Stored, it is computed once here and then indexed.
--
-- Regenerate with: npm run quiet:sql
-- Do not hand-edit — src/taxonomy/quiet.ts is the source, and a test compares
-- the pattern below against it on every run.
--
-- Safe to re-run.

begin;

-- ${MAGNET_TITLES.length} magnet phrases and ${MAGNET_ACRONYMS.length} acronyms, each accepting a hyphen or a space
-- between words, so "front end", "front-end" and "frontend" all count as one.
alter table public.jobs
  add column if not exists quiet boolean
  generated always as (title !~* '${MAGNET_PATTERN}') stored;

-- Covers the page's only query shape: one family, quiet, newest first, open.
create index if not exists jobs_quiet_idx
  on public.jobs (family, posted_at desc)
  where closed_at is null and quiet;

commit;
`;
}

function main(): void {
  const sql = renderMigration();
  const path = MIGRATION_PATH;

  if (process.argv.includes('--check')) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== sql) {
      console.error('2026-09-06-quiet.sql is out of date. Run: npm run quiet:sql');
      process.exitCode = 1;
      return;
    }
    console.log('Migration matches the magnet list.');
    return;
  }

  writeFileSync(path, sql);
  console.log(`Wrote ${path.pathname} (${MAGNET_TITLES.length} magnet phrases).`);
}

// Only when run directly, so the test can import renderMigration without
// writing anything.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
