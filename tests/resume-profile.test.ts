import { test } from 'node:test';
import assert from 'node:assert/strict';

import { profileFromResume } from '../src/ui/resume-profile.js';

/**
 * Reading a profile out of a résumé, for the extension's "start from your
 * résumé" button. Every person below is invented; the LAYOUTS are the common
 * ones — employer line then role, role line then employer, everything on one
 * line with pipes, and dates on a line of their own.
 */

const TODAY = new Date('2026-09-18T00:00:00Z');

const CLASSIC = `JORDAN A. EXAMPLE
Toronto, ON | +1 (416) 555-0199 | jordan.example@example.com | linkedin.com/in/jordan-example | github.com/jexample

SUMMARY
Data engineer with a habit of making pipelines boring.

EXPERIENCE
Northwind Analytics Inc.    Mar 2021 – Present
Senior Data Engineer
• Built the ingestion platform that replaced six cron jobs.
• Cut warehouse spend by 30%.

Contoso Retail, Toronto, ON    Jun 2017 – Feb 2021
Data Engineer
• Owned the nightly sales feed.

EDUCATION
University of Waterloo    Sep 2012 – Apr 2017
Bachelor of Applied Science in Computer Engineering, GPA: 3.7/4.0

SKILLS
Languages: Python, SQL, Scala
Tools: Airflow, dbt, Spark, Kafka
`;

test('a classic résumé: name, contact line, employer-then-role jobs', () => {
  const p = profileFromResume(CLASSIC, { today: TODAY });
  assert.equal(p.details.firstName, 'Jordan');
  assert.equal(p.details.middleName, 'A.');
  assert.equal(p.details.lastName, 'Example');
  assert.equal(p.details.email, 'jordan.example@example.com');
  assert.equal(p.details.phone, '+1 (416) 555-0199');
  assert.equal(p.details.linkedin, 'https://www.linkedin.com/in/jordan-example');
  assert.equal(p.details.github, 'https://github.com/jexample');
  assert.equal(p.details.city, 'Toronto');
  // "ON" on the résumé, spelled out: place pickers find nothing for the code.
  assert.equal(p.details.region, 'Ontario');
  assert.equal(p.details.country, 'Canada');

  assert.equal(p.experience.length, 2);
  assert.deepEqual(
    p.experience.map((j) => [j.company, j.title, j.start, j.end, j.current]),
    [
      ['Northwind Analytics Inc.', 'Senior Data Engineer', '2021-03', '', true],
      ['Contoso Retail', 'Data Engineer', '2017-06', '2021-02', false],
    ],
  );
  assert.equal(p.experience[1]!.location, 'Toronto, ON');
  assert.equal(p.details.currentCompany, 'Northwind Analytics Inc.');
  assert.equal(p.details.currentTitle, 'Senior Data Engineer');

  // Jun 2017 → Sep 2026 is 9 years 3 months, with no gap: rounded down to 9.
  assert.equal(p.answers.yearsExperience, '9');
  assert.equal(p.answers.currentlyEmployed, 'Yes');
  assert.ok(p.notes.some((n) => /counted from 2 jobs starting Jun 2017/.test(n)), p.notes.join('\n'));

  assert.equal(p.education.length, 1);
  assert.deepEqual(p.education[0], {
    school: 'University of Waterloo',
    degree: 'Bachelor of Applied Science',
    discipline: 'Computer Engineering',
    start: '2012-09',
    end: '2017-04',
    gpa: '3.7/4.0',
  });
  assert.equal(p.answers.education, 'Bachelor of Applied Science in Computer Engineering, University of Waterloo, 2017');

  // "Languages: Python, SQL" is programming languages, and must never be offered
  // as the answer to "which languages do you speak?".
  assert.equal(p.answers.languages, undefined);
  assert.ok(p.skills.includes('Python') && p.skills.includes('Airflow') && p.skills.includes('Kafka'));
  assert.ok(!p.skills.some((s) => /languages|tools/i.test(s)), 'labels are not skills');
});

const ROLE_FIRST = `Priya Sample
priya.sample@example.org · 020 7946 0958 · London, United Kingdom · priyasample.dev

Work Experience
Product Designer | Fabrikam Studio | Jan 2022 - Present
- Led the redesign of onboarding.
UX Designer | Litware Ltd | 2019 - 2021
- Ran forty usability sessions.

Education
MA Interaction Design — Royal College of Art, 2018
BA (Hons) Graphic Design, University of Leeds, 2016

Languages
English (native), Hindi (fluent), French (conversational)
`;

test('a role | company | dates résumé in Title Case headings', () => {
  const p = profileFromResume(ROLE_FIRST, { today: TODAY });
  assert.equal(p.details.firstName, 'Priya');
  assert.equal(p.details.lastName, 'Sample');
  assert.equal(p.details.email, 'priya.sample@example.org');
  assert.equal(p.details.phone, '020 7946 0958');
  assert.equal(p.details.city, 'London');
  assert.equal(p.details.country, 'United Kingdom');
  assert.equal(p.details.website, 'https://priyasample.dev');

  assert.deepEqual(
    p.experience.map((j) => [j.company, j.title, j.start, j.end, j.current]),
    [
      ['Fabrikam Studio', 'Product Designer', '2022-01', '', true],
      ['Litware Ltd', 'UX Designer', '2019', '2021', false],
    ],
  );
  // 2019 → 2021 counts as two years (year-only dates count January to January),
  // plus Jan 2022 → Sep 2026: 24 + 56 months = 80 → 6 years.
  assert.equal(p.answers.yearsExperience, '6');

  assert.equal(p.education.length, 2);
  assert.equal(p.education[0]!.school, 'Royal College of Art');
  assert.equal(p.education[0]!.degree, 'MA');
  assert.equal(p.education[0]!.discipline, 'Interaction Design');
  assert.equal(p.education[0]!.end, '2018');
  assert.equal(p.education[1]!.school, 'University of Leeds');
  assert.match(p.education[1]!.degree, /^BA/);
  // The master's is the highest, so it is the "highest qualification" answer.
  assert.equal(p.answers.education, 'MA in Interaction Design, Royal College of Art, 2018');
  assert.equal(p.answers.languages, 'English (native), Hindi (fluent), French (conversational)');
});

const DATES_ALONE = `SAM PLACEHOLDER
Austin, TX
(512) 555-0147
sam.placeholder@example.net
https://www.linkedin.com/in/samplaceholder/

PROFESSIONAL EXPERIENCE

Registered Nurse
Lakeside General Hospital
08/2019 – Present
• Charge nurse on a 32-bed surgical unit.

Nursing Assistant
Riverbend Care Home
05/2016 – 07/2019
• Supported residents with daily care.

EDUCATION
Bachelor of Science in Nursing
Texas State University
Graduated May 2019
`;

test('dates on a line of their own, a nurse rather than an engineer', () => {
  const p = profileFromResume(DATES_ALONE, { today: TODAY });
  assert.equal(p.details.firstName, 'Sam');
  assert.equal(p.details.lastName, 'Placeholder');
  assert.equal(p.details.city, 'Austin');
  assert.equal(p.details.region, 'Texas');
  assert.equal(p.details.country, 'United States');
  assert.equal(p.details.phone, '(512) 555-0147');
  assert.equal(p.details.linkedin, 'https://www.linkedin.com/in/samplaceholder');

  assert.deepEqual(
    p.experience.map((j) => [j.company, j.title, j.start, j.end]),
    [
      ['Lakeside General Hospital', 'Registered Nurse', '2019-08', ''],
      ['Riverbend Care Home', 'Nursing Assistant', '2016-05', '2019-07'],
    ],
  );
  // May 2016 → Sep 2026, continuous: 10 years 4 months → 10.
  assert.equal(p.answers.yearsExperience, '10');
  assert.deepEqual(p.education[0], {
    school: 'Texas State University',
    degree: 'Bachelor of Science',
    discipline: 'Nursing',
    start: '',
    end: '2019-05',
    gpa: '',
  });
});

test('a link the PDF only carries as an annotation is still found', () => {
  // Plenty of résumés print the word "LinkedIn" and hide the address in a link.
  const text = 'Alex Invented\nalex@example.com | LinkedIn | Portfolio\n\nEXPERIENCE\nEngineer, Tailspin Toys  2020 - Present\n';
  const p = profileFromResume(text, {
    today: TODAY,
    links: ['mailto:alex@example.com', 'https://www.linkedin.com/in/alex-invented', 'https://alexinvented.io/'],
  });
  assert.equal(p.details.linkedin, 'https://www.linkedin.com/in/alex-invented');
  assert.equal(p.details.website, 'https://alexinvented.io');
  assert.equal(p.experience[0]!.company, 'Tailspin Toys');
  assert.equal(p.experience[0]!.title, 'Engineer');
});

test('nothing is invented: a résumé without jobs gives no years and no employer', () => {
  const p = profileFromResume('Casey Blank\ncasey@example.com\n\nSKILLS\nExcel, Word\n', { today: TODAY });
  assert.equal(p.answers.yearsExperience, undefined);
  assert.equal(p.answers.currentlyEmployed, undefined);
  assert.equal(p.details.currentCompany, undefined);
  assert.equal(p.details.phone, undefined);
  assert.deepEqual(p.experience, []);
  assert.deepEqual(p.skills, ['Excel', 'Word']);
});

test('dates are not mistaken for a phone number', () => {
  const p = profileFromResume('Rae Nobody\nrae@example.com\n\nEXPERIENCE\nAnalyst, Woodgrove Bank  01/2019 - 12/2021\n', { today: TODAY });
  assert.equal(p.details.phone, undefined);
});

test('a date inside a bullet does not start a new job', () => {
  const text = `Lee Fictional
lee@example.com

EXPERIENCE
Software Engineer, Adatum Corp    2018 - Present
• Led the 2019 - 2020 migration of every service to containers, one team at a time.
`;
  const p = profileFromResume(text, { today: TODAY });
  assert.equal(p.experience.length, 1);
  assert.equal(p.experience[0]!.company, 'Adatum Corp');
});
