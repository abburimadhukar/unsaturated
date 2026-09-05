import type { Metadata } from 'next';
import './globals.css';

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
