import {afterEach,describe,expect,it,vi} from 'vitest';
import {DocumentRelay} from './relay-client';

const newRelay=()=>new DocumentRelay({account_operation:vi.fn().mockReturnValue('{}')} as unknown as ConstructorParameters<typeof DocumentRelay>[0]);
const challenge=()=>new Response(JSON.stringify({nonce:'fixture-nonce'}),{status:200,headers:{'content-type':'application/json'}});
const result=()=>new Response(JSON.stringify({digest:'verified'}),{status:200,headers:{'content-type':'application/json'}});
afterEach(()=>vi.unstubAllGlobals());

describe('Encrypted relay retries preserve one-time signed-proof boundaries',()=>{
  it.each(['create','chunk','finalize','read','download','upload'])('retries a timed-out %s with a fresh nonce and proof',async action=>{
    let posts=0;
    const mock=vi.fn(async (url:string)=>{
      if(url==='/api/vault/challenge')return challenge();
      if(url==='/api/documents'){if(++posts===1)throw new DOMException('Fetch is aborted','AbortError');return result();}
      throw Error('Unexpected endpoint');
    });
    vi.stubGlobal('fetch',mock);
    await expect(newRelay().request({action,document:'fixture-id'})).resolves.toEqual({digest:'verified'});
    expect(posts).toBe(2);expect(mock.mock.calls.map(([url])=>url)).toEqual(['/api/vault/challenge','/api/documents','/api/vault/challenge','/api/documents']);
  });
  it.each(['grant','delete','epoch_prepare','epoch_activate','recover','share'])('never replays unsafe %s after an ambiguous transport failure',async action=>{
    const mock=vi.fn(async (url:string)=>url==='/api/vault/challenge'?challenge():Promise.reject(new DOMException('Fetch is aborted','AbortError')));
    vi.stubGlobal('fetch',mock);
    await expect(newRelay().request({action,document:'fixture-id'})).rejects.toHaveProperty('name','AbortError');
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('does not retry authorization and validation failures even for immutable chunks',async()=>{
    const mock=vi.fn(async (url:string)=>url==='/api/vault/challenge'?challenge():new Response(JSON.stringify({message:'Forbidden'}),{status:403}));
    vi.stubGlobal('fetch',mock);
    await expect(newRelay().request({action:'chunk',document:'fixture-id'})).rejects.toMatchObject({status:403});
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('bounds transient retries to three signed operations and preserves the final transport failure',async()=>{
    let posts=0;
    const mock=vi.fn(async (url:string)=>{
      if(url==='/api/vault/challenge')return challenge();
      posts++;throw new DOMException('Fetch is aborted','AbortError');
    });
    vi.stubGlobal('fetch',mock);
    await expect(newRelay().request({action:'finalize',document:'fixture-id'})).rejects.toHaveProperty('name','AbortError');
    expect(posts).toBe(3);expect(mock).toHaveBeenCalledTimes(6);
  });
  it('retries temporary gateway errors only for replay-safe operations',async()=>{
    let posts=0;
    const mock=vi.fn(async (url:string)=>{
      if(url==='/api/vault/challenge')return challenge();
      return ++posts===1?new Response(JSON.stringify({message:'Gateway unavailable'}),{status:503}):result();
    });
    vi.stubGlobal('fetch',mock);
    await expect(newRelay().request({action:'upload',document:'fixture-id'})).resolves.toEqual({digest:'verified'});
    expect(posts).toBe(2);
  });
});
