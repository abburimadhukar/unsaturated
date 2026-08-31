import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Unsaturated — jobs straight from employers',
  // Ranking moved to recency; the saturation score is no longer computed or
  // shown, so describing the site by it was simply inaccurate.
  description:
    'Cloud, software, data and HRIS roles read directly from employers’ own career pages, newest first.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
