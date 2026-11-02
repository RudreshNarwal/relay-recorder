#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
apps/macos/scripts/package.sh
mkdir -p apps/web/public/downloads
cp apps/macos/dist/Relay.dmg apps/web/public/downloads/Relay.dmg
echo 'Mac package available at /downloads/Relay.dmg after rebuilding web.'
