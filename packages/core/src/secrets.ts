import { createCipheriv,createDecipheriv,randomBytes,createHash,timingSafeEqual,scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCallback);
function key() { const value=process.env.ENCRYPTION_KEY||''; if(!/^[a-f\d]{64}$/i.test(value))throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as hex'); return Buffer.from(value,'hex'); }
export function encryptSecret(value:string) { const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key(),iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.'); }
export function decryptSecret(value:string) {const [version,iv,tag,data,...rest]=value.split('.');if(version!=='v1'||!iv||!tag||data===undefined||rest.length)throw new Error('Invalid encrypted secret');const cipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));cipher.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString('utf8');}
export function hashToken(value:string){return createHash('sha256').update(value).digest('hex');}
export function token(){return randomBytes(32).toString('base64url');}
export function constantEqual(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export async function hashPassword(value:string){const salt=randomBytes(16).toString('hex');const hash=await scrypt(value,salt,64) as Buffer;return `${salt}:${hash.toString('hex')}`;}
export async function verifyPassword(value:string,hash:string){const [salt,expected]=hash.split(':');if(!salt||!expected)return false;const computed=await scrypt(value,salt,64) as Buffer;return constantEqual(computed.toString('hex'),expected);}
