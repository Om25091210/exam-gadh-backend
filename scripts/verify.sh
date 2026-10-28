#!/usr/bin/env bash
# Run before every commit: everything CI runs.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm lint
pnpm typecheck
pnpm build
pnpm test
