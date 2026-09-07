import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifySector, SECTOR_ORDER, SECTOR_LABELS } from '../src/taxonomy/sector.js';
import { isAdmin, adminEmails } from '../src/state/admin.js';

/**
 * Sector detection, the admin gate, and the crawl-order fix.
 *
 * The sector tests are written the wrong way round on purpose: the failure that
 * matters is a venture-funded startup appearing on a page whose entire promise
 * is "these employers struggle to hire". A missed hospital is a smaller loss
 * than a fake one.
 */

// ---------------------------------------------------------------------------
// Sector: the institutions
// ---------------------------------------------------------------------------

const CORNELL = `The Facilities and Campus Services unit at the University seeks a Senior
Engineer. You will work with faculty, students and academic units across campus.
Cornell is an equal opportunity employer and educator.`;

const HOSPITAL = `Join our health system as a Data Engineer supporting clinical staff across
eight hospitals. You will work alongside the care team and report to the CMIO.
Experience in an academic medical center is preferred.`;

const CHARITY = `We are a registered charity and a 501(c)(3) organization. This role is
grant-funded for two years and reports to the Director of Programs. Our donors
expect careful stewardship of every dollar.`;

const COUNCIL = `The County of Alameda is recruiting a Systems Analyst. This is a
classified service position within the merit system. Local authority experience
is desirable.`;

for (const [text, expected, who] of [
  [CORNELL, 'education', 'a university'],
  [HOSPITAL, 'health', 'a hospital'],
  [CHARITY, 'nonprofit', 'a charity'],
  [COUNCIL, 'government', 'a county'],
] as [string, string, string][]) {
  test(`${who} is recognised from its own advert`, () => {
    assert.equal(classifySector({ title: 'Data Engineer', descriptionText: text }).sector, expected);
  });
}

// ---------------------------------------------------------------------------
// Sector: the vendors that talk like them
// ---------------------------------------------------------------------------

for (const [text, who] of [
  [
    // Bayesian Health. Tripped the clinical-language test on "care team members"
    // until "startup" was treated as decisive.
    `We are a startup on a mission to make healthcare proactive by empowering
     physicians, nurses, and care team members with real-time data to save lives.`,
    'a health-tech startup calling itself one',
  ],
  [
    // Ambience Healthcare. "our health system partners" — its customers' wards.
    `Ambience delivers coding-aware documentation and clinical workflow support
     across ambulatory, emergency and inpatient settings at the top health
     systems in North America. Our teams build for our health system partners.`,
    'a vendor describing its customers',
  ],
  [
    `Series B company building the operating system for universities. Our
     platform serves students at over 300 campuses.`,
    'an ed-tech vendor',
  ],
  [
    `The Aptos Foundation supports the growth of the Aptos blockchain. Work with
     our community and our partners across the ecosystem.`,
    'a crypto foundation',
  ],
] as [string, string][]) {
  test(`${who} is not an institution`, () => {
    assert.equal(classifySector({ title: 'Software Engineer', descriptionText: text }).sector, null);
  });
}

test('a name alone never establishes a sector', () => {
  // This is the whole reason the column exists. Matching slugs returned
  // alpacahealth, bayesianhealth and ambiencehealthcare — startups, not
  // hospitals — so a name with no advert behind it claims nothing.
  for (const token of ['alpacahealth', 'bayesianhealth', 'harvard', 'clevelandclinic']) {
    assert.equal(
      classifySector({ title: 'Data Engineer', company: token, token }).sector,
      null,
      `${token} was decided on its name`,
    );
  }
});

test('no description means no verdict, not a guess', () => {
  // Workday and UKG listings often carry none. Null here is "we have not
  // assessed this", and the page says exactly that rather than "not an
  // institution".
  assert.equal(classifySector({ title: 'Cloud Engineer', descriptionText: '' }).sector, null);
  assert.equal(classifySector({ title: 'Cloud Engineer', descriptionText: null }).sector, null);
});

test('a university hospital is decided by the employer name, not by list order', () => {
  // It genuinely reads as both. Education comes first in SECTOR_ORDER, so
  // without the tie-break every hospital attached to a medical school would be
  // filed under universities.
  const both = `${CORNELL}\n${HOSPITAL}`;
  assert.equal(
    classifySector({ title: 'Data Engineer', descriptionText: both, company: 'mountsinai-hospital' }).sector,
    'health',
  );
  assert.equal(
    classifySector({ title: 'Data Engineer', descriptionText: both, company: 'cornell-university' }).sector,
    'education',
  );
});

test('every sector has a label and the two lists agree', () => {
  for (const s of SECTOR_ORDER) {
    assert.ok(SECTOR_LABELS[s], `${s} has no label`);
  }
  assert.equal(Object.keys(SECTOR_LABELS).length, SECTOR_ORDER.length);
});

// ---------------------------------------------------------------------------
// The admin gate
// ---------------------------------------------------------------------------

test('only the listed address is an admin', () => {
  assert.equal(isAdmin('abburimadhukar1@gmail.com'), true);
  assert.equal(isAdmin('someone.else@gmail.com'), false);
  assert.equal(isAdmin(''), false);
  assert.equal(isAdmin(null), false);
  assert.equal(isAdmin(undefined), false);
});

test('the address is matched case- and space-insensitively', () => {
  // Nobody thinks of their own email as case-sensitive, and a capital typed
  // into a sign-in form must not silently revoke access.
  assert.equal(isAdmin('Abburimadhukar1@Gmail.com'), true);
  assert.equal(isAdmin('  abburimadhukar1@gmail.com  '), true);
});

test('a near-miss address is not an admin', () => {
  assert.equal(isAdmin('abburimadhukar1@gmail.com.evil.com'), false);
  assert.equal(isAdmin('xabburimadhukar1@gmail.com'), false);
  assert.equal(isAdmin('abburimadhukar1@gmail.co'), false);
});

test('the admin list is never empty', () => {
  // An empty list would lock the owner out of their own site rather than fail
  // open, but it would do so silently.
  assert.ok(adminEmails().length > 0);
});

test('the route decides admin rights, and the browser is never asked', () => {
  const route = readFileSync(new URL('../app/api/admin/route.ts', import.meta.url), 'utf8');

  // The email must come from the verified session and from nowhere else. A
  // query parameter or a header would be settable by anyone.
  assert.match(route, /isAdmin\(session\?\.user\?\.email\)/);
  assert.doesNotMatch(route, /searchParams/);

  // 404, not 403. A 403 confirms the route exists and that someone else can
  // reach it; 404 says nothing at all.
  // From the gate to the first read. Slicing to the next mention of canWrite
  // reads backwards, because the import line names it first and the slice comes
  // back empty — which passes every assertion made against it.
  const gateAt = route.indexOf('if (!isAdmin');
  const gate = route.slice(gateAt, route.indexOf('const client =', gateAt));
  assert.ok(gate.length > 0, 'expected an admin gate before any data is read');
  assert.match(gate, /status: 404/);
  assert.doesNotMatch(gate, /status: 403/);

  // Counts, never content. Seeing what a colleague applied to is a shared-team
  // fact; reading their CV is not.
  assert.doesNotMatch(route, /resume_text|\bresume\b\s*:/);
  assert.match(route, /resume_chars/);
});

test('the page treats the API as the authority, not a hint', () => {
  const page = readFileSync(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');
  // No email comparison in the browser: a second copy of the rule is a second
  // chance to disagree with the first.
  assert.doesNotMatch(page, /@gmail|adminEmails|isAdmin\(/);
  assert.match(page, /404/);
});

// ---------------------------------------------------------------------------
// Common Crawl: one vendor per job
// ---------------------------------------------------------------------------

test('the harvest reads only the requested vendor', async () => {
  const { harvestCommonCrawl } = await import('../src/discovery/commoncrawl.js');
  // Every job in the matrix read the WHOLE index and discarded all but its own
  // provider — eleven times the load for one eleventh of the value, which is
  // what made Common Crawl start refusing pages.
  const src = readFileSync(new URL('../src/discovery/commoncrawl.ts', import.meta.url), 'utf8');
  assert.match(src, /const patterns = opts\.provider \? PATTERNS\.filter/);
  assert.equal(typeof harvestCommonCrawl, 'function');

  // A provider with no pattern returns nothing and does not throw. Throwing
  // took the whole discovery workflow red on every run — see resilience.test.ts.
  const none = await harvestCommonCrawl({ userAgent: 'test', crawl: 'x', provider: 'lever' });
  assert.deepEqual(none.boards, []);
  assert.deepEqual(none.reports, []);
});

test('a refused index page is counted, not swallowed', () => {
  const src = readFileSync(new URL('../src/discovery/commoncrawl.ts', import.meta.url), 'utf8');
  // The silence was the bug: runs reported success while each held a different
  // partial view of the index.
  assert.match(src, /pagesRead/);
  assert.match(src, /pagesTotal/);
  assert.match(src, /LOST/);

  const cli = readFileSync(new URL('../src/cli/harvest-cc.ts', import.meta.url), 'utf8');
  assert.match(cli, /index page\(s\) refused/);
  assert.match(cli, /not evidence that a board is gone/);
});

// ---------------------------------------------------------------------------
// UKG was throwing away its own description text
// ---------------------------------------------------------------------------

test('UKG keeps the description its listing already carries', () => {
  const src = readFileSync(new URL('../src/ats/adapters/ukg.ts', import.meta.url), 'utf8');
  // BriefDescription was declared in the interface when the adapter was written
  // and never read, so 2,233 postings arrived carrying text that was dropped —
  // text the classifier, the resume match and the sector rules all want, and
  // which no second request can recover for this provider.
  assert.match(src, /BriefDescription/);
  assert.match(src, /descriptionText \? \{ descriptionText \}/);
});
