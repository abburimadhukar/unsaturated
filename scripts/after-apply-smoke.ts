import { researchJob } from '../src/after-apply/research.js';

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) throw new Error('OPENAI_API_KEY is missing; live research cannot be deployed.');

// A real public posting is used only to check the deployed API contract. No
// names are expected: it is valid for careful research to return no people.
const report = await researchJob({
  title: 'Software Engineer - 2027 New Grad',
  company: 'Metabit Technology LLC',
  applyUrl: 'https://job-boards.greenhouse.io/metabittechnologyllc/jobs/4412310009',
}, key, async (url, init) => {
  const response = await fetch(url, init);
  const payload = await response.clone().json() as {
    status?: string;
    output?: Array<{ type?: string; action?: { sources?: Array<{ url?: string }> }; content?: Array<{ text?: string; annotations?: Array<{ url?: string }> }> }>;
  };
  const text = payload.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('') ?? '';
  let rawContacts: Array<{ name?: string; sourceUrl?: string }> = [];
  try { rawContacts = (JSON.parse(text) as { contacts?: typeof rawContacts }).contacts ?? []; } catch { /* no structured output */ }
  const sources = payload.output?.flatMap((item) => item.action?.sources ?? []).map((source) => source.url) ?? [];
  const annotations = payload.output?.flatMap((item) => item.content ?? []).flatMap((part) => part.annotations ?? []).map((note) => note.url) ?? [];
  const path = (value: string | undefined) => {
    try { const link = new URL(value); return link.origin + link.pathname; } catch { return 'invalid'; }
  };
  console.log(`Provider status ${response.status}; response ${payload.status}; proposed contacts: ${JSON.stringify(rawContacts.map((item) => ({ name: item.name, source: path(item.sourceUrl) })))}; sources: ${JSON.stringify(sources.map(path))}; citations: ${JSON.stringify(annotations.map(path))}`);
  return response;
});
if (!report) throw new Error('Live web research did not return a sourced structured response.');
console.log(`Live research OK: ${report.contacts.length} sourced contacts, ${report.signals.length} company signals.`);
