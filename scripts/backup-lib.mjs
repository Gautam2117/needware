import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {open,link,unlink,mkdtemp,chmod,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {Readable,Writable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),{Pool}=require('pg');
const MAGIC=Buffer.from('NEEDBK01'),HEADER=20,TAG=16,MAX=16*1024**3;
const local=host=>['127.0.0.1','localhost','[::1]'].includes(host);
export function backupConfig(environment=process.env){
  const raw=environment.NEEDWARE_BACKUP_KEY;if(!raw||!/^[0-9a-fA-F]{64}$/.test(raw))throw Error('A separate 32-byte backup key is required');
  let url;try{url=new URL(environment.DATABASE_URL);}catch{throw Error('A PostgreSQL database is required');}
  const database=decodeURIComponent(url.pathname.slice(1)),user=decodeURIComponent(url.username),password=decodeURIComponent(url.password);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!user||!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(database)||url.hash||[...url.searchParams.keys()].some(key=>key!=='sslmode'))throw Error('Invalid backup database configuration');
  const ca=environment.NEEDWARE_DATABASE_CA_PEM;if(!local(url.hostname)&&(!ca||ca.length>65536||url.searchParams.has('sslmode')&&url.searchParams.get('sslmode')!=='verify-full'))throw Error('Remote backups require certificate-verified TLS and the database CA');
  url.search='';return {key:Buffer.from(raw,'hex'),url,database,user,password,ca,local:local(url.hostname),path:environment.PATH};
}
function limit(maximum=MAX){let size=0;return new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>maximum)callback(Error('Backup size limit exceeded'));else callback(null,chunk);}});}
function discard(){return new Writable({write(chunk,encoding,callback){chunk.fill(0);callback();}});}
function fileWriter(file,start=0){let position=start;return new Writable({write(chunk,encoding,callback){(async()=>{let offset=0;while(offset<chunk.length){const {bytesWritten}=await file.write(chunk,offset,chunk.length-offset,position);if(!bytesWritten)throw Error('Backup write was interrupted');offset+=bytesWritten;position+=bytesWritten;}})().then(()=>callback(),callback);}});}
function fileReader(file,start,end){return Readable.from((async function*(){let position=start;while(position<=end){const bytes=Buffer.alloc(Math.min(65536,end-position+1)),{bytesRead}=await file.read(bytes,0,bytes.length,position);if(!bytesRead)throw Error('Backup was truncated during read');position+=bytesRead;yield bytes.subarray(0,bytesRead);}})());}
async function driver(config,container){
  const directory=await mkdtemp(join(tmpdir(),'needware-pg-'));await chmod(directory,0o700);
  const env={PATH:config.path,LANG:'C',PGHOST:config.url.hostname.replace(/^\[|\]$/g,''),PGPORT:config.url.port||'5432',PGUSER:config.user,PGPASSWORD:config.password,PGDATABASE:config.database,PGCONNECT_TIMEOUT:'10',PGOPTIONS:'-c statement_timeout=600000',PGSSLMODE:config.local?'disable':'verify-full',PGPASSFILE:'/dev/null'};
  try{if(config.ca){env.PGSSLROOTCERT=join(directory,'database-ca.pem');await writeFile(env.PGSSLROOTCERT,config.ca,{mode:0o600,flag:'wx'});}
    let prefix=null;if(container){if(!config.local||config.url.port!=='55432'||config.user!=='needware')throw Error('The local container option only supports the isolated Needware development service');const found=spawnSync('docker',['ps','--filter','label=com.docker.compose.project=needware-dev','--filter','label=com.docker.compose.service=postgres','--format','{{.ID}}'],{encoding:'utf8',timeout:10000});const id=found.stdout?.trim();if(found.status!==0||!id||!/^[0-9a-f]{12,64}$/.test(id))throw Error('Exactly one local PostgreSQL service is required');prefix=['docker',['exec','-i','-e','PGOPTIONS=-c statement_timeout=600000',id]];}
    const run=(tool,args,input=false)=>{const child=prefix?spawn(prefix[0],[...prefix[1],tool,'--username',config.user,...args],{stdio:[input?'pipe':'ignore','pipe','pipe'],timeout:900000}):spawn(tool,args,{env,stdio:[input?'pipe':'ignore','pipe','pipe'],timeout:900000});let warnings=false;child.stderr.on('data',()=>{warnings=true;});const done=new Promise(resolve=>{child.once('error',()=>resolve({ok:false,warnings}));child.once('close',code=>resolve({ok:code===0,warnings}));});return {child,done};};
    return {run,close:()=>rm(directory,{recursive:true,force:true})};
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
async function databasePool(config){const pool=new Pool({connectionString:config.url.toString(),max:1,connectionTimeoutMillis:10000,ssl:config.local?undefined:{rejectUnauthorized:true,ca:config.ca}});try{await pool.query('SELECT 1');return pool;}catch{await pool.end();throw Error('Could not verify the backup database connection');}}
export async function backupDatabase(path,config,{container=false}={}){
  const target=resolve(path),temporary=join(dirname(target),`.needware-backup-${randomBytes(16).toString('hex')}`);let file,pg,processResult;
  try{pg=await driver(config,container);const pool=await databasePool(config);try{const version=Number((await pool.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);if(version<180000||version>=190000)throw Error('Backup requires the reviewed PostgreSQL 18 deployment');}finally{await pool.end();}
    file=await open(temporary,'wx',0o600);const nonce=randomBytes(12),header=Buffer.concat([MAGIC,nonce]);if((await file.write(header,0,HEADER,0)).bytesWritten!==HEADER)throw Error('Backup header write failed');const cipher=createCipheriv('aes-256-gcm',config.key,nonce,{authTagLength:TAG});cipher.setAAD(header);
    processResult=pg.run('pg_dump',['--format=custom','--no-owner','--no-acl','--lock-wait-timeout=5000','--dbname',config.database]);
    await pipeline(processResult.child.stdout,limit(),cipher,fileWriter(file,HEADER));const completed=await processResult.done;if(!completed.ok||completed.warnings)throw Error('PostgreSQL backup failed or emitted a warning; artifact was not published');
    const size=(await file.stat()).size;if((await file.write(cipher.getAuthTag(),0,TAG,size)).bytesWritten!==TAG)throw Error('Backup authentication tag write failed');await file.sync();await file.chmod(0o400);await file.close();file=null;
    await link(temporary,target);await unlink(temporary);const directory=await open(dirname(target),'r');try{await directory.sync();}finally{await directory.close();}return {bytes:size+TAG};
  }catch(error){processResult?.child.kill('SIGTERM');throw error;}finally{if(file)await file.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});if(pg)await pg.close();}
}
async function authenticatedSnapshot(path,key,directory){
  const source=await open(resolve(path),constants.O_RDONLY|constants.O_NOFOLLOW);let snapshot;try{const stat=await source.stat();if(!stat.isFile()||stat.size<HEADER+TAG+1||stat.size>MAX+HEADER+TAG)throw Error('Invalid encrypted backup size');snapshot=await open(join(directory,'snapshot'),'wx+',0o600);await pipeline(fileReader(source,0,stat.size-1),limit(MAX+HEADER+TAG),fileWriter(snapshot));await snapshot.sync();const copyStat=await snapshot.stat();if(copyStat.size!==stat.size)throw Error('Backup changed during snapshot');const header=Buffer.alloc(HEADER),tag=Buffer.alloc(TAG);await snapshot.read(header,0,HEADER,0);await snapshot.read(tag,0,TAG,stat.size-TAG);if(!header.subarray(0,8).equals(MAGIC))throw Error('Unknown encrypted backup format');
    const decrypt=()=>{const value=createDecipheriv('aes-256-gcm',key,header.subarray(8),{authTagLength:TAG});value.setAAD(header);value.setAuthTag(tag);return value;};
    await pipeline(fileReader(snapshot,HEADER,stat.size-TAG-1),decrypt(),discard());await snapshot.chmod(0o400);return {file:snapshot,size:stat.size,decrypt};
  }catch{if(snapshot)await snapshot.close();throw Error('Backup authentication failed; target database was not touched');}finally{await source.close();}
}
export async function restoreDatabase(path,config,{container=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'needware-restore-'));await chmod(directory,0o700);let snapshot,pg,result,pool;
  try{snapshot=await authenticatedSnapshot(path,config.key,directory);pool=await databasePool(config);
    const version=Number((await pool.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);if(version<180000||version>=190000)throw Error('Restore requires the reviewed PostgreSQL 18 deployment');
    const count=await pool.query(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f'))+(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')+(SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_%') AS objects`);
    if(Number(count.rows[0].objects)!==0)throw Error('Restore requires a separate empty target database; existing data was preserved');
    pg=await driver(config,container);result=pg.run('pg_restore',['--single-transaction','--exit-on-error','--no-owner','--no-acl','--dbname',config.database],true);
    await pipeline(fileReader(snapshot.file,HEADER,snapshot.size-TAG-1),snapshot.decrypt(),result.child.stdin);const finished=await result.done;if(!finished.ok)throw Error('Atomic PostgreSQL restore failed; inspect the separate target database');return {restored:true};
  }catch(error){result?.child.kill('SIGTERM');throw error;}finally{if(snapshot)await snapshot.file.close();if(pool)await pool.end();if(pg)await pg.close();await rm(directory,{recursive:true,force:true});}
}
