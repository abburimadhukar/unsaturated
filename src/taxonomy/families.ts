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

export type Family = 'cloud' | 'software' | 'data' | 'hris';

export const FAMILY_LABELS: Record<Family, string> = {
  cloud: 'Cloud & Infrastructure',
  software: 'Software Engineering',
  data: 'Data',
  hris: 'HRIS',
};

export const FAMILY_ORDER: Family[] = ['cloud', 'software', 'data', 'hris'];

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
  { pattern: /\b(san\b|nas\b|ceph|netapp|storage array)\b/i, canonical: 'Storage', weight: 3 },
  { pattern: /\b(devsecops|cspm|cnapp|soc ?2|fedramp|cis benchmark)\b/i, canonical: 'Cloud Security', weight: 3 },
  { pattern: /\b(active directory|group policy|windows server|sccm|intune)\b/i, canonical: 'Windows/AD', weight: 2 },
  { pattern: /\b(finops|cloud cost|reserved instances?)\b/i, canonical: 'FinOps', weight: 3 },
];

const SOFTWARE_SKILLS: SkillTerm[] = [
  { pattern: /\bpython\b/i, canonical: 'Python', weight: 3 },
  { pattern: /\b(django|flask|fastapi|pyramid|celery)\b/i, canonical: 'Python Web', weight: 4 },
  { pattern: /\b(typescript|javascript|node\.?js|nodejs)\b/i, canonical: 'JS/TS', weight: 3 },
  { pattern: /\b(react|next\.?js|vue|angular|svelte)\b/i, canonical: 'Frontend FW', weight: 3 },
  { pattern: /\b(java|spring boot|spring)\b/i, canonical: 'Java', weight: 2 },
  { pattern: /\b(golang|\bgo\b lang|\.net|c#|ruby on rails|rails|php|laravel)\b/i, canonical: 'Other Backend', weight: 2 },
  { pattern: /\b(rest api|restful|graphql|grpc|microservices?)\b/i, canonical: 'APIs', weight: 2 },
  { pattern: /\b(postgres(ql)?|mysql|mongodb|redis|dynamodb)\b/i, canonical: 'Databases', weight: 2 },
  { pattern: /\b(html|css|tailwind|sass)\b/i, canonical: 'Web UI', weight: 1 },
  { pattern: /\b(unit test|pytest|jest|tdd|test[- ]driven)\b/i, canonical: 'Testing', weight: 1 },
  { pattern: /\b(langchain|llamaindex|openai api|anthropic|rag\b|vector (db|database)|prompt engineering)\b/i, canonical: 'LLM Tooling', weight: 3 },
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

const CLOUD_TITLES =
  /\b(devops|sre|site reliability|production engineer|platform engineer|platform reliability|cloud engineer|cloud architect|cloud operations|cloud infrastructure|infrastructure engineer|infrastructure architect|systems engineer|system engineer|systems administrator|sysadmin|network engineer|network administrator|network architect|noc\b|devsecops|cloud security|storage engineer|virtuali[sz]ation|build engineer|release engineer|observability|kubernetes|finops|mlops|ml ?platform|ai infrastructure|technical operations|techops|site operations|infra engineer|systems architect|cluster (engineer|architect)|capacity engineer|provisioning engineer)\b/i;

const SOFTWARE_TITLES =
  /\b(software engineer|software developer|software development engineer|\bsde\b|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|python developer|python engineer|web developer|application developer|applications engineer|api engineer|programmer|ai engineer|llm engineer|genai engineer|applied ai|forward deployed engineer)\b/i;

const DATA_TITLES =
  /\b(data engineer|data analyst|analytics engineer|data scientist|data architect|database engineer|database administrator|\bdba\b|etl developer|data platform|big data|business intelligence|\bbi\b (developer|analyst|engineer)|reporting analyst|machine learning engineer|ml engineer|machine learning scientist|research scientist|quantitative analyst|decision scientist|data quality)\b/i;

const HRIS_TITLES =
  /\b(hris|hcm|hrms|human resources? (information|systems)|hr systems|hr technology|people systems|people technology|workday (consultant|analyst|specialist|administrator|functional|integration)|successfactors (consultant|analyst)|payroll (analyst|systems|configuration)|benefits (analyst|systems)|compensation analyst|hr data analyst|hr operations analyst|total rewards analyst)\b/i;

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

/** Never in any family, regardless of what the description mentions. */
const GLOBAL_EXCLUSIONS: [RegExp, string][] = [
  [/\b(sales|account)\s+(engineer|executive|manager|director)\b/i, 'sales'],
  [/\bpre[- ]?sales\b/i, 'pre-sales'],
  [/\b(recruiter|talent acquisition|sourcer|staffing (specialist|coordinator))\b/i, 'recruiting'],
  [/\b(data ?cent(er|re)\s+(technician|tech|operator))\b/i, 'datacenter hardware'],
  [/\b(help ?desk|service desk|desktop support|field (service|technician))\b/i, 'end-user support'],
  [/\b(intern|internship|co[- ]?op)\b/i, 'internship'],
  [/\b(nurse|physician|therapist|clinician|caregiver|pharmacist|dental|veterinar)\b/i, 'clinical'],
  [/\b(driver|warehouse|forklift|janitor|custodian|security officer|guard)\b/i, 'manual'],
  [/\b(teacher|professor|lecturer|faculty)\b/i, 'education'],
  [/\b(marketing|content writer|copywriter|social media|seo specialist)\b/i, 'marketing'],

  // Non-engineering roles at technology companies. Their descriptions carry the
  // same stack keywords as the engineering ones, so without this the skill
  // fingerprint happily files a Strategic Sourcing Manager under Cloud.
  [/\b(product|program|project|procurement|sourcing|category|community|office)\s+manager\b/i, 'non-engineering management'],
  [/\b(accountant|accounting|controller|bookkeep)\b/i, 'accounting'],
  [/\b(counsel|attorney|paralegal|legal|compliance officer)\b/i, 'legal'],
  [/\b(designer|creative director|illustrator|\bux\b)\b/i, 'design'],
  [/\b(developer relations|developer advocate|devrel|evangelist|technical writer)\b/i, 'devrel/docs'],
  // Drafts left on public boards; not real openings.
  [/^copy of\b/i, 'draft'],
  // Revenue-side engineering roles, not the four families.
  [/\b(gtm|go.to.market|growth (content )?engineer|deal desk)\b/i, 'revenue'],
  [/\b(solutions?|sales|customer success|customer reliability|implementation)\s+(engineer|architect|consultant|manager)\b/i, 'customer-facing'],
  [/\bsales\b|\bbusiness development\b|\b(sdr|bdr)\b|\brepresentative\b|\bquota\b/i, 'sales'],
  [/\b(financial analyst|finance manager|treasury|investor relations)\b/i, 'finance'],
  [/\b(executive assistant|office administrator|receptionist|facilities)\b/i, 'admin'],
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

export function classifyRole(job: NormalizedJob): RoleClassification {
  const title = job.title;
  // Descriptions are capped — past a few thousand characters we are matching
  // benefits boilerplate, not the role.
  const body = (job.descriptionText ?? '').slice(0, 4000);
  const haystack = `${title} ${body}`;

  const empty: RoleClassification = {
    family: null, score: 0, matchedSkills: [], titleMatched: false, ai: false,
  };

  for (const [pattern, reason] of GLOBAL_EXCLUSIONS) {
    if (pattern.test(title)) return { ...empty, excludedReason: reason };
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

  // Pass 1 — a matching title is the strongest signal available.
  for (const spec of SPECS) {
    if (!spec.titles.test(titleForMatch)) continue;
    if (spec.id === 'hris' && HRIS_EXCLUSIONS.test(titleForMatch)) continue;
    const { score, names } = matchSkills(spec.skills, haystack);
    return { family: spec.id, score, matchedSkills: names, titleMatched: true, ai };
  }

  // Pass 2 — no title match, so fall back to the strongest skill fingerprint.
  // Many providers ship listings with no description at all, which is why a
  // title match alone has to be enough in pass 1.
  let best: RoleClassification = { ...empty, ai };
  for (const spec of SPECS) {
    if (spec.id === 'hris') continue; // never inferred from skills alone
    const { score, names } = matchSkills(spec.skills, haystack);
    if (score >= spec.threshold && score > best.score) {
      best = { family: spec.id, score, matchedSkills: names, titleMatched: false, ai };
    }
  }
  return best;
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
