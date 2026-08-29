import type { NormalizedJob } from '../ats/types.js';

/**
 * Cloud / infrastructure role taxonomy.
 *
 * Matching is SKILL-FIRST, not title-first. In this vertical the same job is
 * called DevOps Engineer, SRE, Platform Engineer, Infrastructure Engineer or
 * Cloud Engineer depending purely on company culture — measured on a 1.8M job
 * index, "devops engineer" (28,422) and "kubernetes engineer" (28,528) return
 * near-identical counts because they are the same population.
 *
 * So titles are used for display and for a confidence bump, never as the
 * retrieval key. A job qualifies on its skill fingerprint.
 */

export type RoleFamily =
  | 'devops_sre'
  | 'platform'
  | 'cloud_infra'
  | 'cloud_architect'
  | 'cloud_security'
  | 'network'
  | 'storage_virt'
  | 'data_platform'
  | 'mlops'
  | 'finops'
  | 'noc_ops'
  | 'sysadmin';

export const ROLE_FAMILY_LABELS: Record<RoleFamily, string> = {
  devops_sre: 'DevOps / SRE',
  platform: 'Platform Engineering',
  cloud_infra: 'Cloud / Infrastructure',
  cloud_architect: 'Cloud Architecture',
  cloud_security: 'Cloud Security / DevSecOps',
  network: 'Network / NetDevOps',
  storage_virt: 'Storage / Virtualization',
  data_platform: 'Data Platform / Data Infra',
  mlops: 'MLOps / AI Infrastructure',
  finops: 'FinOps / Cloud Cost',
  noc_ops: 'NOC / Cloud Operations',
  sysadmin: 'Systems Administration',
};

/**
 * Skill fingerprint. `weight` is how strongly a term implies this is genuinely
 * a cloud/infra role rather than a passing mention — "Kubernetes" is far more
 * diagnostic than "Python".
 */
interface SkillTerm {
  pattern: RegExp;
  canonical: string;
  weight: number;
}

export const CLOUD_SKILLS: SkillTerm[] = [
  // Platforms — strongest signal
  { pattern: /\b(aws|amazon web services)\b/i, canonical: 'AWS', weight: 3 },
  { pattern: /\b(azure|microsoft azure)\b/i, canonical: 'Azure', weight: 3 },
  { pattern: /\b(gcp|google cloud)\b/i, canonical: 'GCP', weight: 3 },
  { pattern: /\b(oci|oracle cloud)\b/i, canonical: 'OCI', weight: 3 },
  { pattern: /\b(ibm cloud|alibaba cloud)\b/i, canonical: 'Other Cloud', weight: 3 },

  // Orchestration & IaC — the most diagnostic terms in the vertical
  { pattern: /\b(kubernetes|k8s|eks|aks|gke|openshift)\b/i, canonical: 'Kubernetes', weight: 4 },
  { pattern: /\bterraform\b/i, canonical: 'Terraform', weight: 4 },
  { pattern: /\b(cloudformation|pulumi|bicep|arm templates?)\b/i, canonical: 'IaC', weight: 3 },
  { pattern: /\b(ansible|puppet|chef|saltstack)\b/i, canonical: 'Config Mgmt', weight: 3 },
  { pattern: /\b(docker|containerd|podman)\b/i, canonical: 'Docker', weight: 2 },
  { pattern: /\bhelm\b/i, canonical: 'Helm', weight: 3 },
  { pattern: /\b(argo\s?cd|argocd|flux\s?cd|gitops)\b/i, canonical: 'GitOps', weight: 3 },

  // Pipelines & observability
  { pattern: /\bci\/?cd\b/i, canonical: 'CI/CD', weight: 2 },
  { pattern: /\b(jenkins|gitlab ci|github actions|circleci|teamcity|bamboo)\b/i, canonical: 'CI Tooling', weight: 2 },
  { pattern: /\b(prometheus|grafana|datadog|splunk|new relic|opentelemetry|elk|nagios|zabbix)\b/i, canonical: 'Observability', weight: 3 },

  // Foundations
  { pattern: /\b(linux|unix|rhel|centos|ubuntu server)\b/i, canonical: 'Linux', weight: 2 },
  { pattern: /\b(bash|shell scripting|powershell)\b/i, canonical: 'Scripting', weight: 1 },
  { pattern: /\b(python|go|golang)\b/i, canonical: 'Python/Go', weight: 1 },

  // Networking & storage
  { pattern: /\b(vpc|subnet|bgp|ospf|load balanc|dns|cdn|firewall|vpn)\b/i, canonical: 'Networking', weight: 2 },
  { pattern: /\b(vmware|vsphere|esxi|hyper-v|nutanix|citrix|xen)\b/i, canonical: 'Virtualization', weight: 3 },
  { pattern: /\b(san\b|nas\b|ceph|netapp|zfs|storage array)\b/i, canonical: 'Storage', weight: 3 },

  // Adjacent specialisms
  { pattern: /\b(devsecops|cspm|cnapp|iam policy|soc ?2|fedramp|cis benchmark)\b/i, canonical: 'Cloud Security', weight: 3 },
  { pattern: /\b(mlops|kubeflow|mlflow|sagemaker|vertex ai)\b/i, canonical: 'MLOps', weight: 3 },
  { pattern: /\b(finops|cloud cost|cost optimi[sz]ation|reserved instances?)\b/i, canonical: 'FinOps', weight: 3 },
  { pattern: /\b(active directory|group policy|windows server|sccm|intune)\b/i, canonical: 'Windows/AD', weight: 2 },
];

/** Title patterns per family. Order matters — first match wins. */
const TITLE_FAMILIES: [RegExp, RoleFamily][] = [
  [/\b(finops|cloud (cost|financial))\b/i, 'finops'],
  [/\b(mlops|ml ?platform|ai infra|machine learning infra)\b/i, 'mlops'],
  [/\b(devsecops|cloud security|security engineer.*cloud|infrastructure security)\b/i, 'cloud_security'],
  [/\b(storage|virtuali[sz]ation|vmware)\b.*\bengineer\b/i, 'storage_virt'],
  [/\bnetwork\b.*\b(engineer|architect|administrator)\b/i, 'network'],
  [/\b(data (platform|infrastructure))\b/i, 'data_platform'],
  [/\b(cloud|solutions?|infrastructure|enterprise)\s+architect\b/i, 'cloud_architect'],
  [/\b(sre|site reliability|production engineer)\b/i, 'devops_sre'],
  [/\bdevops\b/i, 'devops_sre'],
  [/\bplatform\s+(engineer|reliability)/i, 'platform'],
  [/\b(noc|network operations|cloud operations|operations engineer|techops|technical operations)\b/i, 'noc_ops'],
  [/\b(systems? admin|sysadmin|system administrator)\b/i, 'sysadmin'],
  [/\b(cloud|infrastructure|systems?)\s+engineer\b/i, 'cloud_infra'],
  [/\b(aws|azure|gcp)\s+engineer\b/i, 'cloud_infra'],
];

/**
 * Hard exclusions. These overlap on skills but are a different hiring pool, so
 * letting them through would pollute the feed with roles the user can't use.
 */
const EXCLUSIONS: [RegExp, string][] = [
  // Non-engineering functions. These slip through on skill fingerprint alone
  // because their descriptions name the stack the team uses.
  [/\b(product|program|project|engineering)\s+manager\b/i, 'management/PM'],
  [/\b(ux|ui|product)\s+(designer|researcher|lead|validation)\b/i, 'design/research'],
  [/\b(designer|researcher|technical writer|content|marketing|community)\b/i, 'non-engineering'],
  [/\bscrum master\b|\bagile coach\b/i, 'delivery'],

  // "Platform engineer" is only ours when it means infrastructure. Mobile, web
  // and game platform teams are a completely different discipline.
  [/\b(android|ios|mobile|web|game|gaming|frontend|front-end)\s+platform\b/i, 'non-infra platform'],
  [/\b(simulation|perception|autonomy|robotics|controls)\s+engineer\b/i, 'simulation/robotics'],

  [/\b(sales|account)\s+(engineer|executive)\b/i, 'sales role'],
  [/\bpre-?sales\b/i, 'pre-sales'],
  [/\b(data scientist|data analyst)\b/i, 'data science'],
  [/\bdata engineer\b/i, 'data engineering'],
  [/\b(application security|appsec|penetration test|pentest|soc analyst)\b/i, 'appsec/secops'],
  [/\b(data ?cent(er|re)\s+(technician|tech|operator))\b/i, 'datacenter hardware'],
  [/\b(field|desktop|help ?desk|service desk)\s+(technician|support|engineer)\b/i, 'end-user support'],
  [/\b(embedded|firmware|hardware)\s+engineer\b/i, 'embedded/hardware'],
  [/\b(frontend|front-end|mobile|ios|android|game)\s+(developer|engineer)\b/i, 'non-infra software'],
  [/\b(recruiter|talent|sourcer)\b/i, 'recruiting'],
];

export interface CloudClassification {
  inScope: boolean;
  /** Summed weight of matched skill terms. */
  skillScore: number;
  matchedSkills: string[];
  family: RoleFamily | null;
  titleMatched: boolean;
  excludedReason?: string;
}

/** Minimum fingerprint weight for a title-less match to count. */
const SKILL_THRESHOLD = 12;

/**
 * A skill fingerprint alone is not enough. Almost every backend team at a modern
 * company mentions AWS, Docker and CI/CD in its job descriptions, so matching on
 * skills only pulls in generic software roles. The title has to at least gesture
 * at infrastructure before a heavy fingerprint is allowed to qualify it.
 */
const INFRA_TITLE_HINT =
  /\b(infrastructur\w*|platform|cloud|devops|sre|reliability|operations|ops\b|systems?|sysadmin|network|kubernetes|container|deployment|build|release|observability|virtuali[sz]ation|storage|datacent\w*)\b/i;

export function classifyCloudRole(job: NormalizedJob): CloudClassification {
  const title = job.title;
  // Descriptions are capped: past a few thousand characters we are matching
  // boilerplate benefits copy, not the actual role.
  const haystack = `${title} ${(job.descriptionText ?? '').slice(0, 4000)}`;

  for (const [pattern, reason] of EXCLUSIONS) {
    if (pattern.test(title)) {
      return {
        inScope: false,
        skillScore: 0,
        matchedSkills: [],
        family: null,
        titleMatched: false,
        excludedReason: reason,
      };
    }
  }

  const matched = new Map<string, number>();
  for (const term of CLOUD_SKILLS) {
    if (term.pattern.test(haystack)) {
      matched.set(term.canonical, Math.max(matched.get(term.canonical) ?? 0, term.weight));
    }
  }
  const skillScore = [...matched.values()].reduce((a, b) => a + b, 0);

  let family: RoleFamily | null = null;
  for (const [pattern, fam] of TITLE_FAMILIES) {
    if (pattern.test(title)) {
      family = fam;
      break;
    }
  }

  // Two independent ways in:
  //  1. The title names the role outright — this also rescues listing-only feeds
  //     (Workable, SmartRecruiters) that carry no description to fingerprint.
  //  2. A heavy skill fingerprint AND a title that at least mentions infra.
  //     Requiring both is what stops "Senior Software Engineer" at a company
  //     that happens to run Kubernetes from flooding the feed.
  const inScope =
    family !== null || (skillScore >= SKILL_THRESHOLD && INFRA_TITLE_HINT.test(title));

  return {
    inScope,
    skillScore,
    matchedSkills: [...matched.keys()],
    family: family ?? (inScope ? 'cloud_infra' : null),
    titleMatched: family !== null,
  };
}

/** Extracts canonical cloud skills from free text — used to parse a resume. */
export function extractSkills(text: string): string[] {
  const found = new Set<string>();
  for (const term of CLOUD_SKILLS) {
    if (term.pattern.test(text)) found.add(term.canonical);
  }
  return [...found];
}
