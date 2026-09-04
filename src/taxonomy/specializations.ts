import type { Family } from './families.js';

/**
 * Specialization — the second level of the taxonomy, under a family.
 *
 * A family says which part of the industry a role sits in; a specialization says
 * what kind of job it actually is. "Software Engineering" holds thousands of
 * postings, and answering "which of these are frontend?" by reading titles one
 * at a time is exactly the work the site exists to remove.
 *
 * Three rules shape everything below.
 *
 *   1. A specialization belongs to exactly one family, and is only considered
 *      after that family has been decided. A software job can never come out as
 *      `devops_sre`, because the software rule set does not contain it. That is
 *      enforced structurally here, again in the API, and once more by a CHECK
 *      constraint in Postgres.
 *
 *   2. Titles beat descriptions. A title is a deliberate statement about the
 *      job; a description is a wish list that mentions React in a backend
 *      posting. Description terms are read only when the title is generic.
 *
 *   3. Unknown is a real answer, stored as SQL NULL. Many postings carry no
 *      description at all and plenty of titles are just "Engineer II". Guessing
 *      would make every count downstream a small lie — the same mistake the
 *      country filter made by folding undecoded locations into every country.
 */

export type SoftwareSpecialization =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'mobile'
  | 'qa_test'
  | 'application_integration'
  | 'embedded_systems'
  | 'general_software';

export type CloudSpecialization =
  | 'devops_sre'
  | 'platform_engineering'
  | 'cloud_infrastructure'
  | 'networking'
  | 'cloud_security'
  | 'systems_storage'
  | 'finops'
  | 'general_cloud';

export type DataSpecialization =
  | 'data_engineering'
  | 'analytics_bi'
  | 'data_science'
  | 'ml_engineering'
  | 'mlops'
  | 'database_administration'
  | 'general_data';

export type HrisSpecialization =
  | 'workday'
  | 'successfactors'
  | 'oracle_hcm'
  | 'ukg'
  | 'payroll_benefits'
  | 'general_hris';

export type Specialization =
  | SoftwareSpecialization
  | CloudSpecialization
  | DataSpecialization
  | HrisSpecialization;

/**
 * The sentinel the API and the URL use to ask for "family known, specialization
 * not". Never stored — the database holds NULL, exactly as the country filter
 * does. Storing the string 'unknown' would make it sort, group and index as an
 * ordinary value, and every `count(*) group by specialization` downstream would
 * report a guess as if it were a category.
 */
export const UNKNOWN_SPECIALIZATION = '__unknown__';

/**
 * Stamped on every row this classifier writes.
 *
 * The backfill uses it as a restart marker: rows already carrying the current
 * version are skipped, so a run that dies halfway resumes rather than starting
 * over. Bump it whenever the rules below change meaningfully and the next
 * backfill reclassifies everything.
 */
export const CLASSIFICATION_VERSION = 'spec-1';

/** Display order per family. The UI adds "All" and "Unknown" around these. */
export const SPECIALIZATIONS_BY_FAMILY: Record<Family, readonly Specialization[]> = {
  software: [
    'frontend',
    'backend',
    'fullstack',
    'mobile',
    'qa_test',
    'application_integration',
    'embedded_systems',
    'general_software',
  ],
  cloud: [
    'devops_sre',
    'platform_engineering',
    'cloud_infrastructure',
    'networking',
    'cloud_security',
    'systems_storage',
    'finops',
    'general_cloud',
  ],
  data: [
    'data_engineering',
    'analytics_bi',
    'data_science',
    'ml_engineering',
    'mlops',
    'database_administration',
    'general_data',
  ],
  hris: ['workday', 'successfactors', 'oracle_hcm', 'ukg', 'payroll_benefits', 'general_hris'],
};

export const SPECIALIZATION_LABELS: Record<Specialization, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Full-stack',
  mobile: 'Mobile',
  qa_test: 'QA / Test Automation',
  application_integration: 'Application / Integration',
  embedded_systems: 'Embedded / Systems',
  general_software: 'General Software',

  devops_sre: 'DevOps / SRE',
  platform_engineering: 'Platform Engineering',
  cloud_infrastructure: 'Cloud Infrastructure',
  networking: 'Networking',
  cloud_security: 'Cloud Security',
  systems_storage: 'Systems / Storage',
  finops: 'FinOps',
  general_cloud: 'General Cloud',

  data_engineering: 'Data Engineering',
  analytics_bi: 'Analytics / BI',
  data_science: 'Data Science',
  ml_engineering: 'Machine Learning Engineering',
  mlops: 'MLOps',
  database_administration: 'Database Administration',
  general_data: 'General Data',

  workday: 'Workday',
  successfactors: 'SuccessFactors',
  oracle_hcm: 'Oracle HCM / PeopleSoft',
  ukg: 'UKG / Kronos',
  payroll_benefits: 'Payroll / Benefits Systems',
  general_hris: 'General HRIS',
};

/** Shown wherever a family is known but its specialization is not. */
export const UNKNOWN_SPECIALIZATION_LABEL = 'Unknown specialization';

export const ALL_SPECIALIZATIONS: Specialization[] = Object.values(
  SPECIALIZATIONS_BY_FAMILY,
).flat() as Specialization[];

/** Reverse index, derived rather than typed out, so the two cannot drift. */
export const FAMILY_OF_SPECIALIZATION = Object.fromEntries(
  (Object.entries(SPECIALIZATIONS_BY_FAMILY) as [Family, readonly Specialization[]][]).flatMap(
    ([family, list]) => list.map((s) => [s, family] as const),
  ),
) as Record<Specialization, Family>;

export function isSpecialization(value: string): value is Specialization {
  return Object.prototype.hasOwnProperty.call(FAMILY_OF_SPECIALIZATION, value);
}

/** Whether a specialization may be combined with a family in a query. */
export function belongsToFamily(spec: string, family: string): boolean {
  return isSpecialization(spec) && FAMILY_OF_SPECIALIZATION[spec] === family;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface SpecRule {
  id: Specialization;
  /**
   * Matched against the normalised title. First rule to match wins, so the list
   * is ordered most specific first — "Full Stack Mobile Engineer" is a mobile
   * job, and "Cloud Security Engineer" is security before it is cloud.
   */
  title: RegExp;
  /**
   * Individually weak terms, counted in the description only when the title said
   * nothing. Deliberately a list rather than one alternation: the count is the
   * evidence, and a single stray mention must not decide anything.
   */
  body?: RegExp[];
}

/**
 * Description evidence needs two distinct terms, and two more than the runner-up.
 *
 * Every backend posting mentions React somewhere and every frontend posting
 * mentions an API. One hit means nothing; a clear lead over the next-best
 * specialization is the only thing worth acting on. Below this bar the answer is
 * the family's general bucket or NULL, never a guess.
 */
const MIN_BODY_HITS = 2;
const BODY_MARGIN = 2;

const SOFTWARE_RULES: SpecRule[] = [
  {
    id: 'qa_test',
    title:
      /\b(qa|quality assurance|quality engineer|test (engineer|automation|analyst|architect|lead)|automation test|sdet|software (development engineer in test|test engineer))\b/,
    body: [/\bselenium\b/, /\bcypress\b/, /\bplaywright\b/, /\bappium\b/, /\btest automation\b/, /\bregression test/, /\btest (plan|case)s?\b/],
  },
  {
    id: 'embedded_systems',
    title:
      /\b(embedded|firmware|rtos|device driver|bare metal|kernel (engineer|developer)|bsp|hardware software|systems programm|robotics (software|engineer))\b/,
    body: [/\bfreertos\b/, /\bzephyr\b/, /\bmicrocontroller/, /\bi2c\b/, /\bcan bus\b/, /\bembedded (c|linux)\b/, /\bfirmware\b/, /\breal time operating system\b/],
  },
  {
    id: 'mobile',
    title:
      /\b(mobile|ios|android|react native|flutter|swiftui|swift (developer|engineer)|objective c|kotlin (developer|engineer))\b/,
    body: [/\bios\b/, /\bandroid\b/, /\bswiftui\b/, /\bjetpack compose\b/, /\breact native\b/, /\bflutter\b/, /\bxcode\b/, /\bapp store\b/, /\bplay store\b/],
  },
  {
    // The combination clause is not a guess: a title naming both ends is
    // literally describing full-stack work, and it has to be read before the
    // single-end rules below or it would be filed as whichever came first.
    id: 'fullstack',
    title: /\b(full ?stack)\b|\bfront ?end\b.*\bback ?end\b|\bback ?end\b.*\bfront ?end\b/,
    body: [/\bfull ?stack\b/, /\bend to end (feature|ownership|development)\b/, /\bacross the stack\b/],
  },
  {
    id: 'frontend',
    title:
      /\b(front ?end|ui engineer|user interface engineer|web (developer|engineer)|javascript (developer|engineer)|react (developer|engineer)|angular (developer|engineer)|vue (developer|engineer)|design engineer|ux engineer)\b/,
    body: [/\breact\b/, /\bangular\b/, /\bvue\b/, /\bcss\b/, /\btailwind\b/, /\bnext ?js\b/, /\bwebpack\b/, /\baccessibility\b/, /\bdesign system\b/],
  },
  {
    id: 'backend',
    title:
      /\b(back ?end|server side|api (engineer|developer)|services engineer|distributed systems|python (developer|engineer)|java (developer|engineer)|golang (developer|engineer)|net (developer|engineer)|ruby (developer|engineer)|php (developer|engineer)|node ?(js )?(developer|engineer)|scala (developer|engineer))\b/,
    body: [/\brest(ful)? api/, /\bgraphql\b/, /\bgrpc\b/, /\bmicroservices?\b/, /\bpostgres/, /\bdjango\b/, /\bspring boot\b/, /\bfastapi\b/, /\bserver side\b/, /\bmessage queue/],
  },
  {
    id: 'application_integration',
    title:
      /\b(integration (engineer|developer|specialist|analyst|architect)|middleware|mulesoft|boomi|apigee|tibco|informatica|esb|salesforce (developer|engineer)|servicenow (developer|engineer)|sap (abap|developer)|erp (developer|analyst)|applications? (developer|analyst|engineer)|solutions developer|crm developer|workflow (developer|engineer))\b/,
    body: [/\bmulesoft\b/, /\bboomi\b/, /\bapigee\b/, /\bsoap\b/, /\bmiddleware\b/, /\bedi\b/, /\bintegration platform\b/, /\bwebhooks?\b/, /\bsalesforce\b/],
  },
];

const CLOUD_RULES: SpecRule[] = [
  {
    id: 'cloud_security',
    title:
      /\b(security|devsecops|infosec|cybersecurity|iam engineer|identity and access|zero trust|cspm|cnapp|siem|penetration test|appsec|vulnerability)\b/,
    body: [/\bsiem\b/, /\bsoc ?2\b/, /\bvulnerability\b/, /\bzero trust\b/, /\bpenetration test/, /\bfedramp\b/, /\bcspm\b/, /\bthreat (model|detection)/, /\biam\b/],
  },
  {
    id: 'networking',
    title:
      /\b(network|noc|bgp|ospf|sd ?wan|routing and switching|ccna|ccnp|ccie|firewall|load balanc|telecom)\b/,
    body: [/\bbgp\b/, /\bospf\b/, /\bmpls\b/, /\bsd ?wan\b/, /\bcisco\b/, /\bjuniper\b/, /\bpalo alto\b/, /\bsubnet/, /\bvlan\b/, /\brouting\b/],
  },
  {
    id: 'finops',
    title: /\b(finops|cloud (cost|financial|economics)|cost optimi[sz]ation|cloud spend)\b/,
    body: [/\bfinops\b/, /\breserved instances?\b/, /\bsavings plans?\b/, /\bcost allocation\b/, /\bshowback\b/, /\bchargeback\b/, /\bunit economics\b/],
  },
  {
    id: 'devops_sre',
    title:
      /\b(devops|sre|site reliability|production engineer|release engineer|build engineer|reliability engineer|continuous (integration|delivery)|ci ?cd)\b/,
    body: [/\bon call\b/, /\bslo\b/, /\bsli\b/, /\berror budget\b/, /\bincident (response|management)\b/, /\bjenkins\b/, /\bgithub actions\b/, /\bci ?cd\b/, /\bpostmortem/],
  },
  {
    id: 'platform_engineering',
    title:
      /\b(platform (engineer|architect|reliability|operations)|developer (platform|experience|productivity)|internal developer platform|kubernetes (engineer|architect|platform)|container platform|ml ?platform|ai infrastructure|compute platform|cloud platform)\b/,
    body: [/\bbackstage\b/, /\binternal developer platform\b/, /\bgolden path/, /\bself service (platform|infrastructure)/, /\bkubernetes operator/, /\bhelm\b/, /\bargo ?cd\b/, /\bcrossplane\b/],
  },
  {
    id: 'systems_storage',
    title:
      // `systems? admin` alone could never match "Systems Administrator": the
      // group's closing \b demanded a boundary right after "admin", and the word
      // continues. 27 of them sat unclassified because of it.
      /\b(storage|systems? admin(istrator)?|sysadmin|linux (admin|engineer|systems)|unix (admin|engineer)|windows (admin|server|systems)|vmware|virtuali[sz]ation|backup|active directory|end user comput|citrix|hypervisor|data ?cent(er|re) (engineer|operations))\b/,
    body: [/\bnetapp\b/, /\bceph\b/, /\bstorage area network\b/, /\bvsphere\b/, /\besxi\b/, /\bnutanix\b/, /\bactive directory\b/, /\bzfs\b/, /\bfibre channel\b/],
  },
  {
    id: 'cloud_infrastructure',
    title:
      /\b(cloud (engineer|architect|infrastructure|operations|migration|solutions?|developer)|infrastructure (engineer|architect|operations|developer)|iaas|aws (engineer|architect)|azure (engineer|architect)|gcp (engineer|architect)|landing zone|solutions? architect)\b/,
    body: [/\bcloudformation\b/, /\bterraform\b/, /\bec2\b/, /\bvpc\b/, /\blanding zone\b/, /\bwell architected\b/, /\bcloud migration\b/, /\bmulti cloud\b/],
  },
];

const DATA_RULES: SpecRule[] = [
  {
    id: 'mlops',
    title: /\b(mlops|ml ops|machine learning (ops|platform|infrastructure)|model (deployment|serving|ops)|ai ?ops)\b/,
    body: [/\bmlflow\b/, /\bkubeflow\b/, /\bsagemaker\b/, /\bvertex ai\b/, /\bfeature store\b/, /\bmodel registry\b/, /\bmodel serving\b/, /\bmodel monitoring\b/],
  },
  {
    id: 'ml_engineering',
    title:
      /\b(machine learning engineer|ml engineer|deep learning engineer|ai engineer|nlp engineer|computer vision engineer|applied (scientist|ai)|llm engineer|genai engineer|research engineer|machine learning scientist|ml scientist)\b/,
    body: [/\bpytorch\b/, /\btensorflow\b/, /\bhugging ?face\b/, /\bmodel training\b/, /\bneural network/, /\bfine tun/, /\btransformer/, /\bembeddings?\b/],
  },
  {
    id: 'data_science',
    title:
      /\b(data scientist|data science|research scientist|decision scientist|quantitative (analyst|researcher)|statistician|experimentation (scientist|analyst))\b/,
    body: [/\bhypothesis test/, /\ba b test/, /\bregression\b/, /\bstatistical model/, /\bcausal infer/, /\bexperimentation\b/, /\bscikit ?learn\b/],
  },
  {
    id: 'database_administration',
    title:
      /\b(database (administrator|admin|engineer|architect|developer|reliability)|dba|sql server (dba|administrator)|oracle dba|postgres(ql)? (dba|administrator)|mysql dba)\b/,
    body: [/\bindex tuning\b/, /\bquery optimi[sz]ation\b/, /\breplication\b/, /\bhigh availability\b/, /\bbackup and recovery\b/, /\bpl sql\b/, /\bt sql\b/],
  },
  {
    id: 'analytics_bi',
    title:
      /\b(business intelligence|bi (developer|analyst|engineer|consultant)|analytics (engineer|analyst|manager|consultant)|data analyst|reporting analyst|insights analyst|tableau|power ?bi|looker|dashboard (developer|analyst)|marketing analyst|product analyst)\b/,
    body: [/\btableau\b/, /\bpower ?bi\b/, /\blooker\b/, /\bdashboards?\b/, /\bkpis?\b/, /\bbusiness intelligence\b/, /\bself service reporting\b/, /\bqlik\b/],
  },
  {
    id: 'data_engineering',
    title:
      /\b(data engineer|etl (developer|engineer)|elt (developer|engineer)|data platform|data warehouse|data pipeline|big data|data infrastructure|data architect|data ?ops)\b/,
    body: [/\bairflow\b/, /\bdbt\b/, /\bspark\b/, /\bsnowflake\b/, /\bdatabricks\b/, /\bkafka\b/, /\betl\b/, /\bdata pipelines?\b/, /\bredshift\b/, /\bbigquery\b/],
  },
];

const HRIS_RULES: SpecRule[] = [
  {
    id: 'workday',
    title: /\bworkday\b/,
    body: [/\bworkday\b/, /\bworkday studio\b/, /\bcalculated fields?\b/, /\bworkday report/, /\beib\b/],
  },
  {
    id: 'successfactors',
    title: /\b(successfactors|sap sf|employee central)\b/,
    body: [/\bsuccessfactors\b/, /\bemployee central\b/, /\bsap sf\b/, /\bmdf\b/],
  },
  {
    id: 'oracle_hcm',
    title: /\b(peoplesoft|oracle hcm|oracle hr|fusion hcm|taleo|oracle cloud hcm)\b/,
    body: [/\bpeoplesoft\b/, /\boracle hcm\b/, /\bfusion hcm\b/, /\btaleo\b/, /\bpeoplecode\b/],
  },
  {
    id: 'ukg',
    title: /\b(ukg|ultipro|kronos|ultimate software|workforce (central|dimensions))\b/,
    body: [/\bukg\b/, /\bultipro\b/, /\bkronos\b/, /\bworkforce central\b/, /\bworkforce dimensions\b/],
  },
  {
    id: 'payroll_benefits',
    title:
      /\b(payroll|benefits|compensation|total rewards|adp|paycom|paylocity|paychex|ceridian|dayforce|absence management|time and attendance)\b/,
    body: [/\bpayroll\b/, /\bopen enrollment\b/, /\bbenefits administration\b/, /\bgarnishments?\b/, /\bgross to net\b/, /\btax filing\b/],
  },
];

const RULES: Record<Family, SpecRule[]> = {
  software: SOFTWARE_RULES,
  cloud: CLOUD_RULES,
  data: DATA_RULES,
  hris: HRIS_RULES,
};

/**
 * Titles that name the family and nothing narrower.
 *
 * These are the only titles allowed to fall through to a `general_*` value. A
 * job titled "Software Engineer" genuinely IS general software; a job that
 * reached the data family through its skill fingerprint alone, under a title
 * like "Marketing Analyst", has said nothing about its specialization, and that
 * is NULL rather than "general".
 */
const GENERIC_TITLE: Record<Family, RegExp> = {
  // Forward Deployed Engineer and AI Engineer are the two largest unmatched
  // software titles in the corpus, ~170 postings between them. Neither is one of
  // the eight specializations and both are genuinely general software roles, so
  // general_software is the true answer rather than a shrug. The AI ones stay
  // findable through the separate `ai` flag, which is what that flag is for.
  software:
    /\b(software (engineer|developer|development engineer)|sde|programmer|member of technical staff|software architect|engineer (i|ii|iii|iv|v|[1-5])|forward deployed engineer|ai engineer|applied ai|llm engineer|genai engineer|agentic ai|product engineer)\b/,
  cloud:
    /\b(cloud engineer|infrastructure engineer|systems engineer|it (engineer|operations)|technical operations|operations engineer)\b/,
  data: /\b(data (specialist|professional|associate|consultant)|analytics (specialist|professional))\b/,
  hris: /\b(hris|hcm|hrms|hr (systems|technology|information)|people (systems|technology)|human resources (information|systems))\b/,
};

const GENERAL: Record<Family, Specialization> = {
  software: 'general_software',
  cloud: 'general_cloud',
  data: 'general_data',
  hris: 'general_hris',
};

const FAMILY_NOUN: Record<Family, string> = {
  software: 'Software',
  cloud: 'Cloud',
  data: 'Data',
  hris: 'HRIS',
};

/**
 * Same normalisation the family classifier uses, for the same reasons:
 * "Platform Engineering" and "Platform Engineer" are one role, and
 * "Front-End" / "Full-Stack" are hyphenated about half the time.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bengineering\b/g, 'engineer')
    .replace(/[.\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SpecializationResult {
  /** NULL when the family is known but the specialization is not. */
  specialization: Specialization | null;
  /** Short, human-readable account of why — written to the row for debugging. */
  reason: string;
  version: string;
}

/**
 * Decides a specialization within an already-decided family.
 *
 * Never called for an unclassified job: no family means no specialization, and a
 * nontechnical posting that happens to mention Kubernetes is filtered out one
 * level up rather than rescued here.
 */
export function classifySpecialization(
  family: Family,
  title: string,
  description?: string | null,
): SpecializationResult {
  const rules = RULES[family];
  const t = normalise(title);
  // Same cap as the family classifier — past a few thousand characters we are
  // reading the benefits section, not the role.
  const body = normalise((description ?? '').slice(0, 4000));

  // Pass 1 — the title, in specificity order.
  for (const rule of rules) {
    if (rule.title.test(t)) {
      return {
        specialization: rule.id,
        reason: `Title matched ${SPECIALIZATION_LABELS[rule.id]}`,
        version: CLASSIFICATION_VERSION,
      };
    }
  }

  const generic = GENERIC_TITLE[family].test(t);

  // Pass 2 — description terms, but only because the title said nothing.
  if (body) {
    const scored = rules
      .map((r) => ({ id: r.id, hits: (r.body ?? []).filter((p) => p.test(body)).length }))
      .sort((a, b) => b.hits - a.hits);
    const top = scored[0];
    const runnerUp = scored[1];

    if (top && top.hits >= MIN_BODY_HITS && top.hits - (runnerUp?.hits ?? 0) >= BODY_MARGIN) {
      return {
        specialization: top.id,
        reason: generic
          ? `Generic ${FAMILY_NOUN[family]} title; ${SPECIALIZATION_LABELS[top.id]} evidence found in the description`
          : `Description evidence for ${SPECIALIZATION_LABELS[top.id]} (${top.hits} terms)`,
        version: CLASSIFICATION_VERSION,
      };
    }

    if (top && top.hits >= MIN_BODY_HITS) {
      // Two specializations reading about equally. The general bucket is the
      // honest answer where the title at least named the family; otherwise
      // nothing is.
      const tied = scored
        .filter((s) => s.hits >= top.hits - 1)
        .map((s) => SPECIALIZATION_LABELS[s.id]);
      return {
        specialization: generic ? GENERAL[family] : null,
        reason: generic
          ? `Generic ${FAMILY_NOUN[family]} title; competing evidence (${tied.join(', ')}) — using general`
          : `Family identified as ${FAMILY_NOUN[family]}, but evidence is split between ${tied.join(', ')}`,
        version: CLASSIFICATION_VERSION,
      };
    }
  }

  if (generic) {
    return {
      specialization: GENERAL[family],
      reason: `Generic ${FAMILY_NOUN[family]} title with no specialization evidence`,
      version: CLASSIFICATION_VERSION,
    };
  }

  return {
    specialization: null,
    reason: `Family identified as ${FAMILY_NOUN[family]}, but insufficient specialization evidence`,
    version: CLASSIFICATION_VERSION,
  };
}
