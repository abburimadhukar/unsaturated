/** Applies schema.sql. Idempotent — safe to re-run. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { closePool, query } from '../db/client.js';

/**
 * Applies src/db/schema.sql.
 *
 * Guarded on DATABASE_URL being set explicitly: config.databaseUrl defaults to
 * a localhost Postgres that does not exist, so running this without the
 * variable used to succeed quietly against a phantom database whose schema had
 * nothing to do with production.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set. This command applies the schema to a Postgres ' +
        'database; production runs on Supabase, where the schema is applied ' +
        'through the dashboard or the Supabase CLI. Refusing to initialise the ' +
        'localhost default.',
    );
    process.exitCode = 1;
    return;
  }

  const schemaPath = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
  const sql = await readFile(schemaPath, 'utf8');
  await query(sql);
  console.log('schema applied');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
