import nodemailer from 'nodemailer';
export type Mail={to:string;subject:string;text:string;idempotencyKey?:string};
/** permanent: retrying the same message cannot succeed (bad address, rejected sender, missing configuration). */
export class MailError extends Error{constructor(message:string,readonly permanent:boolean){super(message);}}
export async function sendMail(mail:Mail){
 const from=process.env.MAIL_FROM||process.env.SMTP_FROM||'Relay <noreply@localhost>';
 const subject=mail.subject.replace(/[\r\n]+/g,' ').slice(0,200);
 if(process.env.MAIL_PROVIDER==='resend'){
  if(!process.env.RESEND_API_KEY)throw new MailError('RESEND_API_KEY is required when MAIL_PROVIDER=resend',true);
  // Resend replays the first result for a repeated Idempotency-Key, so a retried send cannot duplicate.
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`,'content-type':'application/json',...(mail.idempotencyKey?{'idempotency-key':mail.idempotencyKey}:{})},body:JSON.stringify({from,to:[mail.to],subject,text:mail.text}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new MailError(`Resend rejected the email (${response.status})`,response.status>=400&&response.status<500&&![408,409,429].includes(response.status));
  return;
 }
 if(!process.env.SMTP_HOST)throw new MailError('Email delivery is not configured',true);
 const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',...(process.env.SMTP_USER?{auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}}:{})});
 await transport.sendMail({from,to:mail.to,subject,text:mail.text});
}
