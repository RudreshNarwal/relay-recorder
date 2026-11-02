# Deployment and operation

Relay runs on one Linux host with persistent PostgreSQL, media, and model volumes. Start with 4 CPU cores, 8 GB RAM, and enough disk for originals plus rendered revisions; sustained 4K workloads need more capacity. The worker defaults to two concurrent jobs, while ASR processes one inference at a time. This package does not configure a public host or obtain signing credentials for you.

## HTTPS production installation

1. Install Docker and Compose 2.24.4 or newer. Point a domain's A/AAAA records at the host. Permit inbound TCP 80/443 and optional UDP 443. Keep database and ASR ports private.
2. Run `pnpm install --frozen-lockfile && pnpm setup`. Keep `.env` owner-readable. Set `BETTER_AUTH_URL=https://video.example.com`, `RELAY_DOMAIN=video.example.com`, and real SMTP settings. Set **both** `SMTP_HOST` and `CONTAINER_SMTP_HOST` to the SMTP hostname. Set `SMTP_PORT`, `SMTP_FROM`, and credentials. `SMTP_SECURE=true` means implicit TLS, normally port 465; port 587 uses STARTTLS. Development Mailpit is not a production mail service. To use [Resend](https://resend.com) instead of SMTP, set `MAIL_PROVIDER=resend`, `RESEND_API_KEY` and `MAIL_FROM` with an address on a domain verified in Resend; the SMTP variables are then ignored. The same provider sends sign-in, password-reset and view/comment notification emails. Notification emails are retried with backoff up to five attempts and sent with a per-notification idempotency key, so a retried Resend request cannot deliver twice. Check `notifications.email_state` and `email_error` when a message does not arrive.
3. Leave the generated `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `INTERNAL_API_TOKEN`, and database password intact. Keep `ALLOW_SIGNUP=true` for account setup. Setting it false prevents new accounts, including invited people without an account.
4. Start the stack and initialize its owner:

```sh
export COMPOSE_FILE=compose.yaml:compose.production.yaml
docker compose up -d --build --wait
docker compose exec web pnpm bootstrap
```

Caddy acquires and renews HTTPS certificates. The production override removes host database and web bindings; only the proxy accepts public traffic. Web waits for PostgreSQL and applies migrations before becoming healthy. Worker waits for web readiness. ASR readiness includes model loading; the first launch can take several minutes. Preserve all named volumes across upgrades. Never use `docker compose down -v` on an instance containing recordings.

Use the same `COMPOSE_FILE` value for subsequent production commands, including backups. The deployment contains one web instance; Better Auth's default in-process rate limiter is not a shared multi-host limiter.

### Provider credentials

API keys entered in Settings → AI are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. APIs return configuration status, never the stored secret. Do not change the encryption key without migrating encrypted values. Back it up with the database. Changing `BETTER_AUTH_SECRET` invalidates existing browser sessions.

For Gemini Vertex AI, provide Google Application Default Credentials to both web (connection tests) and worker (generation). On Google Cloud, prefer a workload identity/service account with only the required Vertex permissions. For a JSON credential file, mount it read-only and set `GOOGLE_APPLICATION_CREDENTIALS` to its container path in an additional Compose override:

```yaml
services:
  web:
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/google-adc.json
    volumes: ["/secure/google-adc.json:/run/secrets/google-adc.json:ro"]
  worker:
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/google-adc.json
    volumes: ["/secure/google-adc.json:/run/secrets/google-adc.json:ro"]
```

Set project, location, and model in the UI. No fallback provider is used. Keep credentials out of source control, image layers, terminal history, and public logs. Live provider checks consume your provider quota.

## Storage, resources, and recovery

- `postgres` holds accounts, ACLs, recording manifests, transcripts, revisions, and job leases.
- `media` holds upload chunks, immutable originals, and rendered revision assets. Web and worker must share this exact volume.
- `models` caches pinned Parakeet/Silero weights. It can be rebuilt by downloading the same pinned versions.
- `caddy_data` retains certificates. `caddy_config` retains proxy state.

Web and worker run as UID 1000. ASR runs as UID 10001. Fresh named volumes receive the correct ownership from the images. If replacing volumes with bind mounts, create directories with those owners first. Mount media only into trusted services; access control is enforced by the application, not by public static-file hosting. Do not expose `/data` through a proxy alias.

Compose limits worker and ASR memory/CPU and process count. Tune `WORKER_CONCURRENCY`, `WORKER_MEMORY`, `WORKER_CPUS`, `ASR_MEMORY`, and `ASR_CPUS` for the host. Oversized uploads, invalid media, FFmpeg timeouts, and retry exhaustion become visible failures. Keep headroom for temporary renders and original files. Monitor free space on the Docker data filesystem. A failed upload keeps its recording identity and local Mac original.

Jobs use renewable two-minute leases, at most three attempts by default, and bounded backoff. After a worker crash, another worker reclaims an expired lease. A stale attempt cannot publish over a newer lease or newer edit. Settings → Jobs displays diagnostics and allows retry of permanent failures after their cause is fixed. Playback does not depend on successful AI generation.

### Recording admission limits

`RELAY_MAX_UPLOAD_BYTES` defaults to 34,359,738,368 (32 GiB); `RELAY_MAX_DURATION_SECONDS` defaults to 21,600 (six hours). Both require positive integers. Hard ceilings are 128 GiB and 86,400 seconds. Configure the same values on web and worker. These ceilings bound validation; they are not throughput or storage guarantees. Higher limits require storage, render, transcription, and recovery capacity tests on your host before production use.

Authenticated clients read `/api/v1/capabilities` before new uploads. Each recording snapshots its limits at creation; retries and finalization keep those limits when operator settings change. Legacy recordings receive the original defaults. Edits snapshot the current duration limit separately. Parts remain 8 MiB, with only the last part allowed to be smaller; the largest manifest contains 16,384 parts and is bounded to 4 MB JSON. Browsers reject oversize files before media transfer; the worker independently inspects actual duration.

Render steps receive a bounded timeout of five minutes plus four times output duration, instead of a fixed 30-minute ceiling. Memory, CPU, concurrency, and retry limits still apply. Budget temporary disk space for sources, output, and intermediate revision files. Increasing a limit does not reserve that capacity.

Upgrade the schema and server before clients consume capability fields. Additive fields keep legacy clients working. To roll back, return clients to the older contract before removing fields; recordings admitted above old bounds must finish on the compatible worker. Restore a matching database/media backup if downgrading those bounds or schema. Removing the snapshot while such uploads exist is unsafe.

## Health and diagnostics

```sh
docker compose ps
docker compose logs --tail 100 web worker asr
curl --fail https://video.example.com/api/v1/health
docker compose exec worker ffmpeg -version
docker compose exec asr python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8100/health').read().decode())"
```

Web health checks database connectivity and writable storage. Worker health checks a recent heartbeat written only after a database probe. ASR becomes ready after loading the pinned models. ASR receives its authentication token through the environment, has no host port, and must remain private.

## Consistent backup

The backup script stops web and worker, captures PostgreSQL and media, then restarts whichever were running. This creates a brief outage. Run it from the repository root:

```sh
bash scripts/backup.sh
```

The output directory contains `database.dump`, `media.tar.gz`, `server.env`, and `images.txt`. It is ignored by Git and owner-readable. **It includes authentication and encryption secrets. Encrypt backups before transferring them off-host.** Store backups away from the same disk, monitor success, and rehearse restoration. Pin the source revision and container image digests with each backup. Model caches can be redownloaded; preserving them reduces restore time.

## Restore to a fresh instance

Use an empty host/project with no recordings to preserve. Restoring over an existing database or media volume destroys its state. Keep the new instance isolated until checks pass.

1. Check out the same source revision. Copy the backup's `server.env` to `.env` with mode 600. Adjust the public hostname if needed while retaining the authentication/encryption keys and database password. Set the production `COMPOSE_FILE`.
2. Build the images and start only PostgreSQL:

```sh
docker compose build
docker compose up -d --wait db
docker compose exec -T db pg_restore -U relay -d relay --exit-on-error < /secure/backup/database.dump
docker compose run --rm --no-deps -T --entrypoint tar web -C /data -xzf - < /secure/backup/media.tar.gz
docker compose up -d --wait
```

3. Confirm health, sign in, play and export a restored video, inspect its transcript and comments, and test a private video's access denial. New migrations apply on web startup. Do not rerun owner bootstrap against a restored database.

## Cleanup and upgrades

`docker compose exec web pnpm cleanup` expires login attempts, device tokens, and rate-limit rows, and queues removal of redundant upload chunks for videos ready for at least one day. It preserves originals and revisions. Only explicit video deletion schedules original/revision removal, after seven days. Active renders referencing a deleted source delay its cleanup. Failed or interrupted recordings are retained for recovery; delete them explicitly through the workspace when no longer needed.

Before upgrades, take a consistent backup. When upgrading to schema 13 (reviewed external delivery), stop existing workers with `docker compose stop worker` before running `docker compose up -d --build --wait`; older workers do not understand delivery jobs. Upgrade web and worker together. See [integration upgrade and rollback guidance](INTEGRATIONS.md). Database migration holds an advisory lock and applies schema changes transactionally. If an upgrade needs rollback, restore both the database and media backup with the previous source/image. Do not assume rolling back code alone reverses a schema change.
