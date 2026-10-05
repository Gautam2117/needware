import assert from 'node:assert/strict';
import {WorkerHost} from '../packages/browser-host/src/worker-host.ts';
const original={Worker:globalThis.Worker,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
const timers=new Map();let serial=0,port;
globalThis.setTimeout=(callback,delay)=>{const id=++serial;timers.set(id,{callback,delay});return id;};
globalThis.clearTimeout=id=>timers.delete(id);
globalThis.Worker=class {constructor(){port=this;}postMessage(message){this.message=message;}terminate(){this.terminated=true;}};
try{
  const host=new WorkerHost('/test-worker',command=>command.kind==='cloud'?300_000:30_000);
  const pending=host.request({kind:'cloud'});assert.equal([...timers.values()][0].delay,300_000);
  port.onmessage({data:{id:port.message.id,ok:true,data:'recovered'}});assert.equal(await pending,'recovered');assert.equal(timers.size,0);
  const local=host.request({kind:'local'});assert.equal([...timers.values()][0].delay,30_000);
  const expired=assert.rejects(local,/Runtime timed out/);[...timers.values()][0].callback();await expired;
  port.onmessage({data:{id:port.message.id,ok:true,data:'late'}});
  const closing=host.request({kind:'cloud'}),closed=assert.rejects(closing,/Host closed/);host.close();await closed;assert(port.terminated);
  const invalid=new WorkerHost('/test-worker',()=>Infinity);await assert.rejects(invalid.request({}),/Invalid runtime deadline/);assert.equal(port.message,undefined);invalid.close();
  console.log('PASS bounded cloud retry deadline, local timeout, late reply, close and invalid deadline');
}finally{Object.assign(globalThis,original);}
