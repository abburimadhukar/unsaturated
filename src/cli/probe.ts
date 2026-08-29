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

const PROBE_TOKENS: Record<AtsProvider, string> = {
  greenhouse: 'gruve',
  lever: 'lyrahealth',
  ashby: 'ashby',
  workable: 'nationsecurity',
  smartrecruiters: 'soprasteria1',
  breezy: 'breezy',
  personio: 'personio',
  // Workday needs host + site as well as the tenant, so it is exercised by
  // `npm run discover` rather than by this single-token smoke test.
  workday: '',
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

  for (const provider of providers) {
    const token = PROBE_TOKENS[provider];
    if (!token) {
      console.log(`? ${provider.padEnd(16)} no probe token configured`);
      continue;
    }

    const started = Date.now();
    try {
      const jobs = await getAdapter(provider).fetchJobs(
        { provider, token },
        { userAgent: config.userAgent, timeoutMs: config.timeoutMs },
      );
      const ms = Date.now() - started;
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

  console.log(`\n${providers.length - failures}/${providers.length} adapters healthy`);
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
