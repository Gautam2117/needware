import type { Metadata,Viewport } from 'next';
import OfflineSupport from './offline-support';
import './style.css';
export const metadata: Metadata = { title: 'Needware — Software when you need it.', description: 'Portable applications powered by a typed Rust runtime.', manifest: '/manifest.webmanifest',icons:{icon:'/favicon.svg',apple:'/icon-180.png'},appleWebApp:{capable:true,title:'Needware',statusBarStyle:'default'} };
export const viewport:Viewport={width:'device-width',initialScale:1,themeColor:'#18594e'};
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a href="#main" className="skip">Skip to content</a>{children}<OfflineSupport/></body></html>;
}
