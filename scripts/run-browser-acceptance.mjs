// Own a fixed production build and isolated server for the complete browser corpus.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {createWriteStream,mkdirSync} from 'node:fs';
mkdirSync('.logs',{recursive:true});
execFileSync('cargo',['run','-p','xtask','--','revision-fixture'],{stdio:'inherit'});
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const environment={...process.env,NEEDWARE_TEST_URL:`http://127.0.0.1:${port}`,NEEDWARE_BROWSER_OUTPUT:'test-results/core',NEEDWARE_BROWSER_REPORT:'artifacts/browser-results.json'};
const server=spawn('pnpm',['--filter','@needware/web','start','--port',String(port)],{env:environment,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']}),log=createWriteStream('.logs/browser-server.log',{flags:'a'});
server.stdout.pipe(log);server.stderr.pipe(log);const closed=new Promise(resolve=>server.once('close',resolve));
try{
  let ready=false;for(let i=0;i<60;i++){if(server.exitCode!==null)throw Error('Browser server exited');try{if((await fetch(environment.NEEDWARE_TEST_URL,{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}if(!ready)throw Error('Browser server unavailable');
  const test=spawn('pnpm',['exec','playwright','test','--workers=1'],{env:environment,stdio:'inherit'});process.exitCode=await new Promise(resolve=>test.once('exit',code=>resolve(code??1)));
}finally{
  const signal=name=>{try{if(process.platform==='win32')server.kill(name);else process.kill(-server.pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}};
  signal('SIGTERM');const timer=setTimeout(()=>signal('SIGKILL'),2000);try{await closed;}finally{clearTimeout(timer);}
}
