import 'server-only';
import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import type {Pool} from 'pg';
import {CloudError} from './cloud-request';
export async function publicRequest(request:Request,pool:Pool,bytes=0){
  const supplied=process.env.VERCEL==='1'&&process.env.NEEDWARE_TRUST_PROXY==='vercel'?request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim():undefined;
  const address=supplied&&isIP(supplied)?supplied:'conservative-shared-ingress';
  const key=createHmac('sha256',process.env.BETTER_AUTH_SECRET!).update(`registry:${address}`).digest('hex');
  const result=await pool.query(`INSERT INTO needware_public_limit(key,count,bytes,reset_at) VALUES($1,1,$2,now()+interval '1 minute')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN needware_public_limit.reset_at<=now() THEN 1 ELSE needware_public_limit.count+1 END,
    bytes=CASE WHEN needware_public_limit.reset_at<=now() THEN $2 ELSE needware_public_limit.bytes+$2 END,
    reset_at=CASE WHEN needware_public_limit.reset_at<=now() THEN now()+interval '1 minute' ELSE needware_public_limit.reset_at END
    WHERE needware_public_limit.reset_at<=now() OR (needware_public_limit.count<120 AND needware_public_limit.bytes+$2<=33554432) RETURNING key`,[key,bytes]);
  if(!result.rowCount)throw new CloudError(429,'Registry request or download limit; try again shortly');
}
