import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const compose = ['compose', '-f', 'compose.yaml', '--profile', 'dev'];

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(result.error?.message || `${command} ${args.slice(0, 3).join(' ')} failed${result.signal ? ` (${result.signal})` : ` (exit ${result.status})`}`);
  }
  return result.stdout?.trim();
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Relay requires Node 24 or newer.');
  console.log('Checking Docker. Start Docker Desktop first if it is not running.');
  run('docker', ['info', '--format', '{{.ServerVersion}}'], true);
  run(process.execPath, ['scripts/setup.mjs']);
  process.loadEnvFile('.env');
  console.log('Starting Relay web, database, worker, transcription, and development email.');
  console.log('First startup downloads model weights. Existing accounts, media, and settings are preserved.');
  run('docker', [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '1200']);

  const ownerExists = run('docker', [...compose, 'exec', '-T', 'db', 'psql', '-U', 'relay', '-d', 'relay', '-Atqc', 'SELECT EXISTS(SELECT 1 FROM instance_admins)'], true);
  if (!['t', 'f'].includes(ownerExists)) throw new Error('Could not check server-owner setup.');
  if (ownerExists === 'f') {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log('Create your server-owner account. This is only needed once.');
      run('docker', [...compose, 'exec', 'web', 'pnpm', 'bootstrap']);
    } else {
      console.log('Owner account is not configured. In a terminal, run: docker compose exec web pnpm bootstrap');
    }
  }
  console.log(`\nRelay is ready: ${process.env.BETTER_AUTH_URL || 'http://localhost:3110'}`);
  console.log('Development email: http://localhost:8025');
  console.log('Mac recorder: open the installed Relay app, or build it with pnpm package:mac.');
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
}
