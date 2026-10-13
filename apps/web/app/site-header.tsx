import Link from './offline-link';
const items=[
  {href:'/registry',label:'Discover',name:'Application registry',key:'registry',path:'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z'},
  {href:'/generation',label:'Creations',name:'Your creations',key:'generation',path:'m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z'},
  {href:'/encrypted',label:'Private apps',name:'Your encrypted apps',key:'encrypted',path:'M5 10h14v11H5zm3 0V6a4 4 0 0 1 8 0v4'},
  {href:'/account',label:'Account',name:'Your account',key:'account',path:'M20 21v-2a6 6 0 0 0-12 0v2M14 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8'}
] as const;
export default function SiteHeader({current}:{current?:string}){
 return <header className="site-header"><Link href="/" className="brand" aria-label="Needware home"><span className="brand-mark" aria-hidden="true"><i/><i/><i/><i/></span><span>needware<span className="brand-dot">.</span></span></Link><nav aria-label="Needware">{items.map(item=><Link key={item.key} href={item.href} aria-label={item.name} aria-current={current===item.key?'page':undefined}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.path}/></svg><span>{item.label}</span></Link>)}</nav></header>;
}
