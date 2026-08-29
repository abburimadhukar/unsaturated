import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Unsaturated — cloud roles',
  description: 'Cloud and infrastructure jobs ranked by how few people are likely applying.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
