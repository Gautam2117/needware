import {afterEach,describe,expect,it,vi} from 'vitest';
import {sendTransactionalMail} from './transactional-mail';
const id='5e91ea8b-6a58-4731-aac5-48c186b3e221',message={from:'Needware <sender@example.org>',to:'user@example.org',subject:'Verify your email',text:'A private verification link'},env={NEEDWARE_MAIL_TRANSPORT:'resend',RESEND_API_KEY:'re_'+'a'.repeat(32)};
afterEach(()=>vi.restoreAllMocks());
describe('durable transactional email transport',()=>{
  it('retains the existing SMTP path',async()=>{const smtp={sendMail:vi.fn().mockResolvedValue({messageId:'smtp'})};expect(await sendTransactionalMail(smtp,message,id,{})).toEqual({messageId:'smtp'});expect(smtp.sendMail).toHaveBeenCalledWith(message);});
  it('retries the same outbox identity with a fixed HTTPS destination',async()=>{
    const smtp={sendMail:vi.fn()},request=vi.fn().mockImplementation(()=>Promise.resolve(Response.json({id}))),fetcher=request as typeof fetch;
    await sendTransactionalMail(smtp,message,id,env,fetcher);await sendTransactionalMail(smtp,message,id,env,fetcher);
    expect(smtp.sendMail).not.toHaveBeenCalled();expect(request.mock.calls[0]).toEqual(request.mock.calls[1].map((v,index)=>index===1?{...v,signal:request.mock.calls[0][1].signal}:v));
    const [url,options]=request.mock.calls[0];expect(url).toBe('https://api.resend.com/emails');expect(options.redirect).toBe('error');expect(options.headers['Idempotency-Key']).toBe('needware-outbox-'+id);expect(JSON.parse(options.body)).toEqual({...message,to:[message.to]});
  });
  it.each([429,500,302])('fails closed on provider status %s without leaking private content',async status=>{
    const smtp={sendMail:vi.fn()},request=vi.fn().mockResolvedValue(new Response('private provider error',{status}));
    await expect(sendTransactionalMail(smtp,message,id,env,request as typeof fetch)).rejects.toThrow('Transactional email delivery failed');expect(smtp.sendMail).not.toHaveBeenCalled();
  });
  it('rejects unknown transport, absent key, invalid outbox and header injection before dispatch',async()=>{
    const request=vi.fn(),smtp={sendMail:vi.fn()};for(const [data,identity,settings] of [[message,id,{...env,NEEDWARE_MAIL_TRANSPORT:'unknown'}],[message,id,{...env,RESEND_API_KEY:''}],[message,'invalid',env],[{...message,to:'a@example.org\r\nbcc:bad@example.org'},id,env]] as const)
      await expect(sendTransactionalMail(smtp,data,identity,settings,request as typeof fetch)).rejects.toThrow();expect(request).not.toHaveBeenCalled();expect(smtp.sendMail).not.toHaveBeenCalled();
  });
  it('rejects lost acknowledgements, malformed success and oversized success for durable retry',async()=>{
    const smtp={sendMail:vi.fn()};for(const request of [vi.fn().mockRejectedValue(Error('secret')),vi.fn().mockResolvedValue(Response.json({id:'invalid'})),vi.fn().mockResolvedValue(new Response('x'.repeat(16385)))])
      await expect(sendTransactionalMail(smtp,message,id,env,request as typeof fetch)).rejects.toThrow('Transactional email delivery failed');
  });
});
