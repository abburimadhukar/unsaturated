/**
 * Where the "After applying" page's back button may point.
 *
 * The job card sends the view the reader came from — path AND filters, e.g.
 * `/quiet?family=data&country=GB` — so returning lands them exactly where they
 * were rather than at the top of an unfiltered list. That value arrives in the
 * URL and goes straight into an anchor's href, so it is VALIDATED here, not
 * trusted: the pathname must be one of this site's own list pages, and the whole
 * thing must be a plain same-site path. That is what stops a crafted `?from=`
 * turning this page's own back button into an off-site link, a protocol-relative
 * `//evil.com`, or a `javascript:` URI.
 *
 * Anything that does not pass falls back to the main feed — the same safe default
 * the fixed allow-list used before filters were carried through.
 */

const BACK_LABELS: Record<string, string> = {
  '/': 'jobs',
  '/quiet': 'quiet roles',
  '/institutions': 'institutions',
  '/washington': 'washington',
};

export interface BackTarget {
  href: string;
  label: string;
}

export function safeBackTo(from: string | undefined | null): BackTarget {
  const fallback: BackTarget = { href: '/', label: 'jobs' };
  if (!from || from.length > 300) return fallback;

  // A same-site, absolute-path reference and nothing else: exactly one leading
  // slash (so not the protocol-relative `//host`), no backslashes (which some
  // browsers treat as slashes), and therefore no scheme like `javascript:` or
  // `https:`, which cannot begin with a slash.
  if (!from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return fallback;

  // The pathname — before any query or fragment — must be one of our list pages.
  const path = from.split('?')[0]!.split('#')[0]!;
  const label = BACK_LABELS[path];
  if (!label) return fallback;

  return { href: from, label };
}
