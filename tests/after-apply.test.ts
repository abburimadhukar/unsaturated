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
  recentDetail: '', recentSource: '',
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

test('a recent-activity hook is kept only when its own source was consulted', () => {
  // The "your in" — the single biggest reply-rate lever — rides on the same
  // provenance rule as the person: shown only when its URL was actually consulted.
  const good = parseResearchResponse(payload({
    contacts: [{ ...contact, recentDetail: 'posted about migrating the warehouse to Iceberg', recentSource: source }],
    signals: [],
  }), new Date());
  assert.equal(good?.contacts[0]?.recentDetail, 'posted about migrating the warehouse to Iceberg');
  assert.equal(good?.contacts[0]?.recentSource, source);

  // A hook citing a page the search never consulted is dropped, but the person
  // (whose own source WAS consulted) is still kept — never invent what they did.
  const unsourced = parseResearchResponse(payload({
    contacts: [{ ...contact, recentDetail: 'spoke at a conference', recentSource: 'https://unrelated.test/talk' }],
    signals: [],
  }), new Date());
  assert.equal(unsourced?.contacts.length, 1);
  assert.equal(unsourced?.contacts[0]?.recentDetail, '');
  assert.equal(unsourced?.contacts[0]?.recentSource, '');
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

test('a one-click draft fills the proof as a marked placeholder, never a fabrication', () => {
  // "Use this contact" drafts immediately, before the applicant types their own
  // result. The gap becomes a visible placeholder — the one thing the app cannot
  // know since it stores no resume — so the message is sendable after one edit.
  const draft = outreachDraft({
    contactName: 'Jordan Lee', contactType: 'manager', company: 'Example Cloud',
    jobTitle: 'Data Engineer', sourceDetail: 'I saw your Iceberg migration post', proof: '',
  });
  assert.match(draft, /Hi Jordan/);
  assert.match(draft, /\[one sentence on your most relevant result\]/);
  assert.doesNotMatch(draft, /referred|hiring manager|guarantee/i);
  // A draft still needs a specific detail to be worth sending.
  assert.equal(outreachDraft({
    contactName: 'Jordan Lee', contactType: 'manager', company: 'Example Cloud',
    jobTitle: 'Data Engineer', sourceDetail: '', proof: '',
  }), '');
});

test('the workspace drafts on "Use this contact", shows the hook, and renders the liveness read', () => {
  const ws = readFileSync(new URL('../app/_components/AfterApplyWorkspace.tsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../app/after-apply/page.tsx', import.meta.url), 'utf8');
  // One click builds a draft, gated on the same "I applied" confirmation.
  assert.match(ws, /setDraft\(confirmed/);
  assert.match(ws, /outreachDraft\(\{ contactName: lead\.name/);
  // The hook is shown, preferred over the connection as the opening detail.
  assert.match(ws, /lead\.recentDetail/);
  assert.match(ws, /aahook/);
  // The liveness banner is rendered from a server-computed prop.
  assert.match(ws, /aaliveness-\$\{liveness\.tone\}/);
  assert.match(page, /jobLiveness\(\{/);
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

test('both pages send the back link their path AND their filters', () => {
  // Since the "return to my place" fix the back target carries the filters, so
  // returning lands on the same view rather than a bare page.
  for (const [path, page] of [
    ['/quiet', '../app/quiet/page.tsx'],
    ['/institutions', '../app/institutions/page.tsx'],
  ] as const) {
    const src = readFileSync(new URL(page, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`\`${path}\\?\\$\\{qs\\}\``), `${path} does not carry its filters`);
    assert.match(src, /backTo=\{backTo\}/, `${path} does not pass the computed backTo`);
  }
});

test('the back link is validated before it becomes an href', () => {
  // `from` arrives in the query string and ends up in an anchor's href, so it is
  // validated by safeBackTo (tested exhaustively in back-link.test.ts) rather
  // than trusted. The old unchecked fixed map must be gone.
  assert.match(aaPage, /safeBackTo\(from\)/);
  assert.doesNotMatch(aaPage, /const BACK_TO/);
});

test('resume tailoring is gone from every card, and After applying is not', () => {
  // Tailoring was removed on 25 Sep 2026. This used to assert the feed still
  // gated its tailor button; now it asserts nothing links to /tailor at all —
  // and, the part that matters, that removing it did not take After applying
  // off the cards with it. Asserted on the LINKS, not labels, because comments
  // name both.
  const feed = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  for (const [name, src] of [['JobCard', card], ['feed', feed]] as const) {
    assert.doesNotMatch(src, /href=\{?`?\/tailor/, `${name} still links to /tailor`);
    assert.match(src, /\/after-apply\?job=\$\{encodeURIComponent\(/, `${name} lost its After applying link`);
  }
});
