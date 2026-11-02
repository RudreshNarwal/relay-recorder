import {randomBytes} from 'node:crypto';
import {writeFile,mkdir,access} from 'node:fs/promises';
try{await access('.env');console.log('.env exists; preserving it.');process.exit(0);}catch{}
const secret=()=>randomBytes(32).toString('hex');const password=secret();
await writeFile('.env',`DATABASE_URL=postgresql://relay:${password}@127.0.0.1:55432/relay\nPOSTGRES_PASSWORD=${password}\nBETTER_AUTH_URL=http://localhost:3110\nWEB_PORT=3110\nBETTER_AUTH_SECRET=${secret()}\nENCRYPTION_KEY=${secret()}\nINTERNAL_API_TOKEN=${secret()}\nDATA_DIR=./data\nASR_URL=http://127.0.0.1:8100\nSMTP_HOST=127.0.0.1\nCONTAINER_SMTP_HOST=mail\nSMTP_PORT=1025\nSMTP_FROM="Relay <hello@localhost>"\nALLOW_SIGNUP=true\n`,{flag:'wx',mode:0o600});
await mkdir('data',{recursive:true});console.log('Created private .env and data directory. Start PostgreSQL: docker compose --profile dev up -d --wait db mail');
