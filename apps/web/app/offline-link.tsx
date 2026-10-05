'use client';
import Link from 'next/link';
import type {ReactNode} from 'react';
// Cached application shells use full HTML navigation. RSC requests deliberately
// bypass the offline worker; the sandbox's capture/close guards still apply.
export default function OfflineLink({href,children,className}:{href:string;children:ReactNode;className?:string}){
  return <Link href={href} className={className} prefetch={false} onNavigate={event=>{event.preventDefault();location.assign(href);}}>{children}</Link>;
}
