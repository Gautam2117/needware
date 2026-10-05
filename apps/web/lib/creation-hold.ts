import type {Pool,PoolClient} from 'pg';
export async function creationHeld(client:Pool|PoolClient,owner:string){return Boolean((await client.query('SELECT account_id FROM needware_account_hold WHERE account_id=$1 AND active',[owner])).rowCount);}
