import type { Metadata,Viewport } from 'next';
import OfflineSupport from './offline-support';
import Link from './offline-link';
import './style.css';
import './polish.css';
export const metadata: Metadata = { title: 'Needware — Software when you need it.', description: 'Portable applications powered by a typed Rust runtime.', manifest: '/manifest.webmanifest',icons:{icon:'/favicon.svg',apple:'/icon-180.png'},appleWebApp:{capable:true,title:'Needware',statusBarStyle:'default'} };
export const viewport:Viewport={width:'device-width',initialScale:1,themeColor:'#18594e'};
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a href="#main" className="skip">Skip to content</a>{children}<footer aria-label="Product information"><Link href="/pricing">Pricing</Link> · <Link href="/refunds">Refunds</Link> · <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link> · <a href="mailto:gautam@continuumarc.tech">Support</a><p>Needware by ContinuumArc · Gautam Govind</p></footer><OfflineSupport/></body></html>;
}
