import type { Metadata } from 'next';
import './globals.css';

/**
 * Nothing here is prerendered, and that is a correctness fix rather than a
 * preference.
 *
 * Every page in this app is a client shell that fetches its data at runtime, so
 * prerendering saved one render and bought nothing. What it COST was severe:
 * OpenNext serves a prerendered page with `s-maxage=31536000`, so Cloudflare
 * held each page's HTML for a year — HTML that names the exact hashed script
 * bundles of the build it came from.
 *
 * The next deploy replaces those bundles. The cached HTML keeps asking for the
 * old ones, they 404, and no JavaScript runs at all. The page renders its empty
 * shell and stops.
 *
 * That is what happened to /account: it served HTML from a build days old,
 * pointing at webpack-4a462cecab786e93.js which no longer existed, while
 * /account?bust=1 — a different cache key — returned the current build
 * perfectly. Every other page carried the same year-long header and was simply
 * waiting its turn.
 *
 * Dynamic pages are sent `no-store`, so the HTML is never held and can never
 * disagree with the bundles it references. The feed API keeps its own
 * `s-maxage=60`, which is the caching that actually mattered.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Unsaturated — jobs straight from employers',
  // Ranking moved to recency; the saturation score is no longer computed or
  // shown, so describing the site by it was simply inaccurate.
  description:
    'Cloud, software, data and HRIS roles read directly from employers’ own career pages, newest first.',
};

/**
 * Applies the saved theme before the first paint.
 *
 * React cannot do this: the page renders once with the default dark palette,
 * then a `useEffect` swaps it — so a light-theme visitor gets a black flash on
 * every single page load. This runs synchronously in <head>, before the body
 * exists, so there is nothing to flash.
 *
 * Wrapped in try/catch because reading localStorage throws outright in private
 * browsing and wherever site data is blocked, and a theme preference must never
 * be able to stop the page rendering.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem('unsaturated.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
