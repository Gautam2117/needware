import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
const directory=new URL('../services/control-plane/migrations/',import.meta.url);
const digest=value=>createHash('sha256').update(value).digest('hex');
export async function migrationFiles(){
  const names=(await readdir(directory)).filter(name=>/^\d{4}-.+\.sql$/.test(name)||name==='auth-schema.sql').sort();
  return Promise.all(names.map(async name=>({name,sha256:digest(await readFile(new URL(name,directory)))})));
}
export async function schemaDigest(client){
  // Catalog metadata only: no customer rows, sequence values or owner names.
  const {rows}=await client.query(`SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity,c.relforcerowsecurity,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(jsonb_build_array(pg_get_constraintdef(k.oid),k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
    (SELECT jsonb_agg(jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid) AS indexes,
    (SELECT jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
    (SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')
    AND (c.relname LIKE 'auth\\_%' ESCAPE '\\' OR c.relname LIKE 'needware\\_%' ESCAPE '\\') ORDER BY c.relname`);
  return digest(JSON.stringify(rows));
}
export async function verifyMigrationFiles(client,files){
  const present=await client.query("SELECT to_regclass('public.needware_schema_migration') IS NOT NULL AS present");
  if(!present.rows[0].present)return false;
  const {rows}=await client.query('SELECT name,sha256 FROM needware_schema_migration ORDER BY name');
  if(rows.some(row=>!files.some(file=>file.name===row.name&&file.sha256===row.sha256)))throw Error('MIGRATION_CHECKSUM_CHANGED');
  return rows.length===files.length;
}
export async function assertPriorSchema(client){
  const present=await client.query("SELECT to_regclass('public.needware_schema_readiness') IS NOT NULL AS present");
  if(!present.rows[0].present)return;
  const {rows}=await client.query('SELECT schema_digest FROM needware_schema_readiness WHERE id=true');
  if(rows.length!==1||rows[0].schema_digest!==await schemaDigest(client))throw Error('DATABASE_SCHEMA_DRIFT');
}
export async function recordSchemaReadiness(client,files){
  await client.query('CREATE TABLE IF NOT EXISTS needware_schema_migration(name text PRIMARY KEY,sha256 text NOT NULL CHECK(sha256 ~ \'^[0-9a-f]{64}$\'))');
  await client.query('CREATE TABLE IF NOT EXISTS needware_schema_readiness(id boolean PRIMARY KEY DEFAULT true CHECK(id),schema_digest text NOT NULL CHECK(schema_digest ~ \'^[0-9a-f]{64}$\'),updated_at timestamptz NOT NULL DEFAULT now())');
  for(const file of files)await client.query('INSERT INTO needware_schema_migration(name,sha256) VALUES($1,$2) ON CONFLICT(name) DO NOTHING',[file.name,file.sha256]);
  const hash=await schemaDigest(client);
  await client.query('INSERT INTO needware_schema_readiness(id,schema_digest) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET schema_digest=EXCLUDED.schema_digest,updated_at=now()',[hash]);
}
export async function schemaReady(client){
  if(!await verifyMigrationFiles(client,await migrationFiles()))return false;
  const {rows}=await client.query('SELECT schema_digest FROM needware_schema_readiness WHERE id=true');
  return rows.length===1&&rows[0].schema_digest===await schemaDigest(client);
}
