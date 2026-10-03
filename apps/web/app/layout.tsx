import type { Metadata } from 'next';
import './style.css';
export const metadata: Metadata = { title: 'Needware — Software when you need it.', description: 'Portable applications powered by a typed Rust runtime.', manifest: '/manifest.webmanifest' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a href="#main" className="skip">Skip to content</a>{children}</body></html>;
}
