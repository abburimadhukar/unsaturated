import type { AtsProvider } from '../ats/types.js';
import type { OpenBoard } from './opendata.js';
import { resolveApplyUrl } from '../ats/resolve.js';
import { boardIdentity } from '../corpus/board-store.js';

/**
 * Board tokens from the kalil0321/ats-scrapers open dataset (MIT licence).
 *
 * The existing open-dataset channel (opendata.ts) reads one repo —
 * Feashliaa/job-board-aggregator — covering four providers. This reads a second,
 * larger one: 63,000+ companies across 49 sources, with a per-provider CSV whose
 * columns are `name,slug,url[,domain]`. Because the file already names the
 * provider, the slug is the token for every vendor whose endpoint needs only a
 * token, and the URL carries the extra fields Workday, Oracle and Eightfold need.
 *
 * Nothing here is trusted until verify.ts has confirmed it answers — the dataset
 * is a candidate list, exactly like the Common Crawl harvest, and churns the same
 * way as companies move and rename boards.
 *
 * Source: https://github.com/kalil0321/ats-scrapers (ats-companies/*.csv)
 */

const BASE = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';

/**
 * CSV file -> our provider. Only the files we already have a verify endpoint for
 * (see verify.ts). The dataset also ships adp, successfactors, taleo, paycom,
 * paylocity, avature, jazzhr and phenom — deliberately omitted until an adapter
 * exists, so the gap is visible here rather than silently skipped.
 */
export const DATASET_FILES: { file: string; provider: AtsProvider }[] = [
  { file: 'greenhouse.csv', provider: 'greenhouse' },
  { file: 'lever.csv', provider: 'lever' },
  { file: 'ashby.csv', provider: 'ashby' },
  { file: 'smartrecruiters.csv', provider: 'smartrecruiters' },
  { file: 'workable.csv', provider: 'workable' },
  { file: 'personio.csv', provider: 'personio' },
  { file: 'recruitee.csv', provider: 'recruitee' },
  { file: 'teamtailor.csv', provider: 'teamtailor' },
  { file: 'bamboohr.csv', provider: 'bamboohr' },
  { file: 'rippling.csv', provider: 'rippling' },
  { file: 'breezy.csv', provider: 'breezy' },
  { file: 'icims.csv', provider: 'icims' },
  { file: 'workday.csv', provider: 'workday' },
  { file: 'oracle.csv', provider: 'oracle' },
  { file: 'eightfold.csv', provider: 'eightfold' },
  // ukg omitted on purpose: UKG addresses a board by a numeric board id the
  // dataset does not carry, so a row here could never be verified or crawled.
];

/** Providers whose verify endpoint needs only the token, so the slug alone works. */
const TOKEN_ONLY = new Set<AtsProvider>([
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'workable',
  'personio',
  'recruitee',
  'teamtailor',
  'bamboohr',
  'rippling',
  'breezy',
  'icims',
]);

/** A token is a URL path/subdomain segment; anything else is a parsing artefact. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

/**
 * Workday's address, parsed the same way careers.ts does it. resolveApplyUrl
 * deliberately reports Workday as unsupported — the bare URL is not enough to
 * crawl without the shard and site — so this pulls tenant, shard and site out
 * directly.
 */
const WORKDAY_URL =
  /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Z]{2})\/)?([A-Za-z0-9_-]+)/;

/** "vercel" -> "Vercel". Replaced by the real name on verification where known. */
function titleise(token: string): string {
  return token
    .replace(/[-_.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

export interface DatasetRow {
  name?: string;
  slug?: string;
  url?: string;
  domain?: string;
}

/** Splits one CSV line, honouring double-quoted fields that contain commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parses a dataset CSV into rows.
 *
 * Handles both the standard `name,slug,url,domain` header and the legacy
 * two-column `name,url` form with no header, which the publisher documents as
 * still present in some files.
 */
export function parseCsv(text: string): DatasetRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const first = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const looksLikeHeader = first.some(
    (h) => h === 'name' || h === 'slug' || h === 'url' || h === 'domain',
  );
  const cols = looksLikeHeader ? first : ['name', 'url'];
  const start = looksLikeHeader ? 1 : 0;
  const at = (name: string) => cols.indexOf(name);

  const rows: DatasetRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]!);
    const row: DatasetRow = {};
    const pick = (name: string) => {
      const j = at(name);
      const v = j >= 0 ? f[j]?.trim() : undefined;
      return v && v.length > 0 ? v : undefined;
    };
    row.name = pick('name');
    row.slug = pick('slug');
    row.url = pick('url');
    row.domain = pick('domain');
    rows.push(row);
  }
  return rows;
}

/**
 * One CSV row -> a verifiable board, or null when the row cannot address one.
 *
 * Pure, so every branch is tested directly in tests/datasets.test.ts.
 */
export function rowToBoard(fileProvider: AtsProvider, row: DatasetRow): OpenBoard | null {
  const name = row.name;

  // 1. A full board URL is the most reliable source: it carries Oracle's and
  //    Eightfold's extra fields and the canonical token for everyone else.
  if (row.url) {
    // Workday first, because resolveApplyUrl classes it unsupported by design.
    const wd = WORKDAY_URL.exec(row.url);
    if (wd) {
      const [, tenant, shard, locale, site] = wd;
      if (tenant && shard && site && !/^(wday|en|login|home)$/i.test(site)) {
        return {
          provider: 'workday',
          token: tenant,
          company: name ?? titleise(tenant),
          extra: { host: `${tenant}.${shard}.myworkdayjobs.com`, site, locale: locale ?? 'en-US' },
        };
      }
    }
    const res = resolveApplyUrl(row.url);
    if (res.status === 'supported') {
      const b = res.board;
      return {
        provider: b.provider,
        token: b.token,
        company: name ?? titleise(b.token),
        ...(b.extra ? { extra: b.extra } : {}),
      };
    }
  }

  // 2. Eightfold needs the employer's domain, which this dataset carries in its
  //    own column rather than in the careers URL.
  if (fileProvider === 'eightfold') {
    if (row.slug && row.domain && TOKEN_RE.test(row.slug)) {
      return {
        provider: 'eightfold',
        token: row.slug,
        company: name ?? titleise(row.slug),
        extra: { domain: row.domain, site: row.domain },
      };
    }
    return null;
  }

  // 3. Providers whose endpoint needs only the token: the slug is enough.
  if (TOKEN_ONLY.has(fileProvider) && row.slug && TOKEN_RE.test(row.slug)) {
    return { provider: fileProvider, token: row.slug, company: name ?? titleise(row.slug) };
  }

  // 4. Workday/Oracle rows without a parseable URL carry no addressable board.
  return null;
}

export interface DatasetReport {
  provider: AtsProvider;
  file: string;
  rows: number;
  usable: number;
}

/**
 * Downloads every supported CSV and turns it into verifiable candidates.
 *
 * Deduplicated on board identity across files, because a company that migrated
 * ATS can appear in two of them.
 */
export async function fetchDatasetBoards(opts: {
  userAgent: string;
  providerFilter?: string;
  onProgress?: (file: string, usable: number) => void;
}): Promise<{ boards: OpenBoard[]; reports: DatasetReport[] }> {
  const files = opts.providerFilter
    ? DATASET_FILES.filter((f) => f.provider === opts.providerFilter)
    : DATASET_FILES;

  const seen = new Map<string, OpenBoard>();
  const reports: DatasetReport[] = [];

  for (const { file, provider } of files) {
    let text: string;
    try {
      const res = await fetch(`${BASE}/${file}`, {
        headers: { 'user-agent': opts.userAgent, accept: 'text/csv' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      // One unavailable file must not lose the rest.
      console.error(`  ${file}: ${err instanceof Error ? err.message : String(err)}`);
      reports.push({ provider, file, rows: 0, usable: 0 });
      continue;
    }

    const rows = parseCsv(text);
    let usable = 0;
    for (const row of rows) {
      const board = rowToBoard(provider, row);
      if (!board) continue;
      const key = boardIdentity(board);
      if (seen.has(key)) continue;
      seen.set(key, board);
      usable++;
    }
    reports.push({ provider, file, rows: rows.length, usable });
    opts.onProgress?.(file, usable);
  }

  return { boards: [...seen.values()], reports };
}
