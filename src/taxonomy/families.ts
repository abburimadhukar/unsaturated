import type { NormalizedJob } from '../ats/types.js';

/**
 * Role families.
 *
 * Four families, each with its own matching strategy — because they are not the
 * same kind of category:
 *
 *   cloud/software/data are defined by a TECH STACK, so they match on a skill
 *   fingerprint. Titles in these areas are unreliable ("DevOps Engineer",
 *   "Platform Engineer" and "SRE" are frequently the same job).
 *
 *   hris is defined by a JOB FUNCTION and a set of vendor products, and its
 *   people do not write code. A skill fingerprint finds nothing there, so it
 *   matches on titles and product names instead.
 *
 * AI/ML roles are deliberately NOT a fifth family. They are folded into whichever
 * family the underlying work belongs to — AI infrastructure is cloud, ML
 * engineering is data, LLM application work is software — and separately flagged
 * so they can still be picked out anywhere.
 */

/**
 * The four real families, plus a review queue.
 *
 * 'unsorted' is not a kind of work — it describes what WE know, not what the
 * job is. It carries no specializations, is never inferred from skills, and is
 * excluded from every default view: it appears only when selected by name. It
 * exists so the roles the rules keep missing can be looked at by a person
 * instead of guessed at by a rule.
 */
export type Family = 'cloud' | 'software' | 'data' | 'hris' | 'unsorted';

/** The families that describe actual work — everything except the review queue. */
export const REAL_FAMILIES = ['cloud', 'software', 'data', 'hris'] as const;

export const FAMILY_LABELS: Record<Family, string> = {
  cloud: 'Cloud & Infrastructure',
  software: 'Software Engineering',
  data: 'Data',
  hris: 'HRIS',
  unsorted: 'Unsorted',
};

// Last, deliberately. It is a queue to work through, not a category to browse.
export const FAMILY_ORDER: Family[] = ['cloud', 'software', 'data', 'hris', 'unsorted'];

interface SkillTerm {
  pattern: RegExp;
  canonical: string;
  weight: number;
}

// ---------------------------------------------------------------------------
// Skill vocabularies
// ---------------------------------------------------------------------------

const CLOUD_SKILLS: SkillTerm[] = [
  { pattern: /\b(aws|amazon web services)\b/i, canonical: 'AWS', weight: 3 },
  { pattern: /\b(azure|microsoft azure)\b/i, canonical: 'Azure', weight: 3 },
  { pattern: /\b(gcp|google cloud)\b/i, canonical: 'GCP', weight: 3 },
  { pattern: /\b(oci|oracle cloud)\b/i, canonical: 'OCI', weight: 3 },
  { pattern: /\b(kubernetes|k8s|eks|aks|gke|openshift)\b/i, canonical: 'Kubernetes', weight: 4 },
  { pattern: /\bterraform\b/i, canonical: 'Terraform', weight: 4 },
  { pattern: /\b(cloudformation|pulumi|bicep)\b/i, canonical: 'IaC', weight: 3 },
  { pattern: /\b(ansible|puppet|chef|saltstack)\b/i, canonical: 'Config Mgmt', weight: 3 },
  { pattern: /\b(docker|containerd|podman)\b/i, canonical: 'Docker', weight: 2 },
  { pattern: /\bhelm\b/i, canonical: 'Helm', weight: 3 },
  { pattern: /\b(argo\s?cd|argocd|flux\s?cd|gitops)\b/i, canonical: 'GitOps', weight: 3 },
  { pattern: /\bci\/?cd\b/i, canonical: 'CI/CD', weight: 2 },
  { pattern: /\b(jenkins|gitlab ci|github actions|circleci|teamcity)\b/i, canonical: 'CI Tooling', weight: 2 },
  { pattern: /\b(prometheus|grafana|datadog|splunk|new relic|opentelemetry|nagios|zabbix)\b/i, canonical: 'Observability', weight: 3 },
  { pattern: /\b(linux|unix|rhel|centos)\b/i, canonical: 'Linux', weight: 2 },
  { pattern: /\b(bash|shell scripting|powershell)\b/i, canonical: 'Scripting', weight: 1 },
  { pattern: /\b(vpc|subnet|bgp|ospf|load balanc|firewall|\bvpn\b|tcp\/ip)\b/i, canonical: 'Networking', weight: 2 },
  { pattern: /\b(vmware|vsphere|esxi|hyper-v|nutanix|citrix)\b/i, canonical: 'Virtualization', weight: 3 },
  // Bare "san"/"nas" matched "San Francisco", "San Jose" and every other San-
  // city, adding +3 — 60% of the threshold — to any job whose description
  // mentioned one. Spelled out instead.
  { pattern: /\b(storage area network|network attached storage|ceph|netapp|storage array|iscsi|fibre channel)\b/i, canonical: 'Storage', weight: 3 },
  { pattern: /\b(devsecops|cspm|cnapp|soc ?2|fedramp|cis benchmark)\b/i, canonical: 'Cloud Security', weight: 3 },
  { pattern: /\b(active directory|group policy|windows server|sccm|intune)\b/i, canonical: 'Windows/AD', weight: 2 },
  { pattern: /\b(finops|cloud cost|reserved instances?)\b/i, canonical: 'FinOps', weight: 3 },
];

const SOFTWARE_SKILLS: SkillTerm[] = [
  { pattern: /\bpython\b/i, canonical: 'Python', weight: 3 },
  { pattern: /\b(django|flask|fastapi|pyramid|celery|drf|django rest)\b/i, canonical: 'Python Web', weight: 4 },
  // Python tooling that is strong evidence of a Python role and was invisible:
  // pytest scored only as generic "Testing", and the rest not at all.
  { pattern: /\b(pytest|asyncio|sqlalchemy|pydantic|poetry|boto3|streamlit|pyspark|tox|uvicorn|gunicorn)\b/i, canonical: 'Python Tooling', weight: 3 },
  { pattern: /\b(typescript|javascript|node\.?js|nodejs)\b/i, canonical: 'JS/TS', weight: 3 },
  { pattern: /\b(react|next\.?js|vue|angular|svelte)\b/i, canonical: 'Frontend FW', weight: 3 },
  { pattern: /\b(java|spring boot|spring)\b/i, canonical: 'Java', weight: 2 },
  // The old trailing \b sat after "#", a non-word character, so it demanded a
  // word character right after it and "c#" could never match at all.
  { pattern: /(\bgolang\b|\.net\b|c#|\bruby on rails\b|\brails\b|\bphp\b|\blaravel\b|\bkotlin\b|\bscala\b|\brust\b|\belixir\b)/i, canonical: 'Other Backend', weight: 2 },
  { pattern: /\b(rest api|restful|graphql|grpc|microservices?)\b/i, canonical: 'APIs', weight: 2 },
  { pattern: /\b(postgres(ql)?|mysql|mongodb|redis|dynamodb)\b/i, canonical: 'Databases', weight: 2 },
  { pattern: /\b(html|css|tailwind|sass)\b/i, canonical: 'Web UI', weight: 1 },
  { pattern: /\b(unit test|pytest|jest|tdd|test[- ]driven)\b/i, canonical: 'Testing', weight: 1 },
  { pattern: /\b(langchain|langgraph|llamaindex|crewai|openai|anthropic|rag\b|vector (db|database)|prompt engineering|fine[- ]tun(e|ing)|genai|\bllm\b)\b/i, canonical: 'LLM Tooling', weight: 3 },
];

const DATA_SKILLS: SkillTerm[] = [
  { pattern: /\bsql\b/i, canonical: 'SQL', weight: 3 },
  { pattern: /\b(spark|pyspark|hadoop|hive|flink)\b/i, canonical: 'Big Data', weight: 4 },
  { pattern: /\b(airflow|dagster|prefect|luigi)\b/i, canonical: 'Orchestration', weight: 4 },
  { pattern: /\bdbt\b/i, canonical: 'dbt', weight: 4 },
  { pattern: /\b(snowflake|databricks|redshift|bigquery|synapse)\b/i, canonical: 'Warehouse', weight: 4 },
  { pattern: /\b(tableau|power ?bi|looker|qlik|superset|mode analytics)\b/i, canonical: 'BI Tools', weight: 3 },
  { pattern: /\b(kafka|kinesis|pubsub|streaming)\b/i, canonical: 'Streaming', weight: 3 },
  { pattern: /\b(etl|elt|data pipeline|data warehouse|data lake|lakehouse)\b/i, canonical: 'Pipelines', weight: 3 },
  { pattern: /\b(pandas|numpy|scikit[- ]?learn|jupyter)\b/i, canonical: 'Python Data', weight: 3 },
  { pattern: /\b(tensorflow|pytorch|keras|xgboost|hugging ?face)\b/i, canonical: 'ML Frameworks', weight: 4 },
  { pattern: /\b(mlflow|kubeflow|sagemaker|vertex ai|feature store)\b/i, canonical: 'MLOps', weight: 4 },
  { pattern: /\b(statistic|regression|forecasting|a\/b test|experimentation)\b/i, canonical: 'Statistics', weight: 2 },
  { pattern: /\b(data model(l)?ing|star schema|dimensional model)\b/i, canonical: 'Modeling', weight: 3 },
];

/** HRIS is product-defined rather than skill-defined. */
const HRIS_SKILLS: SkillTerm[] = [
  { pattern: /\bworkday\b/i, canonical: 'Workday', weight: 4 },
  { pattern: /\b(successfactors|sap sf)\b/i, canonical: 'SuccessFactors', weight: 4 },
  { pattern: /\b(ukg|ultipro|kronos)\b/i, canonical: 'UKG/Kronos', weight: 4 },
  { pattern: /\b(peoplesoft|oracle hcm|taleo)\b/i, canonical: 'Oracle HCM', weight: 4 },
  { pattern: /\b(dayforce|ceridian)\b/i, canonical: 'Dayforce', weight: 4 },
  { pattern: /\b(adp\b|paycom|paylocity|paychex|bamboohr|namely|rippling|gusto)\b/i, canonical: 'Payroll/HRIS', weight: 3 },
  { pattern: /\b(hris|hcm|hrms)\b/i, canonical: 'HRIS/HCM', weight: 4 },
  { pattern: /\b(benefits administration|open enrollment|payroll process)\b/i, canonical: 'Benefits/Payroll', weight: 3 },
  { pattern: /\b(core hr|absence management|time (and|&) attendance|compensation module)\b/i, canonical: 'HR Modules', weight: 3 },
  { pattern: /\b(applicant tracking|onboarding system|talent management system)\b/i, canonical: 'Talent Systems', weight: 2 },
];

// ---------------------------------------------------------------------------
// Title signals
// ---------------------------------------------------------------------------

// `mlops` deliberately absent, though it once lived here: MLOps is a
// specialization of the DATA family (see specializations.ts), and leaving the
// token in this list meant every "MLOps Engineer" was filed as cloud — cloud is
// checked before software but after data, so the title never reached the family
// that owns the specialization. `ml platform` and `ai infrastructure` stay:
// those are platform-engineering roles that happen to serve ML.
/**
 * Words that mean a cloud term in a title is not about doing the work.
 *
 * Checked before the cloud rules. Teaching GCP, auditing a GCP estate, and
 * buying cloud capacity all put "GCP" in a title without being cloud jobs. The
 * civil-engineering words are here for one reason: "infrastructure" means roads
 * and bridges to a road builder, and Webber's seasonal equipment operators were
 * landing in the review queue on the strength of that one word.
 */
const CLOUD_TITLE_NOISE =
  /\b(instructor|trainer|training|teacher|curriculum|academy|bootcamp|audit\w*|sourcing|procurement|vendor manage\w*|sales|account executive|recruit\w*|equipment operator|bridge|highway|roadway|civil|paving|seasonal|learning management)\b/i;

/**
 * A cloud role by title.
 *
 * The second half of this was added after 610 postings with a cloud word in the
 * title were found sitting unclassified: "Cloud Networking & Infrastructure
 * Developer", "System Admin Linux", "Linux Administrator", "OpenShift Platform
 * Administrator", "Azure Integration Developer", "IT Infrastructure Analyst".
 * Every one of them named a platform and a technical role, and no rule reached
 * any of them, because the original list enumerated exact phrases.
 *
 * The pairing rule below is deliberately order-free: a platform word anywhere
 * plus a technical-role word anywhere. "Cloud Developer" and "Developer, Cloud
 * Platform" are the same job written two ways, and an enumeration will always
 * miss one of them.
 */
const CLOUD_TITLES =
  /\b(devops|sre|site reliability|production engineer|platform engineer|platform reliability|cloud engineer|cloud architect|solutions architect|cloud operations|cloud infrastructure|infrastructure engineer|infrastructure architect|systems administrator|sysadmin|network engineer|network administrator|network architect|noc\b|devsecops|cloud security|storage engineer|virtuali[sz]ation|build engineer|release engineer|observability|kubernetes|finops|ml ?platform|ai infrastructure|technical operations|techops|site operations|infra engineer|systems architect|cluster (engineer|architect)|capacity engineer|provisioning engineer)\b|\b(systems?|sys)\s?admin\w*\b|\b(linux|unix|aix)\s+(administrator|admin)\b|\binfrastructure\s+(engineer|developer|analyst|architect|specialist|lead)\b/i;

/**
 * A platform word and a technical role word, in either order.
 *
 * Applied ONLY as a last resort, after every family has failed — never in the
 * ordinary title pass. Tried earlier it is a wrecking ball: it pulls "Sr.
 * Software Engineer - Java/SpringBoot/AWS" and "Senior Data Engineer Cloud
 * (Terraform, dbt, Azure)" into cloud, because cloud is checked before software
 * and the mere presence of AWS wins. Measured at 256 roles stolen from Software
 * and Data that way.
 *
 * Used last, it costs nothing and recovers the 610 postings found sitting
 * unclassified with a cloud word in the title — "Cloud Networking &
 * Infrastructure Developer", "OpenShift Platform Administrator", "Azure
 * Integration Developer", "IT Infrastructure Analyst". They named a platform and
 * a technical role, and every rule enumerated exact phrases instead.
 *
 * Deliberately order-free and description-free: "Cloud Developer" and
 * "Developer, Cloud Platform" are the same job written two ways, and 18% of
 * postings have no description to consult.
 */
const CLOUD_TITLES_LOOSE =
  /\b(cloud|aws|amazon web services|azure|gcp|google cloud|kubernetes|k8s|openshift|terraform|vmware|datacent(er|re)|active directory)\b[^,]{0,40}\b(engineer|developer|architect|administrator|admin|analyst|specialist|consultant|operations|sre|lead)\b|\b(engineer|developer|architect|administrator|admin|analyst|specialist|consultant)\b[^,]{0,40}\b(cloud|aws|azure|gcp|kubernetes|openshift|vmware)\b/i;

const SOFTWARE_TITLES =
  /\b(software engineer|software developer|software development engineer|\bsde\b|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|python developer|python engineer|web developer|application developer|applications engineer|api engineer|ux engineer|growth engineer|programmer|ai engineer|llm engineer|genai engineer|applied ai|forward deployed engineer)\b/i;

const DATA_TITLES =
  /\b(data engineer|data analyst|analytics engineer|data scientist|data architect|database engineer|database administrator|\bdba\b|etl developer|data platform|data warehouse|big data|business intelligence|\bbi\b (developer|analyst|engineer)|reporting analyst|machine learning engineer|ml engineer|machine learning scientist|research scientist|quantitative analyst|decision scientist|data quality|mlops|ml ops)\b/i;

/**
 * The vendor clause is what makes "PeopleSoft Developer" and "UKG Analyst"
 * findable at all.
 *
 * HRIS is never inferred from a skill fingerprint — pass 2 skips it — so a title
 * this list does not recognise has no other route into the family. Only Workday
 * and SuccessFactors were named before, which left every PeopleSoft, UKG,
 * Kronos, Dayforce and Taleo role unclassified and therefore invisible.
 * HRIS_EXCLUSIONS still removes the engineers who merely work AT those vendors.
 */
/**
 * The HRIS vendors, as they appear in a TITLE.
 *
 * Naming one is decisive on its own. This used to require the product be
 * followed immediately by one of a fixed list of nouns, and no list could ever
 * be long enough: 36 unambiguous roles were invisible because of it — "Workday
 * Techno Functional Consultant", "Workday Extend Consultant", "Workday Platform
 * Manager", "Manager, Workday Compensation & Talent", "SuccessFactors Support
 * Analyst", "VP, Enterprise Systems, Workday". Nothing excluded them; no rule
 * ever reached them.
 *
 * The title only, never the description. Half the companies in the corpus name
 * Workday in their benefits paragraph, which is exactly why HRIS is never
 * inferred from a skill fingerprint.
 *
 * 'namely', 'gusto' and 'rippling' are absent deliberately: they are ordinary
 * words or companies whose own engineers post here, and matching them would
 * file a backend engineer at Rippling as an HRIS analyst.
 */
export const HRIS_PRODUCTS =
  /\b(workday|successfactors|sap ?sf|peoplesoft|oracle hcm|taleo|ukg|ultipro|kronos|dayforce|ceridian|paycom|paylocity|paychex|bamboohr)\b/i;

/**
 * What turns a payroll, benefits or compensation title into a systems one.
 *
 * "Payroll Specialist" runs and configures the payroll system; "Payroll
 * Manager" runs the function and its vendors. Measured across the corpus that
 * split is 78 systems against 94 management, and only the first belongs in a
 * family called HR Information Systems. The second is picked up as adjacent, so
 * it is one dropdown away rather than gone.
 */
const HRIS_SYSTEMS_WORD =
  '(analyst|administrator|systems?|specialist|configuration|implementation|integration|technolog\\w*|reporting|data|platform)';

/**
 * Workday modules that are not HR at all.
 *
 * Financials, Supply Chain, Adaptive Planning and Student are the same platform
 * and much the same skills, but the work is finance, procurement or academic
 * administration. They stay out of core HRIS and surface as adjacent — close
 * enough to matter to someone with Workday experience, wrong enough that an HR
 * filter should not return them unasked.
 */
export const HRIS_NON_HR_MODULE =
  /\b(financ\w*|fins?|accounting|supply chain|procurement|inventory|adaptive planning|student|grants?|revenue)\b/i;

const HRIS_TITLES = new RegExp(
  [
    // The category, named outright.
    '\\b(hris|hcm|hrms)\\b',
    '\\b(human resources? (information|systems?)|hr (systems?|technology|information)|people (systems|technology|platform))\\b',
    // A vendor product, anywhere in the title.
    HRIS_PRODUCTS.source,
    // Payroll, benefits or compensation WITH a systems word. Two lookaheads
    // rather than an enumeration, because the halves appear in either order —
    // "Payroll Systems Analyst" and "Analyst, Global Payroll" alike.
    `(?=.*\\b(payroll|benefits|total rewards|compensation)\\b)(?=.*\\b${HRIS_SYSTEMS_WORD}\\b)`,
    // Reporting on people data is HRIS work wherever it sits.
    '\\b(hr data analyst|hr operations analyst|people analytics|workforce analytics|hr reporting)\\b',
  ].join('|'),
  'i',
);

/**
 * AI/ML detection - a tag, never a family.
 *
 * Split in two because a bare "AI" in a description tags almost everything:
 * nearly every tech company now calls itself AI-something in its boilerplate.
 * Matching that way tagged 456 of 691 software roles, which is noise.
 *
 * So loose tokens like "AI" or "ML" only count in the TITLE, where they are a
 * deliberate statement about the job. In the body, only unambiguous terms count.
 */
const AI_TITLE =
  /\b(ai|ml|machine learning|deep learning|llm|genai|generative ai|nlp|computer vision|mlops|data scientist)\b/i;

const AI_BODY_STRONG =
  /\b(machine learning|deep learning|large language model|generative ai|neural network|computer vision|natural language processing|pytorch|tensorflow|hugging ?face|scikit[- ]?learn|mlops|fine[- ]tun(e|ing)|model (training|inference|deployment))\b/i;

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/**
 * Exclusions come in two strengths.
 *
 * HARD rules name a job that is never in scope however the title is dressed: a
 * Sales Engineer is a sales job even though "engineer" is in the title.
 *
 * SOFT rules match a word carrying both a non-engineering and an engineering
 * sense — controller, marketing, legal, warehouse, driver — and are skipped when
 * the title also names an engineering role. As blunt word matches these were
 * deleting 35% of realistic engineering titles: every Kubernetes "Controller"
 * role went out as accounting, all of martech data engineering as marketing, and
 * legal-tech engineering as legal. Nothing recorded it, because an excluded job
 * leaves no trace in the corpus.
 */
const ENGINEERING_ROLE =
  /\b(engineer|engineering|developer|architect|administrator|programmer|sre|devops|scientist|analyst)\b/i;

const HARD_EXCLUSIONS: [RegExp, string][] = [
  [/\b(sales|account)\s+(engineer|executive|manager|director)\b/i, 'sales'],
  [/\bpre[- ]?sales\b/i, 'pre-sales'],
  [/\b(recruiter|talent acquisition|sourcer|staffing (specialist|coordinator))\b/i, 'recruiting'],
  [/\b(data ?cent(er|re)\s+(technician|tech|operator))\b/i, 'datacenter hardware'],
  [/\b(help ?desk|service desk|desktop support|field (service|technician))\b/i, 'end-user support'],
  [/\b(intern|internship|co[- ]?op)\b/i, 'internship'],
  [/\b(nurse|physician|therapist|clinician|caregiver|pharmacist|dental|veterinar)\b/i, 'clinical'],
  [/\b(teacher|professor|lecturer|faculty)\b/i, 'education'],
  [/\b(counsel|attorney|paralegal|compliance officer)\b/i, 'legal'],
  [/\b(developer relations|developer advocate|devrel|evangelist|technical writer)\b/i, 'devrel/docs'],
  // Physical-security and manual roles. "security officer" is deliberately NOT
  // here: Chief Information Security Officer and Cloud Security Officer are
  // infosec titles, not night watchmen.
  [/\b(forklift|janitor|custodian|security guard|armed guard)\b/i, 'manual'],
  [/\b(delivery|truck|cdl|bus|van)\s+drivers?\b/i, 'manual'],
  // Drafts left on public boards; not real openings.
  [/^copy of\b/i, 'draft'],
  // Revenue-side roles. "solutions architect" is excluded from this list on
  // purpose — at a vendor it is pre-sales, but at an enterprise it is ordinary
  // internal architecture, so the title alone is not disqualifying.
  [/\b(gtm|go.to.market|deal desk)\b/i, 'revenue'],
  // The HRIS lookahead matters: "HRIS Implementation Consultant" and "Workday
  // Implementation Consultant" are the dominant titles in that family, not
  // customer-facing sales roles, and HRIS is the thinnest family in the corpus.
  [/^(?!.*\b(hris|hcm|hrms|workday|successfactors|peoplesoft|ukg|dayforce|payroll|benefits)\b).*\b(solutions?|sales|customer success|customer reliability|implementation)\s+(engineer|consultant|manager)\b/i, 'customer-facing'],
  [/\bsales\b|\bbusiness development\b|\b(sdr|bdr)\b|\brepresentative\b|\bquota\b/i, 'sales'],
  [/\b(financial analyst|finance manager|treasury|investor relations)\b/i, 'finance'],
  [/\b(executive assistant|office administrator|receptionist|facilities)\b/i, 'admin'],
];

const SOFT_EXCLUSIONS: [RegExp, string][] = [
  [/\b(marketing|content writer|copywriter|social media|seo specialist)\b/i, 'marketing'],
  [/\b(accountant|accounting|controller|bookkeep)\b/i, 'accounting'],
  [/\blegal\b/i, 'legal'],
  [/\b(designer|creative director|illustrator|ux\s+(designer|researcher|writer))\b/i, 'design'],
  [/\b(product|program|project|procurement|sourcing|category|community|office)\s+manager\b/i, 'non-engineering management'],
  [/\bwarehous(e|ing)\b/i, 'manual'],
  [/\bdrivers?\b/i, 'manual'],
  [/\bgrowth (content )?engineer\b/i, 'revenue'],
];

/**
 * HRIS-specific exclusion: engineers who happen to work at an HR software
 * company are software roles, not HRIS roles. Without this, every backend
 * engineer at Workday or Gusto would be misfiled.
 */
const HRIS_EXCLUSIONS =
  /\b(software engineer|software developer|backend|frontend|full[- ]?stack|devops|sre|data engineer|product manager|designer)\b/i;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface RoleClassification {
  family: Family | null;
  /** Summed weight of matched skill terms for the winning family. */
  score: number;
  matchedSkills: string[];
  /**
   * Every skill the posting named, across all four vocabularies.
   *
   * `matchedSkills` is the winning family's fingerprint, which is the right
   * input for classification and the wrong one for resume matching: a job filed
   * as `software` threw away the AWS and Terraform it also mentioned, so a
   * candidate with deep cloud experience scored 0% against it.
   */
  allSkills: string[];
  titleMatched: boolean;
  /** True when the role involves AI/ML, whatever its family. */
  ai: boolean;
  excludedReason?: string;
}

interface FamilySpec {
  id: Family;
  titles: RegExp;
  skills: SkillTerm[];
  /** Minimum fingerprint weight when the title gives no signal. */
  threshold: number;
}

/**
 * Order matters: the first family whose TITLE matches wins.
 *
 * HRIS goes first because its titles are unambiguous. Data and cloud come before
 * software because "Software Engineer" is the most generic title in the market —
 * a data or infrastructure role should be filed as such rather than swallowed by
 * the catch-all.
 */
const SPECS: FamilySpec[] = [
  { id: 'hris', titles: HRIS_TITLES, skills: HRIS_SKILLS, threshold: 5 },
  { id: 'data', titles: DATA_TITLES, skills: DATA_SKILLS, threshold: 5 },
  { id: 'cloud', titles: CLOUD_TITLES, skills: CLOUD_SKILLS, threshold: 5 },
  { id: 'software', titles: SOFTWARE_TITLES, skills: SOFTWARE_SKILLS, threshold: 5 },
];

/** How far another family must out-score a title match before it takes over. */
const DOMINANCE_RATIO = 2;
const DOMINANCE_MARGIN = 8;

function matchSkills(terms: SkillTerm[], haystack: string): { score: number; names: string[] } {
  const found = new Map<string, number>();
  for (const t of terms) {
    if (t.pattern.test(haystack)) {
      found.set(t.canonical, Math.max(found.get(t.canonical) ?? 0, t.weight));
    }
  }
  let score = 0;
  for (const w of found.values()) score += w;
  return { score, names: [...found.keys()] };
}

/**
 * The best-scoring family other than `exclude`, if one clears its threshold and
 * beats the score the title-matched family managed.
 */
function strongestOtherFamily(
  exclude: Family,
  haystack: string,
  beat: number,
): RoleClassification | null {
  let best: RoleClassification | null = null;
  for (const spec of SPECS) {
    if (spec.id === exclude || spec.id === 'hris') continue;
    const { score, names } = matchSkills(spec.skills, haystack);
    if (score < spec.threshold || score <= beat) continue;
    if (!best || score > best.score) {
      best = {
        family: spec.id,
        score,
        matchedSkills: names,
        allSkills: allMatchedSkills(haystack),
        titleMatched: false,
        ai: false,
      };
    }
  }
  return best;
}

/** Union of every family's matched skills — the input resume matching wants. */
function allMatchedSkills(haystack: string): string[] {
  const found = new Set<string>();
  for (const spec of SPECS) {
    for (const name of matchSkills(spec.skills, haystack).names) found.add(name);
  }
  return [...found];
}

export function classifyRole(job: NormalizedJob): RoleClassification {
  const title = job.title;
  // Descriptions are capped — past a few thousand characters we are matching
  // benefits boilerplate, not the role.
  const body = (job.descriptionText ?? '').slice(0, 4000);
  const haystack = `${title} ${body}`;

  const empty: RoleClassification = {
    family: null, score: 0, matchedSkills: [], allSkills: [], titleMatched: false, ai: false,
  };

  for (const [pattern, reason] of HARD_EXCLUSIONS) {
    if (pattern.test(title)) return { ...empty, excludedReason: reason };
  }
  if (!ENGINEERING_ROLE.test(title)) {
    for (const [pattern, reason] of SOFT_EXCLUSIONS) {
      if (pattern.test(title)) return { ...empty, excludedReason: reason };
    }
  }

  const ai = AI_TITLE.test(title) || AI_BODY_STRONG.test(body);

  // "Platform Engineering" and "Platform Engineer" are the same role, but every
  // title pattern below is written in the singular. Normalising here is one
  // change instead of doubling every alternative in four large regexes.
  const titleForMatch = title
    .replace(/\bengineering\b/gi, 'engineer')
    // Hyphenated compounds are the same words: 'Forward-Deployed',
    // 'Full-Stack', 'Front-End' all failed against space-separated patterns.
    .replace(/-/g, ' ');

  // Pass 1 — a matching title, but only if the description does not clearly
  // disagree with it.
  //
  // "Software Engineer" describing Spark, Airflow, dbt and Snowflake is a data
  // role wearing a generic title. Returning on the title alone filed it as
  // software with zero matched skills, which also left resume matching with
  // nothing to compare against.
  for (const spec of SPECS) {
    if (!spec.titles.test(titleForMatch)) continue;
    // A cloud word in a title that is teaching, auditing, buying or building
    // roads. The widened cloud pairing rule below is loose on purpose, and this
    // is what keeps it honest.
    if (spec.id === 'cloud' && CLOUD_TITLE_NOISE.test(titleForMatch)) continue;
    if (spec.id === 'hris' && HRIS_EXCLUSIONS.test(titleForMatch)) continue;
    // A Workday Financials or Supply Chain role is the same platform doing
    // different work. Skipping core HRIS here lets the adjacent pass claim it,
    // so it sits one dropdown away instead of inside an HR filter.
    if (
      spec.id === 'hris' &&
      HRIS_PRODUCTS.test(titleForMatch) &&
      HRIS_NON_HR_MODULE.test(titleForMatch)
    ) continue;

    const { score, names } = matchSkills(spec.skills, haystack);

    // HRIS is title-authoritative: those roles are defined by the product they
    // administer, not by a tech stack, so they never carry a skill fingerprint.
    if (spec.id !== 'hris') {
      if (score < spec.threshold) {
        // The title matched but its own vocabulary barely registers, so let a
        // family the description clearly describes take it instead.
        const better = strongestOtherFamily(spec.id, haystack, score);
        if (better) return { ...better, titleMatched: false, ai };
      } else {
        // The title matched AND has evidence — but another family can still
        // dominate. "Data Analyst" whose description is entirely Kubernetes,
        // Terraform and AWS stayed `data` on a score of 5 against cloud's 20,
        // because the override only rescued below-threshold title matches.
        //
        // The bar is deliberately high: double the score and at least 8 points
        // clear. A Data Engineer mentioning AWS in passing must not become a
        // cloud role.
        const better = strongestOtherFamily(spec.id, haystack, score * DOMINANCE_RATIO);
        if (better && better.score - score >= DOMINANCE_MARGIN) {
          return { ...better, titleMatched: false, ai };
        }
      }
    }

    return {
      family: spec.id,
      score,
      matchedSkills: names,
      allSkills: allMatchedSkills(haystack),
      titleMatched: true,
      ai,
    };
  }

  // Pass 2 — no title match, so fall back to the strongest skill fingerprint.
  // Many providers ship listings with no description at all, which is why a
  // title match alone has to be enough in pass 1.
  let best: RoleClassification = { ...empty, ai };
  for (const spec of SPECS) {
    if (spec.id === 'hris') continue; // never inferred from skills alone
    const { score, names } = matchSkills(spec.skills, haystack);
    if (score >= spec.threshold && score > best.score) {
      best = {
        family: spec.id,
        score,
        matchedSkills: names,
        allSkills: allMatchedSkills(haystack),
        titleMatched: false,
        ai,
      };
    }
  }

  // Pass 3 — last resort, and only for a posting nothing else claimed.
  //
  // A platform word plus a technical role word. Tried any earlier this is a
  // wrecking ball, because cloud is checked before software and a passing
  // mention of AWS would take "Sr. Software Engineer - Java/SpringBoot/AWS".
  // Here it can only ever turn a nothing into a something.
  if (
    best.family === null &&
    !CLOUD_TITLE_NOISE.test(titleForMatch) &&
    CLOUD_TITLES_LOOSE.test(titleForMatch)
  ) {
    return {
      family: 'cloud',
      score: matchSkills(CLOUD_SKILLS, haystack).score,
      matchedSkills: matchSkills(CLOUD_SKILLS, haystack).names,
      allSkills: allMatchedSkills(haystack),
      titleMatched: true,
      ai,
    };
  }

  return best;
}

/**
 * Which stack a software role is built on.
 *
 * A property of a job, not a fifth family. Families are a taxonomy — a role is
 * one of them — but stack is not exclusive: 1,290 of the software roles mention
 * Python AND JavaScript, because a full-stack job genuinely spans both. Forcing
 * those into buckets would mean inventing a rule that is wrong for half of them,
 * so this is a filter you apply rather than a category a job belongs to.
 *
 * Ties go to Python deliberately. Someone filtering for Python work wants to see
 * a full-stack role that uses it; sorting it into "other" would hide exactly the
 * jobs they are looking for.
 *
 * 'unknown' is its own value rather than a default, because 18% of software
 * roles publish no description at all and there is nothing to read. Folding them
 * into either side would make that side's count a lie — the same mistake the
 * country filter made by mixing undecoded locations into every country.
 */
export type Stack = 'python' | 'other' | 'unknown';

/** Skills that mark a role as Python-centred, AI/ML included. */
const PYTHON_STACK = new Set([
  'Python',
  'Python Web',
  'Python Tooling',
  'Python Data',
  'LLM Tooling',
  'ML Frameworks',
  'MLOps',
]);

/** Skills that mark a role as built on something else. */
const OTHER_STACK = new Set([
  'JS/TS',
  'Frontend FW',
  'Java',
  'Other Backend',
  'Web UI',
]);

export function stackOf(matchedSkills: string[]): Stack {
  if (matchedSkills.length === 0) return 'unknown';
  if (matchedSkills.some((s) => PYTHON_STACK.has(s))) return 'python';
  if (matchedSkills.some((s) => OTHER_STACK.has(s))) return 'other';
  // Skills, but none that identify a stack — APIs and Databases alone say
  // nothing about the language. Honest to call that unknown.
  return 'unknown';
}

/** Extracts skills across every family — used to parse a resume. */
export function extractSkills(text: string): string[] {
  const found = new Set<string>();
  for (const terms of [CLOUD_SKILLS, SOFTWARE_SKILLS, DATA_SKILLS, HRIS_SKILLS]) {
    for (const t of terms) if (t.pattern.test(text)) found.add(t.canonical);
  }
  return [...found];
}

/**
 * Per-family skill scores for a job, regardless of what classifyRole decided.
 *
 * classifyRole only reports a score once a family has won, so every near-miss
 * looks identical to a job with no signal at all. Tuning the threshold is
 * guesswork without this.
 */
export function debugScores(job: NormalizedJob): Record<Family, number> {
  const haystack = `${job.title} ${(job.descriptionText ?? '').slice(0, 4000)}`;
  const out = {} as Record<Family, number>;
  for (const spec of SPECS) out[spec.id] = matchSkills(spec.skills, haystack).score;
  return out;
}
