#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json is not on this revision; skipping dependency install"
  exit 0
fi

npm ci
npx playwright install --with-deps chromium
