export function workerHealthQuery(env:Record<string,string|undefined>=process.env){
  const generationMode=env.NEEDWARE_GENERATION_WORKER_MODE;
  if(generationMode!==undefined&&!['continuous','scheduled'].includes(generationMode))return {sql:'false',values:[]};
  const mode=env.NEEDWARE_WORKER_MODE??'continuous',period=Number(env.NEEDWARE_WORKER_INTERVAL_SECONDS??'300');
  if(!['continuous','scheduled'].includes(mode)||!Number.isInteger(period)||period<60||period>3600)return {sql:'false',values:[]};
  const query={sql:`w.mode=$1 AND w.updated_at<=now()+interval '5 seconds' AND (
    ($1='continuous' AND w.state='running' AND w.updated_at>now()-interval '30 seconds') OR
    ($1='scheduled' AND w.period_seconds=$2 AND (
      (w.state='running' AND w.updated_at>now()-interval '30 seconds') OR
      (w.state='idle' AND w.updated_at>now()-(w.period_seconds+60)*interval '1 second')
    ) AND NOT EXISTS (SELECT 1 FROM needware_worker_health newer WHERE newer.worker=w.worker AND newer.mode=w.mode
      AND (newer.updated_at,newer.instance)>(w.updated_at,w.instance)))
  )`,values:[mode,period]};
  if(generationMode){query.sql=query.sql.replace('w.mode=$1',"w.mode=CASE WHEN w.worker='generation' THEN $3 ELSE $1 END").replace("$1='continuous'","w.mode='continuous'").replace("$1='scheduled'","w.mode='scheduled'");query.values.push(generationMode);}
  return query;
}
