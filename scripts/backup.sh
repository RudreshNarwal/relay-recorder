#!/usr/bin/env bash
# Stop writers so the database snapshot and filesystem describe the same instant.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
relay_backup_dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$relay_backup_dir"
relay_running=()
while IFS= read -r relay_service; do
  case "$relay_service" in web|worker) relay_running+=("$relay_service");; esac
done < <(docker compose ps --status running --services)
relay_resume() {
  if ((${#relay_running[@]})); then docker compose start "${relay_running[@]}"; fi
}
trap relay_resume EXIT
if ((${#relay_running[@]})); then docker compose stop "${relay_running[@]}"; fi
docker compose exec -T db pg_dump -U relay -d relay -Fc > "$relay_backup_dir/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar web -C /data -czf - . > "$relay_backup_dir/media.tar.gz"
cp .env "$relay_backup_dir/server.env"
docker compose images > "$relay_backup_dir/images.txt"
printf 'Backup complete: %s. Contains secrets; encrypt before moving off-host.\n' "$relay_backup_dir"
