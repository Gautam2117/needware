export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(){
  const sha=process.env.NEEDWARE_RELEASE_SHA;
  return Response.json({status:'available',release:/^[0-9a-f]{40}$/.test(sha??'')?sha:null,
    accounts:Boolean(process.env.DATABASE_URL&&process.env.BETTER_AUTH_SECRET),
    hostedGeneration:process.env.NEEDWARE_HOSTED_GENERATION==='1',billing:process.env.NEEDWARE_BILLING_MODE??'disabled'},
    {headers:{'Cache-Control':'no-store'}});
}
