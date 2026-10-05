import {isIP} from 'node:net';
export function trustedClientAddress(headers:Headers):string|undefined{
  const supplied=process.env.NEEDWARE_TRUST_PROXY==='caddy-loopback'&&process.env.NEEDWARE_LOOPBACK_INGRESS==='1'
    ?headers.get('x-needware-client-ip')
    :process.env.VERCEL==='1'&&process.env.NEEDWARE_TRUST_PROXY==='vercel'
      ?headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim():undefined;
  return supplied&&isIP(supplied)?supplied:undefined;
}
