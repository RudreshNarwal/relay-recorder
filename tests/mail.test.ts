import test from 'node:test';
import assert from 'node:assert/strict';
import {MailError,sendMail} from '../packages/core/src/mail';

test('Resend delivery sends idempotent plain-text mail and classifies failures',async()=>{
 const original=globalThis.fetch,env={...process.env};const calls:{url:string;init:RequestInit}[]=[];let status=200;
 Object.assign(process.env,{MAIL_PROVIDER:'resend',RESEND_API_KEY:'re_test',MAIL_FROM:'Relay <video@example.test>'});
 globalThis.fetch=(async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response('{"id":"e"}',{status});}) as typeof fetch;
 try{
  await sendMail({to:'owner@example.test',subject:'Alex viewed\r\nBcc: x@evil.test',text:'Hello',idempotencyKey:'relay-notification/1'});
  const headers=calls[0].init.headers as Record<string,string>;
  assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(headers.authorization,'Bearer re_test');assert.equal(headers['idempotency-key'],'relay-notification/1');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)),{from:'Relay <video@example.test>',to:['owner@example.test'],subject:'Alex viewed Bcc: x@evil.test',text:'Hello'});
  for(const [code,permanent] of [[422,true],[403,true],[429,false],[409,false],[500,false]] as const){
   status=code;await assert.rejects(sendMail({to:'a@example.test',subject:'s',text:'t'}),(e:unknown)=>e instanceof MailError&&e.permanent===permanent);
  }
  delete process.env.RESEND_API_KEY;await assert.rejects(sendMail({to:'a@example.test',subject:'s',text:'t'}),(e:unknown)=>e instanceof MailError&&e.permanent);
 }finally{globalThis.fetch=original;process.env=env;}
});
