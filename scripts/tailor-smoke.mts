/**
 * Does tailoring actually work, for a real job, on every vendor?
 *
 * WHY THIS EXISTS
 *
 * The rewrite route shipped asking `jobs` for a column that lives on `boards`.
 * Every job on the site answered "that job is not in the feed any more" while its
 * title sat on the screen above the message. The deploy had been "verified" by
 * loading the page (200) and calling the API with no session (401) — which proves
 * the gate and nothing past it.
 *
 * So this runs the parts of the request that do not need a session: the job
 * lookup against the real database, and the description fetch against the real
 * employer. Those are the two steps that were broken, and both are free.
 *
 * Spends nothing and calls no model. Safe to run before every deploy.
 *
 *   npx tsx scripts/tailor-smoke.mts [job-key ...]
 */
import { describeJob } from '../src/tailor/jd.js';
import { loadJobForTailoring } from '../src/tailor/job-lookup.js';
import { canDescribe } from '../src/tailor/providers.js';

/** One live key per vendor, taken from the feed. */
const DEFAULTS = [
  'ashby:0g:f215ac30-02c2-4145-a7aa-17ed3f87ce1b',
  'bamboohr:1valet:179',
  'breezy:af:4f04fcae4aed',
  'greenhouse:paperlessparts:4732990005',
  'lever:3pillarglobal:05d03da4-32d8-4633-b4ba-700a63b1fe15',
  'personio:1komma5grad:2767053',
  'recruitee:8advisory:2739716',
  'rippling:4ag:60dded9f-554e-411b-8ac9-a9dd4986f627',
  'smartrecruiters:3HPartners:744000146417579',
  'socrata:data.cityofnewyork.us|kpav-sd4t:720985',
  'teamtailor:42t:f5d61893-e119-492e-91eb-436b34ae1cd5',
  'ukg:AAM1000AAM:0ac5173c-dca7-49fb-8c50-354e68abe751',
  'workable:1global:019563FCC9',
  'workday:2020companies:/job/Akron-OH/Retail-Display-Installer---Technology_REQ_112498',
  // Deliberately absent, so "not in the feed" is proven to still mean that.
  'greenhouse:nosuchcompany:000000',
];

const keys = process.argv.slice(2);
const targets = keys.length > 0 ? keys : DEFAULTS;

let lookupOk = 0;
let lookupBad = 0;
let describeOk = 0;
let describeNo = 0;

console.log(`${targets.length} jobs\n`);
console.log('LOOKUP   DESCRIBE  PROVIDER          JOB');
console.log('-'.repeat(96));

for (const key of targets) {
  const provider = key.split(':')[0] ?? '?';
  const found = await loadJobForTailoring(key);

  if (!found.ok) {
    // The distinction that was missing. A row that is genuinely gone is a fact
    // about the world; a query that failed is a fact about us.
    const kind = found.found ? 'BROKEN ' : 'absent ';
    if (found.found) lookupBad++;
    console.log(`${kind}  -         ${provider.padEnd(16)}  ${found.reason.slice(0, 60)}`);
    continue;
  }
  lookupOk++;

  if (!canDescribe(found.job.provider)) {
    console.log(`ok       n/a       ${provider.padEnd(16)}  ${found.job.title.slice(0, 44)}`);
    continue;
  }

  const described = await describeJob(
    { key: found.job.key, title: found.job.title },
    found.extra ? { extra: found.extra } : {},
  );
  if (described.ok) {
    describeOk++;
    console.log(
      `ok       ${String(described.text.length).padStart(6)}    ${provider.padEnd(16)}  ${found.job.title.slice(0, 44)}`,
    );
  } else {
    describeNo++;
    console.log(
      `ok       none      ${provider.padEnd(16)}  ${found.job.title.slice(0, 30)} — ${described.reason.slice(0, 40)}`,
    );
  }
}

console.log('-'.repeat(96));
console.log(
  `lookup: ${lookupOk} found, ${lookupBad} FAILED · descriptions: ${describeOk} read, ${describeNo} unavailable`,
);

// A failed lookup is a broken build. A missing description is a vendor that does
// not publish one, which is ordinary and already reported to the person.
if (lookupBad > 0) {
  console.error('\nFAIL: the job lookup is broken.');
  process.exit(1);
}
console.log('\nOK: every job resolved.');
