import {loadEnvironment} from './load-environment.mjs';
import {backupConfig,backupDatabase,restoreDatabase} from './backup-lib.mjs';
loadEnvironment();const [action,path,...flags]=process.argv.slice(2);
if(!['backup','restore'].includes(action)||!path||flags.some(value=>value!=='--local-container')||flags.length>1)throw Error('Use: node scripts/backup.mjs backup|restore <encrypted-artifact> [--local-container]');
const config=backupConfig();try{const result=await(action==='backup'?backupDatabase:restoreDatabase)(path,config,{container:flags.includes('--local-container')});console.log(action==='backup'?`PASS encrypted backup published (${result.bytes} bytes)`:'PASS authenticated backup restored into separate empty database');}catch(error){console.error(error.message);process.exitCode=1;}finally{config.key.fill(0);}
