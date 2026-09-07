/**
 * Applies a migration from src/db/migrations/.
 *
 *   npm run migrate -- --list
 *   npm run migrate -- 2026-09-07-workday-sites --dry-run
 *   npm run migrate -- 2026-09-07-workday-sites
 *
 * WHY THIS EXISTS
 *
 * Every migration in this project has been pasted into the Supabase SQL editor
 * by hand. That is why the code carries fallbacks for columns that do not exist
 * yet — `jobs.sector`, `boards.site` — and why those fallbacks are the only
 * thing standing between a hand-applied schema and an hourly crawl that fails
 * every run in between.
 *
 * It needs DATABASE_URL, which is the POSTGRES connection string, and is not
 * the same thing as SUPABASE_SECRET_KEY. The secret key talks to PostgREST,
 * which serves rows over HTTP and has no way to run `alter table` at all — so
 * holding it grants every data operation in this repo and none of the schema
 * ones. The connection string lives in the Supabase dashboard under
 * Project Settings → Database.
 *
 * Refuses to guess. config.databaseUrl falls back to a localhost Postgres that
 * does not exist, and a migration that "succeeds" against a phantom database is
 * worse than one that fails, so an unset DATABASE_URL stops the run — the same
 * guard db-init already applies.
 *
 * Each file is applied in ONE call. They open with `begin` and close with
 * `commit` themselves, so a failure half way leaves nothing behind.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../db/migrations/', import.meta.url));

async function list(): Promise<string[]> {
  const files = await readdir(DIR);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const name = args.find((a) => !a.startsWith('--'));

  if (args.includes('--list') || !name) {
    const files = await list();
    console.log(`${files.length} migration(s) in src/db/migrations:\n`);
    for (const f of files) console.log(`  ${f.replace(/\.sql$/, '')}`);
    console.log('\nRun one with:  npm run migrate -- <name>');
    if (!name) process.exitCode = args.includes('--list') ? 0 : 1;
    return;
  }

  const files = await list();
  const file = files.find((f) => f === `${name}.sql` || f === name);
  if (!file) {
    console.error(`No such migration: ${name}\nRun with --list to see them.`);
    process.exitCode = 1;
    return;
  }

  const sql = await readFile(DIR + file, 'utf8');
  console.log(`${file} — ${sql.split('\n').length} lines\n`);

  if (dryRun) {
    // The statements, without the commentary that makes up most of these files.
    const body = sql
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('--'))
      .join('\n');
    console.log(body);
    console.log('\n--dry-run: nothing applied.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set, so there is nothing safe to apply this to.\n\n' +
        'It is the Postgres connection string, NOT SUPABASE_SECRET_KEY — that key\n' +
        'talks to PostgREST, which serves rows over HTTP and cannot run DDL.\n' +
        'Supabase dashboard → Project Settings → Database → Connection string.\n\n' +
        'Refusing to fall back to the localhost default: a migration that appears\n' +
        'to succeed against a database nobody is using is worse than one that fails.',
    );
    process.exitCode = 1;
    return;
  }

  const { query, closePool } = await import('../db/client.js');
  try {
    await query(sql);
    console.log('applied.');
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
