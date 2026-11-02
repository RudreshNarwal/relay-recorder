import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
process.env.APP_ROOT=process.cwd();
const child=spawn(process.execPath,['node_modules/next/dist/bin/next',...process.argv.slice(2)],{stdio:'inherit',env:process.env});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',(code)=>process.exit(code??1));
