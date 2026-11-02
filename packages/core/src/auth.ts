import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { sendMail } from './mail';
import { db, query } from './db';
import { hashToken } from './secrets';
import { fail, origin } from './http';
import type { User } from './policy';

const mail=(to:string,subject:string,text:string)=>sendMail({to,subject,text});
export function authOptions():BetterAuthOptions {
 if(!process.env.BETTER_AUTH_SECRET||process.env.BETTER_AUTH_SECRET.length<32)throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
 return {database:db(),baseURL:origin(),secret:process.env.BETTER_AUTH_SECRET,trustedOrigins:[origin()],
  emailAndPassword:{enabled:true,minPasswordLength:12,disableSignUp:process.env.ALLOW_SIGNUP!=='true',requireEmailVerification:true,
   sendResetPassword:async({user,url})=>mail(user.email,'Reset your Relay password',`Use this link to reset your password: ${url}`)},
  emailVerification:{sendOnSignUp:true,autoSignInAfterVerification:true,sendVerificationEmail:async({user,url})=>mail(user.email,'Verify your Relay email',`Verify your email: ${url}`)},
  session:{expiresIn:60*60*24*7,cookieCache:{enabled:false}},
  advanced:{useSecureCookies:origin().startsWith('https:')},
  rateLimit:{enabled:true,window:60,max:50},
 };
}
let auth:ReturnType<typeof betterAuth>|undefined;
export function getAuth(){return auth??=betterAuth(authOptions());}
export type Actor=User&{name:string;emailVerified:boolean};
export async function actor(request:Request):Promise<Actor|null>{
 const authorization=request.headers.get('authorization');let userId:string|undefined;
 if(authorization){if(!authorization.startsWith('Bearer '))fail(401,'Invalid authorization');const found=await query<{user_id:string}>(`SELECT user_id FROM device_tokens WHERE token_hash=$1 AND expires_at>now()`,[hashToken(authorization.slice(7))]);userId=found[0]?.user_id;if(!userId)fail(401,'Device session expired; sign in again');}
 else {const session=await getAuth().api.getSession({headers:request.headers});userId=session?.user.id;}
 if(!userId)return null;
 const rows=await query<{id:string;email:string;name:string;emailVerified:boolean;isAdmin:boolean}>(`SELECT u.id,u.email,u.name,u."emailVerified",EXISTS(SELECT 1 FROM instance_admins a WHERE a.user_id=u.id) AS "isAdmin" FROM "user" u WHERE u.id=$1`,[userId]);return rows[0]||null;
}
export function requireActor(user:Actor|null):Actor{if(!user)fail(401,'Sign in to continue');return user;}
export function requireAdmin(user:Actor|null):Actor{const u=requireActor(user);if(!u.isAdmin)fail(403,'Server owner access required');return u;}
export function enforceOrigin(request:Request){
 if(['GET','HEAD','OPTIONS'].includes(request.method)||request.headers.get('authorization')?.startsWith('Bearer '))return;
 const provided=request.headers.get('origin');if(provided!==origin())fail(403,'Untrusted request origin');
}
