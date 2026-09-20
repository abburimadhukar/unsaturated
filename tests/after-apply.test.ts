import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPublicSourceUrl, outreachDraft } from '../src/after-apply/draft.js';
import { parseBraveResults, researchLanes, searchPublicSources } from '../src/after-apply/research.js';

test('research links include company and role without making up a person', () => {
  const lanes = researchLanes('Example Cloud', 'Data Engineer');
  assert.equal(lanes.length, 3);
  assert.ok(lanes[0]!.query.includes('"Example Cloud"'));
  assert.ok(lanes[0]!.query.includes('"Data Engineer"'));
  assert.ok(lanes[0]!.query.includes('site:linkedin.com/in'));
  for (const lane of lanes) {
    const url = new URL(lane.searchUrl);
    assert.equal(url.hostname, 'search.brave.com');
    assert.equal(url.searchParams.get('q'), lane.query);
  }
});

test('Brave parser rejects non-web URLs and de-duplicates results', () => {
  const leads = parseBraveResults({ web: { results: [
    { title: 'No', url: 'javascript:alert(1)' },
    { title: 'Profile', url: 'https://example.org/person', description: 'Potential lead' },
    { title: 'Duplicate', url: 'https://example.org/person' },
    { title: 'Malformed', url: 'not a url' },
  ] } });
  assert.deepEqual(leads, [{ title: 'Profile', url: 'https://example.org/person', description: 'Potential lead' }]);
});

test('public scan makes three bounded server-side requests and tolerates one failure', async () => {
  const calls: URL[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    calls.push(url);
    assert.equal(new Headers(init?.headers).get('X-Subscription-Token'), 'secret');
    if (url.searchParams.get('q')?.includes('recruiter')) return new Response('', { status: 429 });
    return Response.json({ web: { results: [{ title: 'Lead', url: 'https://example.org/person' }] } });
  };
  const groups = await searchPublicSources('Example Cloud', 'Data Engineer', 'secret', mockFetch);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => url.hostname === 'api.search.brave.com' && url.searchParams.get('count') === '5'));
  assert.equal(groups[0]!.leads.length, 1);
  assert.equal(groups[1]!.unavailable, true);
  assert.equal(groups[2]!.leads.length, 1);
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
