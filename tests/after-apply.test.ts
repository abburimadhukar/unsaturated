import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isPublicSourceUrl, outreachDraft } from '../src/after-apply/draft.js';
import { parseResearchResponse, researchJob, RESEARCH_MODEL } from '../src/after-apply/research.js';

const source = 'https://example.org/team/jordan-lee';
const contact = {
  name: 'Jordan Lee', role: 'Engineering Director', category: 'Team leadership',
  connection: 'Jordan leads the employer data platform team',
  whyRelevant: 'The job concerns data platforms',
  sourceUrl: source, sourceTitle: 'Example Cloud team',
};
const payload = (json: object, urls = [source]) => ({
  status: 'completed',
  output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: urls.map((url) => ({ url })) } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json), annotations: [] }] },
  ],
});

test('shows direct named contacts only when the search actually consulted their public source', () => {
  const report = parseResearchResponse(payload({
    contacts: [contact, { ...contact, name: 'Wrong Company', sourceUrl: 'https://unrelated.test/person' }],
    signals: [{ title: 'Data platform', detail: 'The team built a data platform', sourceUrl: source, sourceTitle: 'Team page' }],
  }), new Date('2026-09-20T00:00:00Z'));
  assert.equal(report?.contacts.length, 1);
  assert.equal(report?.contacts[0]?.name, 'Jordan Lee');
  assert.equal(report?.signals.length, 1);
  assert.equal(report?.searchedAt, '2026-09-20T00:00:00.000Z');
  assert.equal(parseResearchResponse(payload({ contacts: [contact], signals: [] }, [])), null);
  assert.equal(parseResearchResponse({ status: 'completed', output: [{ type: 'message', content: [] }] }), null);
});

test('research sends one bounded server-side web search using the existing OpenAI key', async () => {
  let calls = 0;
  const mockFetch: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer secret');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, RESEARCH_MODEL);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.max_tool_calls, 4);
    assert.equal(body.store, false);
    assert.match(String(body.input), /Example Cloud/);
    return Response.json(payload({ contacts: [contact], signals: [] }));
  };
  const report = await researchJob({ company: 'Example Cloud', title: 'Data Engineer', applyUrl: 'https://jobs.example.org/123' }, 'secret', mockFetch);
  assert.equal(calls, 1);
  assert.equal(report?.contacts[0]?.name, 'Jordan Lee');
});

test('draft uses only supplied experience and no invented referral', () => {
  const draft = outreachDraft({
    contactName: 'Jordan Lee', contactType: 'manager', company: 'Example Cloud',
    jobTitle: 'Data Engineer', sourceDetail: 'I saw the new data platform launch',
    proof: 'I cut pipeline latency by 40% at my last company',
  });
  assert.match(draft, /Hi Jordan/);
  assert.match(draft, /I recently applied/);
  assert.match(draft, /I cut pipeline latency by 40%/);
  assert.doesNotMatch(draft, /referred|hiring manager|guarantee/i);
  assert.equal(outreachDraft({
    contactName: '', contactType: 'recruiter', company: 'Example Cloud',
    jobTitle: 'Data Engineer', sourceDetail: '', proof: 'experience',
  }), '');
});

test('a contact must have a normal HTTPS source before drafting', () => {
  assert.equal(isPublicSourceUrl('https://www.linkedin.com/in/example'), true);
  assert.equal(isPublicSourceUrl('javascript:alert(1)'), false);
  assert.equal(isPublicSourceUrl('http://example.org/person'), false);
  assert.equal(isPublicSourceUrl('https://user:password@example.org/person'), false);
});

// ---------------------------------------------------------------------------
// Reaching it from Quiet Roles and Institutions
// ---------------------------------------------------------------------------

/**
 * After applying was reachable only from the main feed, so the two pages that
 * surface the LEAST contested roles were the two you could not research an
 * employer from. The shared card carries the same actions row now.
 */
const card = readFileSync(new URL('../app/_components/JobCard.tsx', import.meta.url), 'utf8');
const aaPage = readFileSync(new URL('../app/after-apply/page.tsx', import.meta.url), 'utf8');

test('the shared card links every posting to After applying', () => {
  assert.match(card, /\/after-apply\?job=\$\{encodeURIComponent\(job\.key\)\}/);
  // The key goes in a URL, and some of them carry a Workday path with slashes
  // in it — workday:mbda:/job/Bristol/Software-Engineer_R37445.
  assert.match(card, /encodeURIComponent\(job\.key\)/);
  assert.match(card, /encodeURIComponent\(backTo\)/);
});

test('both pages say where the back link should return to', () => {
  for (const [path, page] of [
    ['/quiet', '../app/quiet/page.tsx'],
    ['/institutions', '../app/institutions/page.tsx'],
  ] as const) {
    const src = readFileSync(new URL(page, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`backTo="${path}"`), `${path} does not pass backTo`);
  }
});

test('the back link can only point at pages on this site', () => {
  // `from` arrives in the query string and ends up in an anchor's href, so it
  // is matched against a fixed list rather than checked as a string. Anything
  // else falls back to the feed, and a crafted link cannot turn this page's own
  // navigation into a way off the site.
  assert.match(aaPage, /const BACK_TO: Record<string, \{ href: string; label: string \}>/);
  assert.match(aaPage, /const back = \(from && BACK_TO\[from\]\) \|\| BACK_TO\['\/'\]!/);
  // Every allowed target is a root-relative path.
  const entries = [...aaPage.matchAll(/'(\/[a-z-]*)': \{ href: '(\/[a-z-]*)'/g)];
  assert.ok(entries.length >= 3, `expected the three list pages, found ${entries.length}`);
  for (const [, key, href] of entries) {
    assert.equal(key, href, 'the key and its href must agree');
    assert.match(href!, /^\/[a-z-]*$/, `${href} is not a path on this site`);
  }
});

test('the card does not offer tailoring it cannot deliver', () => {
  // The feed gates tailoring on the vendors that publish a readable description
  // — 5,727 open postings have none. An ungated copy here would be a button
  // that can only ever explain why it does not work.
  //
  // Asserted on the LINK rather than the label, because the label is named in
  // the comment beside the actions row explaining why it is absent.
  assert.doesNotMatch(card, /href=\{?`?\/tailor\?job=/);
  // And the feed's own gate is still there, so this stays a deliberate
  // difference rather than a feature quietly removed from both.
  const feed = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(feed, /CAN_TAILOR\.has\(j\.provider\)/);
});
