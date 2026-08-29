/** Applies schema.sql. Idempotent — safe to re-run. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { closePool, query } from '../db/client.js';

async function main(): Promise<void> {
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
