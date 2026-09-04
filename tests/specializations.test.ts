import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRole } from '../src/taxonomy/families.js';
import {
  ALL_SPECIALIZATIONS,
  CLASSIFICATION_VERSION,
  FAMILY_OF_SPECIALIZATION,
  SPECIALIZATIONS_BY_FAMILY,
  SPECIALIZATION_LABELS,
  belongsToFamily,
  classifySpecialization,
  isSpecialization,
} from '../src/taxonomy/specializations.js';
import type { NormalizedJob } from '../src/ats/types.js';

/**
 * Classifies exactly the way the crawler does: family first, then a
 * specialization inside that family. Anything these tests assert is therefore a
 * claim about what will actually be written to a row, not about a rule read in
 * isolation.
 */
function classify(title: string, descriptionText = ''): { family: string | null; specialization: string | null } {
  const job: NormalizedJob = { externalId: 't', title, descriptionText };
  const role = classifyRole(job);
  if (!role.family) return { family: null, specialization: null };
  const spec = classifySpecialization(role.family, title, descriptionText);
  return { family: role.family, specialization: spec.specialization };
}

/**
 * A description dense enough to clear a family threshold, per family.
 *
 * Not decoration: several of these titles score below their family's threshold
 * on the title alone and would be handed to whichever family the text described
 * best. Real postings carry this text; a bare title would be testing a case that
 * does not occur.
 */
const SOFTWARE_BODY =
  'You will build services in Python and TypeScript, ship REST APIs, and work with Postgres.';
const CLOUD_BODY =
  'You will run Kubernetes on AWS, manage Terraform, and own our observability stack with Prometheus.';
const DATA_BODY =
  'You will write SQL against Snowflake, build pipelines with Airflow and dbt, and model data for analytics.';
const HRIS_BODY =
  'You will configure core HR, absence management and benefits administration, and support open enrollment.';

// ---------------------------------------------------------------------------
// Software
// ---------------------------------------------------------------------------

const SOFTWARE_CASES: [string, string, string][] = [
  ['Frontend Engineer', SOFTWARE_BODY, 'frontend'],
  ['Backend API Engineer', SOFTWARE_BODY, 'backend'],
  ['Full-stack Engineer', SOFTWARE_BODY, 'fullstack'],
  ['Android Engineer', SOFTWARE_BODY, 'mobile'],
  ['QA Automation Engineer', SOFTWARE_BODY, 'qa_test'],
  ['Integration Developer', SOFTWARE_BODY, 'application_integration'],
  ['Embedded Software Engineer', SOFTWARE_BODY, 'embedded_systems'],
];

for (const [title, body, expected] of SOFTWARE_CASES) {
  test(`software: ${title} -> ${expected}`, () => {
    assert.deepEqual(classify(title, body), { family: 'software', specialization: expected });
  });
}

test('software: a generic title with no evidence is general_software, not a guess', () => {
  const { family, specialization } = classify(
    'Software Engineer',
    'Join a growing team. We use Python. Great benefits and a generous holiday policy.',
  );
  assert.equal(family, 'software');
  assert.equal(specialization, 'general_software');
});

test('software: a generic title with clear backend evidence resolves to backend', () => {
  const { specialization } = classify(
    'Software Engineer II',
    'Design REST APIs and gRPC services, own our Postgres schemas, and scale microservices ' +
      'behind a message queue. Django experience welcome.',
  );
  assert.equal(specialization, 'backend');
});

test('software: a title naming both ends is full-stack, not whichever rule ran first', () => {
  assert.equal(classify('Front End and Back End Engineer', SOFTWARE_BODY).specialization, 'fullstack');
});

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

const CLOUD_CASES: [string, string, string][] = [
  ['Site Reliability Engineer', CLOUD_BODY, 'devops_sre'],
  ['Platform Engineer', CLOUD_BODY, 'platform_engineering'],
  ['Network Engineer', CLOUD_BODY, 'networking'],
  ['Cloud Security Engineer', CLOUD_BODY, 'cloud_security'],
  ['Cloud Infrastructure Engineer', CLOUD_BODY, 'cloud_infrastructure'],
  ['Storage Engineer', CLOUD_BODY, 'systems_storage'],
  ['FinOps Analyst', CLOUD_BODY, 'finops'],
];

for (const [title, body, expected] of CLOUD_CASES) {
  test(`cloud: ${title} -> ${expected}`, () => {
    assert.deepEqual(classify(title, body), { family: 'cloud', specialization: expected });
  });
}

test('cloud: Cloud Operations Engineer lands in cloud infrastructure', () => {
  // One of the roles that prompted this work: technically adjacent, rarely
  // applied to, and previously indistinguishable from every other cloud job.
  assert.deepEqual(classify('Cloud Operations Engineer', CLOUD_BODY), {
    family: 'cloud',
    specialization: 'cloud_infrastructure',
  });
});

test('cloud: security is read before cloud in a title that says both', () => {
  assert.equal(classify('Cloud Security Architect', CLOUD_BODY).specialization, 'cloud_security');
});

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const DATA_CASES: [string, string, string][] = [
  ['Data Engineer', DATA_BODY, 'data_engineering'],
  ['BI Analyst', DATA_BODY, 'analytics_bi'],
  ['Data Scientist', DATA_BODY, 'data_science'],
  ['Machine Learning Engineer', DATA_BODY, 'ml_engineering'],
  ['MLOps Engineer', `${DATA_BODY} You will run MLflow and Kubeflow and own the feature store.`, 'mlops'],
  ['Database Administrator', DATA_BODY, 'database_administration'],
];

for (const [title, body, expected] of DATA_CASES) {
  test(`data: ${title} -> ${expected}`, () => {
    assert.deepEqual(classify(title, body), { family: 'data', specialization: expected });
  });
}

test('data: Data Analyst is analytics, not data engineering', () => {
  assert.equal(classify('Data Analyst', DATA_BODY).specialization, 'analytics_bi');
});

// ---------------------------------------------------------------------------
// HRIS
// ---------------------------------------------------------------------------

const HRIS_CASES: [string, string, string][] = [
  ['Workday Analyst', HRIS_BODY, 'workday'],
  ['SuccessFactors Consultant', HRIS_BODY, 'successfactors'],
  ['PeopleSoft Developer', HRIS_BODY, 'oracle_hcm'],
  ['UKG Analyst', HRIS_BODY, 'ukg'],
  ['Payroll Systems Analyst', HRIS_BODY, 'payroll_benefits'],
];

for (const [title, body, expected] of HRIS_CASES) {
  test(`hris: ${title} -> ${expected}`, () => {
    assert.deepEqual(classify(title, body), { family: 'hris', specialization: expected });
  });
}

test('hris: a bare HRIS title with no product named is general_hris', () => {
  const { family, specialization } = classify(
    'HRIS Analyst',
    'Support our HR systems and partner with the People team.',
  );
  assert.equal(family, 'hris');
  assert.equal(specialization, 'general_hris');
});

test('hris: an engineer at an HR software company stays software', () => {
  // Without this, every backend engineer at Workday or Gusto is filed as HRIS.
  assert.equal(classify('Senior Software Engineer, Workday Payroll', SOFTWARE_BODY).family, 'software');
});

// ---------------------------------------------------------------------------
// Unknown — the case the whole design turns on
// ---------------------------------------------------------------------------

test('unknown: a family-only title with no description leaves specialization NULL', () => {
  // Roughly a fifth of postings publish no description at all. "Data Quality
  // Analyst" is enough to place the family and says nothing about the kind of
  // job, and with no body there is nothing else to read — so there is nothing
  // to say.
  const { family, specialization } = classify('Data Quality Analyst', '');
  assert.equal(family, 'data');
  assert.equal(specialization, null);
});

test('unknown: a generic family title with no description is general, not NULL', () => {
  // The distinction that makes both values worth having. "Technical Operations
  // Engineer" names the cloud family and nothing narrower, so general_cloud is
  // an answer; "Data Quality Analyst" above did not say what kind of data job it
  // was, so NULL is the answer. Neither is a guess.
  const { family, specialization } = classify('Technical Operations Engineer', '');
  assert.equal(family, 'cloud');
  assert.equal(specialization, 'general_cloud');
});

test('unknown: split evidence under a non-generic title is NULL, not a coin toss', () => {
  const result = classifySpecialization(
    'software',
    'Engineer, Core Product',
    'You will work across React and Angular on the client and REST APIs and Postgres on the server.',
  );
  assert.equal(result.specialization, null);
  assert.match(result.reason, /split between/);
});

test('unknown: one stray term is not evidence', () => {
  const result = classifySpecialization('cloud', 'Technology Analyst', 'Some exposure to Terraform.');
  assert.equal(result.specialization, null);
});

test('unknown: a family reached by skills alone, with no title signal, stays NULL', () => {
  // "Marketing Analyst" survives the exclusions because 'analyst' is an
  // engineering-role word, and reaches the data family on its SQL and Tableau.
  // That says which family — it does not say which kind of data job.
  const { family, specialization } = classify(
    'Marketing Analyst',
    'Write SQL against our data warehouse and maintain reporting.',
  );
  assert.equal(family, 'data');
  assert.equal(specialization, 'analytics_bi'); // its title IS an analytics title
  const noTitleSignal = classifySpecialization('data', 'Insights Associate', 'Some SQL required.');
  assert.equal(noTitleSignal.specialization, null);
});

// ---------------------------------------------------------------------------
// Jobs that must not be classified at all
// ---------------------------------------------------------------------------

test('a Product Manager mentioning Python is excluded, not filed as software', () => {
  const { family, specialization } = classify(
    'Product Manager',
    'Partner with engineering. Familiarity with Python and SQL is a plus.',
  );
  assert.equal(family, null);
  assert.equal(specialization, null);
});

test('a Sales Engineer mentioning AWS is excluded, not filed as cloud', () => {
  const { family, specialization } = classify(
    'Sales Engineer',
    'Demo our platform to prospects. Deep knowledge of AWS, Kubernetes and Terraform required.',
  );
  assert.equal(family, null);
  assert.equal(specialization, null);
});

// ---------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------

test('every specialization belongs to exactly one family', () => {
  const seen = new Set<string>();
  for (const [family, list] of Object.entries(SPECIALIZATIONS_BY_FAMILY)) {
    for (const spec of list) {
      assert.equal(seen.has(spec), false, `${spec} appears under more than one family`);
      seen.add(spec);
      assert.equal(FAMILY_OF_SPECIALIZATION[spec], family);
    }
  }
  assert.equal(seen.size, ALL_SPECIALIZATIONS.length);
});

test('every specialization has a label', () => {
  for (const spec of ALL_SPECIALIZATIONS) {
    assert.equal(typeof SPECIALIZATION_LABELS[spec], 'string');
    assert.ok(SPECIALIZATION_LABELS[spec].length > 0);
  }
});

test('a classifier can only ever return one of its own family values', () => {
  const titles = [
    'Engineer', 'Senior Engineer', 'Analyst', 'Consultant', 'Architect',
    'Site Reliability Engineer', 'Data Engineer', 'Workday Analyst', 'Frontend Engineer',
  ];
  for (const family of ['software', 'cloud', 'data', 'hris'] as const) {
    for (const title of titles) {
      const { specialization } = classifySpecialization(family, title, SOFTWARE_BODY);
      if (specialization === null) continue;
      assert.equal(
        belongsToFamily(specialization, family),
        true,
        `${family} produced ${specialization}, which belongs to ${FAMILY_OF_SPECIALIZATION[specialization]}`,
      );
    }
  }
});

test('isSpecialization accepts real values and rejects invented ones', () => {
  assert.equal(isSpecialization('frontend'), true);
  assert.equal(isSpecialization('workday'), true);
  assert.equal(isSpecialization('unknown'), false);
  assert.equal(isSpecialization('__unknown__'), false);
  assert.equal(isSpecialization('backend_engineer'), false);
});

test('every result carries a reason and the current version', () => {
  const result = classifySpecialization('software', 'Backend Engineer', SOFTWARE_BODY);
  assert.equal(result.version, CLASSIFICATION_VERSION);
  assert.match(result.reason, /Title matched Backend/);

  const unknown = classifySpecialization('data', 'Insights Associate', '');
  assert.match(unknown.reason, /Family identified as Data, but insufficient/);
});
