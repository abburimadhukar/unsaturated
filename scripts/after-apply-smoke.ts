import { researchJob } from '../src/after-apply/research.js';

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) throw new Error('OPENAI_API_KEY is missing; live research cannot be deployed.');

// A real public posting is used only to check the deployed API contract. No
// names are expected: it is valid for careful research to return no people.
const report = await researchJob({
  title: 'Software Engineer - 2027 New Grad',
  company: 'Metabit Technology LLC',
  applyUrl: 'https://job-boards.greenhouse.io/metabittechnologyllc/jobs/4412310009',
}, key);
if (!report) throw new Error('Live web research did not return a sourced structured response.');
console.log(`Live research OK: ${report.contacts.length} sourced contacts, ${report.signals.length} company signals.`);
