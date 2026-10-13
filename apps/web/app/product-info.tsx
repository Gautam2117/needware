import Link from './offline-link';
export function ProductInfo({title,children}:{title:string;children:React.ReactNode}){
 return <><header><strong>needware /</strong><nav aria-label="Needware"><Link href="/">Your apps</Link><Link href="/pricing">Pricing</Link><Link href="/account">Your account</Link></nav></header><main id="main" className="billing-page"><h1>{title}</h1>{children}</main></>;
}
