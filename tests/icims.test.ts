import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseListing, pageCount, icimsCompanyFrom, icimsHost, icimsListingUrl } from '../src/ats/adapters/icims.js';
import { toBoard } from '../src/discovery/commoncrawl.js';
import { resolveApplyUrl } from '../src/ats/resolve.js';
import { ADAPTERS } from '../src/ats/adapters/index.js';

/**
 * iCIMS is read from the page iCIMS serves to its own career-site iframe. The
 * fixture is a real listing (Model 1 Commercial Vehicles, 20 September 2026)
 * cut to three postings, so a change in that markup fails here rather than
 * quietly emptying a thousand boards.
 */
const listing = readFileSync(new URL('./fixtures/icims-listing.html', import.meta.url), 'utf8');

test('a posting is read out of the listing markup', () => {
  const jobs = parseListing(listing, 'model1');
  assert.equal(jobs.length, 3);
  const first = jobs[0]!;
  assert.ok(first.title.length > 3, 'the title is the heading, not the markup around it');
  assert.match(first.applyUrl ?? '', /^https:\/\/careers-model1\.icims\.com\/jobs\/\d+\//);
  assert.ok(first.externalId, 'every posting carries an id');
  assert.ok((first.descriptionText ?? '').length > 20, 'the snippet comes across as text');
  assert.ok(!/[<>]/.test(first.title), 'no markup survives into a title');
});

test('the id is the employer’s own requisition number where the board gives one', () => {
  const jobs = parseListing(listing, 'model1');
  // Whatever shape it takes, it must be stable — never the row's position.
  for (const j of jobs) assert.match(String(j.externalId), /^[\w-]+$/);
  assert.equal(new Set(jobs.map((j) => j.externalId)).size, jobs.length, 'ids are distinct');
});

test('both wordings of the location label are read', () => {
  const oneWay = `<li class="iCIMS_JobCardItem"><span class="sr-only field-label">Location</span><span> US-NY-Smithtown</span>
    <a href="https://careers-x.icims.com/jobs/1/a/job"><h3>Kitchen Aide</h3></a></li>`;
  const other = `<li class="iCIMS_JobCardItem"><span class="sr-only field-label">Job Locations</span><span> US-OH-Toledo</span>
    <a href="https://careers-x.icims.com/jobs/2/b/job"><h3>Mobile Dental Assistant</h3></a></li>`;
  assert.equal(parseListing(oneWay, 'x')[0]?.locationRaw, 'US-NY-Smithtown');
  assert.equal(parseListing(other, 'x')[0]?.locationRaw, 'US-OH-Toledo');
});

test('a page with no job table yields nothing rather than throwing', () => {
  assert.deepEqual(parseListing('<html><body><p>Nothing here</p></body></html>', 'x'), []);
});

test('the length of the listing is read from the paginator', () => {
  assert.equal(pageCount(listing), 3);
  assert.equal(pageCount('<div>Page 3 of 22</div>'), 22);
  // No paginator at all is one page, not zero.
  assert.equal(pageCount('<html></html>'), 1);
});

test('the employer is named from the page, not from the token', () => {
  assert.equal(icimsCompanyFrom('<title>Job Listings at Catholic Health</title>'), 'Catholic Health');
  assert.equal(icimsCompanyFrom('<title>Job Listings at 360care LLC</title>'), '360care LLC');
  // The phrase is not always at the start: these two real titles named nobody
  // while the rule was anchored, and 2,589 boards were stored as their token.
  assert.equal(
    icimsCompanyFrom('<title>Fred Hutchinson Cancer Center Job Listings at Fred Hutchinson Cancer Center</title>'),
    'Fred Hutchinson Cancer Center',
  );
  assert.equal(
    icimsCompanyFrom('<title>Careers &#8211; Job Listings at North American Construction Group</title>'),
    'North American Construction Group',
  );
  // Nothing to go on is better than a wrong name.
  assert.equal(icimsCompanyFrom('<title>Search Jobs</title>'), undefined);
  assert.equal(icimsCompanyFrom(null), undefined);
});

test('a seeded board keeps the name the check recovered, not its token', async () => {
  const { readFileSync } = await import('node:fs');
  const seed = readFileSync(new URL('../src/cli/boards-seed.ts', import.meta.url), 'utf8');
  assert.match(seed, /company: named\(r\)/, 'the seeder is back to storing the title-cased token');
});

test('an iCIMS url resolves to a board the crawler can read', () => {
  const r = resolveApplyUrl('https://careers-chsli.icims.com/jobs/74805/kitchen-aide/job?in_iframe=1');
  assert.equal(r.status, 'supported', 'iCIMS is read directly now, not "unsupported"');
  if (r.status !== 'supported') return;
  assert.equal(r.board.provider, 'icims');
  assert.equal(r.board.token, 'chsli');
});

test('the provider is registered, so a stored board actually gets crawled', () => {
  assert.ok(ADAPTERS.icims, 'no adapter registered for icims');
  assert.equal(ADAPTERS.icims.provider, 'icims');
});

// ---------------------------------------------------------------------------
// Repairing the names already stored
// ---------------------------------------------------------------------------

/**
 * 2,589 boards were seeded under their token on 20 September 2026, because the
 * rule below matched "Job Listings at {employer}" only at the start of the page
 * title and most boards prefix it. boards-seed skips anything already in the
 * registry, so the corrected rule cannot reach them — hence icims-names.ts.
 */
test('the employer is read from wherever the phrase appears in the title', () => {
  // All three are real page titles, fetched from live boards that day.
  const cases: [string, string][] = [
    [
      '<title>Fred Hutchinson Cancer Center Job Listings at Fred Hutchinson Cancer Center</title>',
      'Fred Hutchinson Cancer Center',
    ],
    [
      '<title>Careers &#8211; Job Listings at North American Construction Group</title>',
      'North American Construction Group',
    ],
    ['<title>Job Listings at TIC Solutions</title>', 'TIC Solutions'],
    ['<title>Job Listings at Foley &amp; Lardner LLP</title>', 'Foley & Lardner LLP'],
  ];
  for (const [html, expected] of cases) {
    assert.equal(icimsCompanyFrom(html), expected, html);
  }
});

test('a page that names nobody names nobody', () => {
  assert.equal(icimsCompanyFrom('<title>Careers</title>'), undefined);
  assert.equal(icimsCompanyFrom('<title>Job Listings at </title>'), undefined);
  assert.equal(icimsCompanyFrom(''), undefined);
  assert.equal(icimsCompanyFrom(null), undefined);
});

test('the rename only ever touches a board still named after its token', () => {
  // oracle-names.ts learned this the hard way: its first dry run was about to
  // overwrite two boards carrying real names, read from the vendor on the first
  // discovery run, with an error page's title. A repair that can overwrite a
  // good value is not a repair, so the only row either script will touch is one
  // still carrying its own token, plain or title-cased.
  const src = readFileSync(new URL('../src/cli/icims-names.ts', import.meta.url), 'utf8');
  assert.match(src, /function isPlaceholder/);
  assert.match(src, /titleise\(token\)\.toLowerCase\(\)/);
  assert.match(src, /candidates = rows\.filter\(\(r\) => isPlaceholder/);
  // And it can only write the one column, on the one provider.
  assert.match(src, /\.eq\('provider', 'icims'\)/);
  assert.match(src, /\.update\(\{ company: w\.company \}\)/);
  assert.doesNotMatch(src, /\.delete\(|active:|closed_at/);
});

test('the rename can run where the write key actually is', () => {
  // Run from a laptop, dbWrite() falls back to the publishable key, RLS refuses
  // every update, and the script reports success having changed nothing.
  const wf = readFileSync(new URL('../.github/workflows/board-names.yml', import.meta.url), 'utf8');
  assert.match(wf, /options: \[icims, oracle\]/);
  assert.match(wf, /npm run \$\{\{ inputs\.provider \}\}:names/);
  assert.match(wf, /Fail if the write key is missing/);
  // Dry run is the default: a repair that writes by accident is the thing to
  // avoid, and the dry run is the same work minus the UPDATE.
  assert.match(wf, /dryRun:[\s\S]{0,140}?default: true/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const p of ['icims', 'oracle']) {
    assert.ok(pkg.scripts[`${p}:names`], `the workflow calls ${p}:names and package.json has no such script`);
  }
});

// ---------------------------------------------------------------------------
// Not every iCIMS board is careers-{token}
// ---------------------------------------------------------------------------

/**
 * Measured against the Common Crawl index on 22 September 2026: 19,926 iCIMS
 * URLs, 995 distinct hosts. 620 were careers-{token}.icims.com and 374 were
 * something else the employer chose. Two of those, checked live that day:
 *
 *   abudhabi-nyu.icims.com          NYU Abu Dhabi           25 jobs
 *   academiccareers-udst.icims.com  University of Doha      11 jobs
 *
 * Both were unreachable, because the address was built from the token. Both are
 * universities, which is exactly what the Institutions page is short of.
 */
test('a board is addressed by its own host when discovery saw one', () => {
  assert.equal(
    icimsListingUrl({ token: 'abudhabi-nyu', extra: { host: 'abudhabi-nyu.icims.com' } }),
    'https://abudhabi-nyu.icims.com/jobs/search?ss=1&in_iframe=1',
  );
});

test('a board seeded without a host still resolves to the careers- form', () => {
  // 2,589 boards came from the open dataset carrying a token and nothing else.
  // They were live before this change and have to stay live through it.
  assert.equal(
    icimsListingUrl({ token: 'chsli' }),
    'https://careers-chsli.icims.com/jobs/search?ss=1&in_iframe=1',
  );
});

test('a host that is not iCIMS is refused rather than trusted', () => {
  // extra.host is stored data, and stored data is the thing that goes wrong.
  // Anything that is not an icims.com name falls back instead of being fetched.
  for (const host of ['evil.example.com', 'icims.com.attacker.net', '', 'javascript:alert(1)']) {
    assert.equal(icimsHost({ token: 'acme', extra: { host } }), 'careers-acme.icims.com', host);
  }
});

test('the discovery pattern keeps the host and the employer separately', () => {
  const pattern = {
    provider: 'icims' as const,
    match: '*.icims.com/*',
    extract: /https?:\/\/([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.icims\.com)\//i,
  };
  const cases: [string, string | null, string | null][] = [
    ['https://careers-chsli.icims.com/jobs/search?ss=1', 'chsli', 'careers-chsli.icims.com'],
    ['https://abudhabi-nyu.icims.com/jobs/12/job', 'abudhabi-nyu', 'abudhabi-nyu.icims.com'],
    ['https://jobs-acme.icims.com/jobs/1/x/job', 'acme', 'jobs-acme.icims.com'],
    // iCIMS's own hosts, all present in the index sample and none an employer.
    ['https://www.icims.com/products/', null, null],
    ['https://www3.icims.com/anything', null, null],
    ['https://careers.icims.com/x', null, null],
  ];
  for (const [url, token, host] of cases) {
    const board = toBoard(pattern as never, url);
    assert.equal(board?.token ?? null, token, url);
    assert.equal((board?.extra as Record<string, string> | undefined)?.host ?? null, host, url);
  }
});

test('careers-chsli and chsli are one board, not two', () => {
  // The seeded rows carry the bare token. If discovery stored the prefixed
  // label instead, every seeded board would be found again as a second copy.
  const pattern = {
    provider: 'icims' as const,
    match: '*.icims.com/*',
    extract: /https?:\/\/([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.icims\.com)\//i,
  };
  assert.equal(toBoard(pattern as never, 'https://careers-chsli.icims.com/jobs/1/')?.token, 'chsli');
});

test('iCIMS is in the weekly sweep, not only in the seeding list', () => {
  // It was the one supported provider discovery was never wired to, so its
  // coverage was frozen at whatever a single open dataset happened to hold: an
  // employer adopting iCIMS afterwards could never be found.
  const wf = readFileSync(new URL('../.github/workflows/discover.yml', import.meta.url), 'utf8');
  const matrix = /provider: \$\{\{ fromJSON\(.*'(\["[a-z]+"(?:,"[a-z]+")*\])'\) \}\}/.exec(wf);
  assert.ok(matrix, 'the discovery matrix is gone');
  assert.ok((JSON.parse(matrix[1]!) as string[]).includes('icims'));
  assert.match(wf, /options: \[all,[^\]]*\bicims\b/);
});
