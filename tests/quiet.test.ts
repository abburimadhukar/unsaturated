import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  MAGNET_TITLES,
  MAGNET_PATTERN,
  isMagnetTitle,
  quietReasons,
  quietScore,
  SYNDICATED_PROVIDERS,
} from '../src/taxonomy/quiet.js';
import { renderMigration, MIGRATION_PATH } from '../src/cli/quiet-sql.js';
import { classifyRole } from '../src/taxonomy/families.js';

/**
 * Quiet roles: the same work under a title nobody searches for.
 *
 * The rule that matters is what is NOT quiet. A magnet title wrongly treated as
 * quiet puts the most contested job on the site at the top of a page whose
 * entire promise is the opposite, so the popular names are tested one by one.
 */

// ---------------------------------------------------------------------------
// The magnet list
// ---------------------------------------------------------------------------

for (const title of [
  // The head of each family, measured in the live corpus.
  'Software Engineer',
  'Senior Software Engineer',
  'Staff Software Engineer',
  'Software Engineer II',
  'Software Developer',
  'DevOps Engineer',
  'Site Reliability Engineer',
  'Platform Engineer',
  'Network Engineer',
  'Security Engineer',
  'Cloud Engineer',
  'Solutions Architect',
  'Data Engineer',
  'Data Scientist',
  'Data Analyst',
  'Business Analyst',
  'Machine Learning Engineer',
  'Engineering Manager',
  'AI Engineer',
  'Payroll Specialist',
  'Workday Analyst',
]) {
  test(`"${title}" is a magnet, never quiet`, () => {
    assert.equal(isMagnetTitle(title), true);
  });
}

for (const title of [
  // Spelling variants employers actually use for the same magnet role.
  'Front-End Developer',
  'Front End Developer',
  'Frontend Developer',
  'Back-End Engineer',
  'Full-Stack Engineer',
  'Full Stack Developer',
  'Site Reliability Engineer (SRE)',
  'SRE',
  'SDET',
]) {
  test(`"${title}" is caught despite the spelling`, () => {
    assert.equal(isMagnetTitle(title), true);
  });
}

for (const title of [
  // Real off-magnet titles from the corpus — the page's actual inventory.
  'Cloud Operations Analyst',
  'Technical Support Engineer',
  'Systems Administrator',
  'Database Administrator',
  'IT Automation Engineer',
  'DevSecOps Engineer',
  'Integration Architect',
  'Quant Library Developer',
  'Business Systems Analyst',
  'Compensation Analyst',
  'Scheduling Systems Analyst',
]) {
  test(`"${title}" is quiet`, () => {
    assert.equal(isMagnetTitle(title), false);
  });
}

test('a magnet inside a longer title still counts', () => {
  // "Senior Software Engineer, Payments (Remote)" is the most contested kind of
  // posting there is. Anchoring the pattern would have missed every one.
  assert.equal(isMagnetTitle('Senior Software Engineer, Payments (Remote)'), true);
  assert.equal(isMagnetTitle('Data Engineer - Analytics Platform'), true);
  assert.equal(isMagnetTitle('Lead DevOps Engineer (m/w/d)'), true);
});

test('a magnet word buried inside another word does not count', () => {
  // The pattern uses letter boundaries rather than \b so that "swe" cannot
  // match inside "answer" and "sre" cannot match inside "presrelease".
  assert.equal(isMagnetTitle('Answering Services Coordinator'), false);
  assert.equal(isMagnetTitle('Presrelease Coordinator'), false);
});

test('the magnet list is global, not per family', () => {
  // Measured: 88 postings titled plain "Software Engineer" are classified
  // cloud, not software. With a per-family list every one of them escaped
  // cloud's filter and landed on the quiet page — the single worst thing that
  // could appear there.
  assert.equal(classifyRole({ title: 'Software Engineer', descriptionText: 'kubernetes terraform aws' } as never).family, 'cloud');
  assert.equal(isMagnetTitle('Software Engineer'), true);
});

test('every magnet phrase is lowercase and free of regex metacharacters', () => {
  for (const t of MAGNET_TITLES) {
    assert.equal(t, t.toLowerCase(), `${t} must be lowercase`);
    assert.doesNotMatch(t, /[.*+?^${}()|[\]\\]/, `${t} must not contain regex syntax`);
  }
});

// ---------------------------------------------------------------------------
// The migration has to say the same thing as the TypeScript
// ---------------------------------------------------------------------------

test('the checked-in migration matches the magnet list', () => {
  // The pattern exists twice — here and in SQL — because the filter must run in
  // the database. Editing the list and forgetting to regenerate would leave the
  // site filtering on a stale list with nothing to say so.
  assert.ok(existsSync(MIGRATION_PATH), 'run: npm run quiet:sql');
  assert.equal(
    readFileSync(MIGRATION_PATH, 'utf8'),
    renderMigration(),
    'migration is out of date — run: npm run quiet:sql',
  );
});

test('the migration is safe to paste into a production database', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  // The near-outage rule: this project once dropped feed_page and feed_facets
  // and then failed to parse, and only the editor's transaction saved the site.
  // Nothing here may touch a function at all.
  assert.doesNotMatch(sql, /drop\s+function/i);
  assert.doesNotMatch(sql, /create\s+(or replace\s+)?function/i);
  assert.doesNotMatch(sql, /drop\s+table/i);
  assert.doesNotMatch(sql, /delete\s+from/i);

  // Wrapped, and re-runnable.
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
  assert.match(sql, /add column if not exists quiet/i);
  assert.match(sql, /create index if not exists/i);

  // The literal must not be escapable out of.
  const literal = /generated always as \(title !~\* '([^']*)'\) stored/.exec(sql);
  assert.ok(literal, 'expected a single-quoted pattern literal');
  assert.equal(literal[1], MAGNET_PATTERN);

  // Counted over the STATEMENTS only. The prose above them is free to contain
  // an apostrophe; a stray quote in the executable half would end the pattern
  // literal early and turn the rest of the regex into SQL.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  assert.equal(statements.split("'").length - 1, 2, 'exactly one quoted literal in the SQL');
});

// ---------------------------------------------------------------------------
// Why a role is quiet
// ---------------------------------------------------------------------------

test('the first reason is always the one the page exists for', () => {
  const r = quietReasons({ title: 'Cloud Operations Analyst', provider: 'workday' });
  assert.match(r[0]!, /do not search/);
});

test('reasons are read off columns, never invented', () => {
  const onSiteWorkday = quietReasons({
    title: 'Cloud Operations Analyst',
    provider: 'workday',
    remoteType: 'on_site',
    seniority: 'staff',
  });
  assert.ok(onSiteWorkday.some((r) => /geography/.test(r)));
  assert.ok(onSiteWorkday.some((r) => /rarely syndicated/.test(r)));
  assert.ok(onSiteWorkday.some((r) => /needs an account/.test(r)));
  assert.ok(onSiteWorkday.some((r) => /small qualified pool/.test(r)));

  // A remote Greenhouse role earns none of them, and must claim none.
  const remoteGreenhouse = quietReasons({
    title: 'Cloud Operations Analyst',
    provider: 'greenhouse',
    remoteType: 'fully_remote',
    seniority: 'entry',
  });
  assert.equal(remoteGreenhouse.length, 1);
});

test('a fully remote entry-level role on a syndicated board scores lowest', () => {
  // Remote postings draw 2.5-3.4x the applicants of the same job on-site, and
  // entry level is the most contested tier there is. The score has to agree.
  const worst = quietScore({
    title: 'Cloud Operations Analyst',
    provider: 'greenhouse',
    remoteType: 'fully_remote',
    seniority: 'entry',
  });
  const best = quietScore({
    title: 'Cloud Operations Analyst',
    provider: 'ukg',
    remoteType: 'on_site',
    seniority: 'principal',
  });
  assert.ok(worst < best, `${worst} should be below ${best}`);
  assert.ok(worst >= 0 && best <= 100);
});

test('the syndicated list is the three boards every aggregator scrapes', () => {
  assert.deepEqual([...SYNDICATED_PROVIDERS].sort(), ['ashby', 'greenhouse', 'lever']);
});

// ---------------------------------------------------------------------------
// The classifier leak this page exposed
// ---------------------------------------------------------------------------

const family = (t: string) => classifyRole({ title: t, descriptionText: '' } as never).family;

for (const title of [
  // 41 "Target Security Specialist" postings were the single most common result
  // on the quiet cloud page — store loss prevention, ranked first on a page
  // about cloud engineering. A bare "security specialist" is physical far more
  // often than technical.
  'Target Security Specialist',
  'Store Security Specialist',
  'Personnel Security Specialist',
  'Security Specialist',
  'Senior Security Specialist',
]) {
  test(`"${title}" is not an infosec role`, () => {
    assert.notEqual(family(title), 'cloud');
  });
}

for (const title of [
  // …while everything genuinely technical keeps its family. "Security Engineer"
  // alone is 652 correctly classified postings; narrowing must not cost them.
  'Security Engineer',
  'Senior Security Engineer',
  'Security Architect',
  'Security Analyst',
  'Security Engineering Lead',
  'Security Consultant',
  'Application Security Specialist',
  'Cyber Security Specialist',
  'Information Security Specialist',
  'Cloud Security Specialist',
  'SOC Specialist',
]) {
  test(`"${title}" is still cloud`, () => {
    assert.equal(family(title), 'cloud');
  });
}

// ---------------------------------------------------------------------------
// The filters added on 20 September 2026
// ---------------------------------------------------------------------------

/**
 * Source-level, deliberately. These are statements about how the two routes
 * build their queries, and checking them for real would mean standing up a
 * Postgres with a representative corpus in it — which would test the fixture
 * rather than the rule.
 */
const quietRoute = readFileSync(new URL('../app/api/quiet/route.ts', import.meta.url), 'utf8');
const instRoute = readFileSync(new URL('../app/api/institutions/route.ts', import.meta.url), 'utf8');

test('a country facet is not narrowed by the country already chosen', () => {
  // Counting each country WITH the chosen country applied would report the
  // size of a country intersected with itself and every other country as zero,
  // so the dropdown would empty itself the moment it was used.
  for (const [name, src] of [['quiet', quietRoute], ['institutions', instRoute]] as const) {
    assert.match(src, /withPlace = true/, `${name} has no facet escape hatch`);
    assert.match(
      src,
      /COUNTRY_FACETS\.map\([\s\S]{0,200}?base\(\{ withPlace: false \}\)/,
      `${name} counts its countries through the country filter`,
    );
  }
});

test('the navigation tabs ignore the filters set beneath them', () => {
  // A family tab that reads 0 because of a country picked on another tab is
  // how someone concludes the page is broken rather than filtered.
  assert.match(quietRoute, /FAMILIES\.map\([\s\S]{0,160}?base\(\{ withPlace: false \}\)/);
  assert.match(instRoute, /SECTOR_ORDER\.map\([\s\S]{0,160}?base\(\{ withPlace: false \}\)/);
});

test('roles we could not place are selectable, and never folded into a country', () => {
  // A fifth of the corpus has no country. Adding those to whichever country was
  // picked makes the count beside the option wrong and the label a lie — the
  // mistake the main feed made, where "United States" returned 3,204 postings
  // whose country could not be read. Dropping them silently would instead hide
  // a fifth of the page, so they are their own option and their own count.
  for (const src of [quietRoute, instRoute]) {
    assert.match(src, /const UNPLACED = '__unknown__'/);
    assert.match(src, /country === UNPLACED \? q\.is\('country', null\)/);
    assert.match(src, /countryUnknown/, 'the unplaced option has no count to show');
    assert.doesNotMatch(src, /includeUnknown/, 'the folded-in behaviour is back');
  }
});

test('search text cannot break out of the filter grammar', () => {
  // PostgREST's or() takes a comma-separated list in parentheses, so an
  // unescaped comma or bracket in the search box would not be a failed search,
  // it would be a different query.
  for (const src of [quietRoute, instRoute]) {
    assert.match(src, /replace\(\/\[\(\),\*\]\/g, ' '\)/);
  }
});

test('employment type is not offered as a filter', () => {
  // Measured on the live corpus: the stored values are raw vendor text —
  // "Full-Time", "Full Time", "Full time", "permanent / full-time", "Homeoffice"
  // and one literal "__". Filtering on that shows a fraction of what matches
  // and looks broken. It stays out until the values are normalised.
  for (const src of [quietRoute, instRoute]) {
    assert.doesNotMatch(src, /eq\('employment_type'/);
  }
});

test('specialization is offered on institutions and not on quiet roles', () => {
  // 68% of institution roles carry one against 17% of quiet ones. The same
  // control is honest on one page and misleading on the other.
  assert.match(instRoute, /eq\('specialization', specialization\)/);
  assert.doesNotMatch(quietRoute, /eq\('specialization'/);
});

test('quietest-first is ranked over a stated pool, not over the page', () => {
  // quietScore reads the title with a regex and cannot be an ORDER BY — the
  // same reason `quiet` is a stored column. So it ranks the newest POOL rows
  // and the page says so rather than implying the rank covers everything.
  assert.match(quietRoute, /const POOL = \d+/);
  assert.match(quietRoute, /rankedCapped: \(count \?\? 0\) > POOL/);
  assert.match(quietRoute, /reachable = ranked \? Math\.min/);
  const page = readFileSync(new URL('../app/quiet/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /rankedCapped/, 'the page never tells anyone the rank is capped');
});
