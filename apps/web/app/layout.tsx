import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Relay — a little more human', description: 'Your private space for screen recordings, clear ideas, and better conversations.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
