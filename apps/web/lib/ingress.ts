import {isIP} from 'node:net';
export function trustedClientAddress(headers:Headers):string|undefined{
  const supplied=process.env.NEEDWARE_TRUST_PROXY==='caddy-loopback'&&process.env.NEEDWARE_LOOPBACK_INGRESS==='1'
    ?headers.get('x-needware-client-ip')
    :process.env.VERCEL==='1'&&process.env.NEEDWARE_TRUST_PROXY==='vercel'
      ?headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()
      :process.env.NEEDWARE_TRUST_PROXY==='netlify'&&Boolean(process.env.SITE_ID)&&process.env.SITE_ID===process.env.NEEDWARE_NETLIFY_SITE_ID&&Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME)
        ?headers.get('x-nf-client-connection-ip'):undefined;
  return supplied&&isIP(supplied)?supplied:undefined;
}
