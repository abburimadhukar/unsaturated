import { test } from 'node:test';
import assert from 'node:assert/strict';

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
