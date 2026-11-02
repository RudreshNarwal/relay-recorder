import {getAuth} from '../packages/core/src/auth';
import {query,closeDatabase,transaction} from '../packages/core/src/db';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
let hidden=false;
const output=new Writable({write(chunk,_encoding,callback){if(!hidden)process.stdout.write(chunk);callback();}});
const prompt=createInterface({input:process.stdin,output,terminal:!!process.stdin.isTTY});
async function passwordInput(){
 if(!process.stdin.isTTY)throw new Error('Interactive terminal required; otherwise set BOOTSTRAP_PASSWORD securely');
 process.stdout.write('Password (12+ characters; hidden): ');hidden=true;
 try{return await prompt.question('');}finally{hidden=false;process.stdout.write('\n');}
}
try{
 const email=process.env.BOOTSTRAP_EMAIL||await prompt.question('Server owner email: ');
 const name=process.env.BOOTSTRAP_NAME||await prompt.question('Name: ');
 const password=process.env.BOOTSTRAP_PASSWORD||await passwordInput();
 if(password.length<12)throw new Error('Use at least 12 characters');
 const existing=await query('SELECT 1 FROM instance_admins LIMIT 1');if(existing.length)throw new Error('An instance owner already exists');
 let u=(await query<{id:string}>('SELECT id FROM "user" WHERE lower(email)=lower($1)',[email]))[0];
 if(!u){const result=await getAuth().api.signUpEmail({body:{email,name,password}});u={id:result.user.id};}
 await transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtext('relay-bootstrap'))");if((await c.query('SELECT 1 FROM instance_admins LIMIT 1')).rows.length)throw new Error('An instance owner already exists');await c.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1',[u.id]);await c.query('INSERT INTO instance_admins(user_id) VALUES($1)',[u.id]);});
 console.log('Server owner configured. Sign in through the web app.');
}finally{prompt.close();await closeDatabase();}
