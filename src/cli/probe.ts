/**
 * Live smoke test for every adapter. Needs no database.
 *
 * Each provider is probed against a board token that was confirmed public and
 * unauthenticated during design. Run this after touching an adapter or when a
 * vendor is suspected of changing its response shape.
 *
 *   npm run probe
 *   npm run probe -- lever ashby
 */
import { getAdapter, SUPPORTED_PROVIDERS } from '../ats/adapters/index.js';
import { config } from '../config.js';
import type { AtsProvider, NormalizedJob } from '../ats/types.js';

// Partial: usajobs and socrata are not name-probeable board vendors - they are
// single fixed endpoints, so there is no per-company token to smoke-test.
const PROBE_TOKENS: Partial<Record<AtsProvider, string>> = {
  greenhouse: 'gruve',
  lever: 'lyrahealth',
  ashby: 'ashby',
  workable: 'nationsecurity',
  smartrecruiters: 'soprasteria1',
  breezy: 'breezy',
  personio: 'personio',
  rippling: 'bizzycar',
  // Socrata addresses a board as "host|dataset". NYC Jobs is keyless.
  socrata: 'data.cityofnewyork.us|kpav-sd4t',
  // Workday is the largest single source in the corpus, so it is probed here
  // rather than left to `npm run discover`. Skipping it is how a pagination bug
  // that cut every Workday board to 40 jobs survived a green smoke test.
  workday: 'keybank',
};

/** Providers needing more than a bare token to address a board. */
const PROBE_EXTRA: Partial<Record<AtsProvider, Record<string, string>>> = {
  workday: {
    host: 'keybank.wd5.myworkdayjobs.com',
    site: 'External_Career_Site',
    locale: 'en-US',
  },
};

/**
 * Smallest job count a healthy board should return.
 *
 * A plain "did it throw" check passes an adapter that silently returns a
 * truncated page, which is exactly what Workday was doing: 40 of 559.
 */
const MIN_EXPECTED: Partial<Record<AtsProvider, number>> = {
  workday: 100,
  smartrecruiters: 100,
  lever: 50,
};

function coverage(jobs: NormalizedJob[], field: keyof NormalizedJob): string {
  if (jobs.length === 0) return '0%';
  const present = jobs.filter((j) => j[field] !== undefined && j[field] !== '').length;
  return `${Math.round((present / jobs.length) * 100)}%`;
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2) as AtsProvider[];
  const providers = requested.length > 0 ? requested : SUPPORTED_PROVIDERS;
  let failures = 0;
  let skipped = 0;

  for (const provider of providers) {
    const token = PROBE_TOKENS[provider];
    if (!token) {
      console.log(`SKIP ${provider.padEnd(16)} no probe token configured — NOT verified`);
      skipped++;
      continue;
    }

    const started = Date.now();
    try {
      const extra = PROBE_EXTRA[provider];
      const jobs = await getAdapter(provider).fetchJobs(
        { provider, token, ...(extra ? { extra } : {}) },
        { userAgent: config.userAgent, timeoutMs: config.timeoutMs },
      );
      const ms = Date.now() - started;

      const floor = MIN_EXPECTED[provider];
      if (floor !== undefined && jobs.length < floor) {
        failures++;
        console.log(
          `FAIL ${provider.padEnd(16)} returned ${jobs.length} jobs, expected at least ${floor} ` +
            '— looks truncated',
        );
        continue;
      }
      console.log(
        `PASS ${provider.padEnd(16)} ${String(jobs.length).padStart(4)} jobs  ${String(ms).padStart(5)}ms  ` +
          `postedAt=${coverage(jobs, 'postedAt').padStart(4)} ` +
          `remote=${coverage(jobs, 'remoteType').padStart(4)} ` +
          `desc=${coverage(jobs, 'descriptionText').padStart(4)} ` +
          `apply=${coverage(jobs, 'applyUrl').padStart(4)}`,
      );
      const sample = jobs[0];
      if (sample) {
        console.log(
          `     e.g. "${sample.title}" | ${sample.locationRaw ?? 'no location'} | ` +
            `${sample.remoteType ?? 'remote:?'} | posted ${sample.postedAt?.toISOString().slice(0, 10) ?? '?'}`,
        );
      }
    } catch (err) {
      failures++;
      console.log(`FAIL ${provider.padEnd(16)} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Counting unexercised adapters as passes reported "11/11 healthy" while three
  // of them had never been called.
  const checked = providers.length - skipped;
  console.log(
    `\n${checked - failures}/${checked} adapters verified` +
      (skipped > 0 ? ` · ${skipped} not exercised` : ''),
  );
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
